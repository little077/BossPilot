import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/lib/domain/chat';
import { makeMessage } from '@/lib/domain/chat';
import type { SearchTaskParams, TaskSnapshot } from '@/lib/domain/types';
import { AGENT_PORT_NAME, type ClientMessage, type ServerMessage } from '@/lib/ipc/protocol';
import { clearMessages, loadMessages, saveMessage } from '@/lib/storage/db';

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

interface ActiveChat {
  requestId: string;
  messageId?: string;
}

export function useAgentPort() {
  const [snapshot, setSnapshot] = useState<TaskSnapshot>(EMPTY_SNAPSHOT);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatRunning, setChatRunning] = useState(false);
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pendingParams, setPendingParams] = useState<SearchTaskParams | null>(null);

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const activeChatRef = useRef<ActiveChat | null>(null);
  const runningRef = useRef(false);
  const awaitingChatSyncRef = useRef(false);

  const setRunning = useCallback((value: boolean) => {
    runningRef.current = value;
    setChatRunning(value);
  }, []);

  const replaceMessages = useCallback((next: ChatMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const upsertMessage = useCallback((message: ChatMessage) => {
    setMessages((previous) => {
      const index = previous.findIndex((item) => item.id === message.id);
      const next =
        index < 0
          ? [...previous, message]
          : previous.map((item, itemIndex) => (itemIndex === index ? message : item));
      messagesRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    void loadMessages()
      .then((rows) => {
        if (!disposed) replaceMessages(rows);
      })
      .finally(() => {
        if (!disposed) setReady(true);
      });
    return () => {
      disposed = true;
    };
  }, [replaceMessages]);

  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const interruptActiveAssistant = (active: ActiveChat, errorMessage: string): boolean => {
      if (!active.messageId) return false;
      const message = messagesRef.current.find(({ id }) => id === active.messageId);
      if (message?.role !== 'assistant' || message.status !== 'streaming') return false;

      const interrupted: ChatMessage = {
        ...message,
        error: true,
        status: 'error',
        errorMessage,
      };
      upsertMessage(interrupted);
      void saveMessage(interrupted);
      return true;
    };

    const handleStreamMessage = (requestId: string, message: ChatMessage, terminal: boolean) => {
      const active = activeChatRef.current;
      /*
       * subscribe 后 Background 会先回放权威 stream snapshot，再发送 chat_state。
       * 这个短窗口允许把本地断线前的旧 requestId 改绑到后台当前轮次；同步完成后
       * 仍严格拒绝其它 requestId，避免多窗口的延迟事件篡改正在显示的回复。
       */
      if (active && active.requestId !== requestId && !awaitingChatSyncRef.current) return;
      if (active && active.requestId !== requestId) {
        interruptActiveAssistant(active, REPLACED_REQUEST_MESSAGE);
      }

      activeChatRef.current = terminal ? null : { requestId, messageId: message.id };
      setRunning(!terminal);
      upsertMessage(message);
      if (terminal) void saveMessage(message);
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
              setRunning(true);
              if (message.requestId) {
                const active = activeChatRef.current;
                if (active && active.requestId !== message.requestId) {
                  interruptActiveAssistant(active, REPLACED_REQUEST_MESSAGE);
                }
                activeChatRef.current = {
                  requestId: message.requestId,
                  ...(active?.requestId === message.requestId && active.messageId
                    ? { messageId: active.messageId }
                    : {}),
                };
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
                upsertMessage(errorMessage);
                void saveMessage(errorMessage);
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
              upsertMessage(errorMessage);
              void saveMessage(errorMessage);
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
  }, [ready, setRunning, upsertMessage]);

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

  const sendChat = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      if (!trimmed || !ready || !connected || activeChatRef.current) return false;

      const requestId = `chat-${crypto.randomUUID()}`;
      const userMessage = makeMessage('user', trimmed);
      const next = [...messagesRef.current, userMessage];
      const wasAwaitingChatSync = awaitingChatSyncRef.current;
      awaitingChatSyncRef.current = false;
      activeChatRef.current = { requestId };
      replaceMessages(next);
      setRunning(true);

      if (!send({ type: 'chat', requestId, messages: next })) {
        awaitingChatSyncRef.current = wasAwaitingChatSync;
        activeChatRef.current = null;
        replaceMessages(messagesRef.current.filter((message) => message.id !== userMessage.id));
        setRunning(false);
        return false;
      }

      void saveMessage(userMessage);
      return true;
    },
    [connected, ready, replaceMessages, send, setRunning],
  );

  const cancelChat = useCallback(() => {
    const requestId = activeChatRef.current?.requestId;
    if (!requestId) return;
    send({ type: 'cancel', scope: 'chat', requestId });
  }, [send]);

  const downloadDiagnostics = useCallback(() => {
    send({ type: 'download_diagnostics' });
  }, [send]);

  const clearChat = useCallback(() => {
    if (activeChatRef.current) return;
    replaceMessages([]);
    send({ type: 'clear_chat' });
    void clearMessages();
  }, [replaceMessages, send]);

  return {
    snapshot,
    messages,
    chatRunning,
    ready,
    connected,
    pendingParams,
    setPendingParams,
    send,
    sendChat,
    cancelChat,
    downloadDiagnostics,
    clearChat,
  };
}
