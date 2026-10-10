import { afterEach, describe, expect, it, vi } from 'vitest';
import { listModels } from './models';

function mockFetch(response: { ok: boolean; status?: number; json: unknown }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    json: async () => response.json,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listModels', () => {
  it('解析 OpenAI 兼容 data[] 并按 id 去重', async () => {
    const fetchMock = mockFetch({
      ok: true,
      json: {
        object: 'list',
        data: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat' },
          { id: 'deepseek-reasoner' },
          { id: 'deepseek-chat' },
        ],
      },
    });

    const models = await listModels('https://api.deepseek.com', 'sk-test');
    expect(models).toEqual([
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
    ]);
    // 端点拼接 + Bearer 认证头。
    expect(fetchMock).toHaveBeenCalledWith('https://api.deepseek.com/models', {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer sk-test' },
    });
  });

  it('去掉 base URL 结尾多余斜杠', async () => {
    const fetchMock = mockFetch({ ok: true, json: { data: [{ id: 'm' }] } });
    await listModels('https://api.deepseek.com/', 'sk');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/models');
  });

  it('HTTP 非 2xx 抛错', async () => {
    mockFetch({ ok: false, status: 401, json: {} });
    await expect(listModels('https://api.deepseek.com', 'bad')).rejects.toThrow(/HTTP 401/);
  });

  it('响应结构不符（无 data 数组）抛错', async () => {
    mockFetch({ ok: true, json: { models: [] } });
    await expect(listModels('https://api.deepseek.com', 'sk')).rejects.toThrow(/结构异常/);
  });

  it('空列表抛错', async () => {
    mockFetch({ ok: true, json: { data: [] } });
    await expect(listModels('https://api.deepseek.com', 'sk')).rejects.toThrow(
      /未返回任何可用模型/,
    );
  });
});
