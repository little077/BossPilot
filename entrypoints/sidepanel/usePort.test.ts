import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConversation, ChatMessage } from '@/lib/domain/chat';
import type { SearchTaskParams, TaskSnapshot } from '@/lib/domain/types';
import type { ClientMessage, ServerMessage } from '@/lib/ipc/protocol';
import { useAgentPort } from './usePort';

const dbMocks = vi.hoisted(() => ({
  createConversation: vi.fn<(ordinal: number) => ChatConversation>(),
  loadConversations: vi.fn<() => Promise<ChatConversation[]>>(),
  loadMessages: vi.fn<(conversationId: string) => Promise<ChatMessage[]>>(),
  markConversationRead: vi.fn<(conversationId: string) => Promise<void>>(),
  renameConversation: vi.fn<(conversationId: string, title: string) => Promise<ChatConversation>>(),
  saveAiConversationTitle:
    vi.fn<(conversationId: string, title: string) => Promise<ChatConversation>>(),
  saveMessage:
    vi.fn<
      (
        conversationId: string,
        message: ChatMessage,
        options?: { conversation?: ChatConversation; unread?: boolean },
      ) => Promise<ChatConversation>
    >(),
}));
const configMocks = vi.hoisted(() => ({
  getChatHistorySettings: vi.fn<() => Promise<{ autoTitle: boolean }>>(),
}));
const pageAccessMocks = vi.hoisted(() => ({
  requestPageOriginAccess: vi.fn<(pattern: string) => Promise<boolean>>(),
}));

vi.mock('@/lib/storage/db', () => dbMocks);
vi.mock('@/lib/storage/config', () => configMocks);
vi.mock('@/lib/page/access', () => pageAccessMocks);

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

function conversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: 'conversation-1',
    ordinal: 1,
    title: '历史记录 1',
    titleSource: 'fallback',
    createdAt: 1,
    updatedAt: 1,
    lastMessagePreview: '',
    messageCount: 0,
    unread: false,
    ...overrides,
  };
}

beforeEach(() => {
  ports.length = 0;
  dbMocks.createConversation.mockReset().mockImplementation((ordinal) =>
    conversation({
      id: `conversation-${ordinal}`,
      ordinal,
      title: `历史记录 ${ordinal}`,
    }),
  );
  dbMocks.loadConversations.mockReset().mockResolvedValue([]);
  dbMocks.loadMessages.mockReset().mockResolvedValue([]);
  dbMocks.markConversationRead.mockReset().mockResolvedValue();
  dbMocks.renameConversation
    .mockReset()
    .mockImplementation(async (id, title) => conversation({ id, title, titleSource: 'user' }));
  dbMocks.saveAiConversationTitle
    .mockReset()
    .mockImplementation(async (id, title) => conversation({ id, title, titleSource: 'ai' }));
  dbMocks.saveMessage.mockReset().mockImplementation(async (conversationId, message, options) => ({
    ...(options?.conversation ?? conversation({ id: conversationId })),
    updatedAt: message.createdAt,
    lastMessagePreview: message.content || message.errorMessage || '消息',
    messageCount: (options?.conversation?.messageCount ?? 0) + 1,
    unread: options?.unread ?? false,
  }));
  configMocks.getChatHistorySettings.mockReset().mockResolvedValue({ autoTitle: false });
  pageAccessMocks.requestPageOriginAccess.mockReset().mockResolvedValue(true);
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
    dbMocks.loadConversations.mockResolvedValue([
      conversation({
        updatedAt: 1,
        lastMessagePreview: saved.content,
        messageCount: 1,
      }),
      conversation({ id: 'conversation-older', ordinal: 2, updatedAt: 0 }),
    ]);
    dbMocks.loadMessages.mockResolvedValue([saved]);

    const hook = await connectHook();

    expect(hook.result.current.ready).toBe(true);
    expect(hook.result.current.messages).toEqual([saved]);
    expect(ports[0]?.sent).toEqual([{ type: 'subscribe' }]);
  });

  it('reports an initial local-history read failure but still completes startup', async () => {
    dbMocks.loadConversations.mockRejectedValueOnce(new Error('indexeddb unavailable'));
    const hook = renderHook(() => useAgentPort());

    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(hook.result.current.historyError).toContain('本地历史记录保存失败');
    expect(ports).toHaveLength(1);
  });

  it('starts once, converts a second in-flight message to steering, and applies stream snapshots', async () => {
    const hook = await connectHook();

    let firstAccepted = false;
    let secondAccepted = true;
    act(() => {
      firstAccepted = hook.result.current.sendChat('hello');
      secondAccepted = hook.result.current.sendChat('duplicate');
    });

    expect(firstAccepted).toBe(true);
    expect(secondAccepted).toBe(true);
    const request = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    expect(request?.messages.at(-1)?.content).toBe('hello');
    expect(ports[0]?.sent).toContainEqual({
      type: 'run:steer',
      runId: request?.requestId,
      conversationId: 'conversation-1',
      content: 'duplicate',
    });

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
      'conversation-1',
      expect.objectContaining({ id: 'assistant-1', content: 'part done' }),
      expect.objectContaining({ unread: true }),
    );
  });

  it('retries a retryable failed turn without duplicating the user message', async () => {
    const hook = await connectHook();
    act(() => hook.result.current.sendChat('读取页面'));
    const request = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    const failure: ChatMessage = {
      id: 'assistant-failed',
      role: 'assistant',
      content: '',
      createdAt: 2,
      status: 'error',
      error: true,
      errorMessage: '网络中断',
      retryable: true,
    };
    act(() => {
      ports[0]?.emit({
        type: 'stream_error',
        requestId: request?.requestId ?? '',
        conversationId: 'conversation-1',
        message: failure,
      });
      ports[0]?.emit({
        type: 'run_state',
        runs: [
          {
            runId: request?.requestId ?? '',
            requestId: request?.requestId ?? '',
            conversationId: 'conversation-1',
            status: 'error',
            updatedAt: 3,
          },
        ],
      });
    });

    let accepted = false;
    act(() => {
      accepted = hook.result.current.retryChat();
    });

    expect(accepted).toBe(true);
    const retry = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'run:retry' }> =>
        message.type === 'run:retry',
    );
    expect(retry?.conversationId).toBe('conversation-1');
    expect(retry?.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(retry?.messages.some((message) => message.id === failure.id)).toBe(false);
  });

  it('regenerateChat 去掉最后一条 AI 回复后按历史重跑', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('再来一次');
    });
    const request = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    act(() => {
      ports[0]?.emit({
        type: 'stream_start',
        requestId: request?.requestId ?? '',
        message: {
          id: 'assistant-regen',
          role: 'assistant',
          content: '',
          createdAt: 2,
          status: 'streaming',
        },
      });
      ports[0]?.emit({
        type: 'stream_end',
        requestId: request?.requestId ?? '',
        message: {
          id: 'assistant-regen',
          role: 'assistant',
          content: '新回答',
          createdAt: 2,
          status: 'completed',
          finishReason: 'stop',
        },
      });
      // 真实后台会保留 completed 快照用于诊断，并在 stream_end 前后广播 run_state。
      // 终态历史不能被误判为仍在生成，否则重新生成会被静默拦截。
      ports[0]?.emit({
        type: 'run_state',
        runs: [
          {
            runId: request?.requestId ?? '',
            requestId: request?.requestId ?? '',
            conversationId: 'conversation-1',
            status: 'completed',
            updatedAt: 3,
          },
        ],
      });
    });

    let accepted = false;
    act(() => {
      accepted = hook.result.current.regenerateChat();
    });

    expect(accepted).toBe(true);
    const retry = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'run:retry' }> =>
        message.type === 'run:retry',
    );
    expect(retry?.conversationId).toBe('conversation-1');
    expect(retry?.messages.map((message) => message.role)).toEqual(['user']);
    expect(retry?.messages.some((message) => message.id === 'assistant-regen')).toBe(false);
  });

  it('会话仍在生成时 regenerateChat 返回 false', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('还在生成');
    });

    let accepted = true;
    act(() => {
      accepted = hook.result.current.regenerateChat();
    });
    expect(accepted).toBe(false);
    expect(ports[0]?.sent.some((message) => message.type === 'run:retry')).toBe(false);
  });

  it('最后一条不是 AI 回复时 regenerateChat 返回 false', async () => {
    dbMocks.loadConversations.mockResolvedValue([conversation()]);
    dbMocks.loadMessages.mockResolvedValue([
      { id: 'user-only', role: 'user', content: '只有用户消息', createdAt: 1 },
    ]);
    const hook = await connectHook();
    await waitFor(() => expect(hook.result.current.messages).toHaveLength(1));

    let accepted = true;
    act(() => {
      accepted = hook.result.current.regenerateChat();
    });
    expect(accepted).toBe(false);
    expect(ports[0]?.sent.some((message) => message.type === 'run:retry')).toBe(false);
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
    expect(dbMocks.saveMessage).toHaveBeenCalledWith(
      'conversation-1',
      failed,
      expect.objectContaining({ unread: true }),
    );
  });

  it('requests an optional AI title after completion and stores only the matching response', async () => {
    configMocks.getChatHistorySettings.mockResolvedValue({ autoTitle: true });
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('帮我总结网页');
    });
    const chat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!chat) throw new Error('expected chat request');
    const completed: ChatMessage = {
      id: 'assistant-title',
      role: 'assistant',
      content: '网页的三个重点',
      createdAt: 2,
      status: 'completed',
      finishReason: 'stop',
    };
    act(() => {
      ports[0]?.emit({ type: 'stream_end', requestId: chat.requestId, message: completed });
    });

    await waitFor(() =>
      expect(ports[0]?.sent.some(({ type }) => type === 'summarize_conversation')).toBe(true),
    );
    const titleRequest = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'summarize_conversation' }> =>
        message.type === 'summarize_conversation',
    );
    if (!titleRequest) throw new Error('expected title request');
    expect(titleRequest.messages.at(-1)).toEqual(completed);

    act(() => {
      ports[0]?.emit({
        type: 'conversation_title',
        requestId: 'stale-title',
        conversationId: titleRequest.conversationId,
        title: '错误标题',
      });
      ports[0]?.emit({
        type: 'conversation_title',
        requestId: titleRequest.requestId,
        conversationId: titleRequest.conversationId,
        title: '当前网页重点',
      });
    });
    await waitFor(() =>
      expect(dbMocks.saveAiConversationTitle).toHaveBeenCalledWith(
        titleRequest.conversationId,
        '当前网页重点',
      ),
    );
    expect(dbMocks.saveAiConversationTitle).not.toHaveBeenCalledWith(
      titleRequest.conversationId,
      '错误标题',
    );
  });

  it('does not retry the same automatic title after a model title failure', async () => {
    configMocks.getChatHistorySettings.mockResolvedValue({ autoTitle: true });
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('只总结一次');
    });
    const chat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!chat) throw new Error('expected chat request');
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: chat.requestId,
        message: {
          id: 'single-title-answer',
          role: 'assistant',
          content: '完成回复',
          createdAt: 2,
          status: 'completed',
        },
      });
    });
    await waitFor(() =>
      expect(ports[0]?.sent.filter(({ type }) => type === 'summarize_conversation')).toHaveLength(
        1,
      ),
    );
    const titleRequest = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'summarize_conversation' }> =>
        message.type === 'summarize_conversation',
    );
    if (!titleRequest) throw new Error('expected title request');

    act(() => {
      ports[0]?.emit({
        type: 'conversation_title_error',
        requestId: titleRequest.requestId,
        conversationId: titleRequest.conversationId,
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ports[0]?.sent.filter(({ type }) => type === 'summarize_conversation')).toHaveLength(1);
  });

  it('queues the latest turn while an earlier automatic title is still running', async () => {
    configMocks.getChatHistorySettings.mockResolvedValue({ autoTitle: true });
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('第一轮');
    });
    const firstChat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!firstChat) throw new Error('expected first chat');
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: firstChat.requestId,
        message: {
          id: 'first-answer',
          role: 'assistant',
          content: '第一轮答案',
          createdAt: 2,
          status: 'completed',
        },
      });
    });
    await waitFor(() =>
      expect(ports[0]?.sent.filter(({ type }) => type === 'summarize_conversation')).toHaveLength(
        1,
      ),
    );
    const firstTitle = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'summarize_conversation' }> =>
        message.type === 'summarize_conversation',
    );
    if (!firstTitle) throw new Error('expected first title');

    act(() => {
      hook.result.current.sendChat('第二轮');
    });
    const chats = (ports[0]?.sent ?? []).filter(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    const secondChat = chats[1];
    if (!secondChat) throw new Error('expected second chat');
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: secondChat.requestId,
        message: {
          id: 'second-answer',
          role: 'assistant',
          content: '第二轮答案',
          createdAt: 4,
          status: 'completed',
        },
      });
    });
    expect(ports[0]?.sent.filter(({ type }) => type === 'summarize_conversation')).toHaveLength(1);

    act(() => {
      ports[0]?.emit({
        type: 'conversation_title_error',
        requestId: firstTitle.requestId,
        conversationId: firstTitle.conversationId,
      });
    });
    await waitFor(() =>
      expect(ports[0]?.sent.filter(({ type }) => type === 'summarize_conversation')).toHaveLength(
        2,
      ),
    );
    const secondTitle = ports[0]?.sent.filter(
      (message): message is Extract<ClientMessage, { type: 'summarize_conversation' }> =>
        message.type === 'summarize_conversation',
    )[1];
    expect(secondTitle?.messages.at(-1)).toMatchObject({
      id: 'second-answer',
      content: '第二轮答案',
    });
  });

  it('marks a conversation read only when its chat or history detail is actually viewed', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('后台继续回答');
      hook.result.current.setViewedConversationId(null);
    });
    const chat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!chat) throw new Error('expected chat request');
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: chat.requestId,
        message: {
          id: 'unread-answer',
          role: 'assistant',
          content: '后台完成',
          createdAt: 2,
          status: 'completed',
        },
      });
    });
    await waitFor(() => expect(hook.result.current.conversations[0]?.unread).toBe(true));

    act(() => hook.result.current.setViewedConversationId(chat.conversationId));
    expect(hook.result.current.conversations[0]?.unread).toBe(false);
    expect(dbMocks.markConversationRead).toHaveBeenCalledWith(chat.conversationId);
  });

  it('keeps a terminal reply read when the user is already viewing the active chat', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('当前页内等待回复');
    });
    const chat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!chat) throw new Error('expected chat request');
    act(() => hook.result.current.setViewedConversationId(chat.conversationId));
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: chat.requestId,
        message: {
          id: 'read-answer',
          role: 'assistant',
          content: '用户已看到的答案',
          createdAt: 2,
          status: 'completed',
        },
      });
    });

    await waitFor(() =>
      expect(dbMocks.markConversationRead).toHaveBeenCalledWith(chat.conversationId),
    );
    expect(hook.result.current.conversations[0]?.unread).toBe(false);
  });

  it('supports manual history renaming and keeps failures observable', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('创建会话');
    });
    const conversationId = hook.result.current.activeConversationId;
    if (!conversationId) throw new Error('expected conversation');

    await act(async () => {
      await expect(
        hook.result.current.renameConversationTitle(conversationId, '新标题'),
      ).resolves.toBe(true);
    });
    expect(hook.result.current.conversations[0]).toMatchObject({
      title: '新标题',
      titleSource: 'user',
    });

    dbMocks.renameConversation.mockRejectedValueOnce(new Error('quota'));
    await act(async () => {
      await expect(
        hook.result.current.renameConversationTitle(conversationId, '失败标题'),
      ).resolves.toBe(false);
    });
    expect(hook.result.current.historyError).toContain('本地历史记录保存失败');
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
      ports[0]?.emit({
        type: 'run_state',
        runs: [
          {
            runId: 'request-replayed',
            requestId: 'request-replayed',
            conversationId: 'conversation-1',
            status: 'running',
            updatedAt: 1,
          },
        ],
      });
    });

    expect(hook.result.current.snapshot).toEqual(snapshot);
    expect(hook.result.current.pendingParams).toEqual(params);
    expect(hook.result.current.chatRunning).toBe(true);
    expect(hook.result.current.sendChat('steer replayed task')).toBe(true);

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
      'conversation-1',
      expect.objectContaining({ errorMessage: 'current request failed' }),
      expect.objectContaining({ unread: true }),
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
      'conversation-1',
      expect.objectContaining({ id: assistantA.id, content: assistantA.content, status: 'error' }),
      expect.objectContaining({ unread: true }),
    );
    expect(dbMocks.saveMessage).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({ errorMessage: 'B resolver error' }),
      expect.objectContaining({ unread: true }),
    );
  });

  it('sends cancel and diagnostics actions, then starts a new idle conversation without deleting history', async () => {
    const saved: ChatMessage = {
      id: 'saved',
      role: 'assistant',
      content: 'old answer',
      createdAt: 1,
    };
    dbMocks.loadConversations.mockResolvedValue([
      conversation({ lastMessagePreview: saved.content, messageCount: 1 }),
    ]);
    dbMocks.loadMessages.mockResolvedValue([saved]);
    const hook = await connectHook();

    act(() => {
      hook.result.current.sendChat('new question');
      hook.result.current.cancelChat();
      hook.result.current.downloadDiagnostics();
      hook.result.current.startNewConversation();
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
    expect(hook.result.current.messages).toEqual([]);

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
      hook.result.current.startNewConversation();
    });
    expect(hook.result.current.messages).toEqual([]);
    expect(ports[0]?.sent).toContainEqual({ type: 'clear_chat' });
    expect(hook.result.current.activeConversationId).toBeNull();
  });

  it('restores an older conversation and sends its complete context on the next turn', async () => {
    const latest = conversation({ id: 'latest', ordinal: 1, updatedAt: 2 });
    const older = conversation({ id: 'older', ordinal: 2, updatedAt: 1 });
    const latestMessages: ChatMessage[] = [
      { id: 'latest-user', role: 'user', content: '最新会话', createdAt: 2 },
    ];
    const olderMessages: ChatMessage[] = [
      { id: 'older-user', role: 'user', content: '以前的问题', createdAt: 1 },
      { id: 'older-answer', role: 'assistant', content: '以前的回答', createdAt: 2 },
    ];
    dbMocks.loadConversations.mockResolvedValue([latest, older]);
    dbMocks.loadMessages.mockImplementation(async (conversationId) =>
      conversationId === latest.id ? latestMessages : olderMessages,
    );
    const hook = await connectHook();

    let restored = false;
    await act(async () => {
      restored = await hook.result.current.restoreConversation(older.id);
    });
    expect(restored).toBe(true);
    expect(hook.result.current.activeConversationId).toBe(older.id);
    expect(hook.result.current.messages).toEqual(olderMessages);

    act(() => {
      hook.result.current.sendChat('继续刚才的话题');
    });
    const request = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    expect(request).toMatchObject({ conversationId: older.id });
    expect(request?.messages.map(({ content }) => content)).toEqual([
      '以前的问题',
      '以前的回答',
      '继续刚才的话题',
    ]);
  });

  it('keeps a running conversation isolated while another conversation is restored', async () => {
    const running = conversation({ id: 'running', ordinal: 1, updatedAt: 2 });
    const restored = conversation({ id: 'restored', ordinal: 2, updatedAt: 1 });
    const runningHistory: ChatMessage[] = [
      { id: 'running-user-old', role: 'user', content: '运行会话上下文', createdAt: 1 },
    ];
    const restoredHistory: ChatMessage[] = [
      { id: 'restored-user', role: 'user', content: '恢复会话内容', createdAt: 1 },
    ];
    dbMocks.loadConversations.mockResolvedValue([running, restored]);
    dbMocks.loadMessages.mockImplementation(async (conversationId) =>
      conversationId === running.id ? runningHistory : restoredHistory,
    );
    const hook = await connectHook();

    act(() => {
      hook.result.current.sendChat('运行中的新问题');
    });
    const request = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!request) throw new Error('expected running request');

    await act(async () => {
      await hook.result.current.restoreConversation(restored.id);
    });
    expect(hook.result.current.activeConversationId).toBe(restored.id);
    expect(hook.result.current.messages).toEqual(restoredHistory);
    expect(hook.result.current.runningConversationId).toBe(running.id);

    const partial: ChatMessage = {
      id: 'running-assistant',
      role: 'assistant',
      content: '后台部分回复',
      createdAt: 3,
      status: 'streaming',
    };
    act(() => {
      ports[0]?.emit({ type: 'stream_update', requestId: request.requestId, message: partial });
    });
    expect(hook.result.current.messages).toEqual(restoredHistory);

    await act(async () => {
      await hook.result.current.restoreConversation(running.id);
    });
    expect(hook.result.current.messages.at(-1)).toEqual(partial);

    await act(async () => {
      await hook.result.current.restoreConversation(restored.id);
    });
    const terminal: ChatMessage = {
      ...partial,
      content: '后台完整回复',
      status: 'completed',
      finishReason: 'stop',
    };
    act(() => {
      ports[0]?.emit({ type: 'stream_end', requestId: request.requestId, message: terminal });
    });

    expect(hook.result.current.messages).toEqual(restoredHistory);
    expect(hook.result.current.chatRunning).toBe(false);
    expect(hook.result.current.runningConversationId).toBeNull();
    expect(dbMocks.saveMessage).toHaveBeenCalledWith(
      running.id,
      terminal,
      expect.objectContaining({ unread: true }),
    );
    await waitFor(() =>
      expect(hook.result.current.conversations.find(({ id }) => id === running.id)?.unread).toBe(
        true,
      ),
    );
  });

  it('uses the running conversation cache when page permission is answered from another view', async () => {
    const running = conversation({ id: 'running', ordinal: 1, updatedAt: 2 });
    const restored = conversation({ id: 'restored', ordinal: 2, updatedAt: 1 });
    dbMocks.loadConversations.mockResolvedValue([running, restored]);
    dbMocks.loadMessages.mockImplementation(async (conversationId) =>
      conversationId === running.id
        ? [{ id: 'running-old', role: 'user', content: '运行上下文', createdAt: 1 }]
        : [{ id: 'restored-old', role: 'user', content: '其他上下文', createdAt: 1 }],
    );
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('读取页面');
    });
    const request = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!request) throw new Error('expected running request');
    const waiting: ChatMessage = {
      id: 'waiting',
      role: 'assistant',
      content: '',
      createdAt: 3,
      status: 'streaming',
    };
    act(() => {
      ports[0]?.emit({ type: 'stream_update', requestId: request.requestId, message: waiting });
    });
    await act(async () => {
      await hook.result.current.restoreConversation(restored.id);
      await hook.result.current.resolvePagePermission(
        request.requestId,
        'https://example.com/*',
        false,
      );
    });

    const permission = ports[0]?.sent.findLast(
      (message): message is Extract<ClientMessage, { type: 'page_permission_result' }> =>
        message.type === 'page_permission_result',
    );
    expect(permission?.messages.map(({ id }) => id)).toEqual([
      'running-old',
      request.messages.at(-1)?.id,
      waiting.id,
    ]);
  });

  it('leaves the active conversation untouched when restoring history fails', async () => {
    const latest = conversation({ id: 'latest', ordinal: 1, updatedAt: 2 });
    const older = conversation({ id: 'older', ordinal: 2, updatedAt: 1 });
    const latestMessages: ChatMessage[] = [
      { id: 'latest-message', role: 'user', content: '保留的会话', createdAt: 1 },
    ];
    dbMocks.loadConversations.mockResolvedValue([latest, older]);
    dbMocks.loadMessages.mockImplementation(async (conversationId) => {
      if (conversationId === older.id) throw new Error('indexeddb read failed');
      return latestMessages;
    });
    const hook = await connectHook();

    let restored = true;
    await act(async () => {
      restored = await hook.result.current.restoreConversation(older.id);
    });

    expect(restored).toBe(false);
    expect(hook.result.current.activeConversationId).toBe(latest.id);
    expect(hook.result.current.messages).toEqual(latestMessages);
    expect(hook.result.current.historyError).toContain('本地历史记录保存失败');
  });

  it('keeps the newest restore selection when an older database read finishes late', async () => {
    const latest = conversation({ id: 'latest', ordinal: 1, updatedAt: 3 });
    const first = conversation({ id: 'first', ordinal: 2, updatedAt: 2 });
    const second = conversation({ id: 'second', ordinal: 3, updatedAt: 1 });
    let resolveFirst: ((messages: ChatMessage[]) => void) | undefined;
    let resolveSecond: ((messages: ChatMessage[]) => void) | undefined;
    dbMocks.loadConversations.mockResolvedValue([latest, first, second]);
    dbMocks.loadMessages.mockImplementation((conversationId) => {
      if (conversationId === latest.id) return Promise.resolve([]);
      return new Promise<ChatMessage[]>((resolve) => {
        if (conversationId === first.id) resolveFirst = resolve;
        if (conversationId === second.id) resolveSecond = resolve;
      });
    });
    const hook = await connectHook();

    let firstRestore: Promise<boolean> | undefined;
    let secondRestore: Promise<boolean> | undefined;
    act(() => {
      firstRestore = hook.result.current.restoreConversation(first.id);
      secondRestore = hook.result.current.restoreConversation(second.id);
    });
    await act(async () => {
      resolveSecond?.([{ id: 'second-message', role: 'user', content: '第二条', createdAt: 1 }]);
      expect(await secondRestore).toBe(true);
    });
    await act(async () => {
      resolveFirst?.([{ id: 'first-message', role: 'user', content: '第一条', createdAt: 1 }]);
      expect(await firstRestore).toBe(false);
    });

    expect(hook.result.current.activeConversationId).toBe(second.id);
    expect(hook.result.current.messages.at(-1)?.content).toBe('第二条');
    await expect(hook.result.current.restoreConversation('missing')).resolves.toBe(false);
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

  it('restores an existing conversation summary when posting its next turn fails', async () => {
    const existing = conversation({
      id: 'existing',
      lastMessagePreview: '旧回答',
      messageCount: 1,
    });
    const history: ChatMessage[] = [
      { id: 'existing-answer', role: 'assistant', content: '旧回答', createdAt: 1 },
    ];
    dbMocks.loadConversations.mockResolvedValue([existing]);
    dbMocks.loadMessages.mockResolvedValue(history);
    const hook = await connectHook();
    const port = ports[0];
    if (!port) throw new Error('expected a connected test port');
    port.throwOnPost = true;

    let accepted = true;
    act(() => {
      accepted = hook.result.current.sendChat('发送失败的新问题');
    });

    expect(accepted).toBe(false);
    expect(hook.result.current.messages).toEqual(history);
    expect(hook.result.current.conversations.find(({ id }) => id === existing.id)).toEqual(
      existing,
    );
  });

  it('returns false when sending before a Port is ready', () => {
    const loading = new Promise<ChatConversation[]>(() => void 0);
    dbMocks.loadConversations.mockReturnValue(loading);
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
      ports[1]?.emit({ type: 'run_state', runs: [] });
    });

    expect(hook.result.current.chatRunning).toBe(false);
    expect(hook.result.current.messages.at(-1)).toMatchObject({
      status: 'error',
      errorMessage: '生成连接已中断，请重试。',
    });
  });

  it('clears a stale waiting_user run when an expired-request error has no active stream', async () => {
    const hook = await connectHook();
    let accepted = false;
    act(() => {
      accepted = hook.result.current.sendChat('hello');
    });
    expect(accepted).toBe(true);
    const request = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    expect(request?.requestId).toBeDefined();

    // 模拟 SW 重启后的重连订阅：run_state 重放了 restore 保留的 waiting_user 僵尸 run
    act(() => {
      ports[0]?.emit({
        type: 'run_state',
        runs: [
          {
            runId: 'run-stale',
            requestId: 'run-stale',
            conversationId: 'conversation-1',
            status: 'waiting_user',
            updatedAt: 1,
          },
        ],
      });
    });
    expect(hook.result.current.chatRunning).toBe(true);

    // 用户点击授权后后台判定暂停点已过期；但 UI 没有该请求的活跃流（stream 未重放），
    // 错误必须仍能解除"思考中"并展示给用户，而不是被静默丢弃。
    act(() => {
      ports[0]?.emit({
        type: 'error',
        requestId: 'run-stale',
        text: '这次页面授权已经处理、过期或不存在，请重新发送问题。',
      });
    });

    expect(hook.result.current.chatRunning).toBe(false);
    expect(hook.result.current.messages.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'error',
      errorMessage: '这次页面授权已经处理、过期或不存在，请重新发送问题。',
      retryable: true,
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
    expect(dbMocks.saveMessage).toHaveBeenCalledWith(
      'conversation-1',
      requestBTerminal,
      expect.objectContaining({ unread: true }),
    );
    expect(
      dbMocks.saveMessage.mock.calls.some(([, message]) => message.content === 'stale A overwrite'),
    ).toBe(false);
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
      'conversation-1',
      expect.objectContaining({
        id: assistantA.id,
        content: assistantA.content,
        status: 'error',
      }),
      expect.objectContaining({ unread: true }),
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

  it('requests exact page access from the click path and resumes with current history', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('总结当前页');
    });
    const chat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    expect(chat).toBeDefined();
    if (!chat) throw new Error('chat request was not sent');
    const waiting: ChatMessage = {
      id: 'assistant-waiting',
      role: 'assistant',
      content: '',
      createdAt: 2,
      status: 'streaming',
      toolActivity: {
        requestId: chat.requestId,
        callId: 'call-1',
        name: 'read_current_page',
        label: '读取当前页面',
        status: 'waiting_permission',
        statusText: '等待网站读取权限',
        startedAt: 2,
        permissionPattern: 'https://example.com/*',
        sourceOrigin: 'https://example.com',
      },
    };
    act(() => {
      ports[0]?.emit({
        type: 'stream_update',
        requestId: chat.requestId,
        message: waiting,
      });
    });

    let accepted = false;
    await act(async () => {
      accepted = await hook.result.current.resolvePagePermission(
        chat.requestId,
        'https://example.com/*',
        true,
      );
    });

    expect(accepted).toBe(true);
    expect(pageAccessMocks.requestPageOriginAccess).toHaveBeenCalledWith('https://example.com/*');
    expect(ports[0]?.sent.at(-1)).toMatchObject({
      type: 'page_permission_result',
      requestId: chat.requestId,
      granted: true,
      messages: expect.arrayContaining([
        expect.objectContaining({ id: chat.messages[0]?.id }),
        expect.objectContaining({ id: 'assistant-waiting' }),
      ]),
    });

    pageAccessMocks.requestPageOriginAccess.mockRejectedValueOnce(new Error('permission api'));
    await act(async () => {
      accepted = await hook.result.current.resolvePagePermission(
        chat.requestId,
        'https://example.com/*',
        true,
      );
    });
    expect(accepted).toBe(true);
    expect(ports[0]?.sent.at(-1)).toMatchObject({
      type: 'page_permission_result',
      requestId: chat.requestId,
      granted: false,
    });
  });

  it('routes an Ask User answer back to the exact running conversation', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('帮我找周末活动');
    });
    const chat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    expect(chat).toBeDefined();
    if (!chat) throw new Error('chat request was not sent');

    const waiting: ChatMessage = {
      id: 'assistant-ask',
      role: 'assistant',
      content: '',
      createdAt: 2,
      status: 'streaming',
      pendingUserQuestion: {
        requestId: chat.requestId,
        callId: 'ask-1',
        question: '你更方便哪一天？',
        options: [
          { id: 'option-1', label: '周六' },
          { id: 'option-2', label: '周日' },
        ],
        allowCustom: true,
      },
    };
    act(() => {
      ports[0]?.emit({ type: 'stream_update', requestId: chat.requestId, message: waiting });
    });

    let accepted = false;
    await act(async () => {
      accepted = await hook.result.current.resolveAskUser(chat.requestId, '  周日下午  ');
    });
    expect(accepted).toBe(true);
    expect(ports[0]?.sent.at(-1)).toMatchObject({
      type: 'ask_user_result',
      requestId: chat.requestId,
      answer: '周日下午',
      messages: expect.arrayContaining([
        expect.objectContaining({ id: chat.messages[0]?.id }),
        expect.objectContaining({ id: 'assistant-ask' }),
      ]),
    });

    await act(async () => {
      accepted = await hook.result.current.resolveAskUser(chat.requestId, '');
    });
    expect(accepted).toBe(false);
  });

  it('keeps AI title snapshots read-aware and surfaces title-save failures', async () => {
    configMocks.getChatHistorySettings.mockResolvedValue({ autoTitle: true });
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('第一轮');
    });
    const firstChat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!firstChat) throw new Error('expected first chat');
    act(() => {
      hook.result.current.setViewedConversationId('conversation-1');
    });
    // 空结果：AI 标题保存返回 null 时静默跳过
    dbMocks.saveAiConversationTitle.mockResolvedValueOnce(null as never);
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: firstChat.requestId,
        message: {
          id: 'title-answer-1',
          role: 'assistant',
          content: '第一轮答案',
          createdAt: 2,
          status: 'completed',
        },
      });
    });
    await waitFor(() =>
      expect(ports[0]?.sent.some(({ type }) => type === 'summarize_conversation')).toBe(true),
    );
    const firstTitle = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'summarize_conversation' }> =>
        message.type === 'summarize_conversation',
    );
    if (!firstTitle) throw new Error('expected first title');
    await act(async () => {
      ports[0]?.emit({
        type: 'conversation_title',
        requestId: firstTitle.requestId,
        conversationId: firstTitle.conversationId,
        title: '空结果标题',
      });
    });
    expect(hook.result.current.conversations[0]?.title).toBe('历史记录 1');
    // 快照返回 unread=true，但会话当前已读：标题链路不能把未读状态改回去。
    act(() => {
      hook.result.current.sendChat('第二轮');
    });
    const secondChat = ports[0]?.sent.filter(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    )[1];
    if (!secondChat) throw new Error('expected second chat');
    dbMocks.saveAiConversationTitle.mockResolvedValueOnce(
      conversation({ unread: true, title: '已读标题', titleSource: 'ai' }),
    );
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: secondChat.requestId,
        message: {
          id: 'title-answer-2',
          role: 'assistant',
          content: '第二轮答案',
          createdAt: 4,
          status: 'completed',
        },
      });
    });
    await waitFor(() =>
      expect(ports[0]?.sent.filter(({ type }) => type === 'summarize_conversation')).toHaveLength(
        2,
      ),
    );
    const secondTitle = ports[0]?.sent.filter(
      (message): message is Extract<ClientMessage, { type: 'summarize_conversation' }> =>
        message.type === 'summarize_conversation',
    )[1];
    if (!secondTitle) throw new Error('expected second title');
    await act(async () => {
      ports[0]?.emit({
        type: 'conversation_title',
        requestId: secondTitle.requestId,
        conversationId: secondTitle.conversationId,
        title: '已读标题',
      });
    });
    expect(hook.result.current.conversations[0]).toMatchObject({
      title: '已读标题',
      unread: false,
    });
    // 新一轮：保存失败必须可见
    act(() => {
      hook.result.current.sendChat('第三轮');
    });
    const thirdChat = ports[0]?.sent.filter(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    )[2];
    if (!thirdChat) throw new Error('expected third chat');
    dbMocks.saveAiConversationTitle.mockRejectedValueOnce(new Error('quota'));
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: thirdChat.requestId,
        message: {
          id: 'title-answer-3',
          role: 'assistant',
          content: '第三轮答案',
          createdAt: 6,
          status: 'completed',
        },
      });
    });
    await waitFor(() =>
      expect(ports[0]?.sent.filter(({ type }) => type === 'summarize_conversation')).toHaveLength(
        3,
      ),
    );
    const thirdTitle = ports[0]?.sent.filter(
      (message): message is Extract<ClientMessage, { type: 'summarize_conversation' }> =>
        message.type === 'summarize_conversation',
    )[2];
    if (!thirdTitle) throw new Error('expected third title');
    act(() => {
      ports[0]?.emit({
        type: 'conversation_title',
        requestId: thirdTitle.requestId,
        conversationId: thirdTitle.conversationId,
        title: '失败标题',
      });
    });
    await waitFor(() => expect(hook.result.current.historyError).toContain('本地历史记录保存失败'));
  });

  it('does not un-read a conversation from an AI title snapshot', async () => {
    configMocks.getChatHistorySettings.mockResolvedValue({ autoTitle: true });
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('后台一轮');
    });
    const chat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!chat) throw new Error('expected chat request');
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: chat.requestId,
        message: {
          id: 'background-answer',
          role: 'assistant',
          content: '后台完成',
          createdAt: 2,
          status: 'completed',
        },
      });
    });
    await waitFor(() => expect(hook.result.current.conversations[0]?.unread).toBe(true));
    const titleRequest = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'summarize_conversation' }> =>
        message.type === 'summarize_conversation',
    );
    if (!titleRequest) throw new Error('expected title request');
    await act(async () => {
      dbMocks.saveAiConversationTitle.mockResolvedValueOnce(
        conversation({ unread: true, title: '后台标题', titleSource: 'ai' }),
      );
      ports[0]?.emit({
        type: 'conversation_title',
        requestId: titleRequest.requestId,
        conversationId: titleRequest.conversationId,
        title: '后台标题',
      });
    });
    expect(hook.result.current.conversations[0]?.unread).toBe(true);
  });

  it('rolls back an auto-title request when the Port refuses to send', async () => {
    configMocks.getChatHistorySettings.mockResolvedValue({ autoTitle: true });
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('标题第一轮');
    });
    const firstChat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!firstChat) throw new Error('expected first chat');
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: firstChat.requestId,
        message: {
          id: 't-answer-1',
          role: 'assistant',
          content: '第一轮答案',
          createdAt: 2,
          status: 'completed',
        },
      });
    });
    await waitFor(() =>
      expect(ports[0]?.sent.some(({ type }) => type === 'summarize_conversation')).toBe(true),
    );
    const firstTitle = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'summarize_conversation' }> =>
        message.type === 'summarize_conversation',
    );
    if (!firstTitle) throw new Error('expected first title');
    act(() => {
      ports[0]?.emit({
        type: 'conversation_title',
        requestId: firstTitle.requestId,
        conversationId: firstTitle.conversationId,
        title: '第一轮标题',
      });
    });
    await waitFor(() => expect(dbMocks.saveAiConversationTitle).toHaveBeenCalled());
    const port = ports[0];
    if (!port) throw new Error('expected a connected test port');
    act(() => {
      hook.result.current.sendChat('标题第二轮');
    });
    const secondChat = ports[0]?.sent.filter(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    )[1];
    if (!secondChat) throw new Error('expected second chat');
    port.throwOnPost = true;
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: secondChat.requestId,
        message: {
          id: 't-answer-2',
          role: 'assistant',
          content: '第二轮答案',
          createdAt: 4,
          status: 'completed',
        },
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ports[0]?.sent.filter(({ type }) => type === 'summarize_conversation')).toHaveLength(1);
    port.throwOnPost = false;
    act(() => {
      hook.result.current.sendChat('标题第三轮');
    });
    const thirdChat = ports[0]?.sent.filter(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    )[2];
    if (!thirdChat) throw new Error('expected third chat');
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: thirdChat.requestId,
        message: {
          id: 't-answer-3',
          role: 'assistant',
          content: '第三轮答案',
          createdAt: 6,
          status: 'completed',
        },
      });
    });
    await waitFor(() =>
      expect(ports[0]?.sent.filter(({ type }) => type === 'summarize_conversation')).toHaveLength(
        2,
      ),
    );
  });

  it('skips automatic titles for user-renamed conversations', async () => {
    configMocks.getChatHistorySettings.mockResolvedValue({ autoTitle: true });
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('先建会话');
    });
    const firstChat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!firstChat) throw new Error('expected first chat');
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: firstChat.requestId,
        message: {
          id: 'first-answer',
          role: 'assistant',
          content: '第一轮完成',
          createdAt: 2,
          status: 'completed',
        },
      });
    });
    await waitFor(() =>
      expect(ports[0]?.sent.some(({ type }) => type === 'summarize_conversation')).toBe(true),
    );
    const conversationId = hook.result.current.activeConversationId;
    if (!conversationId) throw new Error('expected conversation');
    await act(async () => {
      await hook.result.current.renameConversationTitle(conversationId, '手动标题');
    });
    act(() => {
      hook.result.current.sendChat('完成一轮');
    });
    const chat = ports[0]?.sent.filter(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    )[1];
    if (!chat) throw new Error('expected chat request');
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: chat.requestId,
        message: {
          id: 'renamed-answer',
          role: 'assistant',
          content: '完成',
          createdAt: 2,
          status: 'completed',
        },
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 只有第一轮（重命名前）发出过自动标题请求，重命名后的完成轮不再请求
    expect(ports[0]?.sent.filter(({ type }) => type === 'summarize_conversation')).toHaveLength(1);
  });

  it('skips automatic titles when history settings are unreadable', async () => {
    configMocks.getChatHistorySettings.mockRejectedValueOnce(new Error('settings unavailable'));
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('读取设置');
    });
    const chat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!chat) throw new Error('expected chat request');
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: chat.requestId,
        message: {
          id: 'settings-answer',
          role: 'assistant',
          content: '完成',
          createdAt: 2,
          status: 'completed',
        },
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ports[0]?.sent.some(({ type }) => type === 'summarize_conversation')).toBe(false);
  });

  it('re-checks the conversation after settings resolve and honors a rename made meanwhile', async () => {
    configMocks.getChatHistorySettings.mockResolvedValue({ autoTitle: true });
    let resolveSettings: (() => void) | undefined;
    const settingsGate = new Promise<void>((resolve) => {
      resolveSettings = resolve;
    });
    configMocks.getChatHistorySettings.mockImplementation(() =>
      settingsGate.then(() => ({ autoTitle: true })),
    );
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('设置期间改名');
    });
    const chat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!chat) throw new Error('expected chat request');
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: chat.requestId,
        message: {
          id: 'rename-answer',
          role: 'assistant',
          content: '完成',
          createdAt: 2,
          status: 'completed',
        },
      });
    });
    const conversationId = hook.result.current.activeConversationId;
    if (!conversationId) throw new Error('expected conversation');
    await act(async () => {
      await hook.result.current.renameConversationTitle(conversationId, '设置后才命名');
    });
    await act(async () => {
      resolveSettings?.();
      await settingsGate;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ports[0]?.sent.some(({ type }) => type === 'summarize_conversation')).toBe(false);
  });

  it('drains a queued title request once the earlier one finishes', async () => {
    configMocks.getChatHistorySettings.mockResolvedValue({ autoTitle: true });
    let resolveSettings: (() => void) | undefined;
    const settingsGate = new Promise<void>((resolve) => {
      resolveSettings = resolve;
    });
    configMocks.getChatHistorySettings.mockImplementation(() =>
      settingsGate.then(() => ({ autoTitle: true })),
    );
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('第一轮');
    });
    const firstChat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!firstChat) throw new Error('expected first chat');
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: firstChat.requestId,
        message: {
          id: 'queued-answer-1',
          role: 'assistant',
          content: '第一轮答案',
          createdAt: 2,
          status: 'completed',
        },
      });
    });
    act(() => {
      hook.result.current.sendChat('第二轮');
    });
    const secondChat = ports[0]?.sent.filter(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    )[1];
    if (!secondChat) throw new Error('expected second chat');
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: secondChat.requestId,
        message: {
          id: 'queued-answer-2',
          role: 'assistant',
          content: '第二轮答案',
          createdAt: 4,
          status: 'completed',
        },
      });
    });
    // 两个 title 请求都挂在 settings 读取上：第一个先恢复并发出，第二个排队
    await act(async () => {
      resolveSettings?.();
      await settingsGate;
    });
    await waitFor(() =>
      expect(ports[0]?.sent.filter(({ type }) => type === 'summarize_conversation')).toHaveLength(
        1,
      ),
    );
    const firstTitle = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'summarize_conversation' }> =>
        message.type === 'summarize_conversation',
    );
    if (!firstTitle) throw new Error('expected first title');
    act(() => {
      ports[0]?.emit({
        type: 'conversation_title',
        requestId: firstTitle.requestId,
        conversationId: firstTitle.conversationId,
        title: '第一轮标题',
      });
    });
    await waitFor(() =>
      expect(ports[0]?.sent.filter(({ type }) => type === 'summarize_conversation')).toHaveLength(
        2,
      ),
    );
    const secondTitle = ports[0]?.sent.filter(
      (message): message is Extract<ClientMessage, { type: 'summarize_conversation' }> =>
        message.type === 'summarize_conversation',
    )[1];
    expect(secondTitle?.messages.at(-1)).toMatchObject({
      id: 'queued-answer-2',
      content: '第二轮答案',
    });
  });

  it('rejects a send while a waiting_user or queued run owns the conversation', async () => {
    const hook = await connectHook();
    act(() => {
      ports[0]?.emit({
        type: 'run_state',
        runs: [
          {
            runId: 'wait-run',
            requestId: 'wait-run',
            conversationId: 'conversation-1',
            status: 'waiting_user',
            updatedAt: 1,
          },
        ],
      });
    });
    let accepted = true;
    act(() => {
      accepted = hook.result.current.sendChat('授权等待中');
    });
    expect(accepted).toBe(false);
    act(() => {
      ports[0]?.emit({
        type: 'run_state',
        runs: [
          {
            runId: 'queued-run',
            requestId: 'queued-run',
            conversationId: 'conversation-1',
            status: 'queued',
            updatedAt: 1,
          },
        ],
      });
    });
    act(() => {
      accepted = hook.result.current.sendChat('排队中');
    });
    expect(accepted).toBe(false);
    expect(hook.result.current.messages).toEqual([]);
  });

  it('rolls back a steering attempt when the Port refuses to send', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('第一句');
    });
    const port = ports[0];
    if (!port) throw new Error('expected a connected test port');
    port.throwOnPost = true;
    let accepted = true;
    act(() => {
      accepted = hook.result.current.sendChat('第二句');
    });
    expect(accepted).toBe(false);
    expect(port.sent.some(({ type }) => type === 'run:steer')).toBe(false);
    expect(hook.result.current.messages.map(({ content }) => content)).toEqual(['第一句']);
  });

  it('rejects retry when idle, while a run is active, or without a retryable failure', async () => {
    const hook = await connectHook();
    expect(hook.result.current.retryChat()).toBe(false);
    act(() => {
      hook.result.current.sendChat('运行中');
    });
    expect(hook.result.current.retryChat()).toBe(false);
    const chat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!chat) throw new Error('expected chat request');
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: chat.requestId,
        message: {
          id: 'plain-answer',
          role: 'assistant',
          content: '正常完成',
          createdAt: 2,
          status: 'completed',
        },
      });
    });
    expect(hook.result.current.retryChat()).toBe(false);
    act(() => {
      hook.result.current.sendChat('失败轮');
    });
    const secondChat = ports[0]?.sent.filter(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    )[1];
    if (!secondChat) throw new Error('expected second chat');
    act(() => {
      ports[0]?.emit({
        type: 'stream_error',
        requestId: secondChat.requestId,
        message: {
          id: 'non-retryable',
          role: 'assistant',
          content: '部分内容',
          createdAt: 4,
          status: 'error',
          error: true,
          errorMessage: '不可重试',
        },
      });
    });
    expect(hook.result.current.retryChat()).toBe(false);
  });

  it('rejects retry when the only history is a synthesized error without a user turn', async () => {
    dbMocks.loadConversations.mockResolvedValue([conversation()]);
    const hook = await connectHook();
    act(() => {
      ports[0]?.emit({
        type: 'run_state',
        runs: [
          {
            runId: 'stale',
            requestId: 'stale',
            conversationId: 'conversation-1',
            status: 'waiting_user',
            updatedAt: 1,
          },
        ],
      });
    });
    act(() => {
      ports[0]?.emit({ type: 'error', requestId: 'stale', text: '授权已过期' });
    });
    expect(hook.result.current.retryChat()).toBe(false);
  });

  it('rolls back retry state when the Port refuses to send', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('失败后重试');
    });
    const chat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!chat) throw new Error('expected chat request');
    act(() => {
      ports[0]?.emit({
        type: 'stream_error',
        requestId: chat.requestId,
        conversationId: 'conversation-1',
        message: {
          id: 'fail-1',
          role: 'assistant',
          content: '部分内容',
          createdAt: 2,
          status: 'error',
          error: true,
          errorMessage: '网络中断',
          retryable: true,
        },
      });
    });
    const port = ports[0];
    if (!port) throw new Error('expected a connected test port');
    port.throwOnPost = true;
    let accepted = true;
    act(() => {
      accepted = hook.result.current.retryChat();
    });
    expect(accepted).toBe(false);
    expect(hook.result.current.chatRunning).toBe(false);
    expect(port.sent.some(({ type }) => type === 'run:retry')).toBe(false);
  });

  it('cancels through the run ledger when the local active-chat entry is missing', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('先建会话');
    });
    act(() => {
      ports[0]?.emit({
        type: 'run_state',
        runs: [
          {
            runId: 'ledger-run',
            requestId: 'ledger-run',
            conversationId: 'conversation-1',
            status: 'waiting_user',
            updatedAt: 1,
          },
        ],
      });
    });
    act(() => {
      hook.result.current.cancelChat();
    });
    expect(ports[0]?.sent).toContainEqual({
      type: 'cancel',
      scope: 'chat',
      requestId: 'ledger-run',
    });
  });

  it('rejects page permission resolution for an unknown request', async () => {
    const hook = await connectHook();
    let granted = true;
    await act(async () => {
      granted = await hook.result.current.resolvePagePermission(
        'ghost-request',
        'https://example.com/*',
        true,
      );
    });
    expect(granted).toBe(false);
    expect(pageAccessMocks.requestPageOriginAccess).not.toHaveBeenCalled();
  });

  it('surfaces a read-mark persistence failure', async () => {
    dbMocks.loadConversations.mockResolvedValue([conversation({ unread: true })]);
    const hook = await connectHook();
    dbMocks.markConversationRead.mockRejectedValueOnce(new Error('write blocked'));
    act(() => {
      hook.result.current.setViewedConversationId('conversation-1');
    });
    expect(hook.result.current.conversations[0]?.unread).toBe(false);
    await waitFor(() => expect(hook.result.current.historyError).toContain('本地历史记录保存失败'));
  });

  it('treats a null rename result as a failure', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('建会话');
    });
    const conversationId = hook.result.current.activeConversationId;
    if (!conversationId) throw new Error('expected conversation');
    dbMocks.renameConversation.mockResolvedValueOnce(null as never);
    await act(async () => {
      await expect(
        hook.result.current.renameConversationTitle(conversationId, '空结果'),
      ).resolves.toBe(false);
    });
  });

  it('surfaces a history-save failure from the stream persistence path', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('保存失败');
    });
    const chat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!chat) throw new Error('expected chat request');
    dbMocks.saveMessage.mockRejectedValueOnce(new Error('indexeddb full'));
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: chat.requestId,
        message: {
          id: 'save-fail-answer',
          role: 'assistant',
          content: '完成',
          createdAt: 2,
          status: 'completed',
        },
      });
    });
    await waitFor(() => expect(hook.result.current.historyError).toContain('本地历史记录保存失败'));
  });

  it('ignores history loads that resolve after the panel unmounts', async () => {
    let resolveConversations: ((rows: ChatConversation[]) => void) | undefined;
    dbMocks.loadConversations.mockReturnValue(
      new Promise<ChatConversation[]>((resolve) => {
        resolveConversations = resolve;
      }),
    );
    const hook = renderHook(() => useAgentPort());
    hook.unmount();
    await act(async () => {
      resolveConversations?.([conversation()]);
    });
  });

  it('ignores message loads that resolve after the panel unmounts', async () => {
    dbMocks.loadConversations.mockResolvedValue([conversation()]);
    let resolveMessages: ((rows: ChatMessage[]) => void) | undefined;
    dbMocks.loadMessages.mockReturnValue(
      new Promise<ChatMessage[]>((resolve) => {
        resolveMessages = resolve;
      }),
    );
    const hook = renderHook(() => useAgentPort());
    await waitFor(() => expect(dbMocks.loadMessages).toHaveBeenCalled());
    hook.unmount();
    await act(async () => {
      resolveMessages?.([{ id: 'late', role: 'user', content: '晚到', createdAt: 1 }]);
    });
  });

  it('ignores a stream for an unknown request when no conversation is active', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.startNewConversation();
    });
    act(() => {
      ports[0]?.emit({
        type: 'stream_update',
        requestId: 'ghost-request',
        message: {
          id: 'ghost',
          role: 'assistant',
          content: 'x',
          createdAt: 2,
          status: 'streaming',
        },
      });
    });
    expect(hook.result.current.messages).toEqual([]);
    expect(hook.result.current.chatRunning).toBe(false);
  });

  it('ignores messages from a superseded Port after reconnecting', async () => {
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
    act(() => {
      ports[0]?.emit({
        type: 'snapshot',
        snapshot: {
          taskId: 'stale',
          phase: 'idle',
          statusText: '',
          collected: 0,
          assessed: 0,
          jobs: [],
        },
      });
    });
    expect(hook.result.current.snapshot.taskId).toBe('');
  });

  it('buffers streams from a ghost conversation outside the active view', async () => {
    const hook = await connectHook();
    act(() => {
      ports[0]?.emit({
        type: 'stream_update',
        requestId: 'ghost-run',
        conversationId: 'ghost-conv',
        message: {
          id: 'g1',
          role: 'assistant',
          content: '后台流',
          createdAt: 2,
          status: 'streaming',
        },
      });
    });
    expect(hook.result.current.messages).toEqual([]);
    act(() => {
      ports[0]?.emit({
        type: 'stream_end',
        requestId: 'ghost-run',
        conversationId: 'ghost-conv',
        message: {
          id: 'g1',
          role: 'assistant',
          content: '后台流完成',
          createdAt: 2,
          status: 'completed',
        },
      });
    });
    expect(hook.result.current.messages).toEqual([]);
    expect(dbMocks.saveMessage).toHaveBeenCalledWith(
      'ghost-conv',
      expect.objectContaining({ id: 'g1', status: 'completed' }),
      expect.objectContaining({ unread: true }),
    );
  });

  it('surfaces a global error against the active conversation when idle', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('跑一轮');
    });
    act(() => {
      // 权威台账不含本地请求：本地 active 被打断清空，随后无 requestId 的错误落到当前会话
      ports[0]?.emit({
        type: 'run_state',
        runs: [
          {
            runId: 'other-run',
            requestId: 'other-run',
            conversationId: 'conversation-1',
            status: 'running',
            updatedAt: 1,
          },
        ],
      });
      ports[0]?.emit({ type: 'error', text: '后台全局错误' });
    });
    expect(hook.result.current.messages.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'error',
      errorMessage: '后台全局错误',
    });
  });

  it('keeps its own run visible in run_state and finalizes only authoritative terminal states', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('第一轮');
    });
    const firstChat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!firstChat) throw new Error('expected first chat');
    act(() => {
      // 权威台账包含自身仍在运行的 run：不打断
      ports[0]?.emit({
        type: 'run_state',
        runs: [
          {
            runId: 'own-run',
            requestId: firstChat.requestId,
            conversationId: 'conversation-1',
            status: 'running',
            updatedAt: 1,
          },
        ],
      });
    });
    expect(hook.result.current.chatRunning).toBe(true);
    expect(hook.result.current.messages.at(-1)).toMatchObject({ role: 'user' });
    act(() => {
      // 权威台账把该 run 标记为 error：必须打断并落一条错误
      ports[0]?.emit({
        type: 'run_state',
        runs: [
          {
            runId: 'own-run',
            requestId: firstChat.requestId,
            conversationId: 'conversation-1',
            status: 'error',
            updatedAt: 2,
          },
        ],
      });
    });
    expect(hook.result.current.messages.at(-1)).toMatchObject({
      status: 'error',
      errorMessage: expect.stringContaining('生成连接已中断'),
    });
    act(() => {
      hook.result.current.sendChat('第二轮');
    });
    const secondChat = ports[0]?.sent.filter(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    )[1];
    if (!secondChat) throw new Error('expected second chat');
    act(() => {
      ports[0]?.emit({
        type: 'run_state',
        runs: [
          {
            runId: 'r2',
            requestId: secondChat.requestId,
            conversationId: 'conversation-1',
            status: 'interrupted',
            updatedAt: 1,
          },
        ],
      });
    });
    act(() => {
      hook.result.current.sendChat('第三轮');
    });
    const thirdChat = ports[0]?.sent.filter(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    )[2];
    if (!thirdChat) throw new Error('expected third chat');
    act(() => {
      ports[0]?.emit({
        type: 'run_state',
        runs: [
          {
            runId: 'r3',
            requestId: thirdChat.requestId,
            conversationId: 'conversation-1',
            status: 'cancelled',
            updatedAt: 1,
          },
        ],
      });
    });
    expect(hook.result.current.chatRunning).toBe(false);
  });

  it('clears all local run state when the worker reports idle with stale local runs', async () => {
    const hook = await connectHook();
    act(() => {
      hook.result.current.sendChat('hello');
    });
    const chat = ports[0]?.sent.find(
      (message): message is Extract<ClientMessage, { type: 'chat' }> => message.type === 'chat',
    );
    if (!chat) throw new Error('expected chat request');
    act(() => {
      // 让本地 active 指向一条非 assistant 消息：中断函数必须优雅跳过
      ports[0]?.emit({
        type: 'stream_update',
        requestId: chat.requestId,
        message: {
          id: 'echo',
          role: 'user',
          content: '回显',
          createdAt: 2,
          status: 'streaming',
        },
      });
      ports[0]?.emit({ type: 'chat_state', running: false });
    });
    expect(hook.result.current.chatRunning).toBe(false);
    expect(hook.result.current.messages.find(({ id }) => id === 'echo')).toBeDefined();
    expect(hook.result.current.runs).toEqual([]);
  });
});
