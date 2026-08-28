// ─── PolicyEngine 单元测试 ───
// 覆盖：风险声明决策、参数级规则优先级、未知工具拒绝、
// confirm 门禁输出（确认提问与恢复选项语义）、deny 输出。

import { describe, expect, it } from 'vitest';
import {
  PolicyEngine,
  policyConfirm,
  policyDenied,
  UNKNOWN_TOOL_DENY,
} from '@/lib/agent/policy-engine';
import { ToolCatalog } from '@/lib/agent/tool-catalog';
import type { GenerationToolCall, GenerationToolDefinition } from '@/lib/generation/types';

const tool = (name: string, label = name): GenerationToolDefinition => ({
  name: name as GenerationToolDefinition['name'],
  label,
  description: `${name} 描述`,
  parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
});

const call = (name: string, argumentsValue: Record<string, unknown> = {}): GenerationToolCall => ({
  id: 'call-1',
  name,
  arguments: argumentsValue,
});

const catalogWith = (entries: Array<{ name: string; risk: 'safe' | 'confirm' | 'blocked' }>) => {
  const catalog = new ToolCatalog();
  for (const entry of entries) {
    catalog.register({
      definition: tool(entry.name),
      risk: entry.risk,
      execute: async () => ({ isError: false, statusText: 'ok', content: 'ok' }),
    });
  }
  return catalog;
};

describe('PolicyEngine', () => {
  it('按工具风险声明输出决策：safe 放行、confirm 需确认、blocked 拒绝', () => {
    const engine = new PolicyEngine(
      catalogWith([
        { name: 'read_a', risk: 'safe' },
        { name: 'write_b', risk: 'confirm' },
        { name: 'legacy_c', risk: 'blocked' },
      ]),
    );

    expect(engine.evaluate(call('read_a'))).toMatchObject({ decision: 'allow' });
    expect(engine.evaluate(call('write_b'))).toMatchObject({ decision: 'confirm' });
    expect(engine.evaluate(call('legacy_c'))).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('禁用'),
    });
  });

  it('未注册工具一律拒绝，不允许静默放行', () => {
    const engine = new PolicyEngine(catalogWith([]));
    expect(engine.evaluate(call('ghost_tool'))).toEqual({
      decision: 'deny',
      reason: UNKNOWN_TOOL_DENY,
    });
  });

  it('参数级规则先匹配先生效，覆盖工具风险声明', () => {
    const engine = new PolicyEngine(catalogWith([{ name: 'write_b', risk: 'confirm' }]));
    engine.addRule({
      id: 'block-dangerous-write',
      description: '拦截删除类写入',
      match: (target) => target.name === 'write_b' && target.arguments.mode === 'force',
      decision: 'deny',
      reason: '强制删除需要人工处理。',
    });

    expect(engine.evaluate(call('write_b', { mode: 'force' }))).toMatchObject({
      decision: 'deny',
      reason: '强制删除需要人工处理。',
    });
    expect(engine.evaluate(call('write_b', { mode: 'normal' }))).toMatchObject({
      decision: 'confirm',
    });
  });

  it('规则按注册顺序匹配，先命中先生效', () => {
    const engine = new PolicyEngine(catalogWith([{ name: 'write_b', risk: 'confirm' }]));
    engine.addRule({
      id: 'rule-first',
      description: '第一条规则',
      match: () => true,
      decision: 'deny',
      reason: '第一条命中。',
    });
    engine.addRule({
      id: 'rule-second',
      description: '第二条规则',
      match: () => true,
      decision: 'confirm',
      reason: '不应到达。',
    });

    expect(engine.evaluate(call('write_b'))).toMatchObject({
      decision: 'deny',
      reason: '第一条命中。',
    });
  });

  it('同名规则重复注册抛错', () => {
    const engine = new PolicyEngine(catalogWith([]));
    engine.addRule({
      id: 'rule-1',
      description: '规则一',
      match: () => false,
      decision: 'deny',
      reason: 'x',
    });
    expect(() =>
      engine.addRule({
        id: 'rule-1',
        description: '规则一重复',
        match: () => false,
        decision: 'confirm',
        reason: 'x',
      }),
    ).toThrow(/重复注册/);
  });

  it('confirm 决策输出带「确认执行」选项的统一确认请求（与恢复流程语义一致）', () => {
    const engine = new PolicyEngine(catalogWith([{ name: 'workspace_delete', risk: 'confirm' }]));
    const decision = engine.evaluate(call('workspace_delete'));
    const outcome = policyConfirm(
      call('workspace_delete'),
      decision,
      engine.confirmQuestion(call('workspace_delete'), decision),
    );

    expect(outcome).toMatchObject({
      deferred: true,
      kind: 'user_input',
      statusText: '等待确认工具调用',
    });
    if ('deferred' in outcome && outcome.kind === 'user_input') {
      expect(outcome.question).toContain('workspace_delete');
      expect(outcome.options.map((option) => option.label)).toEqual(['确认执行', '取消']);
      expect(outcome.allowCustom).toBe(false);
    }
  });

  it('deny 决策输出统一的拒绝结果，包含原因', () => {
    const engine = new PolicyEngine(catalogWith([{ name: 'legacy_c', risk: 'blocked' }]));
    const decision = engine.evaluate(call('legacy_c'));
    const denied = policyDenied(call('legacy_c'), decision);

    expect(denied).toMatchObject({ isError: true, statusText: '工具禁用' });
    expect(denied.content).toContain('legacy_c');
    expect(denied.content).toContain('禁用');
  });

  it('confirmQuestion 使用工具标签生成面向用户的提问', () => {
    const engine = new PolicyEngine(catalogWith([{ name: 'workspace_delete', risk: 'confirm' }]));
    const decision = engine.evaluate(call('workspace_delete'));
    const question = engine.confirmQuestion(call('workspace_delete'), decision);

    expect(question).toContain('workspace_delete');
    expect(question).toContain('是否继续');
  });
});
