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

  it('接受 config:set 中空的 model（首次先落库密钥、尚未选模型的合法中间态）', () => {
    expect(
      isClientMessage({
        type: 'config:set',
        requestId: 'c',
        baseUrl: 'https://x',
        model: '',
        apiKey: 'sk-test',
      }),
    ).toBe(true);
  });

  it('接受带合法 toolCall 的 assistant 历史消息', () => {
    expect(
      isClientMessage({
        type: 'chat',
        requestId: 'r',
        messages: [
          {
            id: 'm',
            role: 'assistant',
            content: '已读取当前页面',
            createdAt: 1,
            toolCall: {
              name: 'read_current_page',
              status: 'success',
              summary: '已读取《T》· 10 字',
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it('拒绝非法 toolCall：status 非法 / name 为空 / summary 与 errorCode 超长', () => {
    const chat = (toolCall: unknown) =>
      isClientMessage({
        type: 'chat',
        requestId: 'r',
        messages: [{ id: 'm', role: 'assistant', content: 'x', createdAt: 1, toolCall }],
      });

    expect(chat({ name: 'read_current_page', status: 'done' })).toBe(false);
    expect(chat({ name: '', status: 'running' })).toBe(false);
    expect(chat({ name: 'read_current_page', status: 'error', summary: 'a'.repeat(513) })).toBe(
      false,
    );
    expect(chat({ name: 'read_current_page', status: 'error', errorCode: 'a'.repeat(65) })).toBe(
      false,
    );
  });

  it('拒绝非对象与未知类型', () => {
    expect(isClientMessage(null)).toBe(false);
    expect(isClientMessage({ type: 'run_nl', text: 'x' })).toBe(false);
  });
});
