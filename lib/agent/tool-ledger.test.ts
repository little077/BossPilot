// ─── ToolLedger 单元测试 ───
// 覆盖：记录构造（id/createdAt 补齐）、参数摘要脱敏截断、查询委托。

import { describe, expect, it, vi } from 'vitest';
import {
  MAX_PARAMS_SUMMARY_CHARS,
  type ToolCallLedgerEntry,
  ToolLedger,
} from '@/lib/agent/tool-ledger';

const entry = (overrides: Partial<ToolCallLedgerEntry> = {}): ToolCallLedgerEntry => ({
  id: 'tool-call-1',
  runId: 'run-1',
  conversationId: 'conv-1',
  name: 'workspace_create',
  risk: 'confirm',
  decision: 'allow',
  approved: true,
  isError: false,
  statusText: '已创建',
  createdAt: 1,
  ...overrides,
});

describe('ToolLedger', () => {
  it('record 补齐 id/createdAt 并委托持久化', async () => {
    const save = vi
      .fn<(entry: ToolCallLedgerEntry) => Promise<void>>()
      .mockResolvedValue(undefined);
    const ledger = new ToolLedger({ save, load: async () => [] });

    await ledger.record(entry());

    expect(save).toHaveBeenCalledOnce();
    const saved = save.mock.calls[0]?.[0];
    expect(saved?.id).toMatch(/^tool-call-/);
    expect(saved?.createdAt).toBeGreaterThan(0);
    expect(saved?.name).toBe('workspace_create');
  });

  it('参数摘要超长时截断到上限', async () => {
    const save = vi
      .fn<(entry: ToolCallLedgerEntry) => Promise<void>>()
      .mockResolvedValue(undefined);
    const ledger = new ToolLedger({ save, load: async () => [] });

    await ledger.record(entry({ paramsSummary: 'x'.repeat(MAX_PARAMS_SUMMARY_CHARS + 100) }));

    const saved = save.mock.calls[0]?.[0];
    expect(saved?.paramsSummary?.length).toBe(MAX_PARAMS_SUMMARY_CHARS);
  });

  it('无参数摘要时不落该字段', async () => {
    const save = vi
      .fn<(entry: ToolCallLedgerEntry) => Promise<void>>()
      .mockResolvedValue(undefined);
    const ledger = new ToolLedger({ save, load: async () => [] });

    await ledger.record(entry({ paramsSummary: undefined }));

    const saved = save.mock.calls[0]?.[0];
    expect(saved?.paramsSummary).toBeUndefined();
  });

  it('recent 委托查询：带会话与不带会话', async () => {
    const load = vi
      .fn<(conversationId: string | undefined, limit: number) => Promise<ToolCallLedgerEntry[]>>()
      .mockResolvedValue([entry()]);
    const ledger = new ToolLedger({ save: async () => {}, load });

    await expect(ledger.recent('conv-1', 50)).resolves.toHaveLength(1);
    expect(load).toHaveBeenCalledWith('conv-1', 50);

    await ledger.recent();
    expect(load).toHaveBeenLastCalledWith(undefined, 200);
  });
});
