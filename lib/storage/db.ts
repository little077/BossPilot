// ─── IndexedDB 持久化（dexie） ───
// 对话消息本地落库，冷启动/重连可回放。仅本地存储，无云同步、无遥测。

import Dexie, { type Table } from 'dexie';
import type { ChatMessage } from '@/lib/domain/chat';

class BossPilotDb extends Dexie {
  messages!: Table<ChatMessage, string>;

  constructor() {
    super('bosspilot');
    // v1：对话消息表，主键 id，按 createdAt 建索引供排序回放。
    this.version(1).stores({ messages: 'id, createdAt' });
  }
}

export const db = new BossPilotDb();

/** 按时间顺序读取全部对话消息（冷启动回放）。 */
export async function loadMessages(): Promise<ChatMessage[]> {
  return db.messages.orderBy('createdAt').toArray();
}

/** 落库一条消息（存在则覆盖，用于流式回复定稿）。 */
export async function saveMessage(message: ChatMessage): Promise<void> {
  await db.messages.put(message);
}

/** 清空对话（「新对话」按钮）。 */
export async function clearMessages(): Promise<void> {
  await db.messages.clear();
}
