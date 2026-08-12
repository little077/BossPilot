import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import type { PageTurnSnapshot } from '@/lib/domain/types';
import type { DeferredGenerationTurn } from '@/lib/generation/manager';
import type { GenerationToolDefinition } from '@/lib/generation/types';
import {
  claimPendingPageTurn,
  clearPendingPageTurn,
  createPendingAgentTurn,
  createPendingPageTurn,
  historyMatchesPending,
  loadPendingPageTurn,
  savePendingPageTurn,
} from './pending';

const get = vi.fn();
const set = vi.fn();
const remove = vi.fn();
let stored: Record<string, unknown>;

const HISTORY: ChatMessage[] = [
  { id: 'user-1', role: 'user', content: '总结当前页', createdAt: 1 },
];
const SNAPSHOT: PageTurnSnapshot = {
  tabId: 7,
  windowId: 3,
  url: 'https://example.com/page',
  safeUrl: 'https://example.com/page',
  origin: 'https://example.com',
  title: 'Example',
  scheme: 'https',
  isHttp: true,
  isBoss: false,
  capturedAt: 1,
};
const DEFERRED: DeferredGenerationTurn = {
  version: 1,
  requestId: 'request-1',
  message: {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    createdAt: 2,
    status: 'streaming',
  },
  rawContent: '',
  toolCall: { id: 'call-1', name: 'read_current_page', arguments: {} },
  targetIdentity: { providerId: 'openai', modelId: 'gpt-test' },
  deferredAt: 2,
};

beforeEach(() => {
  stored = {};
  get.mockReset().mockImplementation(async (key: string) => ({ [key]: stored[key] }));
  set.mockReset().mockImplementation(async (value: Record<string, unknown>) => {
    Object.assign(stored, value);
  });
  remove.mockReset().mockImplementation(async (key: string) => {
    delete stored[key];
  });
  vi.stubGlobal('chrome', { storage: { session: { get, set, remove } } });
});

afterEach(() => vi.unstubAllGlobals());

describe('pending page permission turns', () => {
  it('saves a bounded recovery point and claims it only once', async () => {
    const pending = createPendingPageTurn(DEFERRED, SNAPSHOT, HISTORY, 1_000);
    expect(pending.expiresAt).toBe(601_000);
    await savePendingPageTurn(pending);
    await expect(loadPendingPageTurn(2_000)).resolves.toMatchObject({
      requestId: 'request-1',
      status: 'awaiting_permission',
    });
    await expect(claimPendingPageTurn('request-1', 2_000)).resolves.toMatchObject({
      status: 'resuming',
    });
    await expect(claimPendingPageTurn('request-1', 2_000)).resolves.toBeNull();
  });

  it('expires or removes malformed recovery data', async () => {
    await savePendingPageTurn(createPendingPageTurn(DEFERRED, SNAPSHOT, HISTORY, 1_000));
    await expect(loadPendingPageTurn(700_000)).resolves.toBeNull();
    expect(remove).toHaveBeenCalled();

    stored.bosspilot_pending_agent_turn_v2 = { version: 99 };
    await expect(loadPendingPageTurn()).resolves.toBeNull();

    stored.bosspilot_pending_agent_turn_v2 = {
      ...createPendingPageTurn(DEFERRED, SNAPSHOT, HISTORY),
      historyMessageIds: [''],
    };
    await expect(loadPendingPageTurn()).resolves.toBeNull();
  });

  it('keeps Ask User pauses for the browser session without requiring a page snapshot', async () => {
    const pending = createPendingAgentTurn(DEFERRED, null, HISTORY, 'user_input', 1_000);
    expect(pending).toMatchObject({
      version: 2,
      kind: 'user_input',
      status: 'awaiting_user',
      snapshot: null,
      expiresAt: 86_401_000,
    });
    await savePendingPageTurn(pending);
    await expect(claimPendingPageTurn('request-1', 2_000)).resolves.toMatchObject({
      status: 'resuming',
      kind: 'user_input',
    });
  });

  it('restores version 3 deferred turns with a persisted dynamic prompt snapshot', async () => {
    const pending = createPendingAgentTurn(
      { ...DEFERRED, version: 3, systemPrompt: 'skill catalog snapshot' },
      null,
      HISTORY,
      'user_input',
      1_000,
    );
    await savePendingPageTurn(pending);
    await expect(loadPendingPageTurn(2_000)).resolves.toMatchObject({
      generation: { version: 3, systemPrompt: 'skill catalog snapshot' },
    });
  });

  it('restores version 4 deferred turns with a persisted dynamic tool snapshot', async () => {
    const properties: Record<string, unknown> = {};
    const tools: GenerationToolDefinition[] = [
      {
        name: 'mcp__docs__search',
        label: 'Docs / search',
        description: 'Search docs',
        parameters: { type: 'object', properties, additionalProperties: true },
      },
    ];
    const pending = createPendingAgentTurn(
      { ...DEFERRED, version: 4, systemPrompt: 'context snapshot', tools },
      null,
      HISTORY,
      'user_input',
      1_000,
    );
    await savePendingPageTurn(pending);
    properties.changed = true;
    await expect(loadPendingPageTurn(2_000)).resolves.toMatchObject({
      generation: {
        version: 4,
        systemPrompt: 'context snapshot',
        tools: [{ name: 'mcp__docs__search', parameters: { properties: {} } }],
      },
    });
  });

  it('defensively clones all optional generation snapshots before persistence', () => {
    const enriched: DeferredGenerationTurn = {
      ...DEFERRED,
      message: {
        ...DEFERRED.message,
        modelIdentity: { providerId: 'openai', modelId: 'gpt-test' },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 2,
          cost: 0,
        },
        reasoningActivity: { status: 'completed', summary: '完成', startedAt: 1 },
        toolActivity: {
          callId: 'call-1',
          name: 'read_current_page',
          label: '读取当前页面',
          status: 'waiting_permission',
          statusText: '等待权限',
          startedAt: 1,
        },
      },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 2,
        cost: 0,
      },
    };
    const pending = createPendingPageTurn(enriched, SNAPSHOT, HISTORY);
    if (enriched.message.modelIdentity) enriched.message.modelIdentity.modelId = 'mutated';
    enriched.toolCall.arguments.changed = true;
    expect(pending.generation.message.modelIdentity?.modelId).toBe('gpt-test');
    expect(pending.generation.toolCall.arguments).toEqual({});
    expect(pending.generation.usage).toEqual(enriched.usage);
  });

  it('clears only the requested turn and matches exact history ids', async () => {
    const pending = createPendingPageTurn(DEFERRED, SNAPSHOT, HISTORY);
    await savePendingPageTurn(pending);
    expect(historyMatchesPending(pending, HISTORY)).toBe(true);
    expect(
      historyMatchesPending(pending, [
        { id: 'different-message', role: 'user', content: '总结当前页', createdAt: 1 },
      ]),
    ).toBe(false);
    await clearPendingPageTurn('other-request');
    await expect(loadPendingPageTurn()).resolves.not.toBeNull();
    await clearPendingPageTurn('request-1');
    await expect(loadPendingPageTurn()).resolves.toBeNull();
  });
});
