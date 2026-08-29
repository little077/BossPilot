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
  listPendingPageTurns,
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

  it('restores version 5 deferred turns with a persisted tool batch', async () => {
    const pending = createPendingAgentTurn(
      {
        ...DEFERRED,
        version: 5,
        systemPrompt: 'context snapshot',
        toolCalls: [
          { id: 'call-1', name: 'read_current_page', arguments: {} },
          { id: 'call-2', name: 'inspect_page', arguments: { scope: 'viewport' } },
        ],
        toolCallIndex: 1,
        completedToolExecutions: [
          {
            isError: false,
            statusText: '读取完成',
            detail: '正文',
            content: '页面正文',
          },
        ],
      },
      null,
      HISTORY,
      'user_input',
      1_000,
    );
    await savePendingPageTurn(pending);
    await expect(loadPendingPageTurn(2_000)).resolves.toMatchObject({
      generation: {
        version: 5,
        toolCallIndex: 1,
        toolCalls: [
          { id: 'call-1', name: 'read_current_page', arguments: {} },
          { id: 'call-2', name: 'inspect_page', arguments: { scope: 'viewport' } },
        ],
        completedToolExecutions: [{ isError: false, statusText: '读取完成', content: '页面正文' }],
      },
    });
  });

  it('defensively clones all optional generation snapshots before persistence', () => {
    const enriched: DeferredGenerationTurn = {
      ...DEFERRED,
      message: {
        ...DEFERRED.message,
        attachments: [
          {
            id: 'attachment-1',
            kind: 'text',
            name: 'note.txt',
            mimeType: 'text/plain',
            size: 4,
            content: 'note',
          },
        ],
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
        toolActivities: [
          {
            callId: 'call-1',
            name: 'read_current_page',
            label: '读取当前页面',
            status: 'waiting_permission',
            statusText: '等待权限',
            startedAt: 1,
          },
        ],
        pendingUserQuestion: {
          requestId: 'request-1',
          callId: 'call-1',
          question: '继续吗？',
          options: [{ id: 'yes', label: '继续' }],
          allowCustom: true,
          customPlaceholder: '补充说明',
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
      loopMessages: [
        { role: 'user', content: '问题', createdAt: 1 },
        {
          role: 'assistant',
          content: '',
          createdAt: 2,
          toolCalls: [{ id: 'call-1', name: 'read_current_page', arguments: {} }],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read_current_page',
          content: '结果',
          isError: false,
          createdAt: 3,
        },
      ],
      toolCallSignatures: ['read_current_page:{}'],
      toolAttemptSignatures: ['attempt-1'],
      toolCalls: [
        { id: 'call-1', name: 'read_current_page', arguments: {} },
        { id: 'call-2', name: 'inspect_page', arguments: { scope: 'viewport' } },
      ],
      toolCallIndex: 1,
      completedToolExecutions: [
        {
          isError: false,
          statusText: '读取完成',
          content: '页面正文',
          nextPageSnapshot: SNAPSHOT,
        },
      ],
    };
    const pending = createPendingPageTurn(enriched, SNAPSHOT, HISTORY);
    if (enriched.message.modelIdentity) enriched.message.modelIdentity.modelId = 'mutated';
    enriched.toolCall.arguments.changed = true;
    enriched.message.attachments?.splice(0);
    enriched.message.toolActivities?.splice(0);
    enriched.message.pendingUserQuestion?.options.splice(0);
    enriched.loopMessages?.splice(0);
    enriched.toolCallSignatures?.push('mutated');
    enriched.toolAttemptSignatures?.push('mutated');
    enriched.toolCalls?.splice(0);
    enriched.toolCallIndex = 99;
    if (enriched.completedToolExecutions) {
      enriched.completedToolExecutions.splice(0);
    }
    expect(pending.generation.message.modelIdentity?.modelId).toBe('gpt-test');
    expect(pending.generation.toolCall.arguments).toEqual({});
    expect(pending.generation.usage).toEqual(enriched.usage);
    expect(pending.generation.message.attachments).toHaveLength(1);
    expect(pending.generation.message.toolActivities).toHaveLength(1);
    expect(pending.generation.message.pendingUserQuestion?.options).toHaveLength(1);
    expect(pending.generation.loopMessages).toHaveLength(3);
    expect(pending.generation.toolCallSignatures).toEqual(['read_current_page:{}']);
    expect(pending.generation.toolAttemptSignatures).toEqual(['attempt-1']);
    expect(pending.generation.toolCalls).toEqual([
      { id: 'call-1', name: 'read_current_page', arguments: {} },
      { id: 'call-2', name: 'inspect_page', arguments: { scope: 'viewport' } },
    ]);
    expect(pending.generation.toolCallIndex).toBe(1);
    expect(pending.generation.completedToolExecutions).toEqual([
      {
        isError: false,
        statusText: '读取完成',
        content: '页面正文',
        nextPageSnapshot: SNAPSHOT,
      },
    ]);
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

  it('stores independent pending turns for two conversations and prunes only expired entries', async () => {
    const first = createPendingAgentTurn(
      DEFERRED,
      null,
      HISTORY,
      'user_input',
      1_000,
      'conversation-a',
    );
    const second = createPendingAgentTurn(
      { ...DEFERRED, requestId: 'request-2', deferredAt: 3 },
      SNAPSHOT,
      HISTORY,
      'page_permission',
      2_000,
      'conversation-b',
    );
    await savePendingPageTurn(first);
    await savePendingPageTurn(second);

    expect(await listPendingPageTurns(3_000)).toEqual([
      expect.objectContaining({ requestId: 'request-1', conversationId: 'conversation-a' }),
      expect.objectContaining({ requestId: 'request-2', conversationId: 'conversation-b' }),
    ]);
    expect(await loadPendingPageTurn('request-2', 3_000)).toMatchObject({
      conversationId: 'conversation-b',
    });
    await clearPendingPageTurn('request-1');
    expect(await listPendingPageTurns(3_000)).toEqual([
      expect.objectContaining({ requestId: 'request-2' }),
    ]);
    expect(await listPendingPageTurns(700_000)).toEqual([]);
    await clearPendingPageTurn();
  });
});
