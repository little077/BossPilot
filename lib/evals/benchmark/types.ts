// ─── 效率基准的类型契约 ───
// 职责：把「一次 agent 任务执行」抽象为可度量的指标集，
// 供 M1-M5 每次迭代前后对比，用数据证明效率提升不劣化。

import type { ChatMessage } from '@/lib/domain/chat';

/** 一次任务执行的整体指标（从完整历史消息提取）。 */
export interface BenchmarkMetrics {
  /** 模型请求轮次：包含工具活动或模型标识的 assistant 消息数。 */
  modelTurns: number;
  /** 工具调用总次数。 */
  toolCalls: number;
  succeededTools: number;
  failedTools: number;
  /** 端到端耗时：首条 user 消息到最后一个工具完成。 */
  durationMs: number;
  /** 连续失败重试浪费：同工具名连续失败中，第 2 次及以后的耗时合计。 */
  retryWastedMs: number;
  /** 需要用户确认/等待权限的工具调用次数（安全决策成本）。 */
  safetyDecisions: number;
  /** M5.1 工具结果缓存命中次数（statusText 含（cached）标记）。 */
  cachedReads: number;
  /** M5.2 上下文差异注入次数（user 消息含 changedSinceLastRead:false）。 */
  unchangedContextInjections: number;
  /** M5.3 执行器建议命中次数（工具台账 detail 含 [hint]）。 */
  hintSuggestions: number;
}

/** 单个固定基准 case 的定义。 */
export interface BenchmarkCase {
  id: string;
  title: string;
  /** 用户提示词（与日志一致的原文）。 */
  prompt: string;
  /** 关联技能包名（如有）。 */
  skill?: string;
  /** 任务起始页面。 */
  targetUrl?: string;
  /** 期望出现的关键行为，用于断言执行质量。 */
  expect: string[];
}

/** 一次 case 执行的完整记录（供报告与对比）。 */
export interface BenchmarkRun {
  caseId: string;
  label: string;
  metrics: BenchmarkMetrics;
  /** 执行历史，供人工复核。 */
  messages: ChatMessage[];
}

/** 与基线对比的结果。 */
export interface BenchmarkComparison {
  caseId: string;
  label: string;
  baseline: BenchmarkMetrics;
  current: BenchmarkMetrics;
  /** 逐项变化（current - baseline，负值即提升）。 */
  deltas: {
    modelTurns: number;
    toolCalls: number;
    succeededTools: number;
    failedTools: number;
    durationMs: number;
    retryWastedMs: number;
    safetyDecisions: number;
    cachedReads: number;
    unchangedContextInjections: number;
    hintSuggestions: number;
  };
  /** 是否全部指标不劣于基线。 */
  noRegression: boolean;
}

/** 汇总报告（JSON 可序列化）。 */
export interface BenchmarkReport {
  generatedAt: string;
  comparisons: BenchmarkComparison[];
}
