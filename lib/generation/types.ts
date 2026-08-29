import type {
  ChatMessage,
  GenerationFinishReason,
  GenerationUsage,
  ThinkingLevel,
} from '@/lib/domain/chat';
import type {
  AskUserOption,
  BrowserActionErrorCode,
  DomainToolName,
  ModelIdentity,
  PageExtractionMode,
  PageInteractionErrorCode,
  PageReadErrorCode,
  PageTurnSnapshot,
  VisualObservationErrorCode,
} from '@/lib/domain/types';

/**
 * Generation protocols are deliberately separate from model-catalog discovery.
 * Several providers share the same wire protocol.
 */
export type GenerationProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'mistral-conversations';

export interface ResolvedGenerationTarget {
  identity: ModelIdentity;
  providerLabel: string;
  modelName: string;
  protocol: GenerationProtocol;
  baseUrl: string;
  apiKey: string;
  /** 未知或自定义模型默认 false，避免把截图误发给纯文本端点。 */
  supportsImageInput?: boolean;
}

export interface GenerationImageContent {
  data: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface GenerationToolDefinition {
  name: DomainToolName;
  label: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };
}

export interface GenerationToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type GenerationInputMessage =
  | {
      role: 'user';
      content: string;
      createdAt: number;
      images?: GenerationImageContent[];
    }
  | {
      role: 'assistant';
      content: string;
      createdAt: number;
      finishReason?: GenerationFinishReason;
      toolCalls?: GenerationToolCall[];
    }
  | {
      role: 'toolResult';
      toolCallId: string;
      toolName: string;
      content: string;
      images?: GenerationImageContent[];
      isError: boolean;
      createdAt: number;
    };

export interface GenerationRequest {
  systemPrompt: string;
  /** 兼容现有聊天快照；工具回合由 Manager 追加协议无关的内部消息。 */
  messages: Array<ChatMessage | GenerationInputMessage>;
  tools?: GenerationToolDefinition[];
  signal: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  thinkingLevel?: ThinkingLevel;
}

export type GenerationEvent =
  | { type: 'start' }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolCall: GenerationToolCall }
  | {
      type: 'finish';
      reason: GenerationFinishReason;
      usage: GenerationUsage;
    };

export interface GenerationToolExecutionResult {
  content: string;
  /** 只在当前 Agent 循环内传给模型，不进入 ChatMessage、历史记录或诊断日志。 */
  images?: GenerationImageContent[];
  isError: boolean;
  statusText: string;
  detail?: string;
  /** M5.3：执行器给出的下一步决策建议（可信、结构化）；Manager 附加到模型可见结果尾部。 */
  hint?: string;
  errorCode?:
    | 'NOT_ON_JOB_PAGE'
    | 'NO_JOB_SELECTED'
    | 'NO_JOB_LIST'
    | 'CAPTCHA_DETECTED'
    | 'SELECTOR_MISS'
    | 'NO_PERMISSION'
    | 'EXTRACTION_FAILED'
    | 'CANCELLED'
    | BrowserActionErrorCode
    | PageInteractionErrorCode
    | VisualObservationErrorCode
    | PageReadErrorCode;
  sourceOrigin?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  extractionMode?: PageExtractionMode;
  returnedChars?: number;
  truncated?: boolean;
  enrichmentStatus?: 'success' | 'failed' | 'not_applicable';
  outputPath?: string;
  riskLevel?: 'read' | 'write' | 'dangerous';
  authorizationStatus?: 'not_required' | 'pending' | 'granted' | 'denied';
  recoverability?: 'safe_retry' | 'user_retry' | 'not_retryable';
  /**
   * 浏览器工具实际操作完成后的本地页面身份。仅供 background 延续同一 Agent 任务，
   * Manager 不会把完整 URL 或标签页 ID 发给模型。
   */
  nextPageSnapshot?: PageTurnSnapshot;
  /**
   * 一次工具调用发现的全部可信页面句柄（例如 tab.list）。仅供会话级句柄表登记；
   * 模型只能看到工具 content 中经过裁剪的公开字段。
   */
  pageSnapshots?: PageTurnSnapshot[];
}

/** 页面权限需要真实用户手势时暂停；不是错误结果，不能提前发给模型。 */
export interface GenerationPagePermissionDeferredResult {
  deferred: true;
  kind: 'page_permission';
  statusText: string;
  detail: string;
  permissionPattern: string;
  sourceOrigin: string;
  sourceTitle: string;
  permissionKind?: 'read' | 'interact';
}

/** Agent 缺少关键条件时暂停，并把单个澄清问题交给底部 Ask User 面板。 */
export interface GenerationUserInputDeferredResult {
  deferred: true;
  kind: 'user_input';
  statusText: string;
  question: string;
  options: AskUserOption[];
  allowCustom: boolean;
  customPlaceholder?: string;
}

export type GenerationToolDeferredResult =
  | GenerationPagePermissionDeferredResult
  | GenerationUserInputDeferredResult;

export type GenerationToolExecutionOutcome =
  | GenerationToolExecutionResult
  | GenerationToolDeferredResult;

export interface GenerationToolExecutionContext {
  model: {
    providerLabel: string;
    modelName: string;
    supportsImageInput: boolean;
  };
  /** 同一模型回合声明的工具共享 batchId；执行器可据此绑定不可变的回合级资源上下文。 */
  batch?: {
    id: string;
    index: number;
    size: number;
  };
}

/** serial 是安全默认值；parallel 只可用于已声明无相互依赖且不会请求确认的调用。 */
export type GenerationToolExecutionMode = 'serial' | 'parallel';

export type GenerationToolExecutor = (
  call: GenerationToolCall,
  signal: AbortSignal,
  requestId: string,
  reportProgress: (statusText: string, detail?: string) => void,
  context: GenerationToolExecutionContext,
) => Promise<GenerationToolExecutionOutcome>;

export interface GenerationAdapter {
  stream(
    target: ResolvedGenerationTarget,
    request: GenerationRequest,
  ): AsyncIterable<GenerationEvent>;
}
