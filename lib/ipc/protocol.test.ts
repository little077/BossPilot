import { describe, expect, it } from 'vitest';
import {
  isAgentContextCommand,
  isClientMessage,
  isMcpCommand,
  isProviderCommand,
  isSkillCommand,
} from './protocol';

describe('IPC runtime validation', () => {
  it('accepts a bounded chat request and rejects malformed or oversized history', () => {
    const valid = {
      type: 'chat',
      requestId: 'request-1',
      conversationId: 'conversation-1',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'hello',
          createdAt: 1,
        },
      ],
    };

    expect(isClientMessage(valid)).toBe(true);
    expect(isClientMessage({ ...valid, requestId: '' })).toBe(false);
    expect(isClientMessage({ ...valid, conversationId: '' })).toBe(false);
    expect(
      isClientMessage({
        ...valid,
        messages: [{ ...valid.messages[0], content: 'x'.repeat(100_001) }],
      }),
    ).toBe(false);
    expect(
      isClientMessage({
        ...valid,
        messages: [{ ...valid.messages[0], role: 'system' }],
      }),
    ).toBe(false);
  });

  it('validates scoped cancellation and simple commands', () => {
    expect(isClientMessage({ type: 'subscribe' })).toBe(true);
    expect(isClientMessage({ type: 'resume_captcha' })).toBe(true);
    expect(isClientMessage({ type: 'download_diagnostics' })).toBe(true);
    expect(isClientMessage({ type: 'clear_chat' })).toBe(true);
    expect(isClientMessage({ type: 'cancel', scope: 'chat', requestId: 'request-1' })).toBe(true);
    expect(isClientMessage({ type: 'cancel', scope: 'task' })).toBe(true);
    expect(isClientMessage({ type: 'cancel' })).toBe(true);
    expect(isClientMessage({ type: 'cancel', scope: 'unknown' })).toBe(false);
    expect(isClientMessage({ type: 'cancel', requestId: 'x'.repeat(129) })).toBe(false);
    expect(isClientMessage({ type: 'run_nl', text: 'search' })).toBe(true);
    expect(isClientMessage({ type: 'parse_only', text: '' })).toBe(false);
    expect(isClientMessage({ type: 'run_params', params: {} })).toBe(true);
    expect(isClientMessage({ type: 'run_params', params: [] })).toBe(false);
    expect(isClientMessage({ type: 'unknown' })).toBe(false);
    expect(isClientMessage(null)).toBe(false);
    expect(isClientMessage([])).toBe(false);
  });

  it('validates durable page-permission decisions with the same bounded history rules', () => {
    const valid = {
      type: 'page_permission_result',
      requestId: 'request-1',
      granted: true,
      messages: [
        { id: 'user-1', role: 'user', content: '总结当前页', createdAt: 1 },
        { id: 'assistant-1', role: 'assistant', content: '', createdAt: 2 },
      ],
    };
    expect(isClientMessage(valid)).toBe(true);
    expect(isClientMessage({ ...valid, granted: 'yes' })).toBe(false);
    expect(isClientMessage({ ...valid, messages: [] })).toBe(false);
    expect(isClientMessage({ ...valid, requestId: '' })).toBe(false);
  });

  it('validates bounded Ask User answers with the same conversation snapshot', () => {
    const valid = {
      type: 'ask_user_result',
      requestId: 'request-1',
      answer: '周日下午两点以后',
      messages: [{ id: 'user-1', role: 'user', content: '帮我找活动', createdAt: 1 }],
    };
    expect(isClientMessage(valid)).toBe(true);
    expect(isClientMessage({ ...valid, answer: '' })).toBe(false);
    expect(isClientMessage({ ...valid, answer: 'x'.repeat(2_001) })).toBe(false);
    expect(isClientMessage({ ...valid, messages: [] })).toBe(false);
  });

  it('enforces chat count, total size, identifiers, roles, and timestamps', () => {
    const message = {
      id: 'message-1',
      role: 'assistant',
      content: 'x',
      createdAt: 1,
    };
    const chat = {
      type: 'chat',
      requestId: 'request-1',
      conversationId: 'conversation-1',
      messages: [message],
    };

    expect(isClientMessage(chat)).toBe(true);
    expect(isClientMessage({ ...chat, messages: [] })).toBe(false);
    expect(isClientMessage({ ...chat, messages: Array.from({ length: 201 }, () => message) })).toBe(
      false,
    );
    expect(
      isClientMessage({
        ...chat,
        messages: Array.from({ length: 6 }, (_, index) => ({
          ...message,
          id: `message-${index}`,
          content: 'x'.repeat(90_000),
        })),
      }),
    ).toBe(false);
    expect(isClientMessage({ ...chat, messages: [{ ...message, id: '' }] })).toBe(false);
    expect(isClientMessage({ ...chat, messages: [{ ...message, content: 42 }] })).toBe(false);
    expect(isClientMessage({ ...chat, messages: [{ ...message, createdAt: Number.NaN }] })).toBe(
      false,
    );
    expect(isClientMessage({ ...chat, messages: [{ ...message, createdAt: '1' }] })).toBe(false);
  });

  it('accepts bounded safe attachments and rejects executable or oversized payloads', () => {
    const base = {
      type: 'chat',
      requestId: 'request-attachments',
      conversationId: 'conversation-1',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: '分析附件',
          createdAt: 1,
          attachments: [
            {
              id: 'attachment-1',
              kind: 'text',
              name: 'resume.md',
              mimeType: 'text/markdown',
              size: 6,
              content: 'resume',
            },
          ],
        },
      ],
    };
    expect(isClientMessage(base)).toBe(true);
    expect(
      isClientMessage({
        ...base,
        messages: [
          {
            ...base.messages[0],
            attachments: [
              {
                id: 'x',
                kind: 'text',
                name: 'run.exe',
                mimeType: 'application/octet-stream',
                size: 1,
                content: 'x',
              },
            ],
          },
        ],
      }),
    ).toBe(false);
    const user = base.messages[0];
    expect(
      isClientMessage({
        ...base,
        messages: [
          {
            ...user,
            attachments: [
              {
                id: 'image',
                kind: 'image',
                name: 'screen.png',
                mimeType: 'image/png',
                size: 3,
                data: 'AQID',
              },
              {
                id: 'selection',
                kind: 'selection',
                name: '选区',
                content: 'selected',
                sourceOrigin: 'https://example.com',
                sourceTitle: 'Example',
              },
            ],
          },
        ],
      }),
    ).toBe(true);
    expect(
      isClientMessage({
        ...base,
        messages: [
          {
            ...user,
            attachments: [
              {
                id: 'image',
                kind: 'image',
                name: 'screen.png',
                mimeType: 'image/gif',
                size: 3,
                data: 'not base64!',
              },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(
      isClientMessage({ ...base, messages: [{ ...user, attachments: [{ kind: 'unknown' }] }] }),
    ).toBe(false);
  });

  it('validates optional conversation-title requests with bounded chat history', () => {
    const request = {
      type: 'summarize_conversation',
      requestId: 'title-1',
      conversationId: 'conversation-1',
      messages: [{ id: 'u1', role: 'user', content: '总结网页', createdAt: 1 }],
    };
    expect(isClientMessage(request)).toBe(true);
    expect(isClientMessage({ ...request, conversationId: '' })).toBe(false);
    expect(isClientMessage({ ...request, messages: [] })).toBe(false);
  });

  it('validates provider command payloads instead of trusting the type alone', () => {
    expect(isProviderCommand({ type: 'providers:get' })).toBe(true);
    expect(isProviderCommand({ type: 'providers:issue', providerId: 'openai' })).toBe(true);
    expect(isProviderCommand({ type: 'providers:remove', providerId: 'openai' })).toBe(true);
    expect(
      isProviderCommand({
        type: 'providers:select',
        providerId: 'openai',
        modelId: 'gpt-test',
      }),
    ).toBe(true);
    expect(
      isProviderCommand({
        type: 'providers:set-image-input',
        providerId: 'custom',
        modelId: 'vision-model',
        enabled: true,
      }),
    ).toBe(true);
    expect(
      isProviderCommand({
        type: 'providers:set-image-input',
        providerId: 'custom',
        modelId: 'vision-model',
        enabled: 'yes',
      }),
    ).toBe(false);
    expect(
      isProviderCommand({
        type: 'providers:connect',
        providerId: 'openai',
        apiKey: 'secret',
        baseUrl: 'https://api.openai.com/v1',
      }),
    ).toBe(true);
    expect(
      isProviderCommand({
        type: 'providers:connect',
        providerId: 'openai',
        apiKey: 42,
      }),
    ).toBe(false);
    expect(
      isProviderCommand({
        type: 'providers:add-manual-model',
        providerId: 'custom',
        modelId: 'x'.repeat(257),
        apiKey: '',
      }),
    ).toBe(false);
    expect(
      isProviderCommand({
        type: 'providers:add-manual-model',
        providerId: 'custom',
        modelId: 'custom-model',
        apiKey: '',
      }),
    ).toBe(true);
    expect(
      isProviderCommand({
        type: 'providers:connect',
        providerId: 'openai',
        apiKey: 'secret',
        baseUrl: '',
      }),
    ).toBe(false);
    expect(
      isProviderCommand({
        type: 'providers:connect',
        providerId: 'openai',
        apiKey: 'x'.repeat(16_385),
      }),
    ).toBe(false);
    expect(isProviderCommand({ type: 'providers:issue', providerId: '' })).toBe(false);
    expect(isProviderCommand({ type: 'unknown' })).toBe(false);
    expect(isProviderCommand(null)).toBe(false);
  });

  it('validates bounded skill setting commands', () => {
    expect(isSkillCommand({ type: 'skills:get' })).toBe(true);
    expect(
      isSkillCommand({ type: 'skills:set-enabled', name: 'boss-job-search', enabled: false }),
    ).toBe(true);
    expect(isSkillCommand({ type: 'skills:set-enabled', name: '', enabled: true })).toBe(false);
    expect(
      isSkillCommand({ type: 'skills:set-enabled', name: 'x'.repeat(65), enabled: true }),
    ).toBe(false);
    expect(isSkillCommand({ type: 'skills:set-enabled', name: 'boss', enabled: 'yes' })).toBe(
      false,
    );
    expect(isSkillCommand({ type: 'skills:unknown' })).toBe(false);
  });

  it('validates bounded local context commands', () => {
    expect(isAgentContextCommand({ type: 'context:get' })).toBe(true);
    expect(isAgentContextCommand({ type: 'context:clear-memories' })).toBe(true);
    expect(
      isAgentContextCommand({
        type: 'context:save-settings',
        instructions: '中文回答',
        memoryEnabled: true,
      }),
    ).toBe(true);
    expect(isAgentContextCommand({ type: 'context:add-memory', content: '偏好远程' })).toBe(true);
    expect(
      isAgentContextCommand({ type: 'context:update-memory', id: 'm1', content: '偏好现场' }),
    ).toBe(true);
    expect(isAgentContextCommand({ type: 'context:remove-memory', id: 'm1' })).toBe(true);
    expect(isAgentContextCommand({ type: 'context:add-memory', content: '' })).toBe(false);
    expect(
      isAgentContextCommand({
        type: 'context:save-settings',
        instructions: 'x'.repeat(4_001),
        memoryEnabled: true,
      }),
    ).toBe(false);
    expect(isAgentContextCommand({ type: 'context:unknown' })).toBe(false);
  });

  it('validates MCP configuration commands without trusting the type field', () => {
    expect(isMcpCommand({ type: 'mcp:get' })).toBe(true);
    expect(isMcpCommand({ type: 'mcp:save', name: 'Docs', url: 'https://x/mcp', token: '' })).toBe(
      true,
    );
    expect(isMcpCommand({ type: 'mcp:set-enabled', id: 's1', enabled: false })).toBe(true);
    expect(isMcpCommand({ type: 'mcp:remove', id: 's1' })).toBe(true);
    expect(isMcpCommand({ type: 'mcp:save', name: '', url: 'https://x', token: '' })).toBe(false);
    expect(isMcpCommand({ type: 'mcp:set-enabled', id: 's1', enabled: 'yes' })).toBe(false);
    expect(isMcpCommand({ type: 'mcp:unknown' })).toBe(false);
  });
});
