import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatAttachment, ChatConversation, ChatMessage } from '@/lib/domain/chat';
import { makeMessage } from '@/lib/domain/chat';
import type { SearchTaskParams, TaskSnapshot } from '@/lib/domain/types';
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
  const [runningConversationId, setRunningConversationId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [chatRunning, setChatRunning] = useState(false);
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
  const activeChatRef = useRef<ActiveChat | null>(null);
  const runningRef = useRef(false);
  const awaitingChatSyncRef = useRef(false);
  const restoreSequenceRef = useRef(0);
  const titleRequestsRef = useRef(
    new Map<string, { requestId: string; lastMessageId: string | undefined }>(),
  );
  const attemptedTitleMessageIdsRef = useRef(new Map<string, string>());
  const queuedTitleHistoriesRef = useRef(new Map<string, ChatMessage[]>());

  const setRunning = useCallback((value: boolean, conversationId: string | null = null) => {
    runningRef.current = value;
    setChatRunning(value);
    const nextConversationId = value ? conversationId : null;
    setRunningConversationId(nextConversationId);
  }, []);

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
    setConversations((previous) => {
      const next = sortConversations([
        conversation,
        ...previous.filter((item) => item.id !== conversation.id),
      ]);
      conversationsRef.current = next;
      return next;
    });
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

    const handleStreamMessage = (requestId: string, message: ChatMessage, terminal: boolean) => {
      const active = activeChatRef.current;
      /*
       * subscribe 后 Background 会先回放权威 stream snapshot，再发送 chat_state。
       * 这个短窗口允许把本地断线前的旧 requestId 改绑到后台当前轮次；同步完成后
       * 仍严格拒绝其他 requestId，避免多窗口的延迟事件篡改正在显示的回复。
       */
      if (active && active.requestId !== requestId && !awaitingChatSyncRef.current) return;
      if (active && active.requestId !== requestId) {
        interruptActiveAssistant(active, REPLACED_REQUEST_MESSAGE);
      }

      const conversationId =
        active?.requestId === requestId
          ? active.conversationId
          : (active?.conversationId ?? activeConversationIdRef.current);
      if (!conversationId) return;

      activeChatRef.current = terminal
        ? null
        : { requestId, conversationId, messageId: message.id };
      setRunning(!terminal, conversationId);
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
            if (message.running) {
              if (message.requestId) {
                const active = activeChatRef.current;
                if (active && active.requestId !== message.requestId) {
                  interruptActiveAssistant(active, REPLACED_REQUEST_MESSAGE);
                }
                const conversationId =
                  active?.conversationId ?? activeConversationIdRef.current ?? '';
                if (conversationId) {
                  activeChatRef.current = {
                    requestId: message.requestId,
                    conversationId,
                    ...(active?.requestId === message.requestId && active.messageId
                      ? { messageId: active.messageId }
                      : {}),
                  };
                }
                setRunning(true, conversationId || null);
              } else {
                setRunning(true, activeChatRef.current?.conversationId ?? null);
              }
              awaitingChatSyncRef.current = false;
              setConnected(true);
              break;
            }

            const interrupted = activeChatRef.current;
            if (interrupted && runningRef.current) {
              const finalized = interruptActiveAssistant(interrupted, DISCONNECTED_REQUEST_MESSAGE);
              if (!finalized) {
                const errorMessage: ChatMessage = {
                  ...makeMessage('assistant', ''),
                  error: true,
                  status: 'error',
                  errorMessage: DISCONNECTED_REQUEST_MESSAGE,
                };
                upsertMessage(interrupted.conversationId, errorMessage);
                saveChatMessage(interrupted.conversationId, errorMessage, { unread: true });
              }
            }
            activeChatRef.current = null;
            setRunning(false);
            awaitingChatSyncRef.current = false;
            setConnected(true);
            break;
          }
          case 'snapshot':
            setSnapshot(message.snapshot);
            break;
          case 'parsed':
            setPendingParams(message.params);
            break;
          case 'stream_start':
          case 'stream_update':
            handleStreamMessage(message.requestId, message.message, false);
            break;
          case 'stream_end':
          case 'stream_error':
            handleStreamMessage(message.requestId, message.message, true);
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
                if (conversation) upsertConversation(conversation);
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
            const active = activeChatRef.current;
            if (message.requestId && (!active || message.requestId !== active.requestId)) break;
            const finalized = active ? interruptActiveAssistant(active, message.text) : false;
            activeChatRef.current = null;
            setRunning(false);
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
    setRunning,
    upsertConversation,
    upsertMessage,
  ]);

  useEffect(() => {
    if (!ready || !connected || chatRunning || !activeConversationId) return;
    const conversation = conversations.find(({ id }) => id === activeConversationId);
    if (conversation?.titleSource !== 'fallback') return;
    const last = messages.at(-1);
    if (last?.role === 'assistant' && last.status === 'completed' && last.content.trim()) {
      void requestConversationTitle(activeConversationId, messages);
    }
  }, [
    activeConversationId,
    chatRunning,
    connected,
    conversations,
    messages,
    ready,
    requestConversationTitle,
  ]);

  const sendChat = useCallback(
    (text: string, attachments: ChatAttachment[] = []): boolean => {
      const trimmed = text.trim();
      if (!trimmed || !ready || !connected || runningRef.current || activeChatRef.current) {
        return false;
      }

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

      const previousMessages = messagesRef.current;
      const next = [...previousMessages, userMessage];
      const wasAwaitingChatSync = awaitingChatSyncRef.current;
      awaitingChatSyncRef.current = false;
      activeChatRef.current = { requestId, conversationId: conversation.id };
      replaceMessages(next);
      setRunning(true, conversation.id);
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
        activeChatRef.current = null;
        replaceMessages(previousMessages);
        setRunning(false);
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
      setRunning,
      upsertConversation,
    ],
  );

  const cancelChat = useCallback(() => {
    const requestId = activeChatRef.current?.requestId;
    if (!requestId) return;
    send({ type: 'cancel', scope: 'chat', requestId });
  }, [send]);

  const resolvePagePermission = useCallback(
    async (requestId: string, permissionPattern: string, allow: boolean): Promise<boolean> => {
      const active = activeChatRef.current;
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
      const active = activeChatRef.current;
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
    if (runningRef.current || activeChatRef.current) return;
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
    historyError,
    chatRunning,
    ready,
    connected,
    pendingParams,
    setPendingParams,
    send,
    sendChat,
    cancelChat,
    resolvePagePermission,
    resolveAskUser,
    downloadDiagnostics,
    startNewConversation,
    restoreConversation,
    setViewedConversationId,
    renameConversationTitle,
  };
}
