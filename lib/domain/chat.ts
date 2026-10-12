// ─── 对话消息模型 ───
// 侧边栏与用户之间的多轮对话消息。持久化到 IndexedDB（lib/storage/db.ts），
// 冷启动/重连可回放；发送给模型时映射为 LangChain 消息。

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
  /** 本轮回复中的工具调用展示记录（若有）。 */
  toolCall?: ToolCallView;
}

/** 工具卡片展示记录：只保留摘要，完整工具结果不进入会话历史（重放安全）。 */
export interface ToolCallView {
  /** 工具名（如 read_current_page）。 */
  name: string;
  status: 'running' | 'success' | 'error';
  /** 一句话结果摘要（成功：读到了什么；失败：人话错误说明）。 */
  summary?: string;
  /** 稳定错误码（失败时）。 */
  errorCode?: string;
  /** 成功结果落地后的工件编号（UI 展示短编号，全文在档案柜不在消息里）。 */
  artifactId?: string;
}

/** 生成一条消息（补齐 id/createdAt）。 */
export function makeMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: crypto.randomUUID(), role, content, createdAt: Date.now() };
}
