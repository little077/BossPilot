import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  Usage,
} from '@earendil-works/pi-ai';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import { createPiGenerationAdapter, type PiApi } from '@/lib/generation/pi-adapter';
import type {
  GenerationEvent,
  GenerationProtocol,
  ResolvedGenerationTarget,
} from '@/lib/generation/types';

const sdk = vi.hoisted(() => ({ stream: vi.fn() }));

vi.mock('@earendil-works/pi-ai/api/openai-completions', () => ({ stream: sdk.stream }));
vi.mock('@earendil-works/pi-ai/api/openai-responses', () => ({ stream: sdk.stream }));
vi.mock('@earendil-works/pi-ai/api/anthropic-messages', () => ({ stream: sdk.stream }));
vi.mock('@earendil-works/pi-ai/api/google-generative-ai', () => ({ stream: sdk.stream }));
vi.mock('@earendil-works/pi-ai/api/mistral-conversations', () => ({ stream: sdk.stream }));

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

describe('pi-ai default static runtime', () => {
  beforeEach(() => {
    sdk.stream.mockReset();
    sdk.stream.mockImplementation((model: Model<Api>) =>
      events([
        {
          type: 'done',
          reason: 'stop',
          message: assistant(model),
        },
      ]),
    );
  });

  it.each([
    'openai-completions',
    'openai-responses',
    'anthropic-messages',
    'google-generative-ai',
    'mistral-conversations',
  ] satisfies readonly GenerationProtocol[])(
    'uses the statically linked %s stream without runtime import',
    async (protocol) => {
      const adapter = createPiGenerationAdapter();

      const result = await collect(adapter.stream(target(protocol), request()));

      expect(result.at(-1)).toMatchObject({ type: 'finish', reason: 'stop' });
      expect(sdk.stream).toHaveBeenCalledOnce();
      expect(sdk.stream.mock.calls[0]?.[0]).toMatchObject({ api: protocol });
    },
  );

  it('uses the default static provider metadata for an exact OpenAI model', async () => {
    const model = Object.values(OPENAI_MODELS)[0] as Model<PiApi> | undefined;
    if (!model) throw new Error('pi-ai OpenAI catalog must not be empty');
    const adapter = createPiGenerationAdapter();

    await collect(
      adapter.stream(
        {
          identity: { providerId: 'openai', modelId: model.id },
          providerLabel: 'OpenAI',
          modelName: model.name,
          protocol: 'openai-responses',
          baseUrl: model.baseUrl,
          apiKey: 'sk-test-only',
        },
        request(),
      ),
    );

    expect(sdk.stream).toHaveBeenCalledOnce();
    expect(sdk.stream.mock.calls[0]?.[0]).toMatchObject({
      id: model.id,
      api: model.api,
      baseUrl: model.baseUrl,
    });
  });
});

function target(protocol: GenerationProtocol): ResolvedGenerationTarget {
  return {
    identity: { providerId: 'custom', modelId: `test-${protocol}` },
    providerLabel: 'Custom',
    modelName: protocol,
    protocol,
    baseUrl: 'https://example.test/v1',
    apiKey: 'sk-test-only',
  };
}

function request() {
  const message: ChatMessage = {
    id: 'user-1',
    role: 'user',
    content: 'hello',
    createdAt: 1,
  };
  return {
    systemPrompt: 'system',
    messages: [message],
    signal: new AbortController().signal,
  };
}

function assistant(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: 2,
  };
}

async function* events(
  streamEvents: readonly AssistantMessageEvent[],
): AsyncIterable<AssistantMessageEvent> {
  for (const event of streamEvents) yield event;
}

async function collect(stream: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const result: GenerationEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}
