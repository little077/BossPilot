import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import {
  createConversation,
  db,
  loadConversations,
  loadMessages,
  markConversationRead,
  renameConversation,
  saveAiConversationTitle,
  saveMessage,
} from '@/lib/storage/db';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterAll(async () => {
  await db.delete();
});

describe('conversation database', () => {
  it('migrates the v1 global message stream into the first local conversation', async () => {
    await db.delete();
    const legacy = new Dexie('bosspilot');
    legacy.version(1).stores({ messages: 'id, createdAt' });
    await legacy.table('messages').bulkAdd([
      { id: 'u1', role: 'user', content: '旧问题', createdAt: 10 },
      { id: 'a1', role: 'assistant', content: '旧回答', createdAt: 20 },
    ]);
    legacy.close();
    await db.open();

    const conversations = await loadConversations();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      ordinal: 1,
      title: '历史记录 1',
      lastMessagePreview: '旧回答',
      messageCount: 2,
      unread: false,
    });
    expect(await loadMessages(conversations[0]?.id ?? '')).toEqual([
      { id: 'u1', role: 'user', content: '旧问题', createdAt: 10 },
      { id: 'a1', role: 'assistant', content: '旧回答', createdAt: 20 },
    ]);
  });

  it('stores messages transactionally and does not double count a replayed message id', async () => {
    const conversation = createConversation(2, 100);
    const user: ChatMessage = {
      id: 'user',
      role: 'user',
      content: '  第一条   消息  ',
      createdAt: 101,
    };
    const assistant: ChatMessage = {
      id: 'assistant',
      role: 'assistant',
      content: '完成回复',
      createdAt: 102,
      status: 'completed',
    };

    await saveMessage(conversation.id, user, { conversation, unread: false });
    await saveMessage(conversation.id, assistant, { unread: true });
    const replayed = await saveMessage(
      conversation.id,
      { ...assistant, content: '完成回复（权威快照）' },
      { unread: true },
    );

    expect(replayed).toMatchObject({
      messageCount: 2,
      lastMessagePreview: '完成回复（权威快照）',
      unread: true,
    });
    expect(await loadMessages(conversation.id)).toEqual([
      user,
      { ...assistant, content: '完成回复（权威快照）' },
    ]);
  });

  it('tracks read state and never lets an AI title overwrite a user title', async () => {
    const conversation = createConversation(1, 100);
    await saveMessage(
      conversation.id,
      { id: 'u1', role: 'user', content: '问题', createdAt: 101 },
      { conversation, unread: true },
    );
    await markConversationRead(conversation.id);
    expect((await loadConversations())[0]?.unread).toBe(false);

    await saveAiConversationTitle(conversation.id, ' AI 生成标题 ');
    expect((await loadConversations())[0]).toMatchObject({
      title: 'AI 生成标题',
      titleSource: 'ai',
    });
    await renameConversation(conversation.id, ' 用户的新标题 ');
    const preserved = await saveAiConversationTitle(conversation.id, '不应覆盖');
    expect(preserved).toMatchObject({ title: '用户的新标题', titleSource: 'user' });
  });

  it('uses deterministic fallback titles and rejects invalid writes', async () => {
    expect(createConversation(7, 123)).toMatchObject({
      ordinal: 7,
      title: '历史记录 7',
      titleSource: 'fallback',
      createdAt: 123,
      updatedAt: 123,
    });
    await expect(
      saveMessage('missing', { id: 'u', role: 'user', content: 'x', createdAt: 1 }),
    ).rejects.toThrow('本地会话不存在');
    await expect(renameConversation('missing', '标题')).resolves.toBeNull();
    await expect(saveAiConversationTitle('missing', '标题')).resolves.toBeNull();

    const conversation = createConversation(1, 1);
    await saveMessage(
      conversation.id,
      { id: 'u', role: 'user', content: '', errorMessage: '错误消息', createdAt: 2 },
      { conversation },
    );
    await expect(renameConversation(conversation.id, '   ')).rejects.toThrow('不能为空');
  });
});
