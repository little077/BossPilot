// ─── 多会话 Agent 运行注册表 ───
// 职责：限制全局并发、维护 FIFO 队列，并把每个会话绑定到独立生成管理器。

import type { ChatGenerationEvent, ChatGenerationManager } from '@/lib/generation/manager';

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'interrupted';

export interface AgentRunSnapshot {
  runId: string;
  requestId: string;
  conversationId: string;
  status: AgentRunStatus;
  queuePosition?: number;
  startedAt?: number;
  updatedAt: number;
}

export interface RunRegistryStore {
  load(): Promise<AgentRunSnapshot[]>;
  save(runs: AgentRunSnapshot[]): Promise<void>;
}

interface QueuedRun {
  snapshot: AgentRunSnapshot;
  execute: (manager: ChatGenerationManager) => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export type AgentRunRegistryListener = (runs: AgentRunSnapshot[]) => void;

export class AgentRunRegistry {
  private readonly managers = new Map<string, ChatGenerationManager>();
  private readonly runs = new Map<string, AgentRunSnapshot>();
  private readonly queue: QueuedRun[] = [];
  private readonly activeRequestIds = new Set<string>();
  private readonly listeners = new Set<AgentRunRegistryListener>();
  private restored = false;

  constructor(
    private readonly createManager: (
      conversationId: string,
      publish: (event: ChatGenerationEvent) => void,
    ) => ChatGenerationManager,
    private readonly store: RunRegistryStore,
    private readonly maxConcurrent = 2,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('Agent 并发数必须为正整数。');
    }
  }

  async restore(): Promise<AgentRunSnapshot[]> {
    if (this.restored) return this.snapshots();
    const stored = await this.store.load();
    for (const item of stored) {
      const status =
        item.status === 'running' || item.status === 'queued' ? 'interrupted' : item.status;
      this.runs.set(item.requestId, {
        ...item,
        status,
        queuePosition: undefined,
        updatedAt: this.now(),
      });
    }
    this.restored = true;
    await this.persistAndPublish();
    return this.snapshots();
  }

  enqueue(
    conversationId: string,
    requestId: string,
    execute: (manager: ChatGenerationManager) => Promise<void>,
  ): Promise<void> {
    if (
      this.runs.get(requestId)?.status === 'running' ||
      this.queue.some(({ snapshot }) => snapshot.requestId === requestId)
    ) {
      return Promise.reject(new Error('该 Agent 运行已经存在。'));
    }
    const existing = this.runningForConversation(conversationId);
    if (existing && existing.requestId !== requestId) {
      return Promise.reject(new Error('该会话已有 Agent 正在运行。'));
    }

    const snapshot: AgentRunSnapshot = {
      runId: requestId,
      requestId,
      conversationId,
      status: 'queued',
      updatedAt: this.now(),
    };
    this.runs.set(requestId, snapshot);

    const promise = new Promise<void>((resolve, reject) => {
      this.queue.push({ snapshot, execute, resolve, reject });
    });
    this.refreshQueuePositions();
    void this.persistAndPublish();
    this.drain();
    return promise;
  }

  managerForRequest(requestId: string): ChatGenerationManager | undefined {
    const run = this.runs.get(requestId);
    return run ? this.managers.get(run.conversationId) : undefined;
  }

  managerForConversation(conversationId: string): ChatGenerationManager {
    return this.manager(conversationId);
  }

  replayEvents(): Array<{ conversationId: string; event: ChatGenerationEvent }> {
    return [...this.managers.entries()].flatMap(([conversationId, manager]) => {
      const event = manager.getSnapshot();
      return event ? [{ conversationId, event }] : [];
    });
  }

  runningForConversation(conversationId: string): AgentRunSnapshot | undefined {
    return this.snapshots().find(
      (run) =>
        run.conversationId === conversationId &&
        (run.status === 'queued' || run.status === 'running' || run.status === 'waiting_user'),
    );
  }

  stop(requestId: string): boolean {
    const queueIndex = this.queue.findIndex((item) => item.snapshot.requestId === requestId);
    if (queueIndex >= 0) {
      const [item] = this.queue.splice(queueIndex, 1);
      if (!item) return false;
      this.update(requestId, 'cancelled');
      item.resolve();
      this.refreshQueuePositions();
      void this.persistAndPublish();
      return true;
    }
    return this.managerForRequest(requestId)?.stop(requestId) ?? false;
  }

  steer(requestId: string, content: string): boolean {
    return this.managerForRequest(requestId)?.steer(requestId, content) ?? false;
  }

  snapshots(): AgentRunSnapshot[] {
    return [...this.runs.values()]
      .map((item) => ({ ...item }))
      .sort((left, right) => left.updatedAt - right.updatedAt);
  }

  subscribe(listener: AgentRunRegistryListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshots());
    return () => this.listeners.delete(listener);
  }

  clearReplay(conversationId?: string): void {
    if (conversationId) this.managers.get(conversationId)?.clearReplay();
    else for (const manager of this.managers.values()) manager.clearReplay();
  }

  private manager(conversationId: string): ChatGenerationManager {
    const existing = this.managers.get(conversationId);
    if (existing) return existing;
    const manager = this.createManager(conversationId, (event) => this.handleEvent(event));
    this.managers.set(conversationId, manager);
    return manager;
  }

  private drain(): void {
    while (this.activeRequestIds.size < this.maxConcurrent) {
      const item = this.queue.shift();
      if (!item) break;
      const requestId = item.snapshot.requestId;
      this.activeRequestIds.add(requestId);
      this.update(requestId, 'running', { startedAt: this.now(), queuePosition: undefined });
      this.refreshQueuePositions();
      void this.persistAndPublish();
      void item
        .execute(this.manager(item.snapshot.conversationId))
        .then(item.resolve, (error) => {
          this.update(requestId, 'error');
          item.reject(error);
        })
        .finally(() => {
          this.activeRequestIds.delete(requestId);
          const state = this.runs.get(requestId);
          if (state?.status === 'running') this.update(requestId, 'completed');
          void this.persistAndPublish();
          this.drain();
        });
    }
  }

  private handleEvent(event: ChatGenerationEvent): void {
    if (event.type === 'end') {
      this.update(
        event.requestId,
        event.message.status === 'cancelled' ? 'cancelled' : 'completed',
      );
    } else if (event.type === 'error') {
      this.update(event.requestId, event.message.status === 'cancelled' ? 'cancelled' : 'error');
    } else if (
      event.message.pendingUserQuestion ||
      event.message.toolActivity?.status === 'waiting_permission'
    ) {
      this.update(event.requestId, 'waiting_user');
    } else {
      this.update(event.requestId, 'running');
    }
    void this.persistAndPublish();
  }

  private update(
    requestId: string,
    status: AgentRunStatus,
    fields: Partial<Pick<AgentRunSnapshot, 'queuePosition' | 'startedAt'>> = {},
  ): void {
    const current = this.runs.get(requestId);
    if (!current) return;
    this.runs.set(requestId, { ...current, ...fields, status, updatedAt: this.now() });
  }

  private refreshQueuePositions(): void {
    this.queue.forEach((item, index) => {
      item.snapshot = {
        ...item.snapshot,
        status: 'queued',
        queuePosition: index + 1,
        updatedAt: this.now(),
      };
      this.runs.set(item.snapshot.requestId, item.snapshot);
    });
  }

  private async persistAndPublish(): Promise<void> {
    const snapshots = this.snapshots();
    await this.store.save(snapshots).catch(() => void 0);
    for (const listener of this.listeners) listener(snapshots.map((item) => ({ ...item })));
  }
}

const RUNS_KEY = 'bosspilot_agent_runs_v1';

export function createChromeRunRegistryStore(): RunRegistryStore {
  return {
    async load() {
      const stored = await chrome.storage.session.get(RUNS_KEY);
      return parseRunSnapshots(stored[RUNS_KEY]);
    },
    async save(runs) {
      await chrome.storage.session.set({ [RUNS_KEY]: runs });
    },
  };
}

function parseRunSnapshots(value: unknown): AgentRunSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.requestId !== 'string' ||
      typeof item.conversationId !== 'string'
    )
      return [];
    if (
      ![
        'queued',
        'running',
        'waiting_user',
        'completed',
        'cancelled',
        'error',
        'interrupted',
      ].includes(String(item.status))
    )
      return [];
    return [
      {
        runId: typeof item.runId === 'string' ? item.runId : item.requestId,
        requestId: item.requestId,
        conversationId: item.conversationId,
        status: item.status as AgentRunStatus,
        ...(typeof item.queuePosition === 'number' ? { queuePosition: item.queuePosition } : {}),
        ...(typeof item.startedAt === 'number' ? { startedAt: item.startedAt } : {}),
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
