// ─── 2026-08-29 日志基线固化 ───
// 数据来源：c:\Users\18376\Downloads\日志.md（BossPilot 执行日志，15:26:18 → 15:27:27）。
// 该基线是「未做任何效率优化」前的真实执行记录，作为 M1-M5 每次迭代的对比锚点。
// 只允许在团队确认后人工调整；代码不应自动改写它。

import type { BenchmarkCase, BenchmarkMetrics } from './types';

/** 小红书搜索基准 case（用户日志中的真实任务）。 */
export const XHS_SEARCH_CASE: BenchmarkCase = {
  id: 'xhs-search-vibe-coding',
  title: '小红书搜索 vibe coding 展示并整理结果',
  prompt: '加载 xhs-note-scout 技能，在小红书搜索 vibe coding 展示，整理搜索结果。',
  skill: 'xhs-note-scout',
  targetUrl: 'https://www.xiaohongshu.com/explore',
  expect: ['load_skill', 'browser_action search 或等效搜索', '整理结果'],
};

/**
 * 2026-08-29 日志实测基线（29 次工具调用、约 16 轮模型请求、69 秒）。
 * 其中 tab open 失败两组：15:26:25/28 两次短失败（6/2ms）、15:27:20 连续 4 次
 * 各吃满 12s 超时（12140/12187/12235/12236ms）。按「同工具连续失败中
 * 第 2 次及以后计为浪费」的口径合计 36.660s，占总耗时 53.1%——这是 M2 要消灭的主要开销。
 */
export const XHS_SEARCH_BASELINE_20260829: BenchmarkMetrics = {
  modelTurns: 16,
  toolCalls: 29,
  succeededTools: 21,
  failedTools: 8,
  durationMs: 69_000,
  retryWastedMs: 36_660,
  safetyDecisions: 0,
  cachedReads: 0,
  unchangedContextInjections: 0,
  hintSuggestions: 0,
};

/** 全部已固化的基线（当前只有一个 case，M6 后可扩展）。 */
export const BASELINES: ReadonlyArray<{ caseId: string; metrics: BenchmarkMetrics }> = [
  { caseId: XHS_SEARCH_CASE.id, metrics: XHS_SEARCH_BASELINE_20260829 },
];

/** 按 caseId 查找基线。 */
export function baselineFor(caseId: string): BenchmarkMetrics | null {
  return BASELINES.find((entry) => entry.caseId === caseId)?.metrics ?? null;
}
