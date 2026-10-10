import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import { createModel, SYSTEM_PROMPT, toLCMessages } from './model';

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
