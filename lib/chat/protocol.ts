// ─── Port 通信协议：Sidepanel（Client） ↔ Background（Server） ───
// 单一事实源：所有跨侧边栏/后台的消息类型都定义在这里。
// 采用长连接 Port（chrome.runtime.connect）：既是流式通道，也是 MV3
// Service Worker 的保活信号（活跃 Port 会不断重置后台的空闲计时器）。

import type { TurnTrace } from '@/lib/diagnostics/trace';
import type { ChatMessage } from '@/lib/domain/chat';
import type { ModelCatalogEntry, ModelConfigView } from '@/lib/domain/types';

export const AGENT_PORT_NAME = 'bosspilot-agent';

// ─── Client → Background ───

export type ClientMessage =
  /** 侧边栏连接后先声明订阅，后台回放当前正在生成的一轮（若有）。 */
  | { type: 'subscribe' }
  /** 流式对话：发送完整会话历史（由侧边栏持有并持久化，SW 无状态更健壮）。 */
  | { type: 'chat'; requestId: string; messages: ChatMessage[] }
  /** 取消当前这轮生成（AbortController）。 */
  | { type: 'cancel'; requestId: string }
  /** 清空会话历史时同时清掉后台的断线恢复快照。 */
  | { type: 'clear_chat' }
  /** 读取脱敏配置快照。 */
  | { type: 'config:get'; requestId: string }
  /** 保存模型配置（含明文密钥，仅在扩展内传输，落库前加密）。 */
  | {
      type: 'config:set';
      requestId: string;
      baseUrl: string;
      model: string;
      apiKey: string;
      /** 长会话自动压缩开关；缺省时后台沿用既有值。 */
      compactEnabled?: boolean;
    }
  /**
   * 拉取厂商模型目录（对齐主分支「领卡→开通→拉目录→选模型」）。
   * apiKey 传空串时后台回退到已保存密钥（UX：已配置用户只点一下即可刷新列表）。
   */
  | { type: 'models:fetch'; requestId: string; baseUrl: string; apiKey: string }
  /**
   * 请求最近一轮结构化轨迹（最薄观测）：界面只读，后台读 latestTrace 后经
   * trace_state 回传；写入仍只发生在后台，界面永不调 putTrace。
   */
  | { type: 'trace:latest'; requestId: string };

// ─── Background → Client ───

export type ServerMessage =
  | { type: 'connected' }
  | { type: 'chat_state'; running: boolean; requestId?: string }
  /** 流式对话开始：UI 追加一条空的 assistant 消息占位。 */
  | { type: 'stream_start'; requestId: string; message: ChatMessage }
  /**
   * 每次发送当前 assistant 全量快照，而不是让 UI 依赖从未丢失过任何 delta。
   * 断线重连后可以安全地用同一 message.id 覆盖恢复。
   */
  | { type: 'stream_update'; requestId: string; message: ChatMessage }
  | { type: 'stream_end'; requestId: string; message: ChatMessage }
  | { type: 'stream_error'; requestId: string; message: ChatMessage }
  /** config:get / config:set 的脱敏结果。 */
  | { type: 'config_state'; requestId: string; config: ModelConfigView }
  /**
   * models:fetch 的结果。失败也走这里（models 为空 + error 文本），
   * 以免与生成流的 error 通道混用、被误当成一条对话错误消息。
   */
  | { type: 'models_state'; requestId: string; models: ModelCatalogEntry[]; error?: string }
  /** trace:latest 的结果：最近一轮轨迹；无记录时为 null（UI 据此提示「暂无」）。 */
  | { type: 'trace_state'; requestId: string; trace: TurnTrace | null }
  /** 出错。 */
  | { type: 'error'; text: string; requestId?: string };

const MAX_CHAT_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_CHAT_CHARS = 500_000;
// 单条 assistant 消息里循环工具卡片的上限：与循环最大轮次同源（不超循环能产生的数量）。
const MAX_TOOL_CARDS = 8;

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'subscribe':
    case 'clear_chat':
      return true;
    case 'cancel':
      return isBoundedString(value.requestId, 128);
    case 'chat':
      return (
        isBoundedString(value.requestId, 128) &&
        Array.isArray(value.messages) &&
        value.messages.length > 0 &&
        value.messages.length <= MAX_CHAT_MESSAGES &&
        value.messages.every(isChatMessage) &&
        value.messages.reduce(
          (total, message) =>
            total +
            (isRecord(message) && typeof message.content === 'string' ? message.content.length : 0),
          0,
        ) <= MAX_CHAT_CHARS
      );
    case 'config:get':
      return isBoundedString(value.requestId, 128);
    case 'models:fetch':
      return (
        isBoundedString(value.requestId, 128) &&
        isBoundedString(value.baseUrl, 2_048) &&
        typeof value.apiKey === 'string' &&
        value.apiKey.length <= 16_384
      );
    case 'trace:latest':
      return isBoundedString(value.requestId, 128);
    case 'config:set':
      return (
        isBoundedString(value.requestId, 128) &&
        isBoundedString(value.baseUrl, 2_048) &&
        // model 允许为空串：首次「保存密钥 → 拉模型目录 → 再选模型」的闭环里，
        // 用户点「开通并获取模型」时还没选定任何模型，此时先落库密钥，空 model 是
        // 合法中间态。若按非空校验会把这条消息判为非法，导致密钥存不进去。
        typeof value.model === 'string' &&
        value.model.length <= 256 &&
        typeof value.apiKey === 'string' &&
        value.apiKey.length <= 16_384 &&
        // compactEnabled 可缺省（沿用既有值）；出现时必须是布尔。
        (value.compactEnabled === undefined || typeof value.compactEnabled === 'boolean')
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
    (value.toolCall === undefined || isToolCallView(value.toolCall)) &&
    (value.toolCalls === undefined ||
      (Array.isArray(value.toolCalls) &&
        value.toolCalls.length <= MAX_TOOL_CARDS &&
        value.toolCalls.every(isToolCallView))) &&
    (value.compacted === undefined ||
      (isRecord(value.compacted) &&
        typeof value.compacted.rounds === 'number' &&
        Number.isFinite(value.compacted.rounds)))
  );
}

/** 工具卡片展示记录：随 assistant 消息持久化后，重发历史时必须仍能通过校验。 */
function isToolCallView(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedString(value.name, 128) &&
    (value.id === undefined || isBoundedString(value.id, 128)) &&
    (value.status === 'running' || value.status === 'success' || value.status === 'error') &&
    (value.summary === undefined || isBoundedString(value.summary, 512)) &&
    (value.errorCode === undefined || isBoundedString(value.errorCode, 64))
  );
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
