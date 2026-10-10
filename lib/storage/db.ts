// ─── IndexedDB 持久化（dexie） ───
// 对话消息与加密后的模型配置都本地落库，冷启动/重连可回放。
// 仅本地存储，无云同步、无遥测。

import Dexie, { type Table } from 'dexie';
import type { ChatMessage } from '@/lib/domain/chat';

/** 加密后的模型配置；encApiKey 是 AES-GCM 密文，绝不含明文密钥。 */
export interface SecureConfigRow {
  id: 'config';
  baseUrl: string;
  model: string;
  encApiKey: string;
}

class BossPilotDb extends Dexie {
  messages!: Table<ChatMessage, string>;
  secure!: Table<SecureConfigRow, string>;

  constructor() {
    super('bosspilot');
    // v1：对话消息表，主键 id，按 createdAt 建索引供排序回放。
    this.version(1).stores({ messages: 'id, createdAt' });
    // v2：新增加密配置表（单行）。
    this.version(2).stores({ secure: 'id' });
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
