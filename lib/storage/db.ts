// ─── IndexedDB 持久化（dexie） ───
// 对话会话与消息本地落库，冷启动/重连可回放。仅本地存储，无云同步、无遥测。

import Dexie, { type Table } from 'dexie';
import type { ChatConversation, ChatMessage, StoredChatMessage } from '@/lib/domain/chat';

const PREVIEW_CHARS = 80;

class BossPilotDb extends Dexie {
  conversations!: Table<ChatConversation, string>;
  messages!: Table<StoredChatMessage, string>;

  constructor() {
    super('bosspilot');
    // v1：对话消息表，主键 id，按 createdAt 建索引供排序回放。
    this.version(1).stores({ messages: 'id, createdAt' });
    // v2：增加会话层；旧版唯一聊天流自动归入第一条历史记录，不清空用户数据。
    this.version(2)
      .stores({
        conversations: 'id, ordinal, updatedAt, unread',
        messages: 'id, conversationId, [conversationId+createdAt], createdAt',
      })
      .upgrade(async (transaction) => {
        const messageTable = transaction.table<StoredChatMessage, string>('messages');
        const rows = await messageTable.orderBy('createdAt').toArray();
        if (rows.length === 0) return;

        const conversationId = `conversation-${crypto.randomUUID()}`;
        const first = rows[0];
        const last = rows.at(-1);
        if (!first || !last) return;

        await transaction.table<ChatConversation, string>('conversations').add({
          id: conversationId,
          ordinal: 1,
          title: '历史记录 1',
          titleSource: 'fallback',
          createdAt: first.createdAt,
          updatedAt: last.createdAt,
          lastMessagePreview: messagePreview(last),
          messageCount: rows.length,
          unread: false,
        });
        await messageTable.toCollection().modify((message) => {
          message.conversationId = conversationId;
        });
      });
  }
}

export const db = new BossPilotDb();

/** 历史列表按最后消息时间倒序展示。 */
export async function loadConversations(): Promise<ChatConversation[]> {
  return db.conversations.orderBy('updatedAt').reverse().toArray();
}

/** 按时间顺序读取指定会话；存储字段不会泄漏到模型历史。 */
export async function loadMessages(conversationId: string): Promise<ChatMessage[]> {
  const rows = await db.messages
    .where('[conversationId+createdAt]')
    .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey])
    .toArray();
  return rows.map(({ conversationId: _conversationId, ...message }) => message);
}

export interface SaveMessageOptions {
  /** 新会话的首条消息可以在同一事务内创建会话，避免留下空壳记录。 */
  conversation?: ChatConversation;
  /** undefined 表示保留当前状态；true/false 分别标记未读/已读。 */
  unread?: boolean;
}

/**
 * 消息与列表摘要在一个事务中落库。相同 message.id 重放时只覆盖、不重复计数，
 * 适配 MV3 Port 断线重连后的权威快照回放。
 */
export async function saveMessage(
  conversationId: string,
  message: ChatMessage,
  options: SaveMessageOptions = {},
): Promise<ChatConversation> {
  return db.transaction('rw', db.conversations, db.messages, async () => {
    let conversation = await db.conversations.get(conversationId);
    if (!conversation && options.conversation) {
      conversation = { ...options.conversation };
      await db.conversations.add(conversation);
    }
    if (!conversation) throw new Error('本地会话不存在，无法保存消息。');

    const previous = await db.messages.get(message.id);
    await db.messages.put({ ...message, conversationId });

    const next: ChatConversation = {
      ...conversation,
      updatedAt: Math.max(conversation.updatedAt, message.createdAt),
      lastMessagePreview: messagePreview(message),
      messageCount: conversation.messageCount + (previous ? 0 : 1),
      ...(options.unread === undefined ? {} : { unread: options.unread }),
    };
    await db.conversations.put(next);
    return next;
  });
}

export async function markConversationRead(conversationId: string): Promise<void> {
  await db.conversations.update(conversationId, { unread: false });
}

/** 用户改名优先级最高；之后的自动标题请求不能覆盖它。 */
export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<ChatConversation | null> {
  const conversation = await db.conversations.get(conversationId);
  if (!conversation) return null;
  const next = { ...conversation, title: normalizeTitle(title), titleSource: 'user' as const };
  await db.conversations.put(next);
  return next;
}

/** 只更新 fallback/ai 标题，抵御自动请求与用户手动改名之间的竞态。 */
export async function saveAiConversationTitle(
  conversationId: string,
  title: string,
): Promise<ChatConversation | null> {
  return db.transaction('rw', db.conversations, async () => {
    const conversation = await db.conversations.get(conversationId);
    if (!conversation || conversation.titleSource === 'user') return conversation ?? null;
    const next = { ...conversation, title: normalizeTitle(title), titleSource: 'ai' as const };
    await db.conversations.put(next);
    return next;
  });
}

export function createConversation(ordinal: number, now = Date.now()): ChatConversation {
  return {
    id: `conversation-${crypto.randomUUID()}`,
    ordinal,
    title: `历史记录 ${ordinal}`,
    titleSource: 'fallback',
    createdAt: now,
    updatedAt: now,
    lastMessagePreview: '',
    messageCount: 0,
    unread: false,
  };
}

function messagePreview(message: ChatMessage): string {
  const value = (message.content || message.errorMessage || '消息').replace(/\s+/g, ' ').trim();
  return value.slice(0, PREVIEW_CHARS);
}

function normalizeTitle(title: string): string {
  const normalized = title.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!normalized) throw new Error('会话标题不能为空。');
  return normalized;
}
