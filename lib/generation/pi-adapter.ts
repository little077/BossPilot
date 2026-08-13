// ─── pi-ai 统一生成适配器 ───
// 职责：把 BossPilot 的模型目标和对话历史转换为 pi-ai 的协议无关结构，
// 并以 MV3 Service Worker 安全的静态 ESM 方式分派五类流实现。
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  StopReason,
  StreamOptions,
  TSchema,
  Usage,
} from '@earendil-works/pi-ai';
import { stream as streamAnthropicMessages } from '@earendil-works/pi-ai/api/anthropic-messages';
import { stream as streamGoogleGenerativeAI } from '@earendil-works/pi-ai/api/google-generative-ai';
import { stream as streamMistralConversations } from '@earendil-works/pi-ai/api/mistral-conversations';
import { stream as streamOpenAICompletions } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as streamOpenAIResponses } from '@earendil-works/pi-ai/api/openai-responses';
import { ANT_LING_MODELS } from '@earendil-works/pi-ai/providers/ant-ling.models';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { CEREBRAS_MODELS } from '@earendil-works/pi-ai/providers/cerebras.models';
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models';
import { FIREWORKS_MODELS } from '@earendil-works/pi-ai/providers/fireworks.models';
import { GOOGLE_MODELS } from '@earendil-works/pi-ai/providers/google.models';
import { GROQ_MODELS } from '@earendil-works/pi-ai/providers/groq.models';
import { HUGGINGFACE_MODELS } from '@earendil-works/pi-ai/providers/huggingface.models';
import { KIMI_CODING_MODELS } from '@earendil-works/pi-ai/providers/kimi-coding.models';
import { MINIMAX_MODELS } from '@earendil-works/pi-ai/providers/minimax.models';
import { MINIMAX_CN_MODELS } from '@earendil-works/pi-ai/providers/minimax-cn.models';
import { MISTRAL_MODELS } from '@earendil-works/pi-ai/providers/mistral.models';
import { MOONSHOTAI_MODELS } from '@earendil-works/pi-ai/providers/moonshotai.models';
import { MOONSHOTAI_CN_MODELS } from '@earendil-works/pi-ai/providers/moonshotai-cn.models';
import { NVIDIA_MODELS } from '@earendil-works/pi-ai/providers/nvidia.models';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { OPENROUTER_MODELS } from '@earendil-works/pi-ai/providers/openrouter.models';
import { TOGETHER_MODELS } from '@earendil-works/pi-ai/providers/together.models';
import { VERCEL_AI_GATEWAY_MODELS } from '@earendil-works/pi-ai/providers/vercel-ai-gateway.models';
import { XAI_MODELS } from '@earendil-works/pi-ai/providers/xai.models';
import { XIAOMI_MODELS } from '@earendil-works/pi-ai/providers/xiaomi.models';
import { XIAOMI_TOKEN_PLAN_CN_MODELS } from '@earendil-works/pi-ai/providers/xiaomi-token-plan-cn.models';
import { ZAI_MODELS } from '@earendil-works/pi-ai/providers/zai.models';
import { registerTracerProvider } from '@mistralai/mistralai/extra/observability';
import type { GenerationFinishReason } from '@/lib/domain/chat';
import { GenerationError, isAbortError, sanitizeGenerationError } from '@/lib/generation/errors';
import type {
  GenerationAdapter,
  GenerationEvent,
  GenerationProtocol,
  GenerationRequest,
  ResolvedGenerationTarget,
} from '@/lib/generation/types';
import { getProviderDefinition } from '@/lib/providers/registry';

export type PiApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'mistral-conversations';

type PiStream = (
  model: Model<Api>,
  context: Context,
  options: StreamOptions,
) => AsyncIterable<AssistantMessageEvent>;

export type PiApiLoader = (api: PiApi) => Promise<PiStream>;

export interface PiCatalogProvider {
  getModels(): readonly Model<Api>[];
  stream(
    model: Model<Api>,
    context: Context,
    options: StreamOptions,
  ): AsyncIterable<AssistantMessageEvent>;
}

export type PiProviderLoader = (providerId: string) => Promise<PiCatalogProvider | undefined>;

export interface PiGenerationAdapterOptions {
  loadApi?: PiApiLoader;
  loadProvider?: PiProviderLoader;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
// pi-ai/OpenAI require a non-empty client initializer even for keyless compatible endpoints.
// Authorization: null is the SDK-supported way to suppress the generated bearer header, so this
// process-local value is never sent to the provider.
const KEYLESS_OPENAI_CLIENT_INITIALIZER = 'unused';

const CATALOG_MODELS: Readonly<Record<string, readonly Model<Api>[]>> = {
  'ant-ling': Object.values(ANT_LING_MODELS),
  anthropic: Object.values(ANTHROPIC_MODELS),
  cerebras: Object.values(CEREBRAS_MODELS),
  deepseek: Object.values(DEEPSEEK_MODELS),
  fireworks: Object.values(FIREWORKS_MODELS),
  google: Object.values(GOOGLE_MODELS),
  groq: Object.values(GROQ_MODELS),
  huggingface: Object.values(HUGGINGFACE_MODELS),
  'kimi-coding': Object.values(KIMI_CODING_MODELS),
  minimax: Object.values(MINIMAX_MODELS),
  'minimax-cn': Object.values(MINIMAX_CN_MODELS),
  mistral: Object.values(MISTRAL_MODELS),
  moonshotai: Object.values(MOONSHOTAI_MODELS),
  'moonshotai-cn': Object.values(MOONSHOTAI_CN_MODELS),
  nvidia: Object.values(NVIDIA_MODELS),
  openai: Object.values(OPENAI_MODELS),
  openrouter: Object.values(OPENROUTER_MODELS),
  together: Object.values(TOGETHER_MODELS),
  'vercel-ai-gateway': Object.values(VERCEL_AI_GATEWAY_MODELS),
  xai: Object.values(XAI_MODELS),
  xiaomi: Object.values(XIAOMI_MODELS),
  'xiaomi-token-plan-cn': Object.values(XIAOMI_TOKEN_PLAN_CN_MODELS),
  zai: Object.values(ZAI_MODELS),
};
const CATALOG_PROVIDER_IDS = new Set(Object.keys(CATALOG_MODELS));

/** 只信任随 pi-ai 发布的模型元数据；未知端点不会靠名称猜测视觉能力。 */
export function knownModelSupportsImageInput(providerId: string, modelId: string): boolean {
  return (
    CATALOG_MODELS[providerId]?.some(
      (model) => model.id === modelId && model.input.includes('image'),
    ) ?? false
  );
}

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

export function createPiGenerationAdapter({
  loadApi = loadPiApi,
  loadProvider = loadPiProvider,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: PiGenerationAdapterOptions = {}): GenerationAdapter {
  return {
    async *stream(
      target: ResolvedGenerationTarget,
      request: GenerationRequest,
    ): AsyncIterable<GenerationEvent> {
      request.signal.throwIfAborted();

      let terminalReceived = false;
      let startEmitted = false;

      try {
        const runtime = await resolveRuntime(target, loadProvider, loadApi);
        request.signal.throwIfAborted();
        const context = createContext(runtime.model, request);
        const options = createStreamOptions(target, runtime.model, request, timeoutMs);

        for await (const event of runtime.stream(runtime.model, context, options)) {
          if (event.type === 'start') {
            if (!startEmitted) {
              startEmitted = true;
              yield { type: 'start' };
            }
            continue;
          }

          if (event.type === 'text_delta') {
            if (!startEmitted) {
              startEmitted = true;
              yield { type: 'start' };
            }
            if (event.delta) yield { type: 'text-delta', delta: event.delta };
            continue;
          }

          if (event.type === 'toolcall_end') {
            if (!startEmitted) {
              startEmitted = true;
              yield { type: 'start' };
            }
            yield {
              type: 'tool-call',
              toolCall: {
                id: event.toolCall.id,
                name: event.toolCall.name,
                arguments: toUnknownRecord(event.toolCall.arguments),
              },
            };
            continue;
          }

          if (event.type === 'done') {
            terminalReceived = true;
            if (!startEmitted) {
              startEmitted = true;
              yield { type: 'start' };
            }
            yield {
              type: 'finish',
              reason: normalizeFinishReason(event.reason),
              usage: normalizeUsage(event.message.usage),
            };
            break;
          }

          if (event.type === 'error') {
            terminalReceived = true;
            if (event.reason === 'aborted' || request.signal.aborted) {
              throw createAbortError(event.error.errorMessage);
            }
            throw classifyStreamError(event.error.errorMessage, target.apiKey);
          }
        }

        if (!terminalReceived) {
          throw new GenerationError(
            'INVALID_RESPONSE',
            '模型厂商提前结束了响应，未返回完成状态。',
            true,
          );
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (request.signal.aborted) throw createAbortError();
        throw sanitizeGenerationError(error, target.apiKey);
      }
    },
  };
}

function protocolToApi(protocol: GenerationProtocol): PiApi {
  const protocolId: string = protocol;
  switch (protocolId) {
    case 'openai-completions':
      return 'openai-completions';
    case 'openai-responses':
      return 'openai-responses';
    case 'anthropic-messages':
      return 'anthropic-messages';
    case 'google-generative-ai':
      return 'google-generative-ai';
    case 'mistral-conversations':
      return 'mistral-conversations';
    default:
      throw new GenerationError('INVALID_RESPONSE', `不支持的模型生成协议：${protocolId}`, false);
  }
}

async function resolveRuntime(
  target: ResolvedGenerationTarget,
  loadProvider: PiProviderLoader,
  loadApi: PiApiLoader,
): Promise<{ model: Model<Api>; stream: PiStream }> {
  if (CATALOG_PROVIDER_IDS.has(target.identity.providerId)) {
    const provider = await loadProvider(target.identity.providerId);
    const model = provider
      ?.getModels()
      .find((candidate) => candidate.id === target.identity.modelId);

    if (provider && model && haveSameOrigin(model.baseUrl, target.baseUrl)) {
      return {
        model,
        stream: (selectedModel, context, options) =>
          provider.stream(selectedModel, context, options),
      };
    }
  }

  const api = protocolToApi(target.protocol);
  return {
    model: createRuntimeModel(target, api),
    stream: await loadApi(api),
  };
}

function createRuntimeModel(target: ResolvedGenerationTarget, api: PiApi): Model<PiApi> {
  const useConservativeOpenAICompat =
    api === 'openai-completions' &&
    (target.identity.providerId === 'ollama' || target.identity.providerId === 'custom');

  return {
    id: target.identity.modelId,
    name: target.modelName,
    api,
    provider: target.identity.providerId,
    baseUrl: target.baseUrl,
    reasoning: false,
    input: target.supportsImageInput ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    ...(useConservativeOpenAICompat
      ? {
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            maxTokensField: 'max_tokens' as const,
          },
        }
      : {}),
  };
}

function createContext(model: Model<Api>, request: GenerationRequest): Context {
  const hasImageInput = request.messages.some(
    (message) =>
      (message.role === 'toolResult' || message.role === 'user') &&
      'images' in message &&
      Boolean(message.images?.length),
  );
  if (hasImageInput && !model.input.includes('image')) {
    throw new GenerationError(
      'INVALID_RESPONSE',
      '当前模型不支持图片输入，请切换到支持视觉的模型后重试。',
      false,
    );
  }
  return {
    systemPrompt: request.systemPrompt,
    messages: request.messages.flatMap<Context['messages'][number]>((message) => {
      const content = message.content;
      const toolCalls =
        message.role === 'assistant' && 'toolCalls' in message ? message.toolCalls : undefined;
      if (!content.trim() && (message.role !== 'assistant' || (toolCalls?.length ?? 0) === 0)) {
        return [];
      }

      if (message.role === 'user') {
        const images = 'images' in message ? message.images : undefined;
        return [
          {
            role: 'user' as const,
            content: images?.length
              ? [
                  { type: 'text' as const, text: content },
                  ...images.map((image) => ({
                    type: 'image' as const,
                    data: image.data,
                    mimeType: image.mimeType,
                  })),
                ]
              : content,
            timestamp: message.createdAt,
          },
        ];
      }

      if (message.role === 'toolResult') {
        return [
          {
            role: 'toolResult' as const,
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            content: [
              { type: 'text' as const, text: content },
              ...(message.images ?? []).map((image) => ({
                type: 'image' as const,
                data: image.data,
                mimeType: image.mimeType,
              })),
            ],
            isError: message.isError,
            timestamp: message.createdAt,
          },
        ];
      }

      if (
        ('error' in message && message.error) ||
        ('status' in message && (message.status === 'error' || message.status === 'streaming'))
      ) {
        return [];
      }

      const assistant: AssistantMessage = {
        role: 'assistant',
        content: [
          ...(content ? [{ type: 'text' as const, text: content }] : []),
          ...(toolCalls ?? []).map((toolCall) => ({
            type: 'toolCall' as const,
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          })),
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: EMPTY_USAGE,
        stopReason: chatFinishReasonToPi(
          message.finishReason ?? (toolCalls?.length ? 'tool' : undefined),
        ),
        timestamp: message.createdAt,
      };
      return [assistant];
    }),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as unknown as TSchema,
          })),
        }
      : {}),
  };
}

function createStreamOptions(
  target: ResolvedGenerationTarget,
  model: Model<Api>,
  request: GenerationRequest,
  timeoutMs: number,
): StreamOptions {
  const requestedMaxTokens = positiveInteger(request.maxOutputTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const modelMaxTokens = positiveInteger(model.maxTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const usesKeylessOpenAITransport =
    target.apiKey.length === 0 &&
    model.api === 'openai-completions' &&
    getProviderDefinition(target.identity.providerId)?.keyOptional === true;

  return {
    apiKey: usesKeylessOpenAITransport ? KEYLESS_OPENAI_CLIENT_INITIALIZER : target.apiKey,
    signal: request.signal,
    timeoutMs,
    maxRetries: 0,
    maxTokens: Math.min(requestedMaxTokens, modelMaxTokens),
    ...(usesKeylessOpenAITransport ? { headers: { Authorization: null } } : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.thinkingLevel && request.thinkingLevel !== 'off'
      ? {
          onPayload: (payload: unknown) =>
            applyThinkingLevel(payload, target.protocol, request.thinkingLevel ?? 'off'),
        }
      : {}),
  };
}

function applyThinkingLevel(
  payload: unknown,
  protocol: ResolvedGenerationTarget['protocol'],
  level: Exclude<NonNullable<GenerationRequest['thinkingLevel']>, 'off'> | 'off',
): unknown {
  if (level === 'off' || !isRecord(payload)) return payload;
  switch (protocol) {
    case 'openai-completions':
      return { ...payload, reasoning_effort: level };
    case 'openai-responses':
      return {
        ...payload,
        reasoning: { ...(isRecord(payload.reasoning) ? payload.reasoning : {}), effort: level },
      };
    case 'anthropic-messages':
      return {
        ...payload,
        thinking: { type: 'adaptive' },
        output_config: {
          ...(isRecord(payload.output_config) ? payload.output_config : {}),
          effort: level,
        },
      };
    case 'google-generative-ai':
      return {
        ...payload,
        generationConfig: {
          ...(isRecord(payload.generationConfig) ? payload.generationConfig : {}),
          thinkingConfig: { thinkingLevel: level.toUpperCase() },
        },
      };
    case 'mistral-conversations':
      return payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadPiApi(api: PiApi): Promise<PiStream> {
  return staticStreamForApi(api);
}

async function loadPiProvider(providerId: string): Promise<PiCatalogProvider | undefined> {
  const models = CATALOG_MODELS[providerId];
  if (!models) return undefined;

  return {
    getModels: () => models,
    stream: (model, context, options) =>
      staticStreamForApi(requirePiApi(model.api))(model, context, options),
  };
}

function staticStreamForApi(api: PiApi): PiStream {
  switch (api) {
    case 'openai-completions':
      return (model, context, options) => {
        assertModelApi(model, api);
        return streamOpenAICompletions(model, context, options);
      };
    case 'openai-responses':
      return (model, context, options) => {
        assertModelApi(model, api);
        return streamOpenAIResponses(model, context, options);
      };
    case 'anthropic-messages':
      return (model, context, options) => {
        assertModelApi(model, api);
        return streamAnthropicMessages(model, context, options);
      };
    case 'google-generative-ai':
      return (model, context, options) => {
        assertModelApi(model, api);
        return streamGoogleGenerativeAI(model, context, options);
      };
    case 'mistral-conversations':
      return (model, context, options) => {
        assertModelApi(model, api);
        // Mistral SDK 会懒加载同一遥测包；预先建立静态引用以适配 MV3 Service Worker。
        if (typeof registerTracerProvider !== 'function') {
          throw new GenerationError('INVALID_RESPONSE', 'Mistral 遥测模块加载失败。', false);
        }
        return streamMistralConversations(model, context, options);
      };
  }
}

function assertModelApi<TApi extends PiApi>(
  model: Model<Api>,
  api: TApi,
): asserts model is Model<TApi> {
  if (model.api !== api) {
    throw new GenerationError(
      'INVALID_RESPONSE',
      `模型协议与流实现不一致：${model.api} / ${api}`,
      false,
    );
  }
}

function requirePiApi(api: Api): PiApi {
  switch (api) {
    case 'openai-completions':
      return 'openai-completions';
    case 'openai-responses':
      return 'openai-responses';
    case 'anthropic-messages':
      return 'anthropic-messages';
    case 'google-generative-ai':
      return 'google-generative-ai';
    case 'mistral-conversations':
      return 'mistral-conversations';
    default:
      throw new GenerationError('INVALID_RESPONSE', `不支持的模型生成协议：${api}`, false);
  }
}

function haveSameOrigin(catalogBaseUrl: string, targetBaseUrl: string): boolean {
  try {
    return new URL(catalogBaseUrl).origin === new URL(targetBaseUrl).origin;
  } catch {
    return false;
  }
}

function chatFinishReasonToPi(reason?: GenerationFinishReason): StopReason {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool':
      return 'toolUse';
    case 'cancelled':
      return 'aborted';
    default:
      return 'stop';
  }
}

function normalizeFinishReason(
  reason: Extract<StopReason, 'stop' | 'length' | 'toolUse' | 'deferred'>,
): 'stop' | 'length' | 'tool' {
  if (reason === 'length') return 'length';
  if (reason === 'toolUse') return 'tool';
  if (reason === 'deferred') {
    throw new GenerationError(
      'INVALID_RESPONSE',
      '当前模型返回了延迟响应，但 BossPilot 尚未支持异步结果轮询，请更换模型后重试。',
      false,
    );
  }
  return 'stop';
}

function normalizeUsage(usage: Usage): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
} {
  return {
    inputTokens: nonNegativeNumber(usage.input),
    outputTokens: nonNegativeNumber(usage.output),
    cacheReadTokens: nonNegativeNumber(usage.cacheRead),
    cacheWriteTokens: nonNegativeNumber(usage.cacheWrite),
    totalTokens: nonNegativeNumber(usage.totalTokens),
    cost: nonNegativeNumber(usage.cost?.total),
  };
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function toUnknownRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

function classifyStreamError(message: string | undefined, secret: string): GenerationError {
  const publicMessage = message || '模型厂商返回了未知错误。';
  const status = readStreamErrorStatus(publicMessage);

  if (status === 401 || status === 403) {
    return sanitizeGenerationError(
      new GenerationError('AUTH_ERROR', publicMessage, false, status),
      secret,
    );
  }
  if (status === 408) {
    return sanitizeGenerationError(
      new GenerationError('TIMEOUT', publicMessage, true, status),
      secret,
    );
  }
  if (status === 429) {
    return sanitizeGenerationError(
      new GenerationError('RATE_LIMITED', publicMessage, true, status),
      secret,
    );
  }

  return sanitizeGenerationError(
    new GenerationError('UPSTREAM_ERROR', publicMessage, true, status),
    secret,
  );
}

function readStreamErrorStatus(message: string): number | undefined {
  const patterns = [
    /\b(?:HTTP(?:\s+status)?|status(?:[\s_-]*code)?|API\s+error)\D{0,12}([1-5]\d{2})\b/i,
    /^\s*([1-5]\d{2})(?=\s|:|-)/i,
    /\(([1-5]\d{2})\)\s*:/,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

function createAbortError(message?: string): Error {
  return new DOMException(message || '生成已取消。', 'AbortError');
}
