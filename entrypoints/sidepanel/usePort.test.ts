import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import type { SearchTaskParams, TaskSnapshot } from '@/lib/domain/types';
import type { ClientMessage, ServerMessage } from '@/lib/ipc/protocol';
import { useAgentPort } from './usePort';

const dbMocks = vi.hoisted(() => ({
  clearMessages: vi.fn<() => Promise<void>>(),
  loadMessages: vi.fn<() => Promise<ChatMessage[]>>(),
  saveMessage: vi.fn<(message: ChatMessage) => Promise<void>>(),
}));

vi.mock('@/lib/storage/db', () => dbMocks);

class FakePort {
  readonly sent: ClientMessage[] = [];
  throwOnPost = false;
  private messageListeners = new Set<(message: ServerMessage) => void>();
  private disconnectListeners = new Set<() => void>();

  readonly onMessage = {
    addListener: (listener: (message: ServerMessage) => void) => {
      this.messageListeners.add(listener);
    },
  };

  readonly onDisconnect = {
    addListener: (listener: () => void) => {
      this.disconnectListeners.add(listener);
    },
  };

  postMessage(message: ClientMessage) {
    if (this.throwOnPost) throw new Error('port closed');
    this.sent.push(message);
  }

  disconnect() {
    this.emitDisconnect();
  }

  emit(message: ServerMessage) {
    for (const listener of this.messageListeners) listener(message);
  }

  emitDisconnect() {
    for (const listener of this.disconnectListeners) listener();
  }
}

const ports: FakePort[] = [];

beforeEach(() => {
  ports.length = 0;
  dbMocks.clearMessages.mockReset().mockResolvedValue();
  dbMocks.loadMessages.mockReset().mockResolvedValue([]);
  dbMocks.saveMessage.mockReset().mockResolvedValue();
  vi.stubGlobal('chrome', {
    runtime: {
      connect: vi.fn(() => {
        const port = new FakePort();
        ports.push(port);
        return port;
      }),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function connectHook() {
  const hook = renderHook(() => useAgentPort());
  await waitFor(() => expect(ports).toHaveLength(1));
  act(() => {
    ports[0]?.emit({ type: 'connected' });
    ports[0]?.emit({ type: 'chat_state', running: false });
  });
  await waitFor(() => expect(hook.result.current.connected).toBe(true));
  return hook;
}

describe('useAgentPort', () => {
  it('loads history before connecting and subscribes once connected', async () => {
    const saved: ChatMessage = {
      id: 'saved',
      role: 'assistant',
      content: 'previous answer',
      createdAt: 1,
    };
    dbMocks.loadMessages.mockResolvedValue([saved]);

    const hook = await connectHook();

    expect(hook.result.current.ready).toBe(true);
    expect(hook.result.current.messages).toEqual([saved]);
    expect(ports[0]?.sent).toEqual([{ type: 'subscribe' }]);
  });

  it('locks synchronously, sends one request, and applies full stream snapshots', async () => {
    const hook = await connectHook();

    let firstAccepted = false;
    let secondAccepted = true;
    act(() => {
      firstAccepted = hook.result.current.sendChat('hello');
      secondAccepted = hook.result.current.sendChat('duplicate');
    });

    expect(firstAccepted).toBe(true);
    expect(secondAccepted).toBe(false);
    const request = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    expect(request?.messages.at(-1)?.content).toBe('hello');

    const partial: ChatMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'part',
      createdAt: 2,
      status: 'streaming',
    };
    act(() => {
      ports[0]?.emit({
        type: 'stream_start',
        requestId: request?.requestId ?? '',
        message: { ...partial, content: '' },
      });
      ports[0]?.emit({
        type: 'stream_update',
        requestId: request?.requestId ?? '',
        message: partial,
      });
      ports[0]?.emit({
        type: 'stream_end',
        requestId: request?.requestId ?? '',
        message: { ...partial, content: 'part done', status: 'completed', finishReason: 'stop' },
      });
    });

    expect(hook.result.current.chatRunning).toBe(false);
    expect(hook.result.current.messages.at(-1)).toMatchObject({
      id: 'assistant-1',
      content: 'part done',
      status: 'completed',
    });
    expect(dbMocks.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'assistant-1', content: 'part done' }),
    );
  });

  it('preserves partial text and stores the error separately', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('hello');
    });
    const request = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    const failed: ChatMessage = {
      id: 'assistant-error',
      role: 'assistant',
      content: 'partial answer',
      createdAt: 2,
      status: 'error',
      error: true,
      errorMessage: 'provider unavailable',
    };

    act(() => {
      ports[0]?.emit({
        type: 'stream_error',
        requestId: request?.requestId ?? '',
        message: failed,
      });
    });

    expect(hook.result.current.messages.at(-1)).toEqual(failed);
    expect(hook.result.current.chatRunning).toBe(false);
    expect(dbMocks.saveMessage).toHaveBeenCalledWith(failed);
  });

  it('applies task snapshots, parsed parameters, and an active chat state', async () => {
    const hook = await connectHook();
    const snapshot: TaskSnapshot = {
      taskId: 'task-1',
      phase: 'collecting',
      statusText: '正在采集',
      collected: 2,
      assessed: 0,
      jobs: [],
    };
    const params: SearchTaskParams = {
      keyword: '前端开发',
      city: '西安',
      softConditions: [],
      maxJobs: 20,
      fetchDetails: false,
    };

    act(() => {
      ports[0]?.emit({ type: 'snapshot', snapshot });
      ports[0]?.emit({ type: 'parsed', params });
      ports[0]?.emit({ type: 'log', level: 'info', text: 'ignored UI log' });
      ports[0]?.emit({ type: 'chat_state', running: true, requestId: 'request-replayed' });
    });

    expect(hook.result.current.snapshot).toEqual(snapshot);
    expect(hook.result.current.pendingParams).toEqual(params);
    expect(hook.result.current.chatRunning).toBe(true);
    expect(hook.result.current.sendChat('must stay locked')).toBe(false);

    act(() => {
      hook.result.current.setPendingParams(null);
    });
    expect(hook.result.current.pendingParams).toBeNull();
  });

  it('ignores stale stream and error events but accepts the matching request', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('hello');
    });
    const request = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    const stale: ChatMessage = {
      id: 'stale-assistant',
      role: 'assistant',
      content: 'wrong round',
      createdAt: 2,
      status: 'streaming',
    };

    act(() => {
      ports[0]?.emit({
        type: 'stream_update',
        requestId: 'another-request',
        message: stale,
      });
      ports[0]?.emit({
        type: 'error',
        requestId: 'another-request',
        text: 'stale error',
      });
    });
    expect(hook.result.current.messages.some(({ id }) => id === stale.id)).toBe(false);
    expect(hook.result.current.chatRunning).toBe(true);

    act(() => {
      ports[0]?.emit({
        type: 'error',
        requestId: request?.requestId,
        text: 'current request failed',
      });
    });
    expect(hook.result.current.chatRunning).toBe(false);
    expect(hook.result.current.messages.at(-1)).toMatchObject({
      status: 'error',
      errorMessage: 'current request failed',
    });
    expect(dbMocks.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: 'current request failed' }),
    );
  });

  it('ignores scoped errors while idle and accepts only rebound background request B errors', async () => {
    const hook = await connectHook();
    act(() => {
      ports[0]?.emit({
        type: 'error',
        requestId: 'unrelated-idle-request',
        text: 'must not leak into this window',
      });
    });
    expect(hook.result.current.messages).toEqual([]);
    expect(dbMocks.saveMessage).not.toHaveBeenCalled();

    vi.useFakeTimers();
    act(() => {
      hook.result.current.sendChat('request A');
    });
    const requestA = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!requestA) throw new Error('expected request A');
    const assistantA: ChatMessage = {
      id: 'assistant-a-state-only',
      role: 'assistant',
      content: 'A partial before disconnect',
      createdAt: 2,
      status: 'streaming',
    };
    act(() => {
      ports[0]?.emit({
        type: 'stream_update',
        requestId: requestA.requestId,
        message: assistantA,
      });
      ports[0]?.emitDisconnect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    act(() => {
      ports[1]?.emit({ type: 'connected' });
      // 即使没有 stream snapshot，权威 chat_state 也必须从 A 改绑到 B。
      ports[1]?.emit({ type: 'chat_state', running: true, requestId: 'request-b' });
    });
    expect(hook.result.current.connected).toBe(true);
    expect(hook.result.current.messages.find(({ id }) => id === assistantA.id)).toMatchObject({
      content: 'A partial before disconnect',
      status: 'error',
      error: true,
      errorMessage: expect.stringContaining('另一轮请求'),
    });

    act(() => {
      ports[1]?.emit({
        type: 'error',
        requestId: requestA.requestId,
        text: 'stale A resolver error',
      });
    });
    expect(hook.result.current.chatRunning).toBe(true);
    expect(
      hook.result.current.messages.some(
        ({ errorMessage }) => errorMessage === 'stale A resolver error',
      ),
    ).toBe(false);

    act(() => {
      ports[1]?.emit({
        type: 'error',
        requestId: 'request-b',
        text: 'B resolver error',
      });
    });
    expect(hook.result.current.chatRunning).toBe(false);
    expect(hook.result.current.messages.at(-1)).toMatchObject({
      status: 'error',
      errorMessage: 'B resolver error',
    });
    expect(dbMocks.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: assistantA.id, content: assistantA.content, status: 'error' }),
    );
    expect(dbMocks.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: 'B resolver error' }),
    );
  });

  it('sends cancel and diagnostics actions, then clears only an idle conversation', async () => {
    const saved: ChatMessage = {
      id: 'saved',
      role: 'assistant',
      content: 'old answer',
      createdAt: 1,
    };
    dbMocks.loadMessages.mockResolvedValue([saved]);
    const hook = await connectHook();

    act(() => {
      hook.result.current.sendChat('new question');
      hook.result.current.cancelChat();
      hook.result.current.downloadDiagnostics();
      hook.result.current.clearChat();
    });
    const chat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    expect(ports[0]?.sent).toContainEqual({
      type: 'cancel',
      scope: 'chat',
      requestId: chat?.requestId,
    });
    expect(ports[0]?.sent).toContainEqual({ type: 'download_diagnostics' });
    expect(dbMocks.clearMessages).not.toHaveBeenCalled();

    const terminal: ChatMessage = {
      id: 'assistant-terminal',
      role: 'assistant',
      content: 'done',
      createdAt: 2,
      status: 'completed',
      finishReason: 'stop',
    };
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: chat?.requestId ?? '',
        message: terminal,
      });
      hook.result.current.clearChat();
    });
    expect(hook.result.current.messages).toEqual([]);
    expect(ports[0]?.sent).toContainEqual({ type: 'clear_chat' });
    expect(dbMocks.clearMessages).toHaveBeenCalledOnce();
  });

  it('rolls back the optimistic user message when posting the chat fails', async () => {
    const hook = await connectHook();
    const port = ports[0];
    if (!port) throw new Error('expected a connected test port');
    port.throwOnPost = true;

    let accepted = true;
    act(() => {
      accepted = hook.result.current.sendChat('will fail');
    });

    expect(accepted).toBe(false);
    expect(hook.result.current.messages).toEqual([]);
    expect(hook.result.current.chatRunning).toBe(false);
    expect(dbMocks.saveMessage).not.toHaveBeenCalled();
  });

  it('returns false when sending before a Port is ready', () => {
    const loading = new Promise<ChatMessage[]>(() => void 0);
    dbMocks.loadMessages.mockReturnValue(loading);
    const hook = renderHook(() => useAgentPort());

    expect(hook.result.current.send({ type: 'run_nl', text: 'hello' })).toBe(false);
    expect(hook.result.current.sendChat('hello')).toBe(false);
    act(() => {
      hook.result.current.cancelChat();
    });
    expect(ports).toHaveLength(0);
  });

  it('keeps chat locked until subscribe chat_state completes, preventing request C interruption', async () => {
    const hook = renderHook(() => useAgentPort());
    await waitFor(() => expect(ports).toHaveLength(1));

    act(() => ports[0]?.emit({ type: 'connected' }));
    expect(ports[0]?.sent).toEqual([{ type: 'subscribe' }]);
    expect(hook.result.current.connected).toBe(false);
    expect(hook.result.current.sendChat('request C too early')).toBe(false);
    expect(hook.result.current.messages).toEqual([]);

    act(() => ports[0]?.emit({ type: 'chat_state', running: false }));
    expect(hook.result.current.connected).toBe(true);

    let accepted = false;
    act(() => {
      accepted = hook.result.current.sendChat('request C after handshake');
    });
    expect(accepted).toBe(true);
    const requestC = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    expect(requestC?.messages.at(-1)?.content).toBe('request C after handshake');
    expect(hook.result.current.chatRunning).toBe(true);
    expect(
      hook.result.current.messages.some(
        ({ errorMessage }) => errorMessage === '生成连接已中断，请重试。',
      ),
    ).toBe(false);
  });

  it('reconnects and clears a stale running state when the worker has no active session', async () => {
    const hook = await connectHook();
    vi.useFakeTimers();
    act(() => {
      hook.result.current.sendChat('hello');
      ports[0]?.emitDisconnect();
    });
    expect(hook.result.current.connected).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(ports).toHaveLength(2);
    act(() => {
      ports[1]?.emit({ type: 'connected' });
      ports[1]?.emit({ type: 'chat_state', running: false });
    });

    expect(hook.result.current.chatRunning).toBe(false);
    expect(hook.result.current.messages.at(-1)).toMatchObject({
      status: 'error',
      errorMessage: '生成连接已中断，请重试。',
    });
  });

  it('rebinds stale local request A to authoritative background request B during recovery', async () => {
    const hook = await connectHook();
    vi.useFakeTimers();
    act(() => {
      hook.result.current.sendChat('request A');
    });
    const requestA = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!requestA) throw new Error('expected request A');

    act(() => ports[0]?.emitDisconnect());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(ports).toHaveLength(2);

    const requestBPartial: ChatMessage = {
      id: 'assistant-b',
      role: 'assistant',
      content: 'background B partial',
      createdAt: 2,
      status: 'streaming',
    };
    act(() => {
      ports[1]?.emit({ type: 'connected' });
      // Background 的 subscribe 顺序是权威快照在前、chat_state 在后。
      ports[1]?.emit({
        type: 'stream_update',
        requestId: 'request-b',
        message: requestBPartial,
      });
      ports[1]?.emit({ type: 'chat_state', running: true, requestId: 'request-b' });
    });

    expect(hook.result.current.chatRunning).toBe(true);
    expect(hook.result.current.messages.at(-1)).toEqual(requestBPartial);

    act(() => {
      // 同步结束后，A 的延迟事件不能覆盖已经接管的 B。
      ports[1]?.emit({
        type: 'stream_update',
        requestId: requestA.requestId,
        message: { ...requestBPartial, content: 'stale A overwrite' },
      });
      ports[1]?.emit({
        type: 'error',
        requestId: requestA.requestId,
        text: 'stale A error',
      });
      hook.result.current.cancelChat();
    });

    expect(hook.result.current.chatRunning).toBe(true);
    expect(hook.result.current.messages.at(-1)).toEqual(requestBPartial);
    expect(ports[1]?.sent).toContainEqual({
      type: 'cancel',
      scope: 'chat',
      requestId: 'request-b',
    });

    const requestBTerminal: ChatMessage = {
      ...requestBPartial,
      content: 'background B done',
      status: 'completed',
      finishReason: 'stop',
    };
    act(() => {
      ports[1]?.emit({
        type: 'stream_end',
        requestId: 'request-b',
        message: requestBTerminal,
      });
    });

    expect(hook.result.current.chatRunning).toBe(false);
    expect(hook.result.current.messages.at(-1)).toEqual(requestBTerminal);
    expect(dbMocks.saveMessage).toHaveBeenCalledWith(requestBTerminal);
    expect(dbMocks.saveMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: 'stale A overwrite' }),
    );
  });

  it('finalizes partial assistant A before authoritative stream snapshot B takes over', async () => {
    const hook = await connectHook();
    vi.useFakeTimers();
    act(() => {
      hook.result.current.sendChat('request A with partial answer');
    });
    const requestA = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!requestA) throw new Error('expected request A');

    const assistantA: ChatMessage = {
      id: 'assistant-a-snapshot',
      role: 'assistant',
      content: 'A preserved partial text',
      createdAt: 2,
      status: 'streaming',
    };
    act(() => {
      ports[0]?.emit({
        type: 'stream_update',
        requestId: requestA.requestId,
        message: assistantA,
      });
      ports[0]?.emitDisconnect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    const assistantB: ChatMessage = {
      id: 'assistant-b-snapshot',
      role: 'assistant',
      content: 'B authoritative partial',
      createdAt: 3,
      status: 'streaming',
    };
    act(() => {
      ports[1]?.emit({ type: 'connected' });
      ports[1]?.emit({
        type: 'stream_update',
        requestId: 'request-b-snapshot',
        message: assistantB,
      });
    });

    expect(hook.result.current.connected).toBe(false);
    expect(hook.result.current.messages.find(({ id }) => id === assistantA.id)).toMatchObject({
      content: assistantA.content,
      status: 'error',
      error: true,
      errorMessage: expect.stringContaining('另一轮请求'),
    });
    expect(hook.result.current.messages.find(({ id }) => id === assistantB.id)).toEqual(assistantB);
    expect(dbMocks.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: assistantA.id,
        content: assistantA.content,
        status: 'error',
      }),
    );

    act(() => {
      ports[1]?.emit({
        type: 'chat_state',
        running: true,
        requestId: 'request-b-snapshot',
      });
      ports[1]?.emit({
        type: 'stream_update',
        requestId: requestA.requestId,
        message: { ...assistantA, content: 'late A must be ignored' },
      });
    });
    expect(hook.result.current.connected).toBe(true);
    expect(hook.result.current.messages.find(({ id }) => id === assistantA.id)).toMatchObject({
      content: assistantA.content,
      status: 'error',
    });
    expect(hook.result.current.messages.find(({ id }) => id === assistantB.id)).toEqual(assistantB);

    const assistantBTerminal: ChatMessage = {
      ...assistantB,
      content: 'B authoritative done',
      status: 'completed',
      finishReason: 'stop',
    };
    act(() => {
      ports[1]?.emit({
        type: 'stream_end',
        requestId: 'request-b-snapshot',
        message: assistantBTerminal,
      });
    });
    expect(hook.result.current.chatRunning).toBe(false);
    expect(hook.result.current.messages.find(({ id }) => id === assistantB.id)).toEqual(
      assistantBTerminal,
    );
  });

  it('ignores a stale disconnect after a replacement Port has connected', async () => {
    const hook = await connectHook();
    vi.useFakeTimers();

    act(() => ports[0]?.emitDisconnect());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    act(() => {
      ports[1]?.emit({ type: 'connected' });
      ports[1]?.emit({ type: 'chat_state', running: false });
    });
    expect(hook.result.current.connected).toBe(true);

    act(() => ports[0]?.emitDisconnect());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(hook.result.current.connected).toBe(true);
    expect(ports).toHaveLength(2);
  });
});
