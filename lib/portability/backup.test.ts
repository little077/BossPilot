import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '@/lib/memory/store';
import {
  createConversation,
  db,
  loadConversations,
  loadMessages,
  saveMessage,
} from '@/lib/storage/db';
import {
  backupFileName,
  createBossPilotBackup,
  importBossPilotBackup,
  serializeBossPilotBackup,
} from './backup';

const data: Record<string, unknown> = {};

beforeEach(async () => {
  for (const key of Object.keys(data)) delete data[key];
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: data[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(data, items)),
      },
    },
    runtime: { getManifest: () => ({ version: '1.0.0' }) },
  });
  await db.delete();
  await db.open();
});

afterAll(async () => {
  await db.delete();
  vi.unstubAllGlobals();
});

describe('BossPilot local backup', () => {
  it('exports user data without secrets and restores it as a new conversation', async () => {
    const conversation = createConversation(1, 100);
    await saveMessage(
      conversation.id,
      {
        id: 'u1',
        role: 'user',
        content: '我的问题',
        createdAt: 101,
        attachments: [
          {
            id: 'image-1',
            kind: 'image',
            name: 'test.png',
            mimeType: 'image/png',
            size: 4,
            data: 'AQID',
          },
        ],
      },
      { conversation },
    );
    await saveMessage(conversation.id, {
      id: 'a1',
      role: 'assistant',
      content: '回答',
      createdAt: 102,
    });
    await new MemoryStore().saveSettings({ instructions: '请简洁回答', memoryEnabled: true });
    await new MemoryStore().add('偏好双休');
    data['unrelated-api-key'] = 'secret-value';

    const backup = await createBossPilotBackup();
    const text = serializeBossPilotBackup(backup);
    expect(backup).toMatchObject({
      app: 'BossPilot',
      secretsIncluded: false,
      sourceVersion: '1.0.0',
    });
    expect(text).toContain('我的问题');
    expect(text).not.toContain('secret-value');

    const result = await importBossPilotBackup(text);
    expect(result).toEqual({ conversations: 1, messages: 2, memories: 1 });
    const conversations = await loadConversations();
    expect(conversations).toHaveLength(2);
    const imported = conversations.find(({ id }) => id !== conversation.id);
    expect(await loadMessages(imported?.id ?? '')).toEqual([
      expect.objectContaining({
        role: 'user',
        content: '我的问题',
        attachments: [expect.objectContaining({ kind: 'image', data: 'AQID' })],
      }),
      expect.objectContaining({ role: 'assistant', content: '回答' }),
    ]);
  });

  it('rejects invalid, oversized, empty, or unsupported backup data before writes', async () => {
    await expect(importBossPilotBackup('not json')).rejects.toThrow('JSON');
    await expect(importBossPilotBackup('{}')).rejects.toThrow('受支持');
    await expect(
      importBossPilotBackup(
        JSON.stringify({
          app: 'BossPilot',
          formatVersion: 1,
          exportedAt: 1,
          sourceVersion: '1',
          conversations: [{ title: 'x', createdAt: 1, messages: [] }],
          context: { instructions: '', memoryEnabled: false, memories: [] },
          enabledSkills: [],
          chatSettings: { autoTitle: false },
        }),
      ),
    ).rejects.toThrow('空的会话');
    await expect(importBossPilotBackup('x'.repeat(25 * 1024 * 1024 + 1))).rejects.toThrow('25 MB');
  });

  it('creates a stable dated filename', () => {
    expect(backupFileName(new Date(2026, 7, 3))).toBe('bosspilot-backup-20260803.json');
  });

  it('sanitizes supported text and selection attachments during import', async () => {
    const backup = validBackup();
    firstMessage(backup).attachments = [
      {
        id: 'text-1',
        kind: 'text',
        name: 'notes.bin',
        mimeType: 'application/octet-stream',
        content: 'hello',
      },
      {
        id: 'selection-1',
        kind: 'selection',
        name: '页面选区',
        content: 'selected',
        sourceOrigin: 'https://example.com',
        sourceTitle: 'Example',
      },
    ];
    await importBossPilotBackup(JSON.stringify(backup));
    const [conversation] = await loadConversations();
    const [message] = await loadMessages(conversation?.id ?? '');
    expect(message?.attachments).toEqual([
      expect.objectContaining({ kind: 'text', mimeType: 'text/plain', size: 5 }),
      expect.objectContaining({ kind: 'selection', content: 'selected' }),
    ]);
  });

  it('rejects structural limits and unsupported attachment fields', async () => {
    const tooManyConversations = validBackup();
    tooManyConversations.conversations = Array.from({ length: 201 }, () =>
      firstConversation(validBackup()),
    );
    await expect(importBossPilotBackup(JSON.stringify(tooManyConversations))).rejects.toThrow(
      '会话数量',
    );

    const invalidContext = validBackup();
    invalidContext.context = null;
    await expect(importBossPilotBackup(JSON.stringify(invalidContext))).rejects.toThrow(
      '本地上下文',
    );

    const tooManyMemories = validBackup();
    if (!tooManyMemories.context) throw new Error('missing context');
    tooManyMemories.context.memories = Array.from({ length: 101 }, () => 'memory');
    await expect(importBossPilotBackup(JSON.stringify(tooManyMemories))).rejects.toThrow(
      '记忆数量',
    );

    const invalidSettings = validBackup();
    invalidSettings.enabledSkills = null;
    await expect(importBossPilotBackup(JSON.stringify(invalidSettings))).rejects.toThrow(
      '设置无效',
    );

    const invalidMessage = validBackup();
    firstMessage(invalidMessage).role = 'system';
    await expect(importBossPilotBackup(JSON.stringify(invalidMessage))).rejects.toThrow('无效消息');

    const invalidTime = validBackup();
    firstConversation(invalidTime).createdAt = -1;
    await expect(importBossPilotBackup(JSON.stringify(invalidTime))).rejects.toThrow('无效时间');

    const invalidText = validBackup();
    firstConversation(invalidText).title = ' ';
    await expect(importBossPilotBackup(JSON.stringify(invalidText))).rejects.toThrow('文本字段');

    const unsupportedAttachment = validBackup();
    firstMessage(unsupportedAttachment).attachments = [{ id: 'x', kind: 'binary', name: 'x' }];
    await expect(importBossPilotBackup(JSON.stringify(unsupportedAttachment))).rejects.toThrow(
      '不支持的附件',
    );
  });
});

interface TestBackup {
  app: string;
  formatVersion: number;
  exportedAt: number;
  sourceVersion: string;
  conversations: Array<{
    title: string;
    createdAt: number;
    messages: Array<Record<string, unknown>>;
  }>;
  context: { instructions: string; memoryEnabled: boolean; memories: string[] } | null;
  enabledSkills: string[] | null;
  chatSettings: { autoTitle: boolean };
}

function validBackup(): TestBackup {
  return {
    app: 'BossPilot',
    formatVersion: 1,
    exportedAt: 1,
    sourceVersion: '1.0.0',
    conversations: [
      {
        title: 'Imported',
        createdAt: 1,
        messages: [{ role: 'user', content: 'hello', createdAt: 2 }],
      },
    ],
    context: { instructions: '', memoryEnabled: false, memories: [] },
    enabledSkills: [],
    chatSettings: { autoTitle: false },
  };
}

function firstConversation(backup: TestBackup): TestBackup['conversations'][number] {
  const conversation = backup.conversations[0];
  if (!conversation) throw new Error('missing conversation');
  return conversation;
}

function firstMessage(backup: TestBackup): Record<string, unknown> {
  const message = firstConversation(backup).messages[0];
  if (!message) throw new Error('missing message');
  return message;
}
