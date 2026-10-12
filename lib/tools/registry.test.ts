// ─── 工具注册表单测 ───
// mock 两个工具实现与工件关口：验证登记/绑定输出、执行分发，以及
// 「非 bypass 统一过关口、bypass 直通」这一收口契约。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  execute: vi.fn(),
  executeArtifact: vi.fn(),
  ingest: vi.fn(),
}));

vi.mock('./read-current-page', () => ({
  readCurrentPageTool: {
    name: 'read_current_page',
    description: '测试工具描述',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: hoisted.execute,
  },
}));

vi.mock('./read-artifact', () => ({
  readArtifactTool: {
    name: 'read_artifact',
    description: '取回工件全文',
    parameters: { type: 'object', properties: {}, required: [] },
    artifactBypass: true,
    execute: hoisted.executeArtifact,
  },
}));

vi.mock('@/lib/artifacts/gate', () => ({ ingestToolResult: hoisted.ingest }));

import { executeTool, hasTool, listTools, toBindableToolDefinitions } from './registry';
import type { ToolContext } from './types';

const ctx: ToolContext = { signal: new AbortController().signal };

beforeEach(() => {
  // setup.ts 的 restoreAllMocks 不清理 vi.fn 调用历史，这里显式清理以保证「未被调用」断言可靠。
  vi.clearAllMocks();
});

describe('toBindableToolDefinitions', () => {
  it('输出 bindTools 可直接使用的 OpenAI 函数格式（含全部两个工具）', () => {
    expect(toBindableToolDefinitions()).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_current_page',
          description: '测试工具描述',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_artifact',
          description: '取回工件全文',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ]);
  });
});

describe('listTools / hasTool', () => {
  it('登记的表内可查询到已注册工具', () => {
    expect(listTools().map((tool) => tool.name)).toEqual(['read_current_page', 'read_artifact']);
    expect(hasTool('read_current_page')).toBe(true);
    expect(hasTool('read_artifact')).toBe(true);
    expect(hasTool('read_url')).toBe(false);
  });
});

describe('executeTool 分发与工件关口收口', () => {
  it('普通工具的结果统一过关口，返回关口产物', async () => {
    const raw = { isError: false, summary: 'ok', llmText: '全文' };
    const carded = { isError: false, summary: 'ok', llmText: '引用卡', artifactId: 'a-1' };
    hoisted.execute.mockResolvedValue(raw);
    hoisted.ingest.mockResolvedValue(carded);

    const result = await executeTool('read_current_page', { a: 1 }, ctx);

    expect(hoisted.execute).toHaveBeenCalledWith({ a: 1 }, ctx);
    expect(hoisted.ingest).toHaveBeenCalledWith('read_current_page', raw);
    expect(result).toEqual(carded);
  });

  it('bypass 工具（read_artifact）直通关口：取回全文不再变引用', async () => {
    const fullText = { isError: false, summary: '已取回', llmText: '正文全文' };
    hoisted.executeArtifact.mockResolvedValue(fullText);

    const result = await executeTool('read_artifact', { artifact_id: 'a-1' }, ctx);

    expect(result).toEqual(fullText);
    expect(hoisted.ingest).not.toHaveBeenCalled();
  });

  it('未知工具返回 unknown_tool 结构化错误，不触碰关口', async () => {
    const result = await executeTool('read_url', {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe('unknown_tool');
    expect(result.summary).toContain('read_url');
    expect(result.llmText).toContain('unknown_tool');
    expect(hoisted.execute).not.toHaveBeenCalled();
    expect(hoisted.ingest).not.toHaveBeenCalled();
  });

  it('未知工具名超长时截断到 120 字符', async () => {
    const result = await executeTool('x'.repeat(200), {}, ctx);
    expect(result.summary).toContain('x'.repeat(120));
    expect(result.summary).not.toContain('x'.repeat(121));
  });

  it('参数不是普通对象（数组 / null）返回 invalid_arguments', async () => {
    const arrayResult = await executeTool(
      'read_current_page',
      [] as unknown as Record<string, unknown>,
      ctx,
    );
    expect(arrayResult.errorCode).toBe('invalid_arguments');

    const nullResult = await executeTool(
      'read_current_page',
      null as unknown as Record<string, unknown>,
      ctx,
    );
    expect(nullResult.errorCode).toBe('invalid_arguments');
    expect(hoisted.execute).not.toHaveBeenCalled();
  });
});
