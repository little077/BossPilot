// ─── MV3 Agent 暂停点存储 ───
// 职责：用 chrome.storage.session 保存权限或 Ask User 恢复点，跨 Service Worker 回收但不跨浏览器重启。

import type { ChatMessage } from '@/lib/domain/chat';
import type { PageTurnSnapshot } from '@/lib/domain/types';
import type { DeferredGenerationTurn } from '@/lib/generation/manager';

const PENDING_KEY = 'bosspilot_pending_agent_turn_v3';
const LEGACY_PENDING_KEY = 'bosspilot_pending_agent_turn_v2';
const PAGE_PERMISSION_TTL_MS = 10 * 60 * 1_000;
const USER_INPUT_TTL_MS = 24 * 60 * 60 * 1_000;

export type PendingAgentKind = 'page_permission' | 'user_input';

export interface PendingPageTurn {
  version: 2;
  requestId: string;
  conversationId?: string;
  kind: PendingAgentKind;
  status: 'awaiting_permission' | 'awaiting_user' | 'resuming';
  generation: DeferredGenerationTurn;
  snapshot: PageTurnSnapshot | null;
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
  return createPendingAgentTurn(generation, snapshot, history, 'page_permission', now);
}

export function createPendingAgentTurn(
  generation: DeferredGenerationTurn,
  snapshot: PageTurnSnapshot | null,
  history: ChatMessage[],
  kind: PendingAgentKind,
  now = Date.now(),
  conversationId?: string,
): PendingPageTurn {
  return {
    version: 2,
    requestId: generation.requestId,
    ...(conversationId ? { conversationId } : {}),
    kind,
    status: kind === 'user_input' ? 'awaiting_user' : 'awaiting_permission',
    generation: cloneDeferred(generation),
    snapshot: snapshot ? { ...snapshot } : null,
    historyMessageIds: history.map((message) => message.id),
    expiresAt: now + (kind === 'user_input' ? USER_INPUT_TTL_MS : PAGE_PERMISSION_TTL_MS),
  };
}

export async function savePendingPageTurn(turn: PendingPageTurn): Promise<void> {
  await serialized(async () => {
    const turns = await readPendingMap();
    turns[turn.requestId] = turn;
    await writePendingMap(turns);
  });
}

export async function loadPendingPageTurn(
  requestIdOrNow?: string | number,
  now = Date.now(),
): Promise<PendingPageTurn | null> {
  const requestId = typeof requestIdOrNow === 'string' ? requestIdOrNow : undefined;
  const currentNow = typeof requestIdOrNow === 'number' ? requestIdOrNow : now;
  const turns = await loadActivePendingMap(currentNow);
  if (requestId) return turns[requestId] ?? null;
  return (
    Object.values(turns).sort(
      (left, right) => right.generation.deferredAt - left.generation.deferredAt,
    )[0] ?? null
  );
}

export async function listPendingPageTurns(now = Date.now()): Promise<PendingPageTurn[]> {
  return Object.values(await loadActivePendingMap(now)).sort(
    (left, right) => left.generation.deferredAt - right.generation.deferredAt,
  );
}

/** 单 Worker 内串行领取，配合持久化 resuming 状态抵御重复点击与重复 Port 消息。 */
export async function claimPendingPageTurn(
  requestId: string,
  now = Date.now(),
): Promise<PendingPageTurn | null> {
  let claimed: PendingPageTurn | null = null;
  await serialized(async () => {
    const current = await loadPendingPageTurn(requestId, now);
    if (
      !current ||
      current.requestId !== requestId ||
      (current.status !== 'awaiting_permission' && current.status !== 'awaiting_user')
    ) {
      return;
    }
    claimed = { ...current, status: 'resuming' };
    const turns = await readPendingMap();
    turns[requestId] = claimed;
    await writePendingMap(turns);
  });
  return claimed;
}

export async function clearPendingPageTurn(requestId?: string): Promise<void> {
  await serialized(async () => {
    if (!requestId) {
      await chrome.storage.session.remove(PENDING_KEY);
      await chrome.storage.session.remove(LEGACY_PENDING_KEY);
      return;
    }
    const turns = await readPendingMap();
    if (!(requestId in turns)) return;
    delete turns[requestId];
    await writePendingMap(turns);
  });
}

async function loadActivePendingMap(now: number): Promise<Record<string, PendingPageTurn>> {
  const turns = await readPendingMap();
  const active = Object.fromEntries(
    Object.entries(turns).filter(([, turn]) => turn.expiresAt > now),
  );
  if (Object.keys(active).length !== Object.keys(turns).length) await writePendingMap(active);
  return active;
}

async function readPendingMap(): Promise<Record<string, PendingPageTurn>> {
  const [currentStored, legacyStored] = await Promise.all([
    chrome.storage.session.get(PENDING_KEY),
    chrome.storage.session.get(LEGACY_PENDING_KEY),
  ]);
  const current = currentStored[PENDING_KEY];
  const turns: Record<string, PendingPageTurn> = {};
  if (isRecord(current) && current.version === 3 && isRecord(current.turns)) {
    for (const [requestId, value] of Object.entries(current.turns)) {
      const parsed = parsePendingPageTurn(value);
      if (parsed && parsed.requestId === requestId) turns[requestId] = parsed;
    }
    return turns;
  }
  const legacy = parsePendingPageTurn(legacyStored[LEGACY_PENDING_KEY]);
  if (legacy) turns[legacy.requestId] = legacy;
  return turns;
}

async function writePendingMap(turns: Record<string, PendingPageTurn>): Promise<void> {
  await chrome.storage.session.set({ [PENDING_KEY]: { version: 3, turns } });
  await chrome.storage.session.remove(LEGACY_PENDING_KEY);
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
  if (!isRecord(value) || value.version !== 2 || typeof value.requestId !== 'string') return null;
  if (value.kind !== 'page_permission' && value.kind !== 'user_input') return null;
  if (
    value.status !== 'awaiting_permission' &&
    value.status !== 'awaiting_user' &&
    value.status !== 'resuming'
  ) {
    return null;
  }
  if ((value.snapshot !== null && !isSnapshot(value.snapshot)) || !isDeferred(value.generation)) {
    return null;
  }
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
    (value.version === 1 ||
      value.version === 2 ||
      value.version === 3 ||
      value.version === 4 ||
      value.version === 5) &&
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
      ...(value.message.attachments
        ? { attachments: value.message.attachments.map((attachment) => ({ ...attachment })) }
        : {}),
      ...(value.message.modelIdentity ? { modelIdentity: { ...value.message.modelIdentity } } : {}),
      ...(value.message.usage ? { usage: { ...value.message.usage } } : {}),
      ...(value.message.reasoningActivity
        ? { reasoningActivity: { ...value.message.reasoningActivity } }
        : {}),
      ...(value.message.toolActivity ? { toolActivity: { ...value.message.toolActivity } } : {}),
      ...(value.message.toolActivities
        ? { toolActivities: value.message.toolActivities.map((activity) => ({ ...activity })) }
        : {}),
      ...(value.message.pendingUserQuestion
        ? {
            pendingUserQuestion: {
              ...value.message.pendingUserQuestion,
              options: value.message.pendingUserQuestion.options.map((option) => ({ ...option })),
            },
          }
        : {}),
    },
    toolCall: { ...value.toolCall, arguments: { ...value.toolCall.arguments } },
    targetIdentity: { ...value.targetIdentity },
    ...(value.usage ? { usage: { ...value.usage } } : {}),
    ...(value.tools
      ? {
          tools: value.tools.map((tool) => ({
            ...tool,
            parameters: {
              ...tool.parameters,
              properties: structuredClone(tool.parameters.properties),
              ...(tool.parameters.required ? { required: [...tool.parameters.required] } : {}),
            },
          })),
        }
      : {}),
    ...(value.loopMessages
      ? {
          loopMessages: value.loopMessages.map((message) =>
            message.role === 'assistant'
              ? {
                  ...message,
                  ...(message.toolCalls
                    ? {
                        toolCalls: message.toolCalls.map((call) => ({
                          ...call,
                          arguments: { ...call.arguments },
                        })),
                      }
                    : {}),
                }
              : { ...message },
          ),
        }
      : {}),
    ...(value.toolCallSignatures ? { toolCallSignatures: [...value.toolCallSignatures] } : {}),
    ...(value.toolAttemptSignatures
      ? { toolAttemptSignatures: [...value.toolAttemptSignatures] }
      : {}),
    ...(value.toolCalls
      ? {
          toolCalls: value.toolCalls.map((call) => ({
            ...call,
            arguments: { ...call.arguments },
          })),
        }
      : {}),
    ...(value.completedToolExecutions
      ? {
          completedToolExecutions: value.completedToolExecutions.map((execution) => ({
            ...execution,
            ...(execution.nextPageSnapshot
              ? { nextPageSnapshot: { ...execution.nextPageSnapshot } }
              : {}),
            ...(execution.pageSnapshots
              ? { pageSnapshots: execution.pageSnapshots.map((item) => ({ ...item })) }
              : {}),
          })),
        }
      : {}),
  };
}

function isShortString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
