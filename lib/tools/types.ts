// ─── Agent 工具层类型 ───
// 工具 = 「面向模型的声明」+「确定性的执行」：
// - description 与 parameters 是模型可见的接口，必须写清何时该用/不该用；
// - execute 内部零 LLM，流程控制、硬上限、截断全部在确定性代码里完成；
// - 结果双形态：data 供程序/UI，llmText 供模型（已按工具内硬上限截断）；
// - 错误也是结构化结果（稳定错误码），让模型能如实转述而不是编造。

/** 工具输入参数（由模型填写，运行时为普通对象）。 */
export type ToolArgs = Record<string, unknown>;

/** 稳定错误码：跨工具统一，对话卡片与模型都依赖它识别失败原因。 */
export type ToolErrorCode =
  | 'no_active_tab'
  | 'unsupported_page'
  | 'page_access_denied'
  | 'injection_failed'
  | 'empty_content'
  | 'invalid_arguments'
  | 'timeout'
  | 'cancelled'
  | 'artifact_not_found'
  | 'unknown_tool';

/** 工具执行结果：成功与失败共用同一形状，isError 区分。 */
export interface ToolResult {
  isError: boolean;
  errorCode?: ToolErrorCode;
  /** 面向模型的精简文本（已按工具内硬上限截断）。 */
  llmText: string;
  /** 结构化数据（UI 渲染与单测断言用）。 */
  data?: unknown;
  /** 一句话摘要，用于对话流里的工具卡片。 */
  summary: string;
  /** 成功结果经统一关口落地后的工件编号（引用卡的单一事实源，供 UI 卡片展示）。 */
  artifactId?: string;
}

/** 工具执行上下文：取消信号必须被每个工具尊重。 */
export interface ToolContext {
  signal: AbortSignal;
}

/** 工具输入 JSON Schema（单一事实源：绑定模型与运行时校验共用同一份）。 */
export interface ToolParametersSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
}

/** 一个 Agent 工具。 */
export interface AgentTool {
  /** 模型可见名称（snake_case 稳定标识）。 */
  name: string;
  /** 面向模型的中文描述：何时该用 / 何时不该用 / 返回什么。 */
  description: string;
  parameters: ToolParametersSchema;
  /**
   * 工件关口直通标记：仅取回类工具（read_artifact）使用。
   * 取回的全文本身就是终点——若再过一遍落地关口会被替换成新的引用卡，
   * 形成「取回→又变引用」死循环，模型永远拿不到正文。
   */
  artifactBypass?: boolean;
  /** 确定性执行（零 LLM）。 */
  execute: (args: ToolArgs, ctx: ToolContext) => Promise<ToolResult>;
}

/** 交给模型绑定（bindTools）的 OpenAI 格式函数定义，零额外依赖。 */
export interface BindableToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolParametersSchema;
  };
}

/** 组装成功结果。 */
export function toolOk(summary: string, llmText: string, data?: unknown): ToolResult {
  return { isError: false, summary, llmText, data };
}

/** 组装失败结果（稳定错误码 + 面向模型的人话说明）。 */
export function toolError(
  errorCode: ToolErrorCode,
  summary: string,
  llmText: string,
  data?: unknown,
): ToolResult {
  return { isError: true, errorCode, summary, llmText, data };
}
