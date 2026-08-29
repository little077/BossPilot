import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import { summarizeAgentRun } from './run-summary';

describe('summarizeAgentRun', () => {
  it('summarizes model, token, duration, and tool outcomes', () => {
    const message: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'done',
      createdAt: 1,
      status: 'completed',
      modelIdentity: { providerId: 'openai', modelId: 'gpt-test' },
      reasoningActivity: {
        status: 'completed',
        summary: 'plan',
        startedAt: 1_000,
        finishedAt: 1_200,
      },
      toolActivities: [
        {
          callId: 'c1',
          name: 'read_current_page',
          label: 'Read',
          status: 'succeeded',
          statusText: 'Done',
          startedAt: 1_300,
          finishedAt: 1_800,
        },
        {
          callId: 'c2',
          name: 'browser_action',
          label: 'Act',
          status: 'failed',
          statusText: 'Failed',
          startedAt: 1_900,
          finishedAt: 2_000,
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        cost: 0.01,
      },
    };
    expect(summarizeAgentRun(message)).toEqual({
      status: 'completed',
      model: 'openai / gpt-test',
      toolCalls: 2,
      succeededTools: 1,
      failedTools: 1,
      durationMs: 1_000,
      totalTokens: 15,
      cost: 0.01,
    });
  });

  it('returns null for messages without run metadata and supports legacy snapshots', () => {
    expect(summarizeAgentRun({ id: 'u1', role: 'user', content: 'hi', createdAt: 1 })).toBeNull();
    expect(
      summarizeAgentRun({ id: 'a1', role: 'assistant', content: 'hi', createdAt: 1 }),
    ).toBeNull();
    expect(
      summarizeAgentRun({
        id: 'a2',
        role: 'assistant',
        content: '',
        createdAt: 1,
        error: true,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          cost: 0,
        },
      }),
    ).toMatchObject({ status: 'error', model: expect.stringContaining('旧记录') });
    expect(
      summarizeAgentRun({
        id: 'a3',
        role: 'assistant',
        content: '',
        createdAt: 1,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          cost: 0,
        },
      }),
    ).toMatchObject({ status: 'completed', model: expect.stringContaining('旧记录') });
  });
});
