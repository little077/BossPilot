import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import {
  conversationExcerpt,
  generateConversationTitle,
  normalizeGeneratedTitle,
} from '@/lib/generation/conversation-title';
import type {
  GenerationAdapter,
  GenerationEvent,
  ResolvedGenerationTarget,
} from '@/lib/generation/types';

const target: ResolvedGenerationTarget = {
  identity: { providerId: 'deepseek', modelId: 'deepseek-chat' },
  providerLabel: 'DeepSeek',
  modelName: 'DeepSeek Chat',
  protocol: 'openai-completions',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'secret',
};

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: ' 帮我总结当前网页 ', createdAt: 1 },
  { id: 'a1', role: 'assistant', content: '这是网页摘要。', createdAt: 2, status: 'completed' },
];

function adapterWith(events: GenerationEvent[]): GenerationAdapter {
  return {
    async *stream() {
      for (const event of events) yield event;
    },
  };
}

describe('conversation title generation', () => {
  it('sends a bounded transcript and normalizes the streamed title', async () => {
    let source = '';
    const adapter: GenerationAdapter = {
      async *stream(_target, request) {
        source = String(request.messages[0]?.content ?? '');
        yield { type: 'start' };
        yield { type: 'text-delta', delta: '标题：“当前网页' };
        yield { type: 'text-delta', delta: '摘要。”' };
        yield {
          type: 'finish',
          reason: 'stop',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 15,
            cost: 0,
          },
        };
      },
    };

    await expect(
      generateConversationTitle(adapter, target, messages, new AbortController().signal, 3),
    ).resolves.toBe('当前网页摘要');
    expect(source).toContain('用户：帮我总结当前网页');
    expect(source).toContain('助手：这是网页摘要。');
  });

  it('filters unusable messages and bounds long source content', () => {
    const transcript = conversationExcerpt([
      {
        id: 'streaming',
        role: 'assistant',
        content: '不能进入标题上下文',
        createdAt: 1,
        status: 'streaming',
      },
      {
        id: 'error',
        role: 'assistant',
        content: '错误内容',
        createdAt: 2,
        status: 'error',
        error: true,
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: String(index),
        role: 'user' as const,
        content: `第${index}条${'内容'.repeat(600)}`,
        createdAt: index + 3,
      })),
    ]);

    expect(transcript).not.toContain('不能进入标题上下文');
    expect(transcript).not.toContain('第0条');
    expect(transcript.length).toBeLessThanOrEqual(6_000);
  });

  it('rejects empty output, tool calls, cancelled generations, and excessive output', async () => {
    const signal = new AbortController().signal;
    await expect(
      generateConversationTitle(
        adapterWith([
          {
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
          },
        ]),
        target,
        messages,
        signal,
      ),
    ).rejects.toThrow('有效的会话标题');
    await expect(
      generateConversationTitle(
        adapterWith([
          { type: 'tool-call', toolCall: { id: 'tool', name: 'read_current_page', arguments: {} } },
        ]),
        target,
        messages,
        signal,
      ),
    ).rejects.toThrow('不允许调用工具');
    await expect(
      generateConversationTitle(
        adapterWith([
          {
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
          },
        ]),
        target,
        messages,
        signal,
      ),
    ).rejects.toThrow('已中断');
    await expect(
      generateConversationTitle(
        adapterWith([{ type: 'text-delta', delta: '很'.repeat(201) }]),
        target,
        messages,
        signal,
      ),
    ).rejects.toThrow('过长');
  });

  it('rejects a conversation without usable content and clips normalized titles', async () => {
    await expect(
      generateConversationTitle(
        adapterWith([]),
        target,
        [{ id: 'empty', role: 'user', content: '  ', createdAt: 1 }],
        new AbortController().signal,
      ),
    ).rejects.toThrow('没有可用于生成标题的内容');
    expect(normalizeGeneratedTitle(`  标题：${'长'.repeat(40)}！ `)).toBe('长'.repeat(30));
  });
});
