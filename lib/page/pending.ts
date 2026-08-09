// ─── MV3 待授权轮次存储 ───
// 职责：用 chrome.storage.session 保存短期、无正文、无密钥的恢复点，跨 Service Worker 回收但不跨浏览器重启。

import type { ChatMessage } from '@/lib/domain/chat';
import type { PageTurnSnapshot } from '@/lib/domain/types';
import type { DeferredGenerationTurn } from '@/lib/generation/manager';

const PENDING_KEY = 'bosspilot_pending_page_turn_v1';
const PENDING_TTL_MS = 10 * 60 * 1_000;

export interface PendingPageTurn {
  version: 1;
  requestId: string;
  status: 'awaiting_permission' | 'resuming';
  generation: DeferredGenerationTurn;
  snapshot: PageTurnSnapshot;
  historyMessageIds: string[];
  expiresAt: number;
}

let mutationQueue: Promise<void> = Promise.resolve();

export function createPendingPageTurn(
  generation: DeferredGenerationTurn,
  snapshot: PageTurnSnapshot,
  history: ChatMessage[],
  now = Date.now(),
): PendingPageTurn {
  return {
    version: 1,
    requestId: generation.requestId,
    status: 'awaiting_permission',
    generation: cloneDeferred(generation),
    snapshot: { ...snapshot },
    historyMessageIds: history.map((message) => message.id),
    expiresAt: now + PENDING_TTL_MS,
  };
}

export async function savePendingPageTurn(turn: PendingPageTurn): Promise<void> {
  await serialized(async () => {
    await chrome.storage.session.set({ [PENDING_KEY]: turn });
  });
}

export async function loadPendingPageTurn(now = Date.now()): Promise<PendingPageTurn | null> {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const parsed = parsePendingPageTurn(stored[PENDING_KEY]);
  if (!parsed) {
    if (stored[PENDING_KEY] !== undefined) await chrome.storage.session.remove(PENDING_KEY);
    return null;
  }
  if (parsed.expiresAt <= now) {
    await chrome.storage.session.remove(PENDING_KEY);
    return null;
  }
  return parsed;
}

/** 单 Worker 内串行领取，配合持久化 resuming 状态抵御重复点击与重复 Port 消息。 */
export async function claimPendingPageTurn(
  requestId: string,
  now = Date.now(),
): Promise<PendingPageTurn | null> {
  let claimed: PendingPageTurn | null = null;
  await serialized(async () => {
    const current = await loadPendingPageTurn(now);
    if (!current || current.requestId !== requestId || current.status !== 'awaiting_permission') {
      return;
    }
    claimed = { ...current, status: 'resuming' };
    await chrome.storage.session.set({ [PENDING_KEY]: claimed });
  });
  return claimed;
}

export async function clearPendingPageTurn(requestId?: string): Promise<void> {
  await serialized(async () => {
    if (requestId) {
      const current = await loadPendingPageTurn();
      if (!current || current.requestId !== requestId) return;
    }
    await chrome.storage.session.remove(PENDING_KEY);
  });
}

export function historyMatchesPending(turn: PendingPageTurn, history: ChatMessage[]): boolean {
  return (
    history.length === turn.historyMessageIds.length &&
    history.every((message, index) => message.id === turn.historyMessageIds[index])
  );
}

async function serialized(operation: () => Promise<void>): Promise<void> {
  const previous = mutationQueue;
  let release: (() => void) | undefined;
  mutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    await operation();
  } finally {
    release?.();
  }
}

function parsePendingPageTurn(value: unknown): PendingPageTurn | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.requestId !== 'string') return null;
  if (value.status !== 'awaiting_permission' && value.status !== 'resuming') return null;
  if (!isSnapshot(value.snapshot) || !isDeferred(value.generation)) return null;
  if (!Array.isArray(value.historyMessageIds) || !value.historyMessageIds.every(isShortString)) {
    return null;
  }
  if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return null;
  return value as unknown as PendingPageTurn;
}

function isSnapshot(value: unknown): value is PageTurnSnapshot {
  return (
    isRecord(value) &&
    typeof value.tabId === 'number' &&
    typeof value.windowId === 'number' &&
    typeof value.url === 'string' &&
    typeof value.origin === 'string' &&
    typeof value.capturedAt === 'number'
  );
}

function isDeferred(value: unknown): value is DeferredGenerationTurn {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isShortString(value.requestId) &&
    isRecord(value.message) &&
    isRecord(value.toolCall) &&
    isRecord(value.targetIdentity) &&
    typeof value.rawContent === 'string' &&
    typeof value.deferredAt === 'number'
  );
}

function cloneDeferred(value: DeferredGenerationTurn): DeferredGenerationTurn {
  return {
    ...value,
    message: {
      ...value.message,
      ...(value.message.modelIdentity ? { modelIdentity: { ...value.message.modelIdentity } } : {}),
      ...(value.message.usage ? { usage: { ...value.message.usage } } : {}),
      ...(value.message.reasoningActivity
        ? { reasoningActivity: { ...value.message.reasoningActivity } }
        : {}),
      ...(value.message.toolActivity ? { toolActivity: { ...value.message.toolActivity } } : {}),
    },
    toolCall: { ...value.toolCall, arguments: { ...value.toolCall.arguments } },
    targetIdentity: { ...value.targetIdentity },
    ...(value.usage ? { usage: { ...value.usage } } : {}),
  };
}

function isShortString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
