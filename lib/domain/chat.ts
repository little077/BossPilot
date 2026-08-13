// ─── 对话消息模型 ───
// 侧边栏与用户之间的多轮对话消息。持久化到 IndexedDB（lib/storage/db.ts），
// 冷启动可回放；发送给模型时映射为 { role, content }。

import type {
  ModelIdentity,
  PendingUserQuestion,
  ReasoningActivity,
  ToolActivity,
} from '@/lib/domain/types';

export interface GenerationUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

export type GenerationFinishReason = 'stop' | 'length' | 'tool' | 'cancelled';

export type GenerationErrorCode =
  | 'NO_ACTIVE_MODEL'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'MODEL_NOT_FOUND'
  | 'AUTH_REQUIRED'
  | 'PERMISSION_REQUIRED'
  | 'BUSY'
  | 'AUTH_ERROR'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'AGENT_LIMIT_REACHED'
  | 'REPEATED_TOOL_CALL'
  | 'INVALID_RESPONSE';

export interface ChatMessage {
  /** 稳定主键（crypto.randomUUID）。 */
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 用户主动附加的本地图片、文本文件或当前页选区；随会话仅保存在本机。 */
  attachments?: ChatAttachment[];
  /** 毫秒时间戳，用于排序与回放。 */
  createdAt: number;
  /** 该条 assistant 消息是错误提示（UI 用不同样式呈现）。 */
  error?: boolean;
  /** 流式请求的生命周期；旧数据没有该字段时按已完成处理。 */
  status?: 'streaming' | 'completed' | 'cancelled' | 'error';
  /** 错误说明与已生成正文分开保存，避免错误覆盖部分回复。 */
  errorMessage?: string;
  errorCode?: GenerationErrorCode;
  retryable?: boolean;
  /** 本轮实际使用的模型，发送开始时固定，切卡只影响下一轮。 */
  modelIdentity?: ModelIdentity;
  finishReason?: GenerationFinishReason;
  usage?: GenerationUsage;
  /** 原型中的「思考过程」只展示安全阶段摘要，不保存或展示模型私有推理。 */
  reasoningActivity?: ReasoningActivity;
  /** 兼容旧历史记录的最后一个工具快照；新 UI 优先读取 toolActivities。 */
  toolActivity?: ToolActivity;
  /** Agent 循环中的完整工具时间线；每个模型回合最多产生一个工具调用。 */
  toolActivities?: ToolActivity[];
  /** Ask User 暂停点；固定显示在输入框上方，不作为消息气泡渲染。 */
  pendingUserQuestion?: PendingUserQuestion;
}

export type ChatAttachment =
  | {
      id: string;
      kind: 'image';
      name: string;
      mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
      size: number;
      data: string;
    }
  | {
      id: string;
      kind: 'text';
      name: string;
      mimeType: 'text/plain' | 'text/markdown' | 'application/json' | 'text/csv';
      size: number;
      content: string;
    }
  | {
      id: string;
      kind: 'selection';
      name: string;
      content: string;
      sourceOrigin: string;
      sourceTitle: string;
    };

/** 会话标题来源；用户手动改名后，自动标题不得再次覆盖。 */
export type ConversationTitleSource = 'fallback' | 'ai' | 'user';

/**
 * 历史列表的本地会话摘要。正文消息单独存表，避免列表页读取全部长文本。
 * updatedAt 只代表最后一条消息时间，改名和已读操作不会把旧会话顶到列表首位。
 */
export interface ChatConversation {
  id: string;
  ordinal: number;
  title: string;
  titleSource: ConversationTitleSource;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview: string;
  messageCount: number;
  unread: boolean;
}

/** IndexedDB 中的消息行；模型与 IPC 仍只传输不含 conversationId 的 ChatMessage。 */
export interface StoredChatMessage extends ChatMessage {
  conversationId: string;
}

export interface ChatHistorySettings {
  /** 每轮成功回复后额外调用一次当前模型，为历史会话生成短标题。 */
  autoTitle: boolean;
}

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** 每条会话独立的模型运行偏好；未设置字段继承全局 Provider。 */
export interface ConversationRuntimeSettings {
  conversationId: string;
  modelIdentity?: ModelIdentity;
  thinkingLevel: ThinkingLevel;
  contextWindowTokens: number;
  maxOutputTokens: number;
  updatedAt: number;
}

export interface RunCheckpoint {
  id: string;
  runId: string;
  conversationId: string;
  historyMessageIds: string[];
  phase: 'queued' | 'running' | 'waiting_user' | 'stable' | 'interrupted';
  createdAt: number;
}

export interface CompactionSummary {
  id: string;
  runId: string;
  conversationId: string;
  summary: string;
  sourceMessageIds: string[];
  createdAt: number;
}

/** 生成一条消息（补齐 id/createdAt）。 */
export function makeMessage(
  role: ChatMessage['role'],
  content: string,
  attachments?: ChatAttachment[],
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: Date.now(),
    ...(attachments?.length ? { attachments: attachments.map(cloneAttachment) } : {}),
  };
}

export function cloneAttachment(attachment: ChatAttachment): ChatAttachment {
  return { ...attachment };
}
