// ─── 工件关口单测 ───
// mock 档案柜（不落真实 IndexedDB）：验证失败直通、成功落地与引用卡形态。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '@/lib/tools/types';

const hoisted = vi.hoisted(() => ({
  putArtifact: vi.fn(async (input: { tool: string; summary: string; text: string }) => ({
    id: 'a3f8c2e1-0000-0000-0000-000000000000',
    createdAt: 1700000000000,
    ...input,
  })),
}));

vi.mock('./store', () => ({ putArtifact: hoisted.putArtifact }));

import { ingestToolResult, PREVIEW_LIMIT } from './gate';

const okResult = (overrides: Partial<ToolResult> = {}): ToolResult => ({
  isError: false,
  summary: '已读取《测试页面》· 32000 字',
  llmText: '正文'.repeat(4000),
  ...overrides,
});

beforeEach(() => {
  // setup.ts 的 restoreAllMocks 不清理调用历史，显式清理以保证「未被调用」断言可靠。
  vi.clearAllMocks();
});

describe('ingestToolResult', () => {
  it('失败结果直通：不落地、原样返回', async () => {
    const failed: ToolResult = {
      isError: true,
      errorCode: 'timeout',
      summary: '超时了',
      llmText: '[工具执行失败]',
    };

    const result = await ingestToolResult('read_current_page', failed);

    expect(result).toBe(failed);
    expect(hoisted.putArtifact).not.toHaveBeenCalled();
  });

  it('成功结果落地全文并替换为引用卡，透出 artifactId，保留其余字段', async () => {
    const input = okResult({ data: { url: 'https://example.com' } });

    const result = await ingestToolResult('read_current_page', input);

    expect(hoisted.putArtifact).toHaveBeenCalledWith({
      tool: 'read_current_page',
      summary: input.summary,
      text: input.llmText,
    });
    expect(result.artifactId).toBe('a3f8c2e1-0000-0000-0000-000000000000');
    expect(result.summary).toBe(input.summary);
    expect(result.data).toEqual({ url: 'https://example.com' });
    // 原文不再整体出现在模型可见文本里
    expect(result.llmText).not.toBe(input.llmText);
  });

  it('超长正文：引用卡只带前 PREVIEW_LIMIT 字预览并注明截断', async () => {
    const text = `首段${'中'.repeat(PREVIEW_LIMIT)}尾段`;
    const result = await ingestToolResult('read_current_page', okResult({ llmText: text }));

    expect(result.llmText).toContain(`预览（前 ${PREVIEW_LIMIT} 字，已截断）`);
    expect(result.llmText).toContain(`全文共 ${PREVIEW_LIMIT + 4} 字`);
    expect(result.llmText).not.toContain('尾段');
  });

  it('短正文：预览即全文，不出现截断字样', async () => {
    const result = await ingestToolResult('read_current_page', okResult({ llmText: '很短的正文' }));

    expect(result.llmText).toContain('预览即全文');
    expect(result.llmText).toContain('很短的正文');
    expect(result.llmText).not.toContain('已截断');
  });

  it('引用卡包含编号、溯源、取回指引与不可信输入提醒', async () => {
    const result = await ingestToolResult('read_current_page', okResult({ llmText: 'x' }));

    expect(result.llmText).toContain('[工件 a3f8c2e1-0000-0000-0000-000000000000');
    expect(result.llmText).toContain('由工具 read_current_page 产出');
    expect(result.llmText).toContain('摘要：已读取《测试页面》· 32000 字');
    expect(result.llmText).toContain('调用工具 read_artifact 并传入上述工件编号');
    expect(result.llmText).toContain('不可信输入');
  });
});
