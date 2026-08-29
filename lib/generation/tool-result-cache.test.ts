// ─── M5.1 工具结果缓存层单元测试 ───
// 验证：键含页面指纹与参数签名、TTL 过期、页面失效、失败不缓存、命中统计。

import { describe, expect, it } from 'vitest';
import { createToolResultCache, stableArguments } from './tool-result-cache';
import type { GenerationToolCall } from './types';

const PAGE = { tabId: 7, urlKey: 'https://www.zhipin.com/web/geek/job' };

function call(name: string, argumentsValue: Record<string, unknown>): GenerationToolCall {
  return { id: 'call-1', name, arguments: argumentsValue };
}

function result(overrides: Partial<{ content: string; isError: boolean }> = {}): {
  content: string;
  isError: boolean;
  statusText: string;
} {
  return { content: '页面内容', statusText: '已读取当前页面', isError: false, ...overrides };
}

function cache(options: Partial<Parameters<typeof createToolResultCache>[0]> = {}) {
  return createToolResultCache({
    resolvePageKey: () => PAGE,
    ...options,
  });
}

describe('tool result cache', () => {
  it('stores and replays a read within TTL, marking the replay as cached', () => {
    const toolResultCache = cache();
    const read = call('read_current_page', {});
    expect(toolResultCache.lookup(read)).toBeNull(); // 首次执行前无缓存
    toolResultCache.store(read, result());

    const replayed = toolResultCache.lookup(read);
    expect(replayed).not.toBeNull();
    expect(replayed?.content).toContain('（cached）');
    expect(replayed?.statusText).toContain('（cached）');
    expect(toolResultCache.stats()).toMatchObject({ hits: 1, writes: 1 });
  });

  it('does not cache error results, non-whitelisted tools, or unresolvable pages', () => {
    const toolResultCache = cache();
    toolResultCache.store(call('read_current_page', {}), result({ isError: true }));
    toolResultCache.store(call('interact_page', { action: 'click' }), result());
    const noPage = createToolResultCache({ resolvePageKey: () => null });
    noPage.store(call('read_current_page', {}), result());
    expect(toolResultCache.lookup(call('read_current_page', {}))).toBeNull();
    expect(toolResultCache.lookup(call('interact_page', { action: 'click' }))).toBeNull();
    expect(noPage.stats().writes).toBe(0);
  });

  it('expires entries after TTL and treats expired entries as misses', () => {
    let now = 1_000;
    const toolResultCache = cache({ now: () => now, ttlMs: 4_000 });
    const read = call('read_current_page', {});
    toolResultCache.store(read, result());
    now = 5_000; // 恰好过期
    expect(toolResultCache.lookup(read)).toBeNull();
    expect(toolResultCache.stats()).toMatchObject({ misses: 1 });
  });

  it('separates entries by page, tool, and argument signature', () => {
    const toolResultCache = cache();
    toolResultCache.store(call('read_current_page', {}), result());
    toolResultCache.store(
      call('read_current_page', { tabId: 8 }),
      result({ content: '另一个页面' }),
    );
    toolResultCache.store(call('inspect_page', { scope: 'viewport' }), result());
    expect(toolResultCache.lookup(call('read_current_page', { tabId: 8 }))).toMatchObject({
      content: expect.stringContaining('另一个页面'),
    });
    expect(toolResultCache.lookup(call('inspect_page', { scope: 'viewport' }))).not.toBeNull();
  });

  it('invalidates all entries of a tab after navigation', () => {
    const toolResultCache = cache();
    const read = call('read_current_page', {});
    toolResultCache.store(read, result());
    toolResultCache.invalidatePage(7);
    expect(toolResultCache.lookup(read)).toBeNull();
    expect(toolResultCache.stats().invalidations).toBe(1);
  });

  it('produces an order-independent argument signature', () => {
    expect(stableArguments({ a: 1, b: 2 })).toBe(stableArguments({ b: 2, a: 1 }));
    expect(stableArguments({ a: 1, b: 2 })).not.toBe(stableArguments({ a: 1, b: 3 }));
  });
});
