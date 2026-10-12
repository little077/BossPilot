// ─── 流式工具事件生成单测 ───
// 这里完整 mock @langchain/openai，专注验证 streamToolTurn / streamFollowUp 的事件编排：
// 文本增量透传、tool_call 增量聚合、invalid_tool_calls 标记、以及生成②的消息往返成对。
// （createModel 对真实 SDK 的构造断言留在 model.test.ts，两者互不干扰。）

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import type { ModelConfig } from '@/lib/domain/types';
import type { BindableToolDefinition } from '@/lib/tools/types';

const hoisted = vi.hoisted(() => ({
  bindTools: vi.fn(),
  stream: vi.fn(),
}));

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    bindTools(tools: unknown) {
      hoisted.bindTools(tools);
      return { stream: hoisted.stream };
    }
    stream(messages: unknown, options?: unknown) {
      return hoisted.stream(messages, options);
    }
  },
}));

import { streamFollowUp, streamToolTurn } from './model';

const config: ModelConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-test',
};

const signal = new AbortController().signal;

const defs: BindableToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_current_page',
      description: 'desc',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({
  id: crypto.randomUUID(),
  role,
  content,
  createdAt: Date.now(),
});

async function* chunksOf(chunks: readonly unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('streamToolTurn', () => {
  it('绑定工具定义，文本增量透传，流末尾产出聚合后的工具调用', async () => {
    hoisted.stream.mockResolvedValue(
      chunksOf([
        { content: '好的，我先看看', tool_call_chunks: [] },
        { content: '', tool_call_chunks: [{ index: 0, id: 'call_1', name: 'read_current_page' }] },
        { content: '', tool_call_chunks: [{ index: 0, args: '{}' }] },
      ]),
    );

    const events = [];
    for await (const event of streamToolTurn(config, [msg('user', '看看这个页面')], defs, signal)) {
      events.push(event);
    }

    expect(hoisted.bindTools).toHaveBeenCalledWith(defs);
    expect(events).toEqual([
      { type: 'text', text: '好的，我先看看' },
      { type: 'tool_call', call: { id: 'call_1', name: 'read_current_page', args: {} } },
    ]);
  });

  it('只看 invalid_tool_calls 时产出 tool_call_invalid 而不产出 tool_call', async () => {
    hoisted.stream.mockResolvedValue(
      chunksOf([{ content: '', invalid_tool_calls: [{ error: 'bad' }] }]),
    );

    const events = [];
    for await (const event of streamToolTurn(config, [msg('user', 'q')], defs, signal)) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'tool_call_invalid', name: '' }]);
  });

  it('参数不是 JSON 对象时产出带工具名的 tool_call_invalid', async () => {
    hoisted.stream.mockResolvedValue(
      chunksOf([
        { content: '', tool_call_chunks: [{ index: 0, id: 'c', name: 'read_current_page' }] },
        { content: '', tool_call_chunks: [{ index: 0, args: '{oops' }] },
      ]),
    );

    const events = [];
    for await (const event of streamToolTurn(config, [msg('user', 'q')], defs, signal)) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'tool_call_invalid', name: 'read_current_page' }]);
  });

  it('没有工具调用时只有文本事件', async () => {
    hoisted.stream.mockResolvedValue(chunksOf([{ content: '直接回答' }]));

    const events = [];
    for await (const event of streamToolTurn(config, [msg('user', 'q')], defs, signal)) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'text', text: '直接回答' }]);
  });
});

describe('streamFollowUp', () => {
  it('不绑定工具，消息末尾为成对的 AIMessage 工具调用与 ToolMessage 结果', async () => {
    hoisted.stream.mockResolvedValue(chunksOf([{ content: '页面讲了' }, { content: '三件事' }]));
    const call = { id: 'call_1', name: 'read_current_page', args: {} };

    const texts = [];
    for await (const text of streamFollowUp(
      config,
      [msg('user', '总结这个页面')],
      call,
      '页面正文…',
      signal,
    )) {
      texts.push(text);
    }

    expect(texts.join('')).toBe('页面讲了三件事');
    expect(hoisted.bindTools).not.toHaveBeenCalled();

    const [lcMessages] = hoisted.stream.mock.calls[0] as [unknown[]];
    const ai = lcMessages.at(-2);
    const tool = lcMessages.at(-1);
    expect(ai).toBeInstanceOf(AIMessage);
    expect((ai as AIMessage).tool_calls?.[0]).toMatchObject({
      name: 'read_current_page',
      args: {},
      id: 'call_1',
    });
    expect(tool).toBeInstanceOf(ToolMessage);
    expect((tool as ToolMessage).tool_call_id).toBe('call_1');
    expect((tool as ToolMessage).content).toBe('页面正文…');
  });
});
