import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmConfig } from '@/lib/domain/types';
import { chat, chatStream, extractJson, LlmError } from './client';

const config: LlmConfig = {
  baseUrl: 'https://api.example.com/v1/',
  apiKey: 'test-key',
  model: 'test-model',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chat', () => {
  it('发送标准 Chat Completions 请求并返回文本', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chat(config, [{ role: 'user', content: 'hello' }], {
        responseFormatJson: true,
        temperature: 0,
      }),
    ).resolves.toBe('ok');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: 'test-model',
      temperature: 0,
      stream: false,
      response_format: { type: 'json_object' },
    });
  });

  it.each([
    [{ ...config, apiKey: '' }, '未配置 API Key'],
    [{ ...config, baseUrl: '' }, '未配置 base URL'],
    [{ ...config, model: '' }, '未配置模型名'],
  ])('拒绝不完整配置', async (invalidConfig, message) => {
    await expect(chat(invalidConfig, [])).rejects.toThrow(message);
  });

  it('把网络、HTTP 和空响应转换为可读错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('offline')));
    await expect(chat(config, [])).rejects.toThrow('网络请求失败：offline');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response('unauthorized', { status: 401 })),
    );
    await expect(chat(config, [])).rejects.toThrow('模型返回 401：unauthorized');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(chat(config, [])).rejects.toThrow('模型返回内容为空');
  });
});

describe('chatStream', () => {
  it('端点不返回 SSE 时降级为普通 JSON', async () => {
    const onDelta = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '完整回复' } }],
            usage: { prompt_tokens: 12, completion_tokens: 4 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(chatStream(config, [], { onDelta })).resolves.toEqual({
      content: '完整回复',
      usage: { promptTokens: 12, completionTokens: 4 },
    });
    expect(onDelta).toHaveBeenCalledWith('完整回复');
  });

  it('解析 SSE 增量、忽略无效行并读取 usage', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(': keep-alive\n'));
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"你"}}]}\n' +
              'data: not-json\n' +
              'data: {"choices":[{"delta":{"content":"好"}}],"usage":{"prompt_tokens":2,"completion_tokens":2}}\n' +
              'data: [DONE]\n',
          ),
        );
        controller.close();
      },
    });
    const onDelta = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
        ),
    );

    await expect(chatStream(config, [], { onDelta })).resolves.toEqual({
      content: '你好',
      usage: { promptTokens: 2, completionTokens: 2 },
    });
    expect(onDelta.mock.calls.flat()).toEqual(['你', '好']);
  });

  it('保留 AbortError，并处理 HTTP 与空流错误', async () => {
    const abortError = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(abortError));
    await expect(chatStream(config, [])).rejects.toBe(abortError);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('bad', { status: 500 })));
    await expect(chatStream(config, [])).rejects.toThrow('模型返回 500：bad');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(chatStream(config, [])).rejects.toThrow('模型返回内容为空');
  });
});

describe('extractJson', () => {
  it('解析对象、数组和 Markdown 围栏', () => {
    expect(extractJson<{ ok: boolean }>('前言 {"ok":true} 后记')).toEqual({ ok: true });
    expect(extractJson<number[]>('结果：[1,2,3]')).toEqual([1, 2, 3]);
    expect(extractJson<{ value: number }>('```json\n{"value":1}\n```')).toEqual({ value: 1 });
  });

  it('把非法 JSON 转换为 LlmError', () => {
    expect(() => extractJson('{bad json}')).toThrow(LlmError);
  });
});
