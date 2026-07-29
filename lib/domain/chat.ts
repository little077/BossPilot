// ─── 对话消息模型 ───
// 侧边栏与用户之间的多轮对话消息。持久化到 IndexedDB（lib/storage/db.ts），
// 冷启动可回放；发送给模型时映射为 { role, content }。

export interface ChatMessage {
  /** 稳定主键（crypto.randomUUID）。 */
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 毫秒时间戳，用于排序与回放。 */
  createdAt: number;
  /** 该条 assistant 消息是错误提示（UI 用不同样式呈现）。 */
  error?: boolean;
}

/** 生成一条消息（补齐 id/createdAt）。 */
export function makeMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: crypto.randomUUID(), role, content, createdAt: Date.now() };
}
