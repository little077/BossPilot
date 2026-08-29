// ─── 基准执行器与报告 ───
// 职责：执行一次 case（真实或回放），与固化基线对比，产出 JSON 报告。
// M1-M5 每次迭代后调用 runAndCompare 生成 tests/benchmark/results/ 下的对比报告。

import type { ChatMessage } from '@/lib/domain/chat';
import { baselineFor } from './baseline-20260829';
import { measureRun } from './metrics';
import type {
  BenchmarkCase,
  BenchmarkComparison,
  BenchmarkMetrics,
  BenchmarkReport,
} from './types';

/** 执行一次 case：接收一个返回完整历史的执行器，度量并与基线对比。 */
export async function runAndCompare(
  task: BenchmarkCase,
  executor: () => Promise<ChatMessage[]>,
  label = 'current',
): Promise<BenchmarkComparison> {
  const messages = await executor();
  const metrics = measureRun(messages);
  if (!metrics) {
    throw new Error(`基准执行未产生可度量的工具活动或模型调用：${task.id}`);
  }
  return compareToBaseline(task, metrics, label);
}

/** 把一次执行与固化基线对比。 */
export function compareToBaseline(
  task: BenchmarkCase,
  current: BenchmarkMetrics,
  label = 'current',
): BenchmarkComparison {
  const baseline = baselineFor(task.id);
  if (!baseline) {
    throw new Error(`缺少 case 的固化基线：${task.id}`);
  }
  return compare(task.id, baseline, current, label);
}

export function compare(
  caseId: string,
  baseline: BenchmarkMetrics,
  current: BenchmarkMetrics,
  label = 'current',
): BenchmarkComparison {
  const deltas = {
    modelTurns: current.modelTurns - baseline.modelTurns,
    toolCalls: current.toolCalls - baseline.toolCalls,
    succeededTools: current.succeededTools - baseline.succeededTools,
    failedTools: current.failedTools - baseline.failedTools,
    durationMs: current.durationMs - baseline.durationMs,
    retryWastedMs: current.retryWastedMs - baseline.retryWastedMs,
    safetyDecisions: current.safetyDecisions - baseline.safetyDecisions,
    // M5 命中数（正向加分项，不计入不劣化判定，仅作报告统计）。
    cachedReads: current.cachedReads - baseline.cachedReads,
    unchangedContextInjections:
      current.unchangedContextInjections - baseline.unchangedContextInjections,
    hintSuggestions: current.hintSuggestions - baseline.hintSuggestions,
  };
  const noRegression =
    deltas.modelTurns <= 0 &&
    deltas.toolCalls <= 0 &&
    deltas.failedTools <= 0 &&
    deltas.durationMs <= 0 &&
    deltas.retryWastedMs <= 0 &&
    deltas.safetyDecisions <= 0;
  return { caseId, label, baseline, current, deltas, noRegression };
}

/** 渲染 JSON 报告（含逐项变化，负值即提升）。 */
export function renderReport(report: BenchmarkReport): string {
  return JSON.stringify(report, null, 2);
}

/** 汇总多次对比为报告对象。 */
export function buildReport(
  comparisons: BenchmarkComparison[],
  generatedAt = new Date().toISOString(),
): BenchmarkReport {
  return { generatedAt, comparisons };
}

/** 断言一次对比不劣于基线；返回可读的失败原因列表。 */
export function regressionViolations(comparison: BenchmarkComparison): string[] {
  const violations: string[] = [];
  const { deltas } = comparison;
  if (deltas.modelTurns > 0) violations.push(`模型轮次 +${deltas.modelTurns}`);
  if (deltas.toolCalls > 0) violations.push(`工具调用 +${deltas.toolCalls}`);
  if (deltas.failedTools > 0) violations.push(`失败工具 +${deltas.failedTools}`);
  if (deltas.durationMs > 0) violations.push(`端到端耗时 +${deltas.durationMs}ms`);
  if (deltas.retryWastedMs > 0) violations.push(`重试浪费 +${deltas.retryWastedMs}ms`);
  if (deltas.safetyDecisions > 0) violations.push(`安全决策 +${deltas.safetyDecisions}`);
  return violations;
}
