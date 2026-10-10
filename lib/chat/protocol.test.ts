import { describe, expect, it } from 'vitest';
import { isClientMessage } from './protocol';

describe('isClientMessage', () => {
  it('接受无参控制消息', () => {
    expect(isClientMessage({ type: 'subscribe' })).toBe(true);
    expect(isClientMessage({ type: 'clear_chat' })).toBe(true);
  });

  it('接受一条合法 chat 消息', () => {
    expect(
      isClientMessage({
        type: 'chat',
        requestId: 'chat-1',
        messages: [{ id: 'm1', role: 'user', content: '你好', createdAt: 1 }],
      }),
    ).toBe(true);
  });

  it('拒绝缺少 requestId 的 cancel', () => {
    expect(isClientMessage({ type: 'cancel' })).toBe(false);
  });

  it('拒绝空 messages 与非法角色', () => {
    expect(isClientMessage({ type: 'chat', requestId: 'r', messages: [] })).toBe(false);
    expect(
      isClientMessage({
        type: 'chat',
        requestId: 'r',
        messages: [{ id: 'm', role: 'system', content: 'x', createdAt: 1 }],
      }),
    ).toBe(false);
  });

  it('拒绝 config:set 中缺失字段', () => {
    expect(
      isClientMessage({ type: 'config:set', requestId: 'c', baseUrl: 'https://x', model: '' }),
    ).toBe(false);
  });

  it('拒绝非对象与未知类型', () => {
    expect(isClientMessage(null)).toBe(false);
    expect(isClientMessage({ type: 'run_nl', text: 'x' })).toBe(false);
  });
});
