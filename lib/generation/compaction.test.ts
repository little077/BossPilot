import { describe, expect, it } from 'vitest';
import type { GenerationAdapter, GenerationInputMessage } from '@/lib/generation/types';
import { compactGenerationContext, estimateGenerationTokens } from './compaction';

const target = {
  identity: { providerId: 'test', modelId: 'test' },
  providerLabel: 'Test',
  modelName: 'Test',
  protocol: 'openai-completions' as const,
  baseUrl: 'https://example.test',
  apiKey: 'secret',
};

describe('context compaction', () => {
  it('estimates text and image context conservatively', () => {
    expect(
      estimateGenerationTokens([
        {
          role: 'user',
          content: 'x'.repeat(400),
          createdAt: 1,
          images: [{ data: 'x', mimeType: 'image/png' }],
        },
      ]),
    ).toBeGreaterThan(1_100);
  });

  it('preserves the first goal and recent eight messages around a structured summary', async () => {
    const messages: GenerationInputMessage[] = Array.from({ length: 12 }, (_, index) => ({
      role: 'user' as const,
      content: index === 0 ? '最初目标' : `消息 ${index}`,
      createdAt: index,
    }));
    const adapter: GenerationAdapter = {
      async *stream() {
        yield { type: 'text-delta', delta: '- 已完成：读取页面\n- 未完成：生成报告' };
        yield {
          type: 'finish',
          reason: 'stop',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 2,
            cost: 0,
          },
        };
      },
    };

    const compacted = await compactGenerationContext(
      adapter,
      target,
      messages,
      new AbortController().signal,
    );

    expect(compacted[0]).toMatchObject({ role: 'user', content: '最初目标' });
    expect(compacted[1]?.content).toContain('<compacted_context>');
    expect(compacted.slice(-8)).toEqual(messages.slice(-8));
  });

  it('keeps short histories unchanged and surfaces empty or failed summaries as retryable errors', async () => {
    const short: GenerationInputMessage[] = [{ role: 'user', content: '短对话', createdAt: 1 }];
    const unused: GenerationAdapter = {
      async *stream() {
        yield { type: 'start' } as const;
        throw new Error('should not run');
      },
    };
    await expect(
      compactGenerationContext(unused, target, short, new AbortController().signal),
    ).resolves.toBe(short);

    const long = Array.from({ length: 10 }, (_, index) => ({
      role: 'user' as const,
      content: `消息 ${index}`,
      createdAt: index,
    }));
    const empty: GenerationAdapter = {
      async *stream() {
        yield {
          type: 'finish',
          reason: 'stop',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            cost: 0,
          },
        };
      },
    };
    await expect(
      compactGenerationContext(empty, target, long, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: true });

    const failed: GenerationAdapter = {
      async *stream() {
        yield { type: 'start' } as const;
        throw new Error('offline');
      },
    };
    await expect(
      compactGenerationContext(failed, target, long, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: true });

    const cancelled: GenerationAdapter = {
      async *stream() {
        yield {
          type: 'finish',
          reason: 'cancelled',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            cost: 0,
          },
        };
      },
    };
    await expect(
      compactGenerationContext(cancelled, target, long, new AbortController().signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
