// ─── 侧边栏 ↔ Background 的 Port 客户端 Hook ───
// 维护长连接、自动重连（SW 休眠会断开 Port）；
// 会话历史由本 Hook 持有并持久化到 IndexedDB（冷启动/重连可回放），
// 发起对话时把完整历史随消息带给后台（SW 无状态，更健壮）。

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

export function useAgentPort() {
  const [snapshot, setSnapshot] = useState<TaskSnapshot>(EMPTY_SNAPSHOT);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatRunning, setChatRunning] = useState(false);
  const [ready, setReady] = useState(false);
  const [pendingParams, setPendingParams] = useState<SearchTaskParams | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  // 供 sendChat 构建完整历史（避免闭包读到过期 messages）。
  const messagesRef = useRef<ChatMessage[]>([]);
  // 正在流式接收的 assistant 消息元信息（用于定稿时持久化）。
  const streamingRef = useRef<{ id: string; createdAt: number } | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // 冷启动回放：从 IndexedDB 载入历史对话。
  useEffect(() => {
    void loadMessages()
      .then((rows) => setMessages(rows))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const port = chrome.runtime.connect({ name: AGENT_PORT_NAME });
      portRef.current = port;

      port.onMessage.addListener((msg: ServerMessage) => {
        switch (msg.type) {
          case 'connected':
            port.postMessage({ type: 'subscribe' } satisfies ClientMessage);
            break;
          case 'snapshot':
            setSnapshot(msg.snapshot);
            break;
          case 'parsed':
            setPendingParams(msg.params);
            break;
          case 'stream_start': {
            const createdAt = Date.now();
            streamingRef.current = { id: msg.messageId, createdAt };
            setChatRunning(true);
            setMessages((prev) => [
              ...prev,
              { id: msg.messageId, role: 'assistant', content: '', createdAt },
            ]);
            break;
          }
          case 'stream_delta':
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msg.messageId ? { ...m, content: m.content + msg.delta } : m,
              ),
            );
            break;
          case 'stream_end': {
            const meta = streamingRef.current;
            setMessages((prev) =>
              prev.map((m) => (m.id === msg.messageId ? { ...m, content: msg.content } : m)),
            );
            setChatRunning(false);
            streamingRef.current = null;
            void saveMessage({
              id: msg.messageId,
              role: 'assistant',
              content: msg.content,
              createdAt: meta?.createdAt ?? Date.now(),
            });
            break;
          }
          case 'stream_error': {
            const meta = streamingRef.current;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msg.messageId ? { ...m, content: msg.text, error: true } : m,
              ),
            );
            setChatRunning(false);
            streamingRef.current = null;
            void saveMessage({
              id: msg.messageId,
              role: 'assistant',
              content: msg.text,
              createdAt: meta?.createdAt ?? Date.now(),
              error: true,
            });
            break;
          }
          case 'error': {
            // 未进入流式就失败（如取配置报错）：单独落一条错误气泡。
            setChatRunning(false);
            streamingRef.current = null;
            const errMsg: ChatMessage = { ...makeMessage('assistant', msg.text), error: true };
            setMessages((prev) => [...prev, errMsg]);
            void saveMessage(errMsg);
            break;
          }
          case 'log':
            // 第一期对话不产生流水线日志；保留分支以兼容后续能力。
            break;
        }
      });

      port.onDisconnect.addListener(() => {
        portRef.current = null;
        // SW 被回收时 Port 会断，稍后自动重连
        if (!disposed) setTimeout(connect, 500);
      });
    };

    connect();
    return () => {
      disposed = true;
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    try {
      portRef.current?.postMessage(msg);
    } catch {
      // 断连瞬间发送失败：忽略，重连后用户可重试
    }
  }, []);

  /** 发起一轮对话：落一条 user 消息，持久化，并把完整历史发给后台。 */
  const sendChat = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streamingRef.current) return;
      const userMsg = makeMessage('user', trimmed);
      const next = [...messagesRef.current, userMsg];
      messagesRef.current = next;
      setMessages(next);
      void saveMessage(userMsg);
      setChatRunning(true);
      send({ type: 'chat', messages: next });
    },
    [send],
  );

  /** 下载执行日志（诊断记录）。 */
  const downloadDiagnostics = useCallback(() => {
    send({ type: 'download_diagnostics' });
  }, [send]);

  /** 清空当前对话（本地历史 + IndexedDB）。 */
  const clearChat = useCallback(() => {
    messagesRef.current = [];
    setMessages([]);
    void clearMessages();
  }, []);

  return {
    snapshot,
    messages,
    chatRunning,
    ready,
    pendingParams,
    setPendingParams,
    send,
    sendChat,
    downloadDiagnostics,
    clearChat,
  };
}
