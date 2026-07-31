// ─── 对话消息模型 ───
// 侧边栏与用户之间的多轮对话消息。持久化到 IndexedDB（lib/storage/db.ts），
// 冷启动可回放；发送给模型时映射为 { role, content }。

import type { ModelIdentity, ReasoningActivity, ToolActivity } from '@/lib/domain/types';

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
  | 'INVALID_RESPONSE';

export interface ChatMessage {
  /** 稳定主键（crypto.randomUUID）。 */
  id: string;
  role: 'user' | 'assistant';
  content: string;
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
  /** 本轮最多一个只读工具；状态随消息快照一起回放，断线后不会留下幽灵任务。 */
  toolActivity?: ToolActivity;
}

/** 生成一条消息（补齐 id/createdAt）。 */
export function makeMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: crypto.randomUUID(), role, content, createdAt: Date.now() };
}
