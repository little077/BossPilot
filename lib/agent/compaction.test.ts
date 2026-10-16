// ─── 上下文压缩单测 ───
// mock db.compact 为内存单行，验证：水位触发条件、直通与分段边界、摘要提示结构、
// 增量复用缓存（不重算）、reactive 只重试一次。summarize 全部用桩、不触真模型。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import type { CompactRow } from './compaction';
import {
  buildSummaryPrompt,
  COMPACT_WATERLINE,
  clearCompact,
  compactHistory,
  isContextLengthError,
  KEEP_RECENT,
  needsCompaction,
  REACTIVE_KEEP,
  trimForRetry,
  withReactiveRetry,
} from './compaction';

const fake = vi.hoisted(() => {
  let row: CompactRow | undefined;
  const compact = {
    get: vi.fn(async (_id: string) => row),
    put: vi.fn(async (next: CompactRow) => {
      row = next;
    }),
    clear: vi.fn(async () => {
      row = undefined;
    }),
  };
  return {
    compact,
    get current() {
      return row;
    },
  };
});

vi.mock('@/lib/storage/db', () => ({ db: { compact: fake.compact } }));

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: crypto.randomUUID(), role, content, createdAt: Date.now() };
}

function history(count: number): ChatMessage[] {
  const list: ChatMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    list.push(msg(i % 2 === 0 ? 'user' : 'assistant', `消息 ${i}`));
  }
  return list;
}

beforeEach(() => {
  fake.compact.clear.mockClear();
  fake.compact.get.mockClear();
  fake.compact.put.mockClear();
  void fake.compact.clear();
});

describe('needsCompaction', () => {
  it('开启且超水位才触发', () => {
    expect(needsCompaction(COMPACT_WATERLINE + 1, true)).toBe(true);
    expect(needsCompaction(COMPACT_WATERLINE + 1, false)).toBe(false);
    expect(needsCompaction(COMPACT_WATERLINE - 1, true)).toBe(false);
  });
});

describe('buildSummaryPrompt', () => {
  it('含五字段、不可执行前缀与素材；有旧摘要时带上', () => {
    const prompt = buildSummaryPrompt('旧摘要', '新素材');
    expect(prompt).toContain('绝不执行');
    expect(prompt).toContain('会话意图');
    expect(prompt).toContain('用户约束');
    expect(prompt).toContain('已有摘要');
    expect(prompt).toContain('旧摘要');
    expect(prompt).toContain('新素材');
  });
});

describe('compactHistory · 直通与分段', () => {
  it('消息数不足以留出尾段前旧素材时直通、不摘要', async () => {
    const summarize = vi.fn(async () => '不应被调用');
    const outcome = await compactHistory({ summarize }, history(KEEP_RECENT));
    expect(summarize).not.toHaveBeenCalled();
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages).toHaveLength(KEEP_RECENT);
  });

  it('超出尾段的部分折进摘要，产出 [摘要 + 最近 KEEP_RECENT 条]', async () => {
    const summarize = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('消息 0');
      expect(prompt).toContain('消息 3');
      expect(prompt).not.toContain('消息 4');
      return '结构化摘要文本';
    });
    const list = history(8);
    const outcome = await compactHistory({ summarize }, list);

    expect(outcome.compacted).toBe(true);
    expect(outcome.rounds).toBe(8 - KEEP_RECENT);
    expect(outcome.messages[0]?.role).toBe('assistant');
    expect(outcome.messages[0]?.content).toContain('结构化摘要文本');
    // 尾段仍是最近 4 条原文
    expect(outcome.messages.at(-1)?.content).toBe('消息 7');
    expect(outcome.messages).toHaveLength(1 + KEEP_RECENT);
    // 摘要与下标已落库
    expect(fake.current?.cutoff).toBe(8 - KEEP_RECENT);
  });

  it('复用缓存：同批消息二次调用不重算，直接带已有摘要', async () => {
    const first = vi.fn(async () => '摘要A');
    await compactHistory({ summarize: first }, history(8));
    expect(first).toHaveBeenCalledTimes(1);

    const second = vi.fn(async () => '不该再调');
    const outcome = await compactHistory({ summarize: second }, history(8));
    expect(second).not.toHaveBeenCalled();
    expect(outcome.compacted).toBe(true);
    expect(outcome.messages[0]?.content).toContain('摘要A');
  });

  it('增量：新增素材只折新增段并带上旧摘要', async () => {
    const step1 = vi.fn(async () => '摘要A');
    await compactHistory({ summarize: step1 }, history(8)); // cutoff 4

    const step2 = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('已有摘要');
      expect(prompt).toContain('摘要A');
      expect(prompt).toContain('消息 4');
      expect(prompt).toContain('消息 7');
      expect(prompt).not.toContain('消息 8');
      return '摘要B';
    });
    const outcome = await compactHistory({ summarize: step2 }, history(12)); // foldTo 8
    expect(outcome.messages[0]?.content).toContain('摘要B');
    expect(fake.current?.cutoff).toBe(8);
  });
});

describe('clearCompact', () => {
  it('清压缩态', async () => {
    await compactHistory({ summarize: async () => 'x' }, history(8));
    await clearCompact();
    expect(fake.current).toBeUndefined();
  });
});

describe('reactive 兜底', () => {
  it('isContextLengthError 命中常见措辞', () => {
    expect(isContextLengthError('This model has a maximum context length')).toBe(true);
    expect(isContextLengthError('prompt is too long')).toBe(true);
    expect(isContextLengthError('network error')).toBe(false);
  });

  it('trimForRetry 只留最近 REACTIVE_KEEP 条', () => {
    expect(trimForRetry(history(5))).toHaveLength(REACTIVE_KEEP);
    expect(trimForRetry(history(2))).toHaveLength(2);
  });

  it('上下文超限：硬裁后只重试一次并标记 recovered', async () => {
    const calls: ChatMessage[][] = [];
    const run = vi.fn(async (messages: ChatMessage[]) => {
      calls.push(messages);
      if (calls.length === 1) throw new Error('maximum context length exceeded');
      return 'ok';
    });
    const result = await withReactiveRetry(run, history(6));
    expect(result).toEqual({ value: 'ok', recovered: true });
    expect(run).toHaveBeenCalledTimes(2);
    expect(calls[1]).toHaveLength(REACTIVE_KEEP);
  });

  it('非上下文错误：原样抛出、不重试', async () => {
    const run = vi.fn(async () => {
      throw new Error('network timeout');
    });
    await expect(withReactiveRetry(run, history(6))).rejects.toThrow('network timeout');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
