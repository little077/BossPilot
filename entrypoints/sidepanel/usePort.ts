// ─── Sidepanel ↔ Background 长连接 Hook ───
// 维护流式对话状态机：连接/重连、发送、取消、断线回放，以及模型配置读写。
// Port 既是流式通道，也是 MV3 后台保活信号，因此面板打开期间始终保持连接。

import { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_PORT_NAME, type ClientMessage, type ServerMessage } from '@/lib/chat/protocol';
import type { ChatMessage } from '@/lib/domain/chat';
import { makeMessage } from '@/lib/domain/chat';
import type { ModelCatalogEntry, ModelConfigView } from '@/lib/domain/types';
import { clearMessages, loadMessages, saveMessage } from '@/lib/storage/db';

const RECONNECT_DELAY_MS = 300;

interface ActiveChat {
  requestId: string;
  messageId?: string;
}

export function useAgentPort() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatRunning, setChatRunning] = useState(false);
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState<ModelConfigView | null>(null);
  // 模型目录拉取：一次性结果，不持久化（下次打开重新拉取），故留在 UI 内存态。
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const activeRef = useRef<ActiveChat | null>(null);
  const modelsRequestIdRef = useRef<string | null>(null);

  const setRunning = useCallback((value: boolean) => {
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

  // 冷启动回放历史。
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

    const handleStream = (requestId: string, message: ChatMessage, terminal: boolean) => {
      const active = activeRef.current;
      // 只接受当前轮次的事件，避免多窗口延迟事件覆盖正在显示的回复。
      if (!active || active.requestId !== requestId) return;
      activeRef.current = terminal ? null : { requestId, messageId: message.id };
      setRunning(!terminal);
      upsertMessage(message);
      if (terminal) void saveMessage(message);
    };

    const connect = () => {
      if (disposed) return;
      const port = chrome.runtime.connect({ name: AGENT_PORT_NAME });
      portRef.current = port;

      port.onMessage.addListener((message: ServerMessage) => {
        if (portRef.current !== port) return;
        switch (message.type) {
          case 'connected':
            port.postMessage({ type: 'subscribe' } satisfies ClientMessage);
            port.postMessage({
              type: 'config:get',
              requestId: `cfg-${crypto.randomUUID()}`,
            } satisfies ClientMessage);
            break;
          case 'chat_state':
            setConnected(true);
            if (message.running && message.requestId) {
              setRunning(true);
              if (activeRef.current?.requestId !== message.requestId) {
                activeRef.current = { requestId: message.requestId };
              }
            } else {
              activeRef.current = null;
              setRunning(false);
            }
            break;
          case 'stream_start':
          case 'stream_update':
            handleStream(message.requestId, message.message, false);
            break;
          case 'stream_end':
          case 'stream_error':
            handleStream(message.requestId, message.message, true);
            break;
          case 'config_state':
            setConfig(message.config);
            break;
          case 'models_state':
            // 只接受当前发起的那次拉取，避免重连回放或迟到的旧结果覆盖。
            if (message.requestId !== modelsRequestIdRef.current) break;
            modelsRequestIdRef.current = null;
            setModels(message.models);
            setModelsError(message.error ?? '');
            setModelsLoading(false);
            break;
          case 'error': {
            const active = activeRef.current;
            if (message.requestId && (!active || message.requestId !== active.requestId)) break;
            activeRef.current = null;
            setRunning(false);
            const errorMessage: ChatMessage = {
              ...makeMessage('assistant', ''),
              error: true,
              status: 'error',
              errorMessage: message.text,
            };
            upsertMessage(errorMessage);
            void saveMessage(errorMessage);
            break;
          }
        }
      });

      port.onDisconnect.addListener(() => {
        if (portRef.current !== port) return;
        portRef.current = null;
        setConnected(false);
        if (!disposed) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      });

      // 触发后台回放当前轮次状态。
      setConnected(true);
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
      if (!trimmed || !ready || !connected || activeRef.current) return false;

      const requestId = `chat-${crypto.randomUUID()}`;
      const userMessage = makeMessage('user', trimmed);
      const next = [...messagesRef.current, userMessage];
      activeRef.current = { requestId };
      replaceMessages(next);
      setRunning(true);

      if (!send({ type: 'chat', requestId, messages: next })) {
        activeRef.current = null;
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
    const requestId = activeRef.current?.requestId;
    if (!requestId) return;
    send({ type: 'cancel', requestId });
  }, [send]);

  const clearChat = useCallback(() => {
    if (activeRef.current) return;
    replaceMessages([]);
    send({ type: 'clear_chat' });
    void clearMessages();
  }, [replaceMessages, send]);

  const saveConfig = useCallback(
    (input: { baseUrl: string; model: string; apiKey: string }): boolean =>
      send({ type: 'config:set', requestId: `cfg-${crypto.randomUUID()}`, ...input }),
    [send],
  );

  /** 拉取厂商模型目录：apiKey 传空串则后台用已存密钥。结果经 models_state 回流。 */
  const fetchModels = useCallback(
    (input: { baseUrl: string; apiKey: string }): boolean => {
      const requestId = `models-${crypto.randomUUID()}`;
      modelsRequestIdRef.current = requestId;
      setModelsLoading(true);
      setModelsError('');
      setModels([]);
      const ok = send({
        type: 'models:fetch',
        requestId,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
      });
      if (!ok) {
        modelsRequestIdRef.current = null;
        setModelsLoading(false);
        setModelsError('后台连接已断开，无法获取模型。');
      }
      return ok;
    },
    [send],
  );

  /** 选定模型：以空 apiKey 落库（后台沿用已存密钥），只更新 model 字段。 */
  const selectModel = useCallback(
    (baseUrl: string, model: string): boolean =>
      send({
        type: 'config:set',
        requestId: `cfg-${crypto.randomUUID()}`,
        baseUrl,
        model,
        apiKey: '',
      }),
    [send],
  );

  return {
    messages,
    chatRunning,
    ready,
    connected,
    config,
    models,
    modelsLoading,
    modelsError,
    sendChat,
    cancelChat,
    clearChat,
    saveConfig,
    fetchModels,
    selectModel,
  };
}
