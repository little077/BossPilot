import type { ChatAttachment, ChatMessage } from '@/lib/domain/chat';
import { MemoryStore } from '@/lib/memory/store';
import { SkillStore } from '@/lib/skills/store';
import { getChatHistorySettings, setChatHistorySettings } from '@/lib/storage/config';
import {
  createConversation,
  loadConversations,
  loadMessages,
  renameConversation,
  saveMessage,
} from '@/lib/storage/db';

const MAX_BACKUP_CHARS = 25 * 1024 * 1024;
const MAX_CONVERSATIONS = 200;
const MAX_MESSAGES = 10_000;
const MAX_MESSAGE_CHARS = 200_000;

export interface BossPilotBackup {
  app: 'BossPilot';
  formatVersion: 1;
  exportedAt: number;
  sourceVersion: string;
  secretsIncluded: false;
  conversations: PortableConversation[];
  context: {
    instructions: string;
    memoryEnabled: boolean;
    memories: string[];
  };
  enabledSkills: string[];
  chatSettings: { autoTitle: boolean };
}

interface PortableConversation {
  title: string;
  createdAt: number;
  messages: PortableMessage[];
}

interface PortableMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  attachments?: ChatAttachment[];
}

export interface BackupImportResult {
  conversations: number;
  messages: number;
  memories: number;
}

export async function createBossPilotBackup(): Promise<BossPilotBackup> {
  const [summaries, context, skills, chatSettings] = await Promise.all([
    loadConversations(),
    new MemoryStore().view(),
    new SkillStore().list(),
    getChatHistorySettings(),
  ]);
  const conversations: PortableConversation[] = [];
  for (const summary of summaries.slice(0, MAX_CONVERSATIONS)) {
    conversations.push({
      title: summary.title,
      createdAt: summary.createdAt,
      messages: (await loadMessages(summary.id)).map(toPortableMessage),
    });
  }
  return {
    app: 'BossPilot',
    formatVersion: 1,
    exportedAt: Date.now(),
    sourceVersion: chrome.runtime.getManifest().version,
    secretsIncluded: false,
    conversations,
    context: {
      instructions: context.settings.instructions,
      memoryEnabled: context.settings.memoryEnabled,
      memories: context.memories.map(({ content }) => content),
    },
    enabledSkills: skills.skills.filter(({ enabled }) => enabled).map(({ name }) => name),
    chatSettings,
  };
}

export async function importBossPilotBackup(text: string): Promise<BackupImportResult> {
  const backup = parseBackup(text);
  const current = await loadConversations();
  let ordinal = current.reduce((max, item) => Math.max(max, item.ordinal), 0);
  let messageCount = 0;

  for (const item of backup.conversations) {
    ordinal += 1;
    const conversation = createConversation(ordinal, item.createdAt);
    for (const [index, message] of item.messages.entries()) {
      await saveMessage(
        conversation.id,
        {
          ...message,
          id: crypto.randomUUID(),
          ...(message.attachments
            ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
            : {}),
        },
        index === 0 ? { conversation, unread: false } : { unread: false },
      );
      messageCount += 1;
    }
    await renameConversation(conversation.id, item.title);
  }

  const memory = new MemoryStore();
  const currentContext = await memory.view();
  await memory.saveSettings({
    instructions: currentContext.settings.instructions || backup.context.instructions,
    memoryEnabled: currentContext.settings.memoryEnabled || backup.context.memoryEnabled,
  });
  for (const content of [...backup.context.memories].reverse()) await memory.add(content);

  const skillStore = new SkillStore();
  const knownSkills = await skillStore.list();
  const enabled = new Set(backup.enabledSkills);
  for (const skill of knownSkills.skills) {
    if (enabled.has(skill.name)) await skillStore.setEnabled(skill.name, true);
  }
  const currentChatSettings = await getChatHistorySettings();
  await setChatHistorySettings({
    autoTitle: currentChatSettings.autoTitle || backup.chatSettings.autoTitle,
  });

  return {
    conversations: backup.conversations.length,
    messages: messageCount,
    memories: backup.context.memories.length,
  };
}

export function serializeBossPilotBackup(backup: BossPilotBackup): string {
  return JSON.stringify(backup, null, 2);
}

export function backupFileName(now = new Date()): string {
  const part = (value: number) => String(value).padStart(2, '0');
  return `bosspilot-backup-${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}.json`;
}

function parseBackup(text: string): BossPilotBackup {
  if (!text || text.length > MAX_BACKUP_CHARS) throw new Error('备份文件为空或超过 25 MB。');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('备份文件不是有效的 JSON。');
  }
  if (!isRecord(value) || value.app !== 'BossPilot' || value.formatVersion !== 1) {
    throw new Error('这不是受支持的 BossPilot 备份。');
  }
  if (!Array.isArray(value.conversations) || value.conversations.length > MAX_CONVERSATIONS) {
    throw new Error('备份中的会话数量无效。');
  }
  const conversations = value.conversations.map(parseConversation);
  const messageCount = conversations.reduce((total, item) => total + item.messages.length, 0);
  if (messageCount > MAX_MESSAGES) throw new Error('备份中的消息数量超过 10000 条。');
  if (!isRecord(value.context) || !Array.isArray(value.context.memories)) {
    throw new Error('备份中的本地上下文无效。');
  }
  const instructions = boundedText(value.context.instructions, 4_000, true);
  const memories = value.context.memories.map((item) => boundedText(item, 500, false));
  if (memories.length > 100) throw new Error('备份中的记忆数量超过 100 条。');
  if (!Array.isArray(value.enabledSkills) || !isRecord(value.chatSettings)) {
    throw new Error('备份中的设置无效。');
  }
  return {
    app: 'BossPilot',
    formatVersion: 1,
    exportedAt: finiteNumber(value.exportedAt),
    sourceVersion: boundedText(value.sourceVersion, 40, false),
    secretsIncluded: false,
    conversations,
    context: {
      instructions,
      memoryEnabled: value.context.memoryEnabled === true,
      memories,
    },
    enabledSkills: value.enabledSkills.map((item) => boundedText(item, 128, false)),
    chatSettings: { autoTitle: value.chatSettings.autoTitle === true },
  };
}

function parseConversation(value: unknown): PortableConversation {
  if (!isRecord(value) || !Array.isArray(value.messages) || !value.messages.length) {
    throw new Error('备份中存在无效或空的会话。');
  }
  return {
    title: boundedText(value.title, 60, false),
    createdAt: finiteNumber(value.createdAt),
    messages: value.messages.map(parseMessage),
  };
}

function parseMessage(value: unknown): PortableMessage {
  if (!isRecord(value) || (value.role !== 'user' && value.role !== 'assistant')) {
    throw new Error('备份中存在无效消息。');
  }
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.map(parseAttachment)
    : undefined;
  return {
    role: value.role,
    content: boundedText(value.content, MAX_MESSAGE_CHARS, true),
    createdAt: finiteNumber(value.createdAt),
    ...(attachments?.length ? { attachments } : {}),
  };
}

function parseAttachment(value: unknown): ChatAttachment {
  if (!isRecord(value)) throw new Error('备份中存在无效附件。');
  const id = boundedText(value.id, 128, false);
  const name = boundedText(value.name, 200, false);
  if (
    value.kind === 'image' &&
    (value.mimeType === 'image/jpeg' ||
      value.mimeType === 'image/png' ||
      value.mimeType === 'image/webp')
  ) {
    const data = boundedText(value.data, 2_800_000, false);
    return { id, kind: 'image', name, mimeType: value.mimeType, size: data.length, data };
  }
  if (value.kind === 'text') {
    const mimeType =
      value.mimeType === 'text/markdown' ||
      value.mimeType === 'application/json' ||
      value.mimeType === 'text/csv'
        ? value.mimeType
        : 'text/plain';
    const content = boundedText(value.content, 200_000, true);
    return { id, kind: 'text', name, mimeType, size: content.length, content };
  }
  if (value.kind === 'selection') {
    return {
      id,
      kind: 'selection',
      name,
      content: boundedText(value.content, 20_000, false),
      sourceOrigin: boundedText(value.sourceOrigin, 500, true),
      sourceTitle: boundedText(value.sourceTitle, 500, true),
    };
  }
  throw new Error('备份中存在不支持的附件。');
}

function toPortableMessage(message: ChatMessage): PortableMessage {
  return {
    role: message.role,
    content: message.content || message.errorMessage || '',
    createdAt: message.createdAt,
    ...(message.attachments
      ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
  };
}

function boundedText(value: unknown, max: number, allowEmpty: boolean): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    throw new Error('备份中存在长度无效的文本字段。');
  }
  return value.replaceAll('\u0000', '');
}

function finiteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('备份中存在无效时间。');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
