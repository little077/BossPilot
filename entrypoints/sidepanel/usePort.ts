import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatAttachment, ChatConversation, ChatMessage } from '@/lib/domain/chat';
import { makeMessage } from '@/lib/domain/chat';
import type { SearchTaskParams, TaskSnapshot } from '@/lib/domain/types';
import type { AgentRunSnapshot } from '@/lib/generation/registry';
import { AGENT_PORT_NAME, type ClientMessage, type ServerMessage } from '@/lib/ipc/protocol';
import { requestPageOriginAccess } from '@/lib/page/access';
import { getChatHistorySettings } from '@/lib/storage/config';
import {
  createConversation,
  loadConversations,
  loadMessages,
  markConversationRead as persistConversationRead,
  renameConversation,
  type SaveMessageOptions,
  saveAiConversationTitle,
  saveMessage,
} from '@/lib/storage/db';

const EMPTY_SNAPSHOT: TaskSnapshot = {
  taskId: '',
  phase: 'idle',
  statusText: '',
  collected: 0,
  assessed: 0,
  jobs: [],
};

const RECONNECT_DELAY_MS = 500;
const REPLACED_REQUEST_MESSAGE = '连接恢复后已切换到后台正在运行的另一轮请求，此回复已中断。';
const DISCONNECTED_REQUEST_MESSAGE = '生成连接已中断，请重试。';
const HISTORY_SAVE_ERROR = '本地历史记录保存失败，请检查浏览器存储空间后重试。';

interface ActiveChat {
  requestId: string;
  conversationId: string;
  messageId?: string;
}

function sortConversations(items: ChatConversation[]): ChatConversation[] {
  return [...items].sort((left, right) => right.updatedAt - left.updatedAt);
}

function optimisticConversationMessage(
  conversation: ChatConversation,
  message: ChatMessage,
): ChatConversation {
  const preview = (message.content || message.errorMessage || '消息').replace(/\s+/g, ' ').trim();
  return {
    ...conversation,
    updatedAt: Math.max(conversation.updatedAt, message.createdAt),
    lastMessagePreview: preview.slice(0, 80),
    messageCount: conversation.messageCount + 1,
    unread: false,
  };
}

export function useAgentPort() {
  const [snapshot, setSnapshot] = useState<TaskSnapshot>(EMPTY_SNAPSHOT);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AgentRunSnapshot[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pendingParams, setPendingParams] = useState<SearchTaskParams | null>(null);

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const messageCacheRef = useRef(new Map<string, ChatMessage[]>());
  const conversationsRef = useRef<ChatConversation[]>([]);
  const activeConversationIdRef = useRef<string | null>(null);
  const viewedConversationIdRef = useRef<string | null>(null);
  const nextOrdinalRef = useRef(1);
  const activeChatsRef = useRef(new Map<string, ActiveChat>());
  const runsRef = useRef<AgentRunSnapshot[]>([]);
  const awaitingChatSyncRef = useRef(false);
  const restoreSequenceRef = useRef(0);
  const titleRequestsRef = useRef(
    new Map<string, { requestId: string; lastMessageId: string | undefined }>(),
  );
  const attemptedTitleMessageIdsRef = useRef(new Map<string, string>());
  const queuedTitleHistoriesRef = useRef(new Map<string, ChatMessage[]>());

  const activeRuns = runs.filter(
    (run) => run.status === 'queued' || run.status === 'running' || run.status === 'waiting_user',
  );
  const runningConversationIds = [...new Set(activeRuns.map((run) => run.conversationId))];
  const runningConversationId = runningConversationIds[0] ?? null;
  const chatRunning = activeRuns.length > 0;
  const currentConversationRunning = activeConversationId
    ? runningConversationIds.includes(activeConversationId)
    : false;

  const setConversationRunning = useCallback(
    (value: boolean, conversationId: string, requestId?: string) => {
      const next = value
        ? [
            ...runsRef.current.filter((run) => run.conversationId !== conversationId),
            {
              runId: requestId ?? `local-${conversationId}`,
              requestId: requestId ?? `local-${conversationId}`,
              conversationId,
              status: 'running' as const,
              updatedAt: Date.now(),
            },
          ]
        : runsRef.current.filter((run) => run.conversationId !== conversationId);
      runsRef.current = next;
      setRuns(next);
    },
    [],
  );

  const replaceMessages = useCallback((next: ChatMessage[]) => {
    const conversationId = activeConversationIdRef.current;
    if (conversationId) messageCacheRef.current.set(conversationId, next);
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const getConversationMessages = useCallback((conversationId: string): ChatMessage[] => {
    return (
      messageCacheRef.current.get(conversationId) ??
      (activeConversationIdRef.current === conversationId ? messagesRef.current : [])
    );
  }, []);

  const replaceConversationMessages = useCallback((conversationId: string, next: ChatMessage[]) => {
    messageCacheRef.current.set(conversationId, next);
    if (activeConversationIdRef.current === conversationId) {
      messagesRef.current = next;
      setMessages(next);
    }
  }, []);

  const replaceConversations = useCallback((next: ChatConversation[]) => {
    const sorted = sortConversations(next);
    conversationsRef.current = sorted;
    setConversations(sorted);
  }, []);

  const upsertConversation = useCallback((conversation: ChatConversation) => {
    const next = sortConversations([
      conversation,
      ...conversationsRef.current.filter((item) => item.id !== conversation.id),
    ]);
    conversationsRef.current = next;
    setConversations(next);
  }, []);

  const upsertMessage = useCallback(
    (conversationId: string, message: ChatMessage): ChatMessage[] => {
      const previous = getConversationMessages(conversationId);
      const index = previous.findIndex((item) => item.id === message.id);
      const next =
        index < 0
          ? [...previous, message]
          : previous.map((item, itemIndex) => (itemIndex === index ? message : item));
      replaceConversationMessages(conversationId, next);
      return next;
    },
    [getConversationMessages, replaceConversationMessages],
  );

  const saveChatMessage = useCallback(
    (conversationId: string, message: ChatMessage, options: SaveMessageOptions = {}) => {
      void saveMessage(conversationId, message, options)
        .then(async (conversation) => {
          let next = conversation;
          if (conversation.unread && viewedConversationIdRef.current === conversationId) {
            await persistConversationRead(conversationId);
            next = { ...conversation, unread: false };
          }
          const current = conversationsRef.current.find(({ id }) => id === conversationId);
          // 标题只由改名 / AI 标题链路更新；消息保存的 DB 快照可能早于标题写入，不能覆盖标题。
          next = current
            ? { ...next, title: current.title, titleSource: current.titleSource }
            : next;
          upsertConversation(next);
          setHistoryError('');
        })
        .catch(() => setHistoryError(HISTORY_SAVE_ERROR));
    },
    [upsertConversation],
  );

  const send = useCallback((message: ClientMessage): boolean => {
    const port = portRef.current;
    if (!port) return false;
    try {
      port.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }, []);

  const requestConversationTitle = useCallback(
    async (conversationId: string, history: ChatMessage[]) => {
      const conversation = conversationsRef.current.find(({ id }) => id === conversationId);
      if (!conversation || conversation.titleSource === 'user') return;
      const lastMessageId = history.at(-1)?.id;
      if (
        lastMessageId &&
        attemptedTitleMessageIdsRef.current.get(conversationId) === lastMessageId
      ) {
        return;
      }
      const activeRequest = titleRequestsRef.current.get(conversationId);
      if (activeRequest) {
        if (activeRequest.lastMessageId !== lastMessageId) {
          queuedTitleHistoriesRef.current.set(conversationId, history);
        }
        return;
      }

      const settings = await getChatHistorySettings().catch(() => ({ autoTitle: false }));
      if (!settings.autoTitle) return;
      const current = conversationsRef.current.find(({ id }) => id === conversationId);
      const requestAfterSettings = titleRequestsRef.current.get(conversationId);
      if (requestAfterSettings) {
        if (requestAfterSettings.lastMessageId !== lastMessageId) {
          queuedTitleHistoriesRef.current.set(conversationId, history);
        }
        return;
      }
      if (!current || current.titleSource === 'user') {
        return;
      }

      const requestId = `title-${crypto.randomUUID()}`;
      titleRequestsRef.current.set(conversationId, { requestId, lastMessageId });
      if (lastMessageId) attemptedTitleMessageIdsRef.current.set(conversationId, lastMessageId);
      if (
        !send({
          type: 'summarize_conversation',
          requestId,
          conversationId,
          messages: history,
        })
      ) {
        titleRequestsRef.current.delete(conversationId);
        if (attemptedTitleMessageIdsRef.current.get(conversationId) === lastMessageId) {
          attemptedTitleMessageIdsRef.current.delete(conversationId);
        }
      }
    },
    [send],
  );

  useEffect(() => {
    let disposed = false;
    void loadConversations()
      .then(async (rows) => {
        if (disposed) return;
        replaceConversations(rows);
        nextOrdinalRef.current = Math.max(0, ...rows.map(({ ordinal }) => ordinal)) + 1;
        const latest = rows[0];
        if (!latest) return;

        const history = await loadMessages(latest.id);
        if (disposed) return;
        activeConversationIdRef.current = latest.id;
        setActiveConversationId(latest.id);
        replaceMessages(history);
      })
      .catch(() => {
        if (!disposed) setHistoryError(HISTORY_SAVE_ERROR);
      })
      .finally(() => {
        if (!disposed) setReady(true);
      });
    return () => {
      disposed = true;
    };
  }, [replaceConversations, replaceMessages]);

  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const interruptActiveAssistant = (active: ActiveChat, errorMessage: string): boolean => {
      if (!active.messageId) return false;
      const message = getConversationMessages(active.conversationId).find(
        ({ id }) => id === active.messageId,
      );
      if (message?.role !== 'assistant' || message.status !== 'streaming') return false;

      const interrupted: ChatMessage = {
        ...message,
        error: true,
        status: 'error',
        errorMessage,
      };
      upsertMessage(active.conversationId, interrupted);
      saveChatMessage(active.conversationId, interrupted, { unread: true });
      return true;
    };

    const handleStreamMessage = (
      requestId: string,
      conversationHint: string | undefined,
      message: ChatMessage,
      terminal: boolean,
    ) => {
      const active = [...activeChatsRef.current.values()].find(
        (candidate) => candidate.requestId === requestId,
      );
      const legacyActive = activeConversationIdRef.current
        ? activeChatsRef.current.get(activeConversationIdRef.current)
        : undefined;
      if (!conversationHint && legacyActive && legacyActive.requestId !== requestId) {
        if (!awaitingChatSyncRef.current) return;
        interruptActiveAssistant(legacyActive, REPLACED_REQUEST_MESSAGE);
        activeChatsRef.current.delete(legacyActive.conversationId);
      }
      const conversationId =
        conversationHint ?? active?.conversationId ?? activeConversationIdRef.current;
      if (!conversationId) return;

      if (terminal) activeChatsRef.current.delete(conversationId);
      else
        activeChatsRef.current.set(conversationId, {
          requestId,
          conversationId,
          messageId: message.id,
        });
      setConversationRunning(!terminal, conversationId, requestId);
      const historySnapshot = upsertMessage(conversationId, message);
      if (terminal) {
        saveChatMessage(conversationId, message, { unread: true });
        if (message.status === 'completed' && message.content.trim()) {
          void requestConversationTitle(conversationId, historySnapshot);
        }
      }
    };

    const connect = () => {
      if (disposed) return;
      const port = chrome.runtime.connect({ name: AGENT_PORT_NAME });
      portRef.current = port;
      awaitingChatSyncRef.current = true;

      port.onMessage.addListener((message: ServerMessage) => {
        if (portRef.current !== port) return;
        switch (message.type) {
          case 'connected':
            port.postMessage({ type: 'subscribe' } satisfies ClientMessage);
            break;
          case 'chat_state': {
            // 兼容旧后台；新后台以 run_state 为唯一运行状态来源。
            if (message.running && message.requestId) {
              const active = [...activeChatsRef.current.values()].find(
                (candidate) => candidate.requestId === message.requestId,
              );
              const conversationId = active?.conversationId ?? activeConversationIdRef.current;
              if (conversationId) {
                const previous = activeChatsRef.current.get(conversationId);
                if (previous && previous.requestId !== message.requestId) {
                  interruptActiveAssistant(previous, REPLACED_REQUEST_MESSAGE);
                }
                activeChatsRef.current.set(conversationId, {
                  requestId: message.requestId,
                  conversationId,
                  ...(active?.messageId ? { messageId: active.messageId } : {}),
                });
                setConversationRunning(true, conversationId, message.requestId);
              }
            } else if (!message.running && runsRef.current.length > 0) {
              for (const active of activeChatsRef.current.values()) {
                interruptActiveAssistant(active, DISCONNECTED_REQUEST_MESSAGE);
              }
              activeChatsRef.current.clear();
              runsRef.current = [];
              setRuns([]);
            }
            awaitingChatSyncRef.current = false;
            setConnected(true);
            break;
          }
          case 'run_state':
            for (const active of activeChatsRef.current.values()) {
              const authoritative = message.runs.find((run) => run.requestId === active.requestId);
              if (
                authoritative &&
                authoritative.status !== 'interrupted' &&
                authoritative.status !== 'error' &&
                authoritative.status !== 'cancelled'
              ) {
                continue;
              }
              const finalized = interruptActiveAssistant(active, DISCONNECTED_REQUEST_MESSAGE);
              if (!finalized) {
                const errorMessage: ChatMessage = {
                  ...makeMessage('assistant', ''),
                  error: true,
                  status: 'error',
                  errorMessage: DISCONNECTED_REQUEST_MESSAGE,
                };
                upsertMessage(active.conversationId, errorMessage);
                saveChatMessage(active.conversationId, errorMessage, { unread: true });
              }
              activeChatsRef.current.delete(active.conversationId);
            }
            runsRef.current = message.runs;
            setRuns(message.runs);
            awaitingChatSyncRef.current = false;
            setConnected(true);
            break;
          case 'snapshot':
            setSnapshot(message.snapshot);
            break;
          case 'parsed':
            setPendingParams(message.params);
            break;
          case 'stream_start':
          case 'stream_update':
            handleStreamMessage(message.requestId, message.conversationId, message.message, false);
            break;
          case 'stream_end':
          case 'stream_error':
            handleStreamMessage(message.requestId, message.conversationId, message.message, true);
            break;
          case 'conversation_title': {
            if (
              titleRequestsRef.current.get(message.conversationId)?.requestId !== message.requestId
            ) {
              break;
            }
            titleRequestsRef.current.delete(message.conversationId);
            void saveAiConversationTitle(message.conversationId, message.title)
              .then((conversation) => {
                if (!conversation) return;
                const current = conversationsRef.current.find(
                  ({ id }) => id === message.conversationId,
                );
                // 消息保存链路可能已把会话标记为已读；AI 标题快照不把未读状态改回去。
                upsertConversation(
                  current && !current.unread && conversation.unread
                    ? { ...conversation, unread: false }
                    : conversation,
                );
              })
              .catch(() => setHistoryError(HISTORY_SAVE_ERROR));
            const queued = queuedTitleHistoriesRef.current.get(message.conversationId);
            queuedTitleHistoriesRef.current.delete(message.conversationId);
            if (queued) void requestConversationTitle(message.conversationId, queued);
            break;
          }
          case 'conversation_title_error':
            if (
              titleRequestsRef.current.get(message.conversationId)?.requestId === message.requestId
            ) {
              titleRequestsRef.current.delete(message.conversationId);
              const queued = queuedTitleHistoriesRef.current.get(message.conversationId);
              queuedTitleHistoriesRef.current.delete(message.conversationId);
              if (queued) void requestConversationTitle(message.conversationId, queued);
            }
            break;
          case 'error': {
            const active = message.requestId
              ? [...activeChatsRef.current.values()].find(
                  (candidate) => candidate.requestId === message.requestId,
                )
              : activeChatsRef.current.get(activeConversationIdRef.current ?? '');
            if (message.requestId && !active) {
              // 后台判定该请求已过期/失败，但本端没有对应活跃流（重连后暂停点
              // 已过期导致 stream 未重放，或面板重开过）。不能静默丢弃：从运行
              // 台账反查所属会话，解除运行状态并展示错误，否则"思考中"会残留。
              const staleRun = runsRef.current.find((run) => run.requestId === message.requestId);
              if (!staleRun) break;
              setConversationRunning(false, staleRun.conversationId);
              const errorMessage: ChatMessage = {
                ...makeMessage('assistant', ''),
                error: true,
                status: 'error',
                errorMessage: message.text,
                retryable: true,
              };
              upsertMessage(staleRun.conversationId, errorMessage);
              saveChatMessage(staleRun.conversationId, errorMessage, { unread: true });
              break;
            }
            const finalized = active ? interruptActiveAssistant(active, message.text) : false;
            if (active) {
              activeChatsRef.current.delete(active.conversationId);
              setConversationRunning(false, active.conversationId);
            }
            if (!finalized) {
              const errorMessage: ChatMessage = {
                ...makeMessage('assistant', ''),
                error: true,
                status: 'error',
                errorMessage: message.text,
              };
              const conversationId = active?.conversationId ?? activeConversationIdRef.current;
              if (conversationId) {
                upsertMessage(conversationId, errorMessage);
                saveChatMessage(conversationId, errorMessage, { unread: true });
              }
            }
            break;
          }
          case 'log':
            break;
        }
      });

      port.onDisconnect.addListener(() => {
        if (portRef.current !== port) return;
        portRef.current = null;
        awaitingChatSyncRef.current = false;
        setConnected(false);
        if (!disposed) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      });
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      portRef.current?.disconnect();
      portRef.current = null;
      setConnected(false);
    };
  }, [
    ready,
    getConversationMessages,
    requestConversationTitle,
    saveChatMessage,
    setConversationRunning,
    upsertConversation,
    upsertMessage,
  ]);

  useEffect(() => {
    if (!ready || !connected || currentConversationRunning || !activeConversationId) return;
    const conversation = conversations.find(({ id }) => id === activeConversationId);
    if (conversation?.titleSource !== 'fallback') return;
    const last = messages.at(-1);
    if (last?.role === 'assistant' && last.status === 'completed' && last.content.trim()) {
      void requestConversationTitle(activeConversationId, messages);
    }
  }, [
    activeConversationId,
    currentConversationRunning,
    connected,
    conversations,
    messages,
    ready,
    requestConversationTitle,
  ]);

  const sendChat = useCallback(
    (text: string, attachments: ChatAttachment[] = []): boolean => {
      const trimmed = text.trim();
      if (!trimmed || !ready || !connected) return false;

      const requestId = `chat-${crypto.randomUUID()}`;
      restoreSequenceRef.current += 1;
      const userMessage = makeMessage('user', trimmed, attachments);
      let conversation = conversationsRef.current.find(
        ({ id }) => id === activeConversationIdRef.current,
      );
      const isNewConversation = !conversation;
      if (!conversation) {
        conversation = createConversation(nextOrdinalRef.current++);
        activeConversationIdRef.current = conversation.id;
        setActiveConversationId(conversation.id);
        upsertConversation(conversation);
      }

      const activeRun = runsRef.current.find(
        (run) =>
          run.conversationId === conversation?.id &&
          (run.status === 'running' || run.status === 'waiting_user' || run.status === 'queued'),
      );
      if (activeRun) {
        if (activeRun.status !== 'running' || attachments.length > 0) return false;
        const steeringMessage = makeMessage('user', trimmed);
        const next = [...messagesRef.current, steeringMessage];
        if (
          !send({
            type: 'run:steer',
            runId: activeRun.runId,
            conversationId: conversation.id,
            content: trimmed,
          })
        )
          return false;
        replaceMessages(next);
        upsertConversation(optimisticConversationMessage(conversation, steeringMessage));
        saveChatMessage(conversation.id, steeringMessage, { unread: false });
        return true;
      }

      const previousMessages = messagesRef.current;
      const next = [...previousMessages, userMessage];
      const wasAwaitingChatSync = awaitingChatSyncRef.current;
      awaitingChatSyncRef.current = false;
      activeChatsRef.current.set(conversation.id, { requestId, conversationId: conversation.id });
      replaceMessages(next);
      setConversationRunning(true, conversation.id, requestId);
      upsertConversation(optimisticConversationMessage(conversation, userMessage));

      if (
        !send({
          type: 'chat',
          requestId,
          conversationId: conversation.id,
          messages: next,
        })
      ) {
        awaitingChatSyncRef.current = wasAwaitingChatSync;
        activeChatsRef.current.delete(conversation.id);
        replaceMessages(previousMessages);
        setConversationRunning(false, conversation.id);
        if (isNewConversation) {
          activeConversationIdRef.current = null;
          setActiveConversationId(null);
          replaceConversations(
            conversationsRef.current.filter(({ id }) => id !== conversation?.id),
          );
        } else {
          upsertConversation(conversation);
        }
        return false;
      }

      saveChatMessage(conversation.id, userMessage, {
        ...(isNewConversation ? { conversation } : {}),
        unread: false,
      });
      return true;
    },
    [
      connected,
      ready,
      replaceConversations,
      replaceMessages,
      saveChatMessage,
      send,
      setConversationRunning,
      upsertConversation,
    ],
  );

  const cancelChat = useCallback(() => {
    const conversationId = activeConversationIdRef.current;
    const requestId = conversationId
      ? (activeChatsRef.current.get(conversationId)?.requestId ??
        runsRef.current.find((run) => run.conversationId === conversationId)?.requestId)
      : undefined;
    if (!requestId) return;
    send({ type: 'cancel', scope: 'chat', requestId });
  }, [send]);

  const retryChat = useCallback((): boolean => {
    const conversationId = activeConversationIdRef.current;
    if (!conversationId || runsRef.current.some((run) => run.conversationId === conversationId)) {
      return false;
    }
    const history = getConversationMessages(conversationId);
    const last = history.at(-1);
    if (last?.role !== 'assistant' || !last.error || !last.retryable) return false;
    const messages = history.slice(0, -1);
    if (!messages.some((message) => message.role === 'user')) return false;
    const runId = `retry-${crypto.randomUUID()}`;
    activeChatsRef.current.set(conversationId, { requestId: runId, conversationId });
    setConversationRunning(true, conversationId, runId);
    if (!send({ type: 'run:retry', runId, conversationId, messages })) {
      activeChatsRef.current.delete(conversationId);
      setConversationRunning(false, conversationId);
      return false;
    }
    return true;
  }, [getConversationMessages, send, setConversationRunning]);

  const resolvePagePermission = useCallback(
    async (requestId: string, permissionPattern: string, allow: boolean): Promise<boolean> => {
      const active = [...activeChatsRef.current.values()].find(
        (candidate) => candidate.requestId === requestId,
      );
      if (!active || active.requestId !== requestId) return false;

      let granted = false;
      if (allow) {
        try {
          // 必须保持为点击处理器后的第一个异步浏览器调用，确保 user gesture 不丢失。
          granted = await requestPageOriginAccess(permissionPattern);
        } catch {
          granted = false;
        }
      }
      return send({
        type: 'page_permission_result',
        requestId,
        granted,
        messages: getConversationMessages(active.conversationId),
      });
    },
    [getConversationMessages, send],
  );

  const resolveAskUser = useCallback(
    async (requestId: string, answer: string): Promise<boolean> => {
      const active = [...activeChatsRef.current.values()].find(
        (candidate) => candidate.requestId === requestId,
      );
      const normalized = answer.replaceAll('\u0000', '').trim().slice(0, 2_000);
      if (!active || active.requestId !== requestId || !normalized) return false;
      return send({
        type: 'ask_user_result',
        requestId,
        answer: normalized,
        messages: getConversationMessages(active.conversationId),
      });
    },
    [getConversationMessages, send],
  );

  const downloadDiagnostics = useCallback(() => {
    send({ type: 'download_diagnostics' });
  }, [send]);

  const startNewConversation = useCallback(() => {
    restoreSequenceRef.current += 1;
    activeConversationIdRef.current = null;
    setActiveConversationId(null);
    replaceMessages([]);
    send({ type: 'clear_chat' });
  }, [replaceMessages, send]);

  const restoreConversation = useCallback(
    async (conversationId: string): Promise<boolean> => {
      if (!conversationsRef.current.some(({ id }) => id === conversationId)) return false;
      const sequence = ++restoreSequenceRef.current;
      try {
        const cached = messageCacheRef.current.get(conversationId);
        const history = cached ?? (await loadMessages(conversationId));
        if (sequence !== restoreSequenceRef.current) return false;
        activeConversationIdRef.current = conversationId;
        setActiveConversationId(conversationId);
        replaceConversationMessages(conversationId, history);
        setHistoryError('');
        return true;
      } catch {
        if (sequence === restoreSequenceRef.current) setHistoryError(HISTORY_SAVE_ERROR);
        return false;
      }
    },
    [replaceConversationMessages],
  );

  const setViewedConversationId = useCallback(
    (conversationId: string | null) => {
      viewedConversationIdRef.current = conversationId;
      if (!conversationId) return;
      const conversation = conversationsRef.current.find(({ id }) => id === conversationId);
      if (conversation?.unread) upsertConversation({ ...conversation, unread: false });
      void persistConversationRead(conversationId).catch(() => setHistoryError(HISTORY_SAVE_ERROR));
    },
    [upsertConversation],
  );

  const renameConversationTitle = useCallback(
    async (conversationId: string, title: string): Promise<boolean> => {
      try {
        const conversation = await renameConversation(conversationId, title);
        if (!conversation) return false;
        upsertConversation(conversation);
        setHistoryError('');
        return true;
      } catch {
        setHistoryError(HISTORY_SAVE_ERROR);
        return false;
      }
    },
    [upsertConversation],
  );

  return {
    snapshot,
    messages,
    conversations,
    activeConversationId,
    runningConversationId,
    runningConversationIds,
    runs,
    historyError,
    chatRunning,
    ready,
    connected,
    pendingParams,
    setPendingParams,
    send,
    sendChat,
    cancelChat,
    retryChat,
    resolvePagePermission,
    resolveAskUser,
    downloadDiagnostics,
    startNewConversation,
    restoreConversation,
    setViewedConversationId,
    renameConversationTitle,
  };
}
