import { describe, expect, it, vi } from 'vitest';
import type { ChatGenerationEvent, ChatGenerationManager } from '@/lib/generation/manager';
import {
  AgentRunRegistry,
  type AgentRunSnapshot,
  createChromeRunRegistryStore,
  type RunRegistryStore,
} from './registry';

interface FakeManager {
  stop: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  clearReplay: ReturnType<typeof vi.fn>;
  getSnapshot: ReturnType<typeof vi.fn>;
  publish: (event: ChatGenerationEvent) => void;
}

function deferred() {
  let resolve: () => void = () => void 0;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function store(initial: AgentRunSnapshot[] = []): RunRegistryStore {
  let value = initial;
  return {
    load: vi.fn(async () => value),
    save: vi.fn(async (next) => {
      value = structuredClone(next);
    }),
  };
}

function managerFactory() {
  const managers = new Map<string, FakeManager>();
  const create = vi.fn((conversationId: string, publish: (event: ChatGenerationEvent) => void) => {
    const manager = {
      stop: vi.fn(() => true),
      steer: vi.fn(() => true),
      clearReplay: vi.fn(),
      getSnapshot: vi.fn(() => null),
      publish,
    } satisfies FakeManager;
    managers.set(conversationId, manager);
    return manager as unknown as ChatGenerationManager;
  });
  return { create, managers };
}

describe('AgentRunRegistry', () => {
  it('runs two conversations and queues the third in FIFO order', async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const factory = managerFactory();
    const registry = new AgentRunRegistry(factory.create, store(), 2, () => 10);
    const a = registry.enqueue('a', 'run-a', async () => first.promise);
    const b = registry.enqueue('b', 'run-b', async () => second.promise);
    const c = registry.enqueue('c', 'run-c', async () => third.promise);
    await Promise.resolve();

    expect(registry.snapshots()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: 'run-a', status: 'running' }),
        expect.objectContaining({ requestId: 'run-b', status: 'running' }),
        expect.objectContaining({ requestId: 'run-c', status: 'queued', queuePosition: 1 }),
      ]),
    );
    first.resolve();
    await a;
    await Promise.resolve();
    expect(factory.create).toHaveBeenCalledWith('c', expect.any(Function));
    second.resolve();
    third.resolve();
    await Promise.all([b, c]);
  });

  it('cancels queued work and routes steering to the exact running conversation', async () => {
    const first = deferred();
    const factory = managerFactory();
    const registry = new AgentRunRegistry(factory.create, store(), 1);
    const a = registry.enqueue('a', 'run-a', async () => first.promise);
    const b = registry.enqueue('b', 'run-b', async () => void 0);
    await Promise.resolve();
    expect(registry.stop('run-b')).toBe(true);
    await b;
    expect(registry.steer('run-a', '调整条件')).toBe(true);
    expect(factory.managers.get('a')?.steer).toHaveBeenCalledWith('run-a', '调整条件');
    first.resolve();
    await a;
  });

  it('marks in-flight and queued persisted runs interrupted after recovery', async () => {
    const factory = managerFactory();
    const registry = new AgentRunRegistry(
      factory.create,
      store([
        {
          runId: 'run-a',
          requestId: 'run-a',
          conversationId: 'a',
          status: 'running',
          updatedAt: 1,
        },
        {
          runId: 'run-b',
          requestId: 'run-b',
          conversationId: 'b',
          status: 'queued',
          updatedAt: 2,
        },
      ]),
      2,
      () => 20,
    );
    await registry.restore();
    await registry.restore();
    expect(registry.snapshots().map(({ status }) => status)).toEqual([
      'interrupted',
      'interrupted',
    ]);
  });

  it('rejects invalid concurrency, duplicate runs, and another run in one conversation', async () => {
    const factory = managerFactory();
    expect(() => new AgentRunRegistry(factory.create, store(), 0)).toThrow('并发数');
    const hold = deferred();
    const registry = new AgentRunRegistry(factory.create, store(), 1);
    const running = registry.enqueue('a', 'run-a', async () => hold.promise);
    await Promise.resolve();
    await expect(registry.enqueue('a', 'run-a', async () => void 0)).rejects.toThrow('已经存在');
    await expect(registry.enqueue('a', 'run-b', async () => void 0)).rejects.toThrow('该会话');
    const queued = registry.enqueue('b', 'run-queued', async () => void 0);
    await expect(registry.enqueue('b', 'run-queued', async () => void 0)).rejects.toThrow();
    expect(registry.stop('run-queued')).toBe(true);
    await queued;
    expect(registry.stop('missing')).toBe(false);
    expect(registry.steer('missing', 'x')).toBe(false);
    hold.resolve();
    await running;
  });

  it('publishes statuses, exposes replay, clears managers, stops active work, and records failure', async () => {
    const factory = managerFactory();
    const registry = new AgentRunRegistry(factory.create, store(), 2, () => 30);
    const seen: AgentRunSnapshot[][] = [];
    const unsubscribe = registry.subscribe((runs) => seen.push(runs));
    const gate = deferred();
    const task = registry.enqueue('a', 'run-a', async () => gate.promise);
    await Promise.resolve();
    const manager = factory.managers.get('a');
    const streamingMessage = {
      id: 'assistant-1',
      role: 'assistant' as const,
      content: '',
      createdAt: 1,
      status: 'streaming' as const,
    };
    manager?.publish({ type: 'update', requestId: 'run-a', message: streamingMessage });
    expect(registry.runningForConversation('a')).toMatchObject({ status: 'running' });
    manager?.publish({
      type: 'update',
      requestId: 'run-a',
      message: {
        ...streamingMessage,
        toolActivity: {
          callId: 'call-permission',
          name: 'read_current_page',
          label: '读取页面',
          status: 'waiting_permission',
          statusText: '等待权限',
          startedAt: 1,
        },
      },
    });
    manager?.publish({
      type: 'update',
      requestId: 'run-a',
      message: {
        ...streamingMessage,
        pendingUserQuestion: {
          requestId: 'run-a',
          callId: 'call-1',
          question: '继续吗？',
          options: [],
          allowCustom: true,
        },
      },
    });
    expect(registry.runningForConversation('a')).toMatchObject({ status: 'waiting_user' });
    manager?.getSnapshot.mockReturnValue({
      type: 'update',
      requestId: 'run-a',
      message: streamingMessage,
    });
    expect(registry.replayEvents()).toEqual([
      { conversationId: 'a', event: expect.objectContaining({ requestId: 'run-a' }) },
    ]);
    registry.clearReplay('a');
    registry.clearReplay();
    expect(manager?.clearReplay).toHaveBeenCalledTimes(2);
    expect(registry.stop('run-a')).toBe(true);
    manager?.publish({
      type: 'error',
      requestId: 'run-a',
      message: { ...streamingMessage, status: 'error', error: true },
    });
    gate.resolve();
    await task;
    unsubscribe();
    expect(seen.length).toBeGreaterThan(2);

    await expect(
      registry.enqueue('b', 'run-fail', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(registry.snapshots()).toEqual(
      expect.arrayContaining([expect.objectContaining({ requestId: 'run-fail', status: 'error' })]),
    );
  });

  it('maps completed and cancelled terminal generation events', async () => {
    const factory = managerFactory();
    const registry = new AgentRunRegistry(factory.create, store(), 2);
    const first = deferred();
    const second = deferred();
    const a = registry.enqueue('a', 'run-a', async () => first.promise);
    const b = registry.enqueue('b', 'run-b', async () => second.promise);
    await Promise.resolve();
    const message = {
      id: 'assistant',
      role: 'assistant' as const,
      content: 'done',
      createdAt: 1,
      status: 'completed' as const,
    };
    factory.managers.get('a')?.publish({ type: 'end', requestId: 'run-a', message });
    factory.managers.get('b')?.publish({
      type: 'error',
      requestId: 'run-b',
      message: { ...message, status: 'cancelled' },
    });
    expect(registry.snapshots()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: 'run-a', status: 'completed' }),
        expect.objectContaining({ requestId: 'run-b', status: 'cancelled' }),
      ]),
    );
    first.resolve();
    second.resolve();
    await Promise.all([a, b]);
  });

  it('round-trips sanitized run state through chrome.storage.session', async () => {
    let stored: unknown;
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          get: vi.fn(async () => ({ bosspilot_agent_runs_v1: stored })),
          set: vi.fn(async (value: Record<string, unknown>) => {
            stored = value.bosspilot_agent_runs_v1;
          }),
        },
      },
    });
    const chromeStore = createChromeRunRegistryStore();
    await chromeStore.save([
      {
        runId: 'run-1',
        requestId: 'run-1',
        conversationId: 'conversation-1',
        status: 'queued',
        queuePosition: 2,
        startedAt: 1,
        updatedAt: 2,
      },
    ]);
    expect(await chromeStore.load()).toEqual([
      expect.objectContaining({ requestId: 'run-1', queuePosition: 2, startedAt: 1 }),
    ]);
    stored = [null, { requestId: '', conversationId: 'x', status: 'bad' }];
    expect(await chromeStore.load()).toEqual([]);
    stored = {
      requestId: 'not-an-array',
    };
    expect(await chromeStore.load()).toEqual([]);
    stored = [
      {
        requestId: 'legacy-run',
        conversationId: 'legacy-conversation',
        status: 'interrupted',
      },
    ];
    expect(await chromeStore.load()).toEqual([
      expect.objectContaining({
        runId: 'legacy-run',
        requestId: 'legacy-run',
        status: 'interrupted',
        updatedAt: expect.any(Number),
      }),
    ]);
    vi.unstubAllGlobals();
  });

  it('reuses one generation manager per conversation', () => {
    const factory = managerFactory();
    const registry = new AgentRunRegistry(factory.create, store());
    const first = registry.managerForConversation('conversation-a');
    const second = registry.managerForConversation('conversation-a');
    expect(first).toBe(second);
    expect(factory.create).toHaveBeenCalledTimes(1);
  });
});
