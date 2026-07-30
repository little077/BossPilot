import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverProviderModels, ProviderDiscoveryError } from './discovery';
import { getProviderDefinition, type ProviderDefinition } from './registry';

function provider(providerId: string): ProviderDefinition {
  const definition = getProviderDefinition(providerId);
  if (!definition) throw new Error(`Missing test provider: ${providerId}`);
  return definition;
}

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('discoverProviderModels', () => {
  it('requests and normalizes an OpenAI-compatible model catalog', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [
          { id: ' model-a ', name: ' Model A ' },
          { id: 'model-a', name: 'Duplicate' },
          { id: 'model-b', display_name: 'Model B' },
          { id: '', name: 'Missing ID' },
          { id: 'x'.repeat(257), name: 'Too long' },
          null,
        ],
      }),
    );

    await expect(
      discoverProviderModels({
        provider: provider('deepseek'),
        baseUrl: 'https://api.example.com/v1/?debug=1#models',
        apiKey: 'secret-key',
        fetchImpl,
      }),
    ).resolves.toEqual([
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'Model B' },
    ]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer secret-key',
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('uses Anthropic authentication headers without leaking a bearer header', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [{ id: 'claude-test', name: 'Claude Test' }] }));

    await expect(
      discoverProviderModels({
        provider: provider('anthropic'),
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'anthropic-key',
        fetchImpl,
      }),
    ).resolves.toEqual([{ id: 'claude-test', name: 'Claude Test' }]);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models?limit=1000',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': 'anthropic-key',
        },
      }),
    );
  });

  it('parses Gemini models and excludes models without a generation capability', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        models: [
          {
            name: 'models/gemini-pro',
            displayName: 'Gemini Pro',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/gemini-stream',
            displayName: 'Gemini Stream',
            supportedGenerationMethods: ['streamGenerateContent'],
          },
          {
            name: 'models/embedding-only',
            supportedGenerationMethods: ['embedContent'],
          },
          { name: 'models/legacy-unspecified' },
          { displayName: 'Missing ID' },
        ],
      }),
    );

    await expect(
      discoverProviderModels({
        provider: provider('google'),
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'gemini-key',
        fetchImpl,
      }),
    ).resolves.toEqual([
      { id: 'gemini-pro', name: 'Gemini Pro' },
      { id: 'gemini-stream', name: 'Gemini Stream' },
      { id: 'legacy-unspecified', name: 'legacy-unspecified' },
    ]);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          'x-goog-api-key': 'gemini-key',
        },
      }),
    );
  });

  it('follows Anthropic cursor pagination and merges the model pages', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'claude-new', display_name: 'Claude New' }],
          has_more: true,
          last_id: 'cursor one',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'claude-old', display_name: 'Claude Old' }],
          has_more: false,
        }),
      );

    await expect(
      discoverProviderModels({
        provider: provider('anthropic'),
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'anthropic-key',
        fetchImpl,
      }),
    ).resolves.toEqual([
      { id: 'claude-new', name: 'Claude New' },
      { id: 'claude-old', name: 'Claude Old' },
    ]);

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.anthropic.com/v1/models?limit=1000&after_id=cursor+one',
      expect.any(Object),
    );
  });

  it('follows Gemini page tokens and supports the current supportedActions field', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          models: [
            {
              name: 'models/gemini-new',
              supportedActions: ['generateContent'],
            },
          ],
          nextPageToken: 'next/page',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          models: [
            {
              name: 'models/gemini-old',
              supportedActions: ['embedContent'],
            },
          ],
        }),
      );

    await expect(
      discoverProviderModels({
        provider: provider('google'),
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'gemini-key',
        fetchImpl,
      }),
    ).resolves.toEqual([{ id: 'gemini-new', name: 'gemini-new' }]);

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=next%2Fpage',
      expect.any(Object),
    );
  });

  it('rejects invalid or repeated pagination cursors', async () => {
    const missingCursorFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [{ id: 'claude-model' }],
        has_more: true,
      }),
    );
    await expect(
      discoverProviderModels({
        provider: provider('anthropic'),
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'key',
        fetchImpl: missingCursorFetch,
      }),
    ).rejects.toThrow('缺少下一页游标');

    const repeatedCursorFetch = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse({
        models: [{ name: 'models/gemini-model' }],
        nextPageToken: 'same-cursor',
      }),
    );
    await expect(
      discoverProviderModels({
        provider: provider('google'),
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'key',
        fetchImpl: repeatedCursorFetch,
      }),
    ).rejects.toThrow('重复的模型目录分页游标');
  });

  it('uses Ollama tags and never sends the optional local key', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        models: [{ name: 'llama3.2:latest' }, { model: 'qwen2.5:latest' }, { name: '' }],
      }),
    );

    await expect(
      discoverProviderModels({
        provider: provider('ollama'),
        baseUrl: 'http://localhost:11434/',
        apiKey: 'must-not-leave',
        fetchImpl,
      }),
    ).resolves.toEqual([
      { id: 'llama3.2:latest', name: 'llama3.2:latest' },
      { id: 'qwen2.5:latest', name: 'qwen2.5:latest' },
    ]);

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('does not send a key to a public model catalog', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [{ id: 'open/model' }] }));

    await discoverProviderModels({
      provider: provider('vercel-ai-gateway'),
      baseUrl: 'https://ai-gateway.vercel.sh/v1',
      apiKey: 'private-key',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ai-gateway.vercel.sh/v1/models',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('redacts secrets from HTTP and network errors', async () => {
    const secret = 'sk-sensitive-value';
    const httpFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: `Invalid credential ${secret}`,
          },
        },
        { status: 401 },
      ),
    );

    const httpError = await discoverProviderModels({
      provider: provider('openai'),
      baseUrl: 'https://api.openai.com/v1',
      apiKey: secret,
      fetchImpl: httpFetch,
    }).catch((error: unknown) => error);

    expect(httpError).toBeInstanceOf(ProviderDiscoveryError);
    expect((httpError as Error).message).toContain('401');
    expect((httpError as Error).message).toContain('[REDACTED]');
    expect((httpError as Error).message).not.toContain(secret);

    const networkFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`socket closed while sending ${secret}`));
    const networkError = await discoverProviderModels({
      provider: provider('openai'),
      baseUrl: 'https://api.openai.com/v1',
      apiKey: secret,
      fetchImpl: networkFetch,
    }).catch((error: unknown) => error);

    expect(networkError).toBeInstanceOf(ProviderDiscoveryError);
    expect((networkError as Error).message).toContain('[REDACTED]');
    expect((networkError as Error).message).not.toContain(secret);
  });

  it.each([
    ['a top-level message', JSON.stringify({ message: 'quota exhausted' }), 'quota exhausted'],
    ['a string error', JSON.stringify({ error: 'account disabled' }), 'account disabled'],
    ['plain text', '  upstream   unavailable \n retry later  ', 'upstream unavailable retry later'],
  ])('extracts $0 from an HTTP failure', async (_caseName, body, expectedMessage) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 503 }));

    const error = await discoverProviderModels({
      provider: provider('openai'),
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderDiscoveryError);
    expect((error as Error).message).toContain('503');
    expect((error as Error).message).toContain(expectedMessage);
  });

  it('rejects invalid JSON and catalogs without usable models', async () => {
    const invalidJsonFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{not-json', { status: 200 }));

    await expect(
      discoverProviderModels({
        provider: provider('openai'),
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'key',
        fetchImpl: invalidJsonFetch,
      }),
    ).rejects.toBeInstanceOf(ProviderDiscoveryError);

    const emptyFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [{ id: '' }, { id: 'x'.repeat(257) }, { wrong: 'shape' }],
      }),
    );
    await expect(
      discoverProviderModels({
        provider: provider('openai'),
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'key',
        fetchImpl: emptyFetch,
      }),
    ).rejects.toBeInstanceOf(ProviderDiscoveryError);
  });

  it('aborts a model catalog request after the configured timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    });

    const error = await discoverProviderModels({
      provider: provider('openai'),
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'key',
      fetchImpl,
      timeoutMs: 5,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderDiscoveryError);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('rejects responses that exceed the declared or actual one-megabyte limit', async () => {
    const declaredOversizeFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('not read', {
        headers: { 'content-length': '1000001' },
      }),
    );

    await expect(
      discoverProviderModels({
        provider: provider('openai'),
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'key',
        fetchImpl: declaredOversizeFetch,
      }),
    ).rejects.toBeInstanceOf(ProviderDiscoveryError);

    const actualOversizeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(
      discoverProviderModels({
        provider: provider('openai'),
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'key',
        fetchImpl: actualOversizeFetch,
      }),
    ).rejects.toBeInstanceOf(ProviderDiscoveryError);
  });

  it('caps a valid catalog at one thousand unique models', async () => {
    const data = Array.from({ length: 1_005 }, (_, index) => ({
      id: `model-${index}`,
      name: `Model ${index}`,
    }));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data }));

    const models = await discoverProviderModels({
      provider: provider('openai'),
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'key',
      fetchImpl,
    });

    expect(models).toHaveLength(1_000);
    expect(models.at(-1)).toEqual({ id: 'model-999', name: 'Model 999' });
  });
});
