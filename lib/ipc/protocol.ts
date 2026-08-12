// ─── Port 通信协议：Sidepanel（Client） ↔ Background（Server） ───
// 单一事实源：所有跨侧边栏/后台的消息类型都定义在这里。
// 采用长连接 Port（chrome.runtime.connect），后台以流式方式广播任务快照。

import type { ChatMessage } from '@/lib/domain/chat';
import type { ProviderStateView, SearchTaskParams, TaskSnapshot } from '@/lib/domain/types';
import type { McpSettingsView } from '@/lib/mcp/types';
import type { AgentContextView } from '@/lib/memory/types';
import type { SkillSettingsView } from '@/lib/skills/types';

export const AGENT_PORT_NAME = 'bosspilot-agent';

// ─── Client → Background ───

export type ClientMessage =
  /** 侧边栏连接后先声明订阅，后台回放当前任务快照（若有）。 */
  | { type: 'subscribe' }
  /** 流式对话：发送完整会话历史（由侧边栏持有并持久化，SW 无状态更健壮）。 */
  | { type: 'chat'; requestId: string; conversationId: string; messages: ChatMessage[] }
  /** 主回复完成后的可选低成本标题生成；只返回短标题，不接触本地存储。 */
  | {
      type: 'summarize_conversation';
      requestId: string;
      conversationId: string;
      messages: ChatMessage[];
    }
  /** 用户对当前页精确来源权限作出决定后，恢复同一轮只读工具调用。 */
  | {
      type: 'page_permission_result';
      requestId: string;
      granted: boolean;
      messages: ChatMessage[];
    }
  /** 回答底部 Ask User 面板后，从持久化暂停点继续原 Agent 循环。 */
  | {
      type: 'ask_user_result';
      requestId: string;
      answer: string;
      messages: ChatMessage[];
    }
  /** 直接用自然语言发起一次任务（后台先做意图解析再执行）。 */
  | { type: 'run_nl'; text: string }
  /** 用已确认的结构化参数发起任务（任务卡片/编辑后确认走这条）。 */
  | { type: 'run_params'; params: SearchTaskParams }
  /** 取消当前任务（含流式对话）。 */
  | { type: 'cancel'; scope?: 'chat' | 'task'; requestId?: string }
  /** 清空会话历史时同时清掉 Background 中用于断线恢复的最后一轮快照。 */
  | { type: 'clear_chat' }
  /** 验证码已手动通过，请求继续。 */
  | { type: 'resume_captcha' }
  /** 下载执行日志与当前 Boss 页面结构诊断（经 chrome.downloads 落盘）。 */
  | { type: 'download_diagnostics' }
  /** 仅解析自然语言、不执行，用于「先确认参数再跑」。 */
  | { type: 'parse_only'; text: string };

// ─── Background → Client ───

export type ServerMessage =
  | { type: 'connected' }
  | { type: 'chat_state'; running: boolean; requestId?: string }
  /** 任务快照全量广播（phase/进度/已采集岗位）。 */
  | { type: 'snapshot'; snapshot: TaskSnapshot }
  /** parse_only 的结果：解析出的参数，交 UI 渲染成可编辑任务卡片。 */
  | { type: 'parsed'; params: SearchTaskParams }
  /** 一条面向用户的日志/提示（追加到对话流）。 */
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  /** 流式对话开始：UI 追加一条空的 assistant 消息占位（messageId 用于对齐）。 */
  | { type: 'stream_start'; requestId: string; message: ChatMessage }
  /**
   * 每次发送当前 assistant 全量快照，而不是让 UI 依赖从未丢失过任何 delta。
   * 断线重连后可以安全地用同一 message.id 覆盖恢复。
   */
  | { type: 'stream_update'; requestId: string; message: ChatMessage }
  | { type: 'stream_end'; requestId: string; message: ChatMessage }
  | { type: 'stream_error'; requestId: string; message: ChatMessage }
  | { type: 'conversation_title'; requestId: string; conversationId: string; title: string }
  | { type: 'conversation_title_error'; requestId: string; conversationId: string }
  /** 出错。 */
  | { type: 'error'; text: string; requestId?: string };

const MAX_CHAT_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_CHAT_CHARS = 500_000;
const MAX_CHAT_ATTACHMENT_CHARS = 6_000_000;

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'subscribe':
    case 'resume_captcha':
    case 'download_diagnostics':
    case 'clear_chat':
      return true;
    case 'chat':
    case 'summarize_conversation':
      return (
        isBoundedString(value.requestId, 128) &&
        isBoundedString(value.conversationId, 128) &&
        isChatHistory(value.messages)
      );
    case 'page_permission_result':
      return (
        isBoundedString(value.requestId, 128) &&
        typeof value.granted === 'boolean' &&
        isChatHistory(value.messages)
      );
    case 'ask_user_result':
      return (
        isBoundedString(value.requestId, 128) &&
        isBoundedString(value.answer, 2_000) &&
        isChatHistory(value.messages)
      );
    case 'run_nl':
    case 'parse_only':
      return isBoundedString(value.text, 20_000);
    case 'run_params':
      return isRecord(value.params);
    case 'cancel':
      return (
        (value.scope === undefined || value.scope === 'chat' || value.scope === 'task') &&
        (value.requestId === undefined || isBoundedString(value.requestId, 128))
      );
    default:
      return false;
  }
}

function isChatHistory(value: unknown): value is ChatMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_CHAT_MESSAGES &&
    value.every(isChatMessage) &&
    value.reduce(
      (total, message) =>
        total +
        (isRecord(message) && typeof message.content === 'string' ? message.content.length : 0),
      0,
    ) <= MAX_CHAT_CHARS &&
    value.reduce(
      (total, message) =>
        total +
        (isRecord(message) && Array.isArray(message.attachments)
          ? message.attachments.reduce(
              (sum: number, attachment: unknown) => sum + attachmentPayloadChars(attachment),
              0,
            )
          : 0),
      0,
    ) <= MAX_CHAT_ATTACHMENT_CHARS
  );
}

// ─── 多模型配置：一次性 Runtime Message ───
// 密钥只允许出现在 Sidepanel → Background 的 connect 命令中，任何响应都不得回传明文。

export type ProviderCommand =
  | { type: 'providers:get' }
  | { type: 'providers:issue'; providerId: string }
  | {
      type: 'providers:connect';
      providerId: string;
      apiKey: string;
      baseUrl?: string;
    }
  | { type: 'providers:select'; providerId: string; modelId: string }
  | {
      type: 'providers:set-image-input';
      providerId: string;
      modelId: string;
      enabled: boolean;
    }
  | {
      type: 'providers:add-manual-model';
      providerId: string;
      modelId: string;
      apiKey: string;
      baseUrl?: string;
    }
  | { type: 'providers:remove'; providerId: string };

export type ProviderCommandResponse =
  | { ok: true; state: ProviderStateView }
  | { ok: false; error: string };

export type SkillCommand =
  | { type: 'skills:get' }
  | { type: 'skills:set-enabled'; name: string; enabled: boolean };

export type SkillCommandResponse =
  | { ok: true; state: SkillSettingsView }
  | { ok: false; error: string };

export type AgentContextCommand =
  | { type: 'context:get' }
  | { type: 'context:save-settings'; instructions: string; memoryEnabled: boolean }
  | { type: 'context:add-memory'; content: string }
  | { type: 'context:update-memory'; id: string; content: string }
  | { type: 'context:remove-memory'; id: string }
  | { type: 'context:clear-memories' };

export type AgentContextCommandResponse =
  | { ok: true; state: AgentContextView }
  | { ok: false; error: string };

export type McpCommand =
  | { type: 'mcp:get' }
  | { type: 'mcp:save'; id?: string; name: string; url: string; token: string }
  | { type: 'mcp:set-enabled'; id: string; enabled: boolean }
  | { type: 'mcp:remove'; id: string };

export type McpCommandResponse =
  | { ok: true; state: McpSettingsView }
  | { ok: false; error: string };

export function isMcpCommand(value: unknown): value is McpCommand {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'mcp:get':
      return true;
    case 'mcp:save':
      return (
        (value.id === undefined || isBoundedString(value.id, 128)) &&
        isBoundedString(value.name, 80) &&
        isBoundedString(value.url, 2_048) &&
        typeof value.token === 'string' &&
        value.token.length <= 16_384
      );
    case 'mcp:set-enabled':
      return isBoundedString(value.id, 128) && typeof value.enabled === 'boolean';
    case 'mcp:remove':
      return isBoundedString(value.id, 128);
    default:
      return false;
  }
}

export function isAgentContextCommand(value: unknown): value is AgentContextCommand {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'context:get':
    case 'context:clear-memories':
      return true;
    case 'context:save-settings':
      return (
        typeof value.instructions === 'string' &&
        value.instructions.length <= 4_000 &&
        typeof value.memoryEnabled === 'boolean'
      );
    case 'context:add-memory':
      return isBoundedString(value.content, 500);
    case 'context:update-memory':
      return isBoundedString(value.id, 128) && isBoundedString(value.content, 500);
    case 'context:remove-memory':
      return isBoundedString(value.id, 128);
    default:
      return false;
  }
}

export function isSkillCommand(value: unknown): value is SkillCommand {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'skills:get') return true;
  return (
    value.type === 'skills:set-enabled' &&
    isBoundedString(value.name, 64) &&
    typeof value.enabled === 'boolean'
  );
}

export function isProviderCommand(value: unknown): value is ProviderCommand {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'providers:get':
      return true;
    case 'providers:issue':
    case 'providers:remove':
      return isBoundedString(value.providerId, 64);
    case 'providers:select':
      return isBoundedString(value.providerId, 64) && isBoundedString(value.modelId, 256);
    case 'providers:set-image-input':
      return (
        isBoundedString(value.providerId, 64) &&
        isBoundedString(value.modelId, 256) &&
        typeof value.enabled === 'boolean'
      );
    case 'providers:connect':
      return (
        isBoundedString(value.providerId, 64) &&
        typeof value.apiKey === 'string' &&
        value.apiKey.length <= 16_384 &&
        (value.baseUrl === undefined || isBoundedString(value.baseUrl, 2_048))
      );
    case 'providers:add-manual-model':
      return (
        isBoundedString(value.providerId, 64) &&
        isBoundedString(value.modelId, 256) &&
        typeof value.apiKey === 'string' &&
        value.apiKey.length <= 16_384 &&
        (value.baseUrl === undefined || isBoundedString(value.baseUrl, 2_048))
      );
    default:
      return false;
  }
}

function isChatMessage(value: unknown): value is ChatMessage {
  return (
    isRecord(value) &&
    isBoundedString(value.id, 256) &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' &&
    value.content.length <= MAX_MESSAGE_CHARS &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    (value.attachments === undefined ||
      (Array.isArray(value.attachments) &&
        value.attachments.length <= 3 &&
        value.attachments.every(isChatAttachment)))
  );
}

function isChatAttachment(value: unknown): boolean {
  if (!isRecord(value) || !isBoundedString(value.id, 128) || !isBoundedString(value.name, 120)) {
    return false;
  }
  if (value.kind === 'image') {
    return (
      (value.mimeType === 'image/jpeg' ||
        value.mimeType === 'image/png' ||
        value.mimeType === 'image/webp') &&
      typeof value.size === 'number' &&
      value.size >= 0 &&
      value.size <= 2 * 1024 * 1024 &&
      typeof value.data === 'string' &&
      value.data.length <= 2_800_000 &&
      /^[A-Za-z0-9+/]*={0,2}$/u.test(value.data)
    );
  }
  if (value.kind === 'text') {
    return (
      (value.mimeType === 'text/plain' ||
        value.mimeType === 'text/markdown' ||
        value.mimeType === 'application/json' ||
        value.mimeType === 'text/csv') &&
      typeof value.size === 'number' &&
      value.size >= 0 &&
      value.size <= 200 * 1024 &&
      isBoundedString(value.content, 200 * 1024)
    );
  }
  return (
    value.kind === 'selection' &&
    isBoundedString(value.content, 8_000) &&
    typeof value.sourceOrigin === 'string' &&
    value.sourceOrigin.length <= 2_048 &&
    typeof value.sourceTitle === 'string' &&
    value.sourceTitle.length <= 200
  );
}

function attachmentPayloadChars(value: unknown): number {
  if (!isRecord(value)) return 0;
  if (typeof value.data === 'string') return value.data.length;
  if (typeof value.content === 'string') return value.content.length;
  return 0;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
