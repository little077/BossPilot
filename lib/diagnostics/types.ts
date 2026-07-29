// ─── 诊断记录：类型定义 ───
// 借鉴 RedScope 的 Run / Event / Artifact 三层，简化为「单次任务」内存模型：
// 每轮对话（或后续每次工具任务）是一个 DiagnosticRun，内含步骤时间线与 LLM 调用摘要。
// 记录器在内存中收集，任务结束 flush；导出前统一脱敏，仅落地本机，无遥测。

/** 一次任务的最终结局。 */
export type DiagnosticRunStatus = 'completed' | 'error' | 'cancelled';

/** 时间线上的一步。kind 便于后续按类别（工具/网络/页面）扩展。 */
export interface DiagnosticStep {
  /** 任务内自增序号，从 1 起。 */
  seq: number;
  /** 相对任务开始的毫秒偏移。 */
  atMs: number;
  /** 事件类别：对话轮次先用这几种，后续期次可扩展 tool/page/network。 */
  kind: 'input' | 'llm' | 'note' | 'error';
  /** 一句话摘要（已脱敏）。 */
  summary: string;
  /** 可选补充细节（已脱敏）。 */
  detail?: string;
}

/** 一次 LLM 调用的摘要（不含原文，仅规模与耗时）。 */
export interface DiagnosticLlmCall {
  model: string;
  /** 请求携带的消息条数。 */
  messageCount: number;
  /** 输入字符数（估算 token≈chars/4，报告里给个参考）。 */
  promptChars: number;
  /** 输出字符数。 */
  outputChars: number;
  /** 端点回传的用量（若有）。 */
  promptTokens?: number;
  completionTokens?: number;
  /** 调用耗时（毫秒）。 */
  latencyMs: number;
  /** 是否走了非流式降级路径。 */
  fellBackToNonStream?: boolean;
}

/** 一次完整任务的诊断记录。 */
export interface DiagnosticRun {
  runId: string;
  /** 触发本次任务的用户输入（已脱敏）。 */
  userInput: string;
  model: string;
  /** 端点主机名（不含完整 URL / 路径 / 参数）。 */
  baseUrlHost: string;
  extensionVersion: string;
  adapterVersion: number;
  startedAt: number;
  endedAt?: number;
  status: DiagnosticRunStatus;
  /** 出错时的简要原因（已脱敏）。 */
  errorSummary?: string;
  steps: DiagnosticStep[];
  llmCalls: DiagnosticLlmCall[];
}
