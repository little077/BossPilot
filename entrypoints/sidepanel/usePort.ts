// ─── 侧边栏 ↔ Background 的 Port 客户端 Hook ───
// 维护长连接、自动重连（SW 休眠会断开 Port）、暴露快照与日志流。

import { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_PORT_NAME, type ClientMessage, type ServerMessage } from '@/lib/ipc/protocol';
import type { SearchTaskParams, TaskSnapshot } from '@/lib/domain/types';

export interface ChatEntry {
  id: number;
  role: 'user' | 'agent';
  level?: 'info' | 'warn' | 'error';
  text: string;
}

const EMPTY_SNAPSHOT: TaskSnapshot = {
  taskId: '',
  phase: 'idle',
  statusText: '',
  collected: 0,
  assessed: 0,
  jobs: [],
};

let entryId = 0;

export function useAgentPort() {
  const [snapshot, setSnapshot] = useState<TaskSnapshot>(EMPTY_SNAPSHOT);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [pendingParams, setPendingParams] = useState<SearchTaskParams | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  const pushEntry = useCallback((e: Omit<ChatEntry, 'id'>) => {
    setEntries((prev) => [...prev.slice(-199), { ...e, id: ++entryId }]);
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
          case 'log':
            pushEntry({ role: 'agent', level: msg.level, text: msg.text });
            break;
          case 'error':
            pushEntry({ role: 'agent', level: 'error', text: msg.text });
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
  }, [pushEntry]);

  const send = useCallback((msg: ClientMessage) => {
    try {
      portRef.current?.postMessage(msg);
    } catch {
      // 断连瞬间发送失败：忽略，重连后用户可重试
    }
  }, []);

  return { snapshot, entries, pushEntry, pendingParams, setPendingParams, send };
}
