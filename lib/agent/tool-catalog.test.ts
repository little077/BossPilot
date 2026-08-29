// ─── ToolCatalog 单元测试 ───
// 覆盖：注册、重复注册防御、查询、风险过滤、执行分发、前缀模式（MCP）、未知工具。

import { describe, expect, it, vi } from 'vitest';
import { type CatalogToolContext, ToolCatalog } from '@/lib/agent/tool-catalog';
import type { ToolContext } from '@/lib/agent/tool-context';
import type { GenerationToolCall, GenerationToolDefinition } from '@/lib/generation/types';

const tool = (name: string): GenerationToolDefinition => ({
  name: name as GenerationToolDefinition['name'],
  label: name,
  description: `${name} 描述`,
  parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
});

const call = (name: string): GenerationToolCall => ({ id: 'call-1', name, arguments: {} });

const context = (toolContext: ToolContext): Omit<CatalogToolContext, 'call'> => ({
  signal: new AbortController().signal,
  requestId: 'request-1',
  conversationId: 'conversation-1',
  approved: false,
  modelContext: { model: { providerLabel: 'test', modelName: 'test', supportsImageInput: false } },
  toolContext,
});

describe('ToolCatalog', () => {
  it('注册后按名查询定义与执行器，定义列表包含全部工具', () => {
    const catalog = new ToolCatalog();
    catalog.register({ definition: tool('read_a'), risk: 'safe', execute: vi.fn() });
    catalog.register({ definition: tool('write_b'), risk: 'confirm', execute: vi.fn() });

    expect(catalog.has('read_a')).toBe(true);
    expect(catalog.get('read_a')?.risk).toBe('safe');
    expect(catalog.get('write_b')?.risk).toBe('confirm');
    expect(catalog.definitions().map((item) => item.name)).toEqual(['read_a', 'write_b']);
  });

  it('同名工具重复注册直接抛错，防止定义与执行器割裂', () => {
    const catalog = new ToolCatalog();
    catalog.register({ definition: tool('read_a'), risk: 'safe', execute: vi.fn() });
    expect(() =>
      catalog.register({ definition: tool('read_a'), risk: 'confirm', execute: vi.fn() }),
    ).toThrow(/重复注册/);
  });

  it('uses serial scheduling by default and only allows safe tools to opt into parallel mode', () => {
    const catalog = new ToolCatalog();
    catalog.register({ definition: tool('serial_safe'), risk: 'safe', execute: vi.fn() });
    catalog.register({
      definition: tool('parallel_safe'),
      risk: 'safe',
      scheduling: 'parallel',
      execute: vi.fn(),
    });
    catalog.register({
      definition: tool('confirm_tool'),
      risk: 'confirm',
      scheduling: 'parallel',
      execute: vi.fn(),
    });
    catalog.register({
      definition: tool('dynamic'),
      risk: 'safe',
      scheduling: (candidate) => (candidate.arguments.independent === true ? 'parallel' : 'serial'),
      execute: vi.fn(),
    });

    expect(catalog.executionMode(call('serial_safe'))).toBe('serial');
    expect(catalog.executionMode(call('parallel_safe'))).toBe('parallel');
    expect(catalog.executionMode(call('confirm_tool'))).toBe('serial');
    expect(catalog.executionMode({ ...call('dynamic'), arguments: { independent: true } })).toBe(
      'parallel',
    );
    expect(catalog.executionMode(call('dynamic'))).toBe('serial');
    expect(catalog.executionMode(call('missing'))).toBe('serial');
  });

  it('按风险等级过滤定义列表（能力开放），且返回克隆不污染注册表', () => {
    const catalog = new ToolCatalog();
    catalog.register({ definition: tool('read_a'), risk: 'safe', execute: vi.fn() });
    catalog.register({ definition: tool('write_b'), risk: 'confirm', execute: vi.fn() });

    const confirmOnly = catalog.definitions({ risks: ['confirm'] });
    expect(confirmOnly.map((item) => item.name)).toEqual(['write_b']);

    const modified = catalog.definitions();
    const firstModified = modified[0];
    if (!firstModified) throw new Error('tool catalog unexpectedly empty');
    firstModified.label = '被外部修改';
    expect(catalog.get('read_a')?.definition.label).toBe('read_a');
    expect(modified).not.toBe(catalog.definitions());
  });

  it('execute 把调用上下文传给执行器并返回其结果', async () => {
    const catalog = new ToolCatalog();
    const executor = vi
      .fn()
      .mockResolvedValue({ isError: false, statusText: '完成', content: 'ok' });
    catalog.register({ definition: tool('read_a'), risk: 'safe', execute: executor });

    const ctx = context({} as ToolContext);
    const result = await catalog.execute(call('read_a'), ctx);

    expect(result).toMatchObject({ isError: false, statusText: '完成' });
    expect(executor).toHaveBeenCalledWith({ ...ctx, call: call('read_a') });
  });

  it('未注册工具返回统一的「未开放」错误，不抛异常', async () => {
    const catalog = new ToolCatalog();
    const result = await catalog.execute(call('ghost_tool'), context({} as ToolContext));
    expect(result).toMatchObject({ isError: true, statusText: '工具禁用' });
    if (!('deferred' in result)) {
      expect(result.content).toContain('未开放ghost_tool');
    }
  });

  it('前缀模式注册覆盖 MCP 动态工具，精确注册优先', async () => {
    const catalog = new ToolCatalog();
    const exact = vi.fn().mockResolvedValue({ isError: false, statusText: '精确', content: 'ok' });
    const pattern = vi
      .fn()
      .mockResolvedValue({ isError: false, statusText: '模式', content: 'ok' });
    catalog.register({ definition: tool('mcp__server_1__special'), risk: 'safe', execute: exact });
    catalog.registerPattern('mcp__', {
      definition: tool('mcp__*'),
      risk: 'safe',
      execute: pattern,
    });

    expect(catalog.has('mcp__server_1__other')).toBe(true);
    await catalog.execute(call('mcp__server_1__other'), context({} as ToolContext));
    await catalog.execute(call('mcp__server_1__special'), context({} as ToolContext));
    expect(pattern).toHaveBeenCalledOnce();
    expect(exact).toHaveBeenCalledOnce();
  });

  it('同名前缀模式重复注册抛错', () => {
    const catalog = new ToolCatalog();
    catalog.registerPattern('mcp__', {
      definition: tool('mcp__*'),
      risk: 'safe',
      execute: vi.fn(),
    });
    expect(() =>
      catalog.registerPattern('mcp__', {
        definition: tool('mcp__*'),
        risk: 'safe',
        execute: vi.fn(),
      }),
    ).toThrow(/重复注册/);
  });
});
