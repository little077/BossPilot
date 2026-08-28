// ─── 工具调用台账 ───
// 每次工具调用的结构化记录：策略决策、是否获批准、耗时、结果与参数摘要。
// 数据落 IndexedDB（v6 runToolCalls 表），供诊断报告回放「模型每一步做了什么、
// 策略引擎如何放行」。参数摘要入库前脱敏截断，只留可定位问题的最小信息。

import type { ToolRisk } from '@/lib/agent/tool-catalog';
import { redact } from '@/lib/diagnostics/redaction';
import { loadRecentToolCalls, saveToolCall } from '@/lib/storage/db';

/** 台账单条记录：一次工具调用的完整生命周期（策略决策 + 执行结果）。 */
export interface ToolCallLedgerEntry {
  id: string;
  runId: string;
  conversationId: string;
  name: string;
  risk: ToolRisk;
  decision: 'allow' | 'confirm' | 'deny';
  /** 消费式授权是否命中（confirm 工具被用户确认过为 true）。 */
  approved: boolean;
  isError: boolean;
  statusText?: string;
  /** 脱敏截断后的参数摘要，仅用于定位（不存完整参数）。 */
  paramsSummary?: string;
  costMs?: number;
  createdAt: number;
}

/** 参数摘要保留的最大字符数。 */
export const MAX_PARAMS_SUMMARY_CHARS = 200;

export interface ToolLedgerOptions {
  save?: (entry: ToolCallLedgerEntry) => Promise<void>;
  load?: (conversationId: string | undefined, limit: number) => Promise<ToolCallLedgerEntry[]>;
}

/** 记录与查询工具调用台账；默认落 IndexedDB，测试可注入内存实现。 */
export class ToolLedger {
  private readonly save: NonNullable<ToolLedgerOptions['save']>;
  private readonly load: NonNullable<ToolLedgerOptions['load']>;

  constructor(options: ToolLedgerOptions = {}) {
    this.save = options.save ?? saveToolCall;
    this.load = options.load ?? loadRecentToolCalls;
  }

  /** 记录一次工具调用（补全 id/createdAt，参数摘要脱敏截断）。 */
  record(entry: Omit<ToolCallLedgerEntry, 'id' | 'createdAt'>): Promise<void> {
    const paramsSummary = entry.paramsSummary
      ? redact(entry.paramsSummary).slice(0, MAX_PARAMS_SUMMARY_CHARS)
      : undefined;
    return this.save({
      ...entry,
      paramsSummary,
      id: `tool-call-${crypto.randomUUID()}`,
      createdAt: Date.now(),
    });
  }

  /** 读取最近记录；不传会话时返回全局最近记录。 */
  recent(conversationId?: string, limit = 200): Promise<ToolCallLedgerEntry[]> {
    return this.load(conversationId, limit);
  }
}
