// ─── 工具结果缓存层（M5.1 跨轮复用）───
// 职责：以 (toolName, 参数签名, tabId, urlKey) 为键缓存只读工具结果，
// 同一页面模型重复侦察直接命中缓存，返回带 (cached) 标记的结果，避免
// 「刚打开页面立刻又 read+inspect 重复一轮」。
// 安全边界：只缓存成功结果；页面导航后由调用方 invalidatePage 失效；
// 过期条目（短 TTL）一律视为未命中，不做任何跨页面复用。

import type { GenerationToolCall, GenerationToolExecutionResult } from './types';

/** 页面级键解析：从调用上下文解析目标标签页与页面键；无法解析返回 null。 */
export type ToolResultPageKeyResolver = (
  call: GenerationToolCall,
) => { tabId: number; urlKey: string } | null;

export interface ToolResultCacheOptions {
  /** 缓存有效期；默认 4 秒（计划 3-5s 窗口）。 */
  ttlMs?: number;
  now?: () => number;
  /** 解析本次调用对应的页面键；缺省时不缓存任何调用。 */
  resolvePageKey?: ToolResultPageKeyResolver;
  /** 白名单判断；默认 read_current_page / inspect_page。 */
  cacheable?: (toolName: string) => boolean;
}

export interface ToolResultCacheStats {
  hits: number;
  misses: number;
  writes: number;
  invalidations: number;
}

export interface ToolResultCache {
  /** 执行前查找；命中返回缓存结果（已附加 (cached) 标记），否则 null。 */
  lookup(call: GenerationToolCall): GenerationToolExecutionResult | null;
  /** 执行成功后写入缓存；失败/暂停结果不缓存。 */
  store(call: GenerationToolCall, result: GenerationToolExecutionResult): void;
  /** 页面导航后失效该页面的全部条目（导航类工具执行后调用）。 */
  invalidatePage(tabId: number): void;
  /** 命中统计（供评测报告与测试断言）。 */
  stats(): ToolResultCacheStats;
}

const CACHED_MARKER = '（cached）';

export function createToolResultCache(options: ToolResultCacheOptions): ToolResultCache {
  const ttlMs = options.ttlMs ?? 4_000;
  const now = options.now ?? Date.now;
  const resolvePageKey = options.resolvePageKey;
  const cacheable =
    options.cacheable ??
    ((toolName) => toolName === 'read_current_page' || toolName === 'inspect_page');
  const entries = new Map<string, { result: GenerationToolExecutionResult; expiresAt: number }>();
  const stats: ToolResultCacheStats = { hits: 0, misses: 0, writes: 0, invalidations: 0 };

  function cacheKey(call: GenerationToolCall): string | null {
    if (!resolvePageKey || !cacheable(call.name)) return null;
    const page = resolvePageKey(call);
    if (!page) return null;
    return `${call.name}|${stableArguments(call.arguments)}|${page.tabId}|${page.urlKey}`;
  }

  return {
    lookup(call) {
      const key = cacheKey(call);
      if (!key) {
        stats.misses += 1;
        return null;
      }
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= now()) {
        entries.delete(key);
        stats.misses += 1;
        return null;
      }
      stats.hits += 1;
      const { result } = entry;
      return {
        ...result,
        statusText: `${result.statusText}${CACHED_MARKER}`,
        content: `${result.content}\n\n${CACHED_MARKER} 页面未变化，本条为最近一次成功结果的复用；如需最新页面状态，请等待页面变化或打开新页面后再读。`,
      };
    },
    store(call, result) {
      const key = cacheKey(call);
      if (!key || result.isError) return;
      entries.set(key, { result, expiresAt: now() + ttlMs });
      stats.writes += 1;
    },
    invalidatePage(tabId) {
      for (const [key] of entries) {
        // 键格式：toolName|params|tabId|urlKey
        const parts = key.split('|');
        if (parts[2] === String(tabId)) entries.delete(key);
      }
      stats.invalidations += 1;
    },
    stats() {
      return { ...stats };
    },
  };
}

/** 稳定参数签名：仅对 JSON 序列化后的键排序，保证参数顺序无关。 */
export function stableArguments(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, Object.keys(value).sort());
  } catch {
    return JSON.stringify(value);
  }
}
