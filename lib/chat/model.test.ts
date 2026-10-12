import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import {
  accumulateToolCalls,
  createModel,
  SYSTEM_PROMPT,
  takeFirstToolCall,
  toLCFollowUpMessages,
  toLCMessages,
} from './model';

const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({
  id: crypto.randomUUID(),
  role,
  content,
  createdAt: Date.now(),
});

describe('toLCMessages', () => {
  it('首条固定为 system 人设，用户消息映射为 HumanMessage', () => {
    const result = toLCMessages([msg('user', '你好')]);
    expect(result[0]).toBeInstanceOf(SystemMessage);
    expect(result[0]?.content).toBe(SYSTEM_PROMPT);
    expect(result[1]).toBeInstanceOf(HumanMessage);
    expect(result[1]?.content).toBe('你好');
  });

  it('assistant 历史按 SystemMessage 提供（兼容端点无 tool 关联限制）', () => {
    const result = toLCMessages([msg('user', 'a'), msg('assistant', 'b')]);
    expect(result[2]).toBeInstanceOf(SystemMessage);
    expect(result[2]?.content).toBe('b');
  });
});

describe('createModel', () => {
  it('用配置构造 ChatOpenAI 实例并带上 baseURL', () => {
    const model = createModel({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
    });
    expect(model).toBeDefined();
    expect(model.model).toBe('deepseek-chat');
  });
});

describe('accumulateToolCalls', () => {
  it('同 index 增量合并：name/id 取首个非空，args 逐段拼接', () => {
    const pending = new Map();
    accumulateToolCalls(pending, [{ index: 0, id: 'call_1', name: 'read_current_page', args: '' }]);
    accumulateToolCalls(pending, [
      { index: 0, args: '{"a"' },
      { index: 0, args: ': 1}' },
    ]);

    expect(pending.get(0)).toEqual({
      id: 'call_1',
      name: 'read_current_page',
      argsRaw: '{"a": 1}',
    });
  });

  it('不同 index 各自成组', () => {
    const pending = new Map();
    accumulateToolCalls(pending, [
      { index: 0, name: 'tool_a', args: '{}' },
      { index: 1, name: 'tool_b', args: '{}' },
    ]);
    expect(pending.size).toBe(2);
  });
});

describe('takeFirstToolCall', () => {
  it('空集合返回 null', () => {
    expect(takeFirstToolCall(new Map())).toBeNull();
  });

  it('缺 name 判为无效', () => {
    const pending = new Map([[0, { id: 'c', name: '', argsRaw: '' }]]);
    expect(takeFirstToolCall(pending)).toEqual({ ok: false, name: '' });
  });

  it('参数不是合法 JSON 对象时判为无效', () => {
    const badJson = new Map([[0, { id: 'c', name: 'read_current_page', argsRaw: '{oops' }]]);
    expect(takeFirstToolCall(badJson)).toEqual({ ok: false, name: 'read_current_page' });

    const arrayArgs = new Map([[0, { id: 'c', name: 'read_current_page', argsRaw: '[1]' }]]);
    expect(takeFirstToolCall(arrayArgs)).toEqual({ ok: false, name: 'read_current_page' });
  });

  it('空参数按空对象处理，缺 id 时补随机 id', () => {
    const pending = new Map([[0, { id: '', name: 'read_current_page', argsRaw: '' }]]);
    const parsed = takeFirstToolCall(pending);
    if (!parsed?.ok) throw new Error('预期解析成功');
    expect(parsed.call.args).toEqual({});
    expect(parsed.call.id).toMatch(/^call_/);
  });

  it('多组调用时取 index 最小的一个', () => {
    const pending = new Map([
      [1, { id: 'b', name: 'tool_b', argsRaw: '{}' }],
      [0, { id: 'a', name: 'tool_a', argsRaw: '{}' }],
    ]);
    const parsed = takeFirstToolCall(pending);
    if (!parsed?.ok) throw new Error('预期解析成功');
    expect(parsed.call.name).toBe('tool_a');
  });
});

describe('toLCFollowUpMessages', () => {
  it('历史之后追加成对的 AIMessage 工具调用与 ToolMessage 结果', () => {
    const call = { id: 'call_1', name: 'read_current_page', args: {} };
    const result = toLCFollowUpMessages([msg('user', '看看这个页面')], call, '页面正文…');

    expect(result[0]).toBeInstanceOf(SystemMessage);
    expect(result[1]).toBeInstanceOf(HumanMessage);

    const ai = result[2] as AIMessage;
    const tool = result[3] as ToolMessage;
    expect(ai).toBeInstanceOf(AIMessage);
    expect(ai.tool_calls?.[0]).toMatchObject({
      name: 'read_current_page',
      args: {},
      id: 'call_1',
    });
    expect(tool).toBeInstanceOf(ToolMessage);
    expect(tool.tool_call_id).toBe('call_1');
    expect(tool.content).toBe('页面正文…');
  });
});
