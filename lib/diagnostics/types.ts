// ─── 诊断记录：类型定义 ───
// 借鉴 RedScope 的 Run / Event / Artifact 三层，简化为「单次任务」内存模型：
// 每轮对话（或每次流水线任务）是一个 DiagnosticRun，内含步骤时间线与 LLM 调用记录。
// 记录器在内存中收集，任务结束 flush；导出前统一脱敏，仅落地本机，无遥测。
//
// 设计目标（M0 起）：日志不只是「审计摘要」，而是「AI 可分析的调试日志」——
// 包含提示词原文、输出全文、页面步骤与失配时的 DOM 结构快照，
// 下载后可直接交给任意模型定位问题。

/** 记录轨道：聊天轨与任务（流水线/工具）轨各自独立记录，互不覆盖。 */
export type DiagnosticSource = 'chat' | 'task';

/** 一次任务的最终结局。 */
export type DiagnosticRunStatus = 'completed' | 'error' | 'cancelled';

/** 时间线上的一步。 */
export interface DiagnosticStep {
  /** 任务内自增序号，从 1 起。 */
  seq: number;
  /** 相对任务开始的毫秒偏移。 */
  atMs: number;
  /**
   * 事件类别：
   * - input/llm/note/error：对话与通用记录；
   * - page：页面动作（导航、抽取结果、selectorMiss、验证码）；
   * - tool：领域工具调用（v0.3 一来一回起使用）。
   */
  kind: 'input' | 'llm' | 'note' | 'error' | 'page' | 'tool';
  /** 一句话摘要（已脱敏）。 */
  summary: string;
  /** 可选补充细节（已脱敏）。超长细节（如 DOM outline）由报告层移入附录渲染。 */
  detail?: string;
}

/** 发给模型的一条消息（已脱敏、超长截断）。 */
export interface DiagnosticLlmMessage {
  role: string;
  content: string;
}

/** 一次 LLM 调用的完整记录（原文 + 规模与耗时）。 */
export interface DiagnosticLlmCall {
  model: string;
  /** 本次调用的用途（如：对话 / 意图解析 / 岗位评估），便于报告分节。 */
  purpose?: string;
  /** 请求携带的消息条数。 */
  messageCount: number;
  /** 输入字符数（估算 token≈chars/4，报告里给个参考）。 */
  promptChars: number;
  /** 输出字符数。 */
  outputChars: number;
  /** 发送的完整消息列表（含 system prompt；已脱敏、单条截断）。 */
  messages?: DiagnosticLlmMessage[];
  /** 模型输出全文（已脱敏、截断）。 */
  outputText?: string;
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
  /** 记录来源轨道（chat=对话轮次，task=流水线/工具任务）。 */
  source: DiagnosticSource;
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
