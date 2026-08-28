import { describe, expect, it } from 'vitest';
import type { GenerationAdapter, GenerationInputMessage } from '@/lib/generation/types';
import {
  compactGenerationContext,
  estimateGenerationTokens,
  findCompactionCutPoint,
} from './compaction';

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
    expect(
      estimateGenerationTokens([
        {
          role: 'assistant',
          content: '',
          createdAt: 1,
          toolCalls: [
            { id: 'call-1', name: 'observe_page', arguments: { query: 'x'.repeat(400) } },
          ],
        },
      ]),
    ).toBeGreaterThan(100);
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

  it('moves the cut point before an assistant tool call instead of orphaning its result', async () => {
    const messages: GenerationInputMessage[] = [
      { role: 'user', content: '最初目标', createdAt: 0 },
      { role: 'assistant', content: '准备', createdAt: 1 },
      { role: 'user', content: '继续', createdAt: 2 },
      {
        role: 'assistant',
        content: '',
        createdAt: 3,
        toolCalls: [{ id: 'call-1', name: 'observe_page', arguments: { query: '报告' } }],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'observe_page',
        content: '找到报告按钮',
        isError: false,
        createdAt: 4,
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        role: 'assistant' as const,
        content: `后续 ${index}`,
        createdAt: index + 5,
      })),
    ];
    expect(findCompactionCutPoint(messages)).toBe(3);

    let summaryInput = '';
    const adapter: GenerationAdapter = {
      async *stream(_target, request) {
        summaryInput = request.messages[0]?.content ?? '';
        yield { type: 'text-delta', delta: '保留工具进度' };
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
    const toolCallIndex = compacted.findIndex(
      (message) => message.role === 'assistant' && message.toolCalls?.[0]?.id === 'call-1',
    );
    expect(toolCallIndex).toBeGreaterThan(0);
    expect(compacted[toolCallIndex + 1]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
    });
    expect(summaryInput).toContain('role: user');
  });

  it('includes old tool metadata and image counts in the untrusted summary transcript', async () => {
    const messages: GenerationInputMessage[] = [
      { role: 'user', content: '目标', createdAt: 0 },
      {
        role: 'assistant',
        content: '',
        createdAt: 1,
        toolCalls: [{ id: 'old-call', name: 'tab', arguments: { note: 'x'.repeat(8_100) } }],
      },
      {
        role: 'toolResult',
        toolCallId: 'old-call',
        toolName: 'tab',
        content: '已切换',
        isError: false,
        createdAt: 2,
        images: [{ data: 'abc', mimeType: 'image/png' }],
      },
      { role: 'assistant', content: '过渡', createdAt: 3 },
      { role: 'user', content: '新阶段', createdAt: 4 },
      ...Array.from({ length: 7 }, (_, index) => ({
        role: 'assistant' as const,
        content: `消息 ${index}`,
        createdAt: index + 5,
      })),
    ];
    let transcript = '';
    const adapter: GenerationAdapter = {
      async *stream(_target, request) {
        transcript = request.messages[0]?.content ?? '';
        yield { type: 'text-delta', delta: '摘要' };
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
    await compactGenerationContext(adapter, target, messages, new AbortController().signal);
    expect(transcript).toContain('toolCalls:');
    expect(transcript).toContain('toolCallId: old-call');
    expect(transcript).toContain('toolName: tab');
    expect(transcript).toContain('images: 1');
  });

  it('skips an orphan tool result at the desired cut and recognizes a recent first user', () => {
    const orphaned: GenerationInputMessage[] = [
      ...Array.from({ length: 4 }, (_, index) => ({
        role: 'assistant' as const,
        content: `旧 ${index}`,
        createdAt: index,
      })),
      {
        role: 'toolResult',
        toolCallId: 'missing',
        toolName: 'tab',
        content: '孤立结果',
        isError: true,
        createdAt: 4,
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        role: 'assistant' as const,
        content: `新 ${index}`,
        createdAt: index + 5,
      })),
    ];
    expect(findCompactionCutPoint(orphaned)).toBe(5);

    const recentGoal = [...orphaned];
    recentGoal[4] = { role: 'user', content: '第一个用户目标', createdAt: 4 };
    expect(findCompactionCutPoint(recentGoal)).toBe(4);
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
