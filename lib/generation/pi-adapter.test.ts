import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  StreamOptions,
  Usage,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '@/lib/domain/chat';
import { GenerationError } from '@/lib/generation/errors';
import {
  createPiGenerationAdapter,
  knownModelSupportsImageInput,
  type PiApi,
  type PiApiLoader,
  type PiCatalogProvider,
  type PiProviderLoader,
} from '@/lib/generation/pi-adapter';
import type {
  GenerationEvent,
  GenerationProtocol,
  GenerationRequest,
  ResolvedGenerationTarget,
} from '@/lib/generation/types';

interface StreamCall {
  api: PiApi;
  model: Model<Api>;
  context: Context;
  options: StreamOptions;
}

interface CatalogStreamCall {
  model: Model<Api>;
  context: Context;
  options: StreamOptions;
}

const USAGE: Usage = {
  input: 12,
  output: 5,
  cacheRead: 3,
  cacheWrite: 2,
  totalTokens: 22,
  cost: {
    input: 0.001,
    output: 0.002,
    cacheRead: 0.0001,
    cacheWrite: 0.0002,
    total: 0.0033,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pi-ai generation adapter', () => {
  it('uses trusted catalog metadata instead of guessing visual support from model names', () => {
    expect(knownModelSupportsImageInput('openai', 'gpt-4.1')).toBe(true);
    expect(knownModelSupportsImageInput('openai', 'o3-mini')).toBe(false);
    expect(knownModelSupportsImageInput('custom', 'gpt-4.1')).toBe(false);
    expect(knownModelSupportsImageInput('openai', 'unknown-vision-model')).toBe(false);
  });

  it('maps chat history, request controls, streamed text, and usage', async () => {
    const calls: StreamCall[] = [];
    const partial = makeAssistant('stop');
    const loadApi = makeLoader(
      [
        { type: 'start', partial },
        { type: 'text_start', contentIndex: 0, partial },
        { type: 'text_delta', contentIndex: 0, delta: '你好', partial },
        { type: 'text_delta', contentIndex: 0, delta: '，世界', partial },
        { type: 'text_end', contentIndex: 0, content: '你好，世界', partial },
        { type: 'done', reason: 'stop', message: makeAssistant('stop', USAGE) },
      ],
      calls,
    );
    const adapter = createPiGenerationAdapter({ loadApi, timeoutMs: 45_000 });
    const controller = new AbortController();
    const history: ChatMessage[] = [
      message('user', '  第一问  ', 1),
      {
        ...message('assistant', '  第一答  ', 2),
        status: 'completed',
        finishReason: 'length',
      },
      { ...message('assistant', '不应回放的错误', 3), error: true },
      { ...message('assistant', '不应回放的错误状态', 4), status: 'error' },
      { ...message('assistant', '尚未完成', 5), status: 'streaming' },
      message('assistant', '   ', 6),
      message('user', '第二问', 7),
    ];

    const result = await collect(
      adapter.stream(makeTarget(), {
        systemPrompt: '你是 BossPilot。',
        messages: history,
        signal: controller.signal,
        maxOutputTokens: 2_048,
        temperature: 0.4,
      }),
    );

    expect(result).toEqual([
      { type: 'start' },
      { type: 'text-delta', delta: '你好' },
      { type: 'text-delta', delta: '，世界' },
      {
        type: 'finish',
        reason: 'stop',
        usage: {
          inputTokens: 12,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          totalTokens: 22,
          cost: 0.0033,
        },
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.api).toBe('openai-completions');
    expect(calls[0]?.model).toMatchObject({
      id: 'chat-model',
      name: 'Chat Model',
      provider: 'provider-one',
      api: 'openai-completions',
      baseUrl: 'https://api.example.com/v1',
      maxTokens: 8_192,
    });
    expect(calls[0]?.context.systemPrompt).toBe('你是 BossPilot。');
    expect(calls[0]?.context.messages).toEqual([
      { role: 'user', content: '  第一问  ', timestamp: 1 },
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: '  第一答  ' }],
        stopReason: 'length',
        timestamp: 2,
      }),
      { role: 'user', content: '第二问', timestamp: 7 },
    ]);
    expect(calls[0]?.options).toEqual({
      apiKey: 'sk-sensitive',
      signal: controller.signal,
      timeoutMs: 45_000,
      maxRetries: 0,
      maxTokens: 2_048,
      temperature: 0.4,
    });
  });

  it('maps an explicit thinking level through the provider payload hook', async () => {
    const calls: StreamCall[] = [];
    const loadApi = makeLoader(
      [{ type: 'done', reason: 'stop', message: makeAssistant('stop') }],
      calls,
    );
    const adapter = createPiGenerationAdapter({ loadApi });
    await collect(
      adapter.stream(makeTarget(), {
        ...makeRequest(),
        thinkingLevel: 'high',
      }),
    );

    expect(await calls[0]?.options.onPayload?.({ model: 'chat-model' }, calls[0].model)).toEqual({
      model: 'chat-model',
      reasoning_effort: 'high',
    });
  });

  it('maps bounded image tool results to pi-ai image content for visual models', async () => {
    const calls: StreamCall[] = [];
    const loadApi = makeLoader(
      [{ type: 'done', reason: 'stop', message: makeAssistant('stop') }],
      calls,
    );
    const adapter = createPiGenerationAdapter({ loadApi });

    await collect(
      adapter.stream(makeTarget({ supportsImageInput: true }), {
        systemPrompt: 'system',
        messages: [
          message('user', '查看页面', 1),
          {
            role: 'toolResult',
            toolCallId: 'visual-1',
            toolName: 'observe_visual_page',
            content: 'visual metadata',
            images: [{ data: 'YWJj', mimeType: 'image/jpeg' }],
            isError: false,
            createdAt: 2,
          },
        ],
        signal: new AbortController().signal,
      }),
    );

    expect(calls[0]?.model.input).toEqual(['text', 'image']);
    expect(calls[0]?.context.messages).toContainEqual(
      expect.objectContaining({
        role: 'toolResult',
        content: [
          { type: 'text', text: 'visual metadata' },
          { type: 'image', data: 'YWJj', mimeType: 'image/jpeg' },
        ],
      }),
    );
  });

  it('maps user image attachments directly to multimodal user content', async () => {
    const calls: StreamCall[] = [];
    const loadApi = makeLoader(
      [{ type: 'done', reason: 'stop', message: makeAssistant('stop') }],
      calls,
    );
    const adapter = createPiGenerationAdapter({ loadApi });
    await collect(
      adapter.stream(makeTarget({ supportsImageInput: true }), {
        systemPrompt: 'system',
        messages: [
          {
            role: 'user',
            content: 'describe',
            createdAt: 1,
            images: [{ data: 'AQID', mimeType: 'image/png' }],
          },
        ],
        signal: new AbortController().signal,
      }),
    );
    expect(calls[0]?.context.messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ],
    });
  });

  it('fails before the provider request if a text-only model receives an image', async () => {
    const stream = vi.fn(() => toAsyncIterable([]));
    const adapter = createPiGenerationAdapter({
      loadApi: async () => stream,
    });
    const request: GenerationRequest = {
      systemPrompt: 'system',
      messages: [
        {
          role: 'toolResult',
          toolCallId: 'visual-1',
          toolName: 'observe_visual_page',
          content: 'visual metadata',
          images: [{ data: 'YWJj', mimeType: 'image/jpeg' }],
          isError: false,
          createdAt: 2,
        },
      ],
      signal: new AbortController().signal,
    };

    await expect(collect(adapter.stream(makeTarget(), request))).rejects.toThrow(
      '当前模型不支持图片输入',
    );
    expect(stream).not.toHaveBeenCalled();
  });

  it('maps protocol-neutral tools, tool calls, and tool results', async () => {
    const calls: StreamCall[] = [];
    const toolCall = {
      type: 'toolCall' as const,
      id: 'call-1',
      name: 'read_current_job',
      arguments: {},
    };
    const partial = {
      ...makeAssistant('toolUse'),
      content: [toolCall],
    };
    const loadApi = makeLoader(
      [
        { type: 'start', partial },
        { type: 'toolcall_end', contentIndex: 0, toolCall, partial },
        { type: 'done', reason: 'toolUse', message: partial },
      ],
      calls,
    );
    const adapter = createPiGenerationAdapter({ loadApi });

    const result = await collect(
      adapter.stream(makeTarget(), {
        systemPrompt: 'system',
        messages: [
          { role: 'user', content: '解读当前岗位', createdAt: 1 },
          {
            role: 'assistant',
            content: '',
            createdAt: 2,
            finishReason: 'tool',
            toolCalls: [{ id: 'prior-call', name: 'read_current_job', arguments: {} }],
          },
          {
            role: 'toolResult',
            toolCallId: 'prior-call',
            toolName: 'read_current_job',
            content: '岗位资料',
            isError: false,
            createdAt: 3,
          },
        ],
        tools: [
          {
            name: 'read_current_job',
            label: '读取当前岗位',
            description: '读取当前岗位详情',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
        ],
        signal: new AbortController().signal,
      }),
    );

    expect(result).toEqual([
      { type: 'start' },
      {
        type: 'tool-call',
        toolCall: { id: 'call-1', name: 'read_current_job', arguments: {} },
      },
      {
        type: 'finish',
        reason: 'tool',
        usage: {
          inputTokens: 12,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          totalTokens: 22,
          cost: 0.0033,
        },
      },
    ]);
    expect(calls[0]?.context.tools).toEqual([
      {
        name: 'read_current_job',
        description: '读取当前岗位详情',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    ]);
    expect(calls[0]?.context.messages).toEqual([
      { role: 'user', content: '解读当前岗位', timestamp: 1 },
      expect.objectContaining({
        role: 'assistant',
        stopReason: 'toolUse',
        content: [expect.objectContaining({ type: 'toolCall', id: 'prior-call' })],
      }),
      {
        role: 'toolResult',
        toolCallId: 'prior-call',
        toolName: 'read_current_job',
        content: [{ type: 'text', text: '岗位资料' }],
        isError: false,
        timestamp: 3,
      },
    ]);
  });

  it.each([
    ['openai-completions', 'openai-completions'],
    ['openai-responses', 'openai-responses'],
    ['anthropic-messages', 'anthropic-messages'],
    ['google-generative-ai', 'google-generative-ai'],
    ['mistral-conversations', 'mistral-conversations'],
  ] as const)('dispatches %s to only its %s API loader', async (protocol, expectedApi) => {
    const calls: StreamCall[] = [];
    const loadApi = makeLoader(
      [{ type: 'done', reason: 'stop', message: makeAssistant('stop') }],
      calls,
    );
    const adapter = createPiGenerationAdapter({ loadApi });

    await collect(adapter.stream(makeTarget({ protocol }), makeRequest()));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.api).toBe(expectedApi);
    expect(calls[0]?.model.api).toBe(expectedApi);
  });

  it('prefers an exact same-origin catalog model and keeps its metadata', async () => {
    const catalogModel: Model<'openai-responses'> = {
      id: 'gpt-catalog',
      name: 'GPT Catalog',
      api: 'openai-responses',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
      headers: { 'x-catalog-header': 'kept' },
      compat: { supportsDeveloperRole: false },
    };
    const catalogCalls: CatalogStreamCall[] = [];
    const provider = makeCatalogProvider(
      [catalogModel],
      [{ type: 'done', reason: 'stop', message: makeAssistant('stop') }],
      catalogCalls,
    );
    const loadProvider: PiProviderLoader = async () => provider;
    const loadApi: PiApiLoader = async () => {
      throw new Error('generic fallback should not load');
    };
    const adapter = createPiGenerationAdapter({ loadApi, loadProvider });

    await collect(
      adapter.stream(
        makeTarget({
          identity: { providerId: 'openai', modelId: 'gpt-catalog' },
          providerLabel: 'OpenAI',
          modelName: 'GPT Catalog',
          protocol: 'openai-completions',
          baseUrl: 'https://api.openai.com/v1',
        }),
        makeRequest(),
      ),
    );

    expect(catalogCalls).toHaveLength(1);
    expect(catalogCalls[0]?.model).toBe(catalogModel);
    expect(catalogCalls[0]?.model).toMatchObject({
      api: 'openai-responses',
      reasoning: true,
      headers: { 'x-catalog-header': 'kept' },
      compat: { supportsDeveloperRole: false },
    });
    expect(catalogCalls[0]?.options).toMatchObject({
      apiKey: 'sk-sensitive',
      maxRetries: 0,
      maxTokens: 4_096,
    });
  });

  it('lets a mixed catalog provider dispatch using the selected model API', async () => {
    const openAIModel: Model<'openai-completions'> = {
      id: 'accounts/fireworks/models/llama',
      name: 'Llama',
      api: 'openai-completions',
      provider: 'fireworks',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 8_192,
    };
    const anthropicModel: Model<'anthropic-messages'> = {
      id: 'accounts/fireworks/models/deepseek',
      name: 'DeepSeek',
      api: 'anthropic-messages',
      provider: 'fireworks',
      baseUrl: 'https://api.fireworks.ai/inference',
      reasoning: true,
      input: ['text'],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
      headers: { 'x-fireworks-model': 'anthropic' },
      compat: { supportsEagerToolInputStreaming: false },
    };
    const catalogCalls: CatalogStreamCall[] = [];
    const provider = makeCatalogProvider(
      [openAIModel, anthropicModel],
      [{ type: 'done', reason: 'stop', message: makeAssistant('stop') }],
      catalogCalls,
    );
    const adapter = createPiGenerationAdapter({
      loadProvider: async () => provider,
      loadApi: async () => {
        throw new Error('generic fallback should not load');
      },
    });

    await collect(
      adapter.stream(
        makeTarget({
          identity: {
            providerId: 'fireworks',
            modelId: 'accounts/fireworks/models/deepseek',
          },
          providerLabel: 'Fireworks',
          modelName: 'DeepSeek',
          protocol: 'openai-completions',
          baseUrl: 'https://api.fireworks.ai/inference/v1',
        }),
        makeRequest(),
      ),
    );

    expect(catalogCalls).toHaveLength(1);
    expect(catalogCalls[0]?.model).toBe(anthropicModel);
    expect(catalogCalls[0]?.model).toMatchObject({
      api: 'anthropic-messages',
      headers: { 'x-fireworks-model': 'anthropic' },
      compat: { supportsEagerToolInputStreaming: false },
    });
    expect(catalogCalls[0]?.options.maxTokens).toBe(8_192);
  });

  it('falls back to the configured protocol when a catalog lacks the selected model', async () => {
    const catalogCalls: CatalogStreamCall[] = [];
    const provider = makeCatalogProvider(
      [makeBasicCatalogModel('another-model', 'openai-responses', 'openai')],
      [{ type: 'done', reason: 'stop', message: makeAssistant('stop') }],
      catalogCalls,
    );
    const apiCalls: StreamCall[] = [];
    const adapter = createPiGenerationAdapter({
      loadProvider: async () => provider,
      loadApi: makeLoader(
        [{ type: 'done', reason: 'stop', message: makeAssistant('stop') }],
        apiCalls,
      ),
    });

    await collect(
      adapter.stream(
        makeTarget({
          identity: { providerId: 'openai', modelId: 'new-model' },
          providerLabel: 'OpenAI',
          modelName: 'New Model',
          protocol: 'openai-responses',
          baseUrl: 'https://api.openai.com/v1',
        }),
        makeRequest(),
      ),
    );

    expect(catalogCalls).toHaveLength(0);
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0]?.model).toMatchObject({
      id: 'new-model',
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('rejects a cross-origin catalog model and keeps the key on the configured origin', async () => {
    const catalogModel = makeBasicCatalogModel(
      'same-id',
      'openai-responses',
      'openai',
      'https://unexpected.example/v1',
    );
    const catalogCalls: CatalogStreamCall[] = [];
    const apiCalls: StreamCall[] = [];
    const adapter = createPiGenerationAdapter({
      loadProvider: async () =>
        makeCatalogProvider(
          [catalogModel],
          [{ type: 'done', reason: 'stop', message: makeAssistant('stop') }],
          catalogCalls,
        ),
      loadApi: makeLoader(
        [{ type: 'done', reason: 'stop', message: makeAssistant('stop') }],
        apiCalls,
      ),
    });

    await collect(
      adapter.stream(
        makeTarget({
          identity: { providerId: 'openai', modelId: 'same-id' },
          providerLabel: 'OpenAI',
          modelName: 'Same ID',
          protocol: 'openai-responses',
          baseUrl: 'https://api.openai.com/v1',
        }),
        makeRequest(),
      ),
    );

    expect(catalogCalls).toHaveLength(0);
    expect(apiCalls[0]?.model.baseUrl).toBe('https://api.openai.com/v1');
    expect(apiCalls[0]?.options.apiKey).toBe('sk-sensitive');
  });

  it('uses conservative OpenAI compatibility flags for Ollama', async () => {
    const calls: StreamCall[] = [];
    const loadApi = makeLoader(
      [{ type: 'done', reason: 'stop', message: makeAssistant('stop') }],
      calls,
    );
    const adapter = createPiGenerationAdapter({ loadApi });

    await collect(
      adapter.stream(
        makeTarget({
          identity: { providerId: 'ollama', modelId: 'qwen3:8b' },
          providerLabel: 'Ollama',
          modelName: 'qwen3:8b',
          baseUrl: 'http://localhost:11434/v1',
          apiKey: '',
        }),
        makeRequest(),
      ),
    );

    expect(calls[0]?.model).toMatchObject({
      provider: 'ollama',
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: 'max_tokens',
      },
    });
  });

  it.each([
    {
      providerId: 'ollama',
      providerLabel: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
    },
    {
      providerId: 'custom',
      providerLabel: 'Custom',
      baseUrl: 'https://keyless.example.test/v1',
    },
  ])(
    'keeps Authorization off the wire for keyless $providerId with the default runtime',
    async ({ providerId, providerLabel, baseUrl }) => {
      let capturedRequest: Request | undefined;
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        capturedRequest = new Request(input, init);
        return openAIStreamResponse();
      });
      vi.stubGlobal('fetch', fetchMock);
      const adapter = createPiGenerationAdapter();

      const result = await collect(
        adapter.stream(
          makeTarget({
            identity: { providerId, modelId: 'keyless-model' },
            providerLabel,
            modelName: 'Keyless Model',
            baseUrl,
            apiKey: '',
          }),
          makeRequest(),
        ),
      );

      expect(result).toContainEqual({ type: 'text-delta', delta: 'ok' });
      expect(result.at(-1)).toMatchObject({ type: 'finish', reason: 'stop' });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(capturedRequest?.url).toBe(`${baseUrl}/chat/completions`);
      expect(capturedRequest?.headers.get('authorization')).toBeNull();
      expect([...(capturedRequest?.headers ?? new Headers()).values()].join(' ')).not.toContain(
        'unused',
      );
    },
  );

  it('does not enable keyless transport for an unregistered provider', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createPiGenerationAdapter();

    const error = await readRejectedError(
      adapter.stream(makeTarget({ apiKey: '' }), makeRequest()),
    );

    expect(error).toBeInstanceOf(GenerationError);
    expect(error.message).toContain('No API key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['length', 'length'],
    ['toolUse', 'tool'],
  ] as const)('normalizes pi-ai %s completion to %s', async (piReason, expectedReason) => {
    const loadApi = makeLoader([
      {
        type: 'done',
        reason: piReason,
        message: makeAssistant(piReason),
      },
    ]);
    const adapter = createPiGenerationAdapter({ loadApi });

    const result = await collect(adapter.stream(makeTarget(), makeRequest()));

    expect(result.at(-1)).toMatchObject({ type: 'finish', reason: expectedReason });
  });

  it('rejects deferred provider responses until durable polling is implemented', async () => {
    const loadApi = makeLoader([
      {
        type: 'done',
        reason: 'deferred',
        message: makeAssistant('deferred'),
      },
    ]);
    const adapter = createPiGenerationAdapter({ loadApi });

    await expect(collect(adapter.stream(makeTarget(), makeRequest()))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: false,
    });
  });

  it('preserves an upstream aborted terminal as cancellation', async () => {
    const loadApi = makeLoader([
      {
        type: 'error',
        reason: 'aborted',
        error: makeAssistant('aborted', USAGE, 'request aborted'),
      },
    ]);
    const adapter = createPiGenerationAdapter({ loadApi });

    await expect(collect(adapter.stream(makeTarget(), makeRequest()))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('turns an aborted request signal into cancellation even if upstream throws another error', async () => {
    const controller = new AbortController();
    const loadApi: PiApiLoader = async () => {
      return () => {
        const iterator: AsyncIterator<AssistantMessageEvent> = {
          next: async () => {
            controller.abort();
            throw new Error('upstream transport closed');
          },
        };
        return {
          [Symbol.asyncIterator]: () => iterator,
        };
      };
    };
    const adapter = createPiGenerationAdapter({ loadApi });

    await expect(
      collect(
        adapter.stream(makeTarget(), {
          ...makeRequest(),
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('redacts the API key from upstream terminal errors', async () => {
    const loadApi = makeLoader([
      {
        type: 'error',
        reason: 'error',
        error: makeAssistant(
          'error',
          USAGE,
          'provider rejected Authorization: Bearer sk-sensitive',
        ),
      },
    ]);
    const adapter = createPiGenerationAdapter({ loadApi });

    const error = await readRejectedError(adapter.stream(makeTarget(), makeRequest()));

    expect(error).toBeInstanceOf(GenerationError);
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain('sk-sensitive');
  });

  it.each([
    ['OpenAI API error (401): rejected sk-sensitive', 'AUTH_ERROR', false, 401],
    ['403 status code: credential sk-sensitive denied', 'AUTH_ERROR', false, 403],
    ['request failed with statusCode: 408 for sk-sensitive', 'TIMEOUT', true, 408],
    ['429: quota exhausted for sk-sensitive', 'RATE_LIMITED', true, 429],
    ['HTTP 500: provider failed near sk-sensitive', 'UPSTREAM_ERROR', true, 500],
    ['Mistral API error (503): unavailable sk-sensitive', 'UPSTREAM_ERROR', true, 503],
  ] as const)(
    'classifies stream error "%s" as %s without leaking the key',
    async (message, expectedCode, expectedRetryable, expectedStatus) => {
      const loadApi = makeLoader([
        {
          type: 'error',
          reason: 'error',
          error: makeAssistant('error', USAGE, message),
        },
      ]);
      const adapter = createPiGenerationAdapter({ loadApi });

      const error = await readRejectedError(adapter.stream(makeTarget(), makeRequest()));

      expect(error).toBeInstanceOf(GenerationError);
      expect(error).toMatchObject({
        code: expectedCode,
        retryable: expectedRetryable,
        status: expectedStatus,
      });
      expect(error.message).toContain('[REDACTED]');
      expect(error.message).not.toContain('sk-sensitive');
    },
  );

  it('keeps an unclassified provider terminal as a redacted upstream error', async () => {
    const loadApi = makeLoader([
      {
        type: 'error',
        reason: 'error',
        error: makeAssistant(
          'error',
          USAGE,
          'content policy rejected request signed with sk-sensitive',
        ),
      },
    ]);
    const adapter = createPiGenerationAdapter({ loadApi });

    const error = await readRejectedError(adapter.stream(makeTarget(), makeRequest()));

    expect(error).toMatchObject({
      code: 'UPSTREAM_ERROR',
      retryable: true,
      status: undefined,
    });
    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain('sk-sensitive');
  });

  it('rejects a stream that closes without a terminal event', async () => {
    const partial = makeAssistant('stop');
    const loadApi = makeLoader([
      { type: 'start', partial },
      { type: 'text_delta', contentIndex: 0, delta: '未完成', partial },
    ]);
    const adapter = createPiGenerationAdapter({ loadApi });

    const error = await readRejectedError(adapter.stream(makeTarget(), makeRequest()));

    expect(error).toBeInstanceOf(GenerationError);
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE', retryable: true });
  });
});

function makeTarget(
  overrides: Partial<ResolvedGenerationTarget> & { protocol?: GenerationProtocol } = {},
): ResolvedGenerationTarget {
  return {
    identity: { providerId: 'provider-one', modelId: 'chat-model' },
    providerLabel: 'Provider One',
    modelName: 'Chat Model',
    protocol: 'openai-completions',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-sensitive',
    ...overrides,
  };
}

function makeRequest(): GenerationRequest {
  return {
    systemPrompt: 'system',
    messages: [message('user', 'hello', 1)],
    signal: new AbortController().signal,
  };
}

function openAIStreamResponse(): Response {
  const chunks = [
    {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'keyless-model',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'ok' },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'keyless-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function message(role: ChatMessage['role'], content: string, createdAt: number): ChatMessage {
  return {
    id: `message-${createdAt}`,
    role,
    content,
    createdAt,
  };
}

function makeAssistant(
  stopReason: AssistantMessage['stopReason'],
  usage: Usage = USAGE,
  errorMessage?: string,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'provider-one',
    model: 'chat-model',
    usage,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 10,
  };
}

function makeLoader(events: AssistantMessageEvent[], calls: StreamCall[] = []): PiApiLoader {
  return async (api) => {
    return (model, context, options) => {
      calls.push({ api, model, context, options });
      return toAsyncIterable(events);
    };
  };
}

function makeCatalogProvider(
  models: readonly Model<Api>[],
  events: AssistantMessageEvent[],
  calls: CatalogStreamCall[],
): PiCatalogProvider {
  return {
    getModels: () => models,
    stream: (model, context, options) => {
      calls.push({ model, context, options });
      return toAsyncIterable(events);
    },
  };
}

function makeBasicCatalogModel(
  id: string,
  api: PiApi,
  provider: string,
  baseUrl = 'https://api.openai.com/v1',
): Model<Api> {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 8_192,
  };
}

async function* toAsyncIterable(
  events: AssistantMessageEvent[],
): AsyncIterable<AssistantMessageEvent> {
  for (const event of events) yield event;
}

async function collect(events: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const result: GenerationEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function readRejectedError(events: AsyncIterable<GenerationEvent>): Promise<Error> {
  try {
    await collect(events);
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Expected Error, received ${String(error)}`);
  }
  throw new Error('Expected stream to reject.');
}
