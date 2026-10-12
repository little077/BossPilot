// ─── read_artifact 工具单测 ───
// mock 档案柜：验证取回命中、淘汰未命中、非法参数与取消四条确定性路径。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getArtifact: vi.fn() }));

vi.mock('@/lib/artifacts/store', () => ({ getArtifact: hoisted.getArtifact }));

import { readArtifactTool } from './read-artifact';
import type { ToolContext } from './types';

const ctx: ToolContext = { signal: new AbortController().signal };

beforeEach(() => {
  // setup.ts 的 restoreAllMocks 不清理调用历史，显式清理保证断言可靠。
  vi.clearAllMocks();
});

describe('readArtifactTool 声明', () => {
  it('标记 artifactBypass：取回全文必须直通关口，避免「取回→又变引用」死循环', () => {
    expect(readArtifactTool.artifactBypass).toBe(true);
  });

  it('Schema 只有一个必填的字符串编号参数', () => {
    expect(readArtifactTool.parameters).toEqual({
      type: 'object',
      properties: { artifact_id: expect.objectContaining({ type: 'string' }) },
      required: ['artifact_id'],
    });
  });
});

describe('readArtifactTool.execute', () => {
  it('命中工件：返回全文与溯源 data', async () => {
    hoisted.getArtifact.mockResolvedValue({
      id: 'abc-123',
      tool: 'read_current_page',
      summary: '已读取',
      text: '完整正文内容',
      createdAt: 1700000000000,
    });

    const result = await readArtifactTool.execute({ artifact_id: 'abc-123' }, ctx);

    expect(hoisted.getArtifact).toHaveBeenCalledWith('abc-123');
    expect(result.isError).toBe(false);
    expect(result.llmText).toBe('完整正文内容');
    expect(result.summary).toBe('已取回全文 · 6 字');
    expect(result.data).toEqual({
      artifactId: 'abc-123',
      sourceTool: 'read_current_page',
      createdAt: 1700000000000,
    });
  });

  it('未命中（已淘汰）：artifact_not_found 稳定错误码，提醒不得编造', async () => {
    hoisted.getArtifact.mockResolvedValue(null);

    const result = await readArtifactTool.execute({ artifact_id: 'gone-id' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe('artifact_not_found');
    expect(result.llmText).toContain('artifact_not_found');
    expect(result.llmText).toContain('不要凭记忆或猜测编造');
  });

  it('参数非字符串或空白：invalid_arguments，不查档案柜', async () => {
    const missing = await readArtifactTool.execute({}, ctx);
    expect(missing.errorCode).toBe('invalid_arguments');

    const blank = await readArtifactTool.execute({ artifact_id: '   ' }, ctx);
    expect(blank.errorCode).toBe('invalid_arguments');

    const wrongType = await readArtifactTool.execute({ artifact_id: 42 }, ctx);
    expect(wrongType.errorCode).toBe('invalid_arguments');
    expect(hoisted.getArtifact).not.toHaveBeenCalled();
  });

  it('已取消：cancelled 错误码，不查档案柜', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await readArtifactTool.execute(
      { artifact_id: 'abc' },
      { signal: controller.signal },
    );

    expect(result.errorCode).toBe('cancelled');
    expect(hoisted.getArtifact).not.toHaveBeenCalled();
  });

  it('超长编号入错误文本时截断到 120 字符', async () => {
    hoisted.getArtifact.mockResolvedValue(null);

    const result = await readArtifactTool.execute({ artifact_id: 'x'.repeat(200) }, ctx);

    expect(result.llmText).toContain('x'.repeat(120));
    expect(result.llmText).not.toContain('x'.repeat(121));
  });
});
