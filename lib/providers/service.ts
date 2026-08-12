// ─── 多模型配置服务 ───
// 职责：在 Background 串行执行领卡、模型发现、选择和销毁，响应始终返回脱敏快照。

import type { ProviderConnectionView, ProviderModel, ProviderStateView } from '@/lib/domain/types';
import type { ProviderCommand } from '@/lib/ipc/protocol';
import { type DiscoverModelsOptions, discoverProviderModels } from '@/lib/providers/discovery';
import { normalizeProviderBaseUrl } from '@/lib/providers/permissions';
import { getProviderBaseUrl, getProviderDefinition, PROVIDERS } from '@/lib/providers/registry';
import {
  createChromeProviderStateStore,
  type ProviderStateStore,
  type StoredProviderConnection,
  type StoredProviderState,
} from '@/lib/providers/store';

type DiscoverModels = (options: DiscoverModelsOptions) => Promise<ProviderModel[]>;

export class ProviderServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderServiceError';
  }
}

export class ProviderService {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ProviderStateStore = createChromeProviderStateStore(),
    private readonly discoverModels: DiscoverModels = discoverProviderModels,
    private readonly now: () => number = Date.now,
  ) {}

  async handle(command: ProviderCommand): Promise<ProviderStateView> {
    switch (command.type) {
      case 'providers:get':
        return toStateView(await this.store.load());
      case 'providers:issue':
        return this.mutate((state) => issueProvider(state, command.providerId));
      case 'providers:connect':
        return this.mutate(async (state) => {
          const provider = requireProvider(command.providerId);
          const current = state.connections[provider.id];
          const apiKey = requireString(command.apiKey, 'API Key') || current?.apiKey || '';
          if (!provider.keyOptional && !apiKey) {
            throw new ProviderServiceError('请先填写 API Key。');
          }

          const baseUrl = normalizeProviderBaseUrl(
            getProviderBaseUrl(provider.id, command.baseUrl ?? current?.baseUrl),
          );
          const models = await this.discoverModels({ provider, baseUrl, apiKey });
          const selectedModelId =
            current?.selectedModelId && models.some((model) => model.id === current.selectedModelId)
              ? current.selectedModelId
              : undefined;

          state.connections[provider.id] = {
            providerId: provider.id,
            baseUrl,
            apiKey,
            models,
            ...(selectedModelId ? { selectedModelId } : {}),
            ...(current?.imageInputModelIds
              ? {
                  imageInputModelIds: current.imageInputModelIds.filter((modelId) =>
                    models.some(({ id }) => id === modelId),
                  ),
                }
              : {}),
            configuredAt: this.now(),
          };
          if (
            state.activeModel?.providerId === provider.id &&
            state.activeModel.modelId !== selectedModelId
          ) {
            state.activeModel = undefined;
          }
          return state;
        });
      case 'providers:select':
        return this.mutate((state) =>
          selectModel(state, command.providerId, command.modelId, this.now()),
        );
      case 'providers:set-image-input':
        return this.mutate((state) =>
          setImageInputCapability(state, command.providerId, command.modelId, command.enabled),
        );
      case 'providers:add-manual-model':
        return this.mutate((state) => {
          const provider = requireProvider(command.providerId);
          const connection = requireConnection(state, provider.id);
          const apiKey = requireString(command.apiKey, 'API Key') || connection.apiKey;
          if (!provider.keyOptional && !apiKey) {
            throw new ProviderServiceError('请先填写 API Key。');
          }
          connection.baseUrl = normalizeProviderBaseUrl(
            getProviderBaseUrl(provider.id, command.baseUrl ?? connection.baseUrl),
          );
          connection.apiKey = apiKey;
          return addManualModel(state, provider.id, command.modelId, this.now());
        });
      case 'providers:remove':
        return this.mutate((state) => removeProvider(state, command.providerId));
    }
  }

  private async mutate(
    operation: (state: StoredProviderState) => StoredProviderState | Promise<StoredProviderState>,
  ): Promise<ProviderStateView> {
    let resolveResult: (value: ProviderStateView) => void = () => void 0;
    let rejectResult: (reason?: unknown) => void = () => void 0;
    const result = new Promise<ProviderStateView>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.mutationTail = this.mutationTail
      .catch(() => void 0)
      .then(async () => {
        try {
          const state = await this.store.load();
          const next = await operation(cloneState(state));
          await this.store.save(next);
          resolveResult(toStateView(next));
        } catch (error) {
          rejectResult(error);
        }
      });

    return result;
  }
}

function issueProvider(state: StoredProviderState, providerId: string): StoredProviderState {
  const provider = requireProvider(providerId);
  if (state.connections[provider.id]) return state;
  state.connections[provider.id] = {
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    apiKey: '',
    models: [],
  };
  return state;
}

function selectModel(
  state: StoredProviderState,
  providerId: string,
  rawModelId: string,
  configuredAt: number,
): StoredProviderState {
  const modelId = requireString(rawModelId, '模型 ID');
  const connection = requireConnection(state, providerId);
  if (!connection.models.some((model) => model.id === modelId)) {
    throw new ProviderServiceError('该模型不在当前目录中，请先刷新模型列表。');
  }
  connection.selectedModelId = modelId;
  connection.configuredAt = configuredAt;
  state.activeModel = { providerId, modelId };
  return state;
}

function addManualModel(
  state: StoredProviderState,
  providerId: string,
  rawModelId: string,
  configuredAt: number,
): StoredProviderState {
  const modelId = requireString(rawModelId, '模型 ID');
  if (modelId.length > 256) throw new ProviderServiceError('模型 ID 不能超过 256 个字符。');
  const connection = requireConnection(state, providerId);
  if (!connection.models.some((model) => model.id === modelId)) {
    connection.models.push({ id: modelId, name: modelId });
  }
  return selectModel(state, providerId, modelId, configuredAt);
}

function setImageInputCapability(
  state: StoredProviderState,
  providerId: string,
  rawModelId: string,
  enabled: boolean,
): StoredProviderState {
  const provider = requireProvider(providerId);
  if (!provider.custom) {
    throw new ProviderServiceError('内置厂商的视觉能力由可信模型目录管理。');
  }
  const connection = requireConnection(state, providerId);
  const modelId = requireString(rawModelId, '模型 ID');
  if (!connection.models.some(({ id }) => id === modelId)) {
    throw new ProviderServiceError('该模型不在当前目录中。');
  }
  const current = new Set(connection.imageInputModelIds ?? []);
  if (enabled) current.add(modelId);
  else current.delete(modelId);
  connection.imageInputModelIds = [...current];
  return state;
}

function removeProvider(state: StoredProviderState, providerId: string): StoredProviderState {
  requireProvider(providerId);
  if (!state.connections[providerId]) return state;
  delete state.connections[providerId];

  if (state.activeModel?.providerId === providerId) {
    delete state.activeModel;
  }
  return state;
}

function requireProvider(providerId: string) {
  const provider = getProviderDefinition(requireString(providerId, '厂商 ID'));
  if (!provider) throw new ProviderServiceError('未知的模型厂商。');
  return provider;
}

function requireConnection(
  state: StoredProviderState,
  providerId: string,
): StoredProviderConnection {
  requireProvider(providerId);
  const connection = state.connections[providerId];
  if (!connection) throw new ProviderServiceError('请先从发卡台领取该厂商。');
  return connection;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ProviderServiceError(`${label}格式不正确。`);
  return value.trim();
}

function toStateView(state: StoredProviderState): ProviderStateView {
  const registryOrder = new Map(PROVIDERS.map((provider, index) => [provider.id, index]));
  const connections = Object.values(state.connections)
    .sort(
      (left, right) =>
        (registryOrder.get(left.providerId) ?? Number.MAX_SAFE_INTEGER) -
        (registryOrder.get(right.providerId) ?? Number.MAX_SAFE_INTEGER),
    )
    .map<ProviderConnectionView>((connection) => ({
      providerId: connection.providerId,
      baseUrl: connection.baseUrl,
      hasApiKey: Boolean(connection.apiKey),
      apiKeyLastFour: connection.apiKey.slice(-4),
      models: connection.models.map((model) => ({ ...model })),
      ...(connection.imageInputModelIds?.length
        ? { imageInputModelIds: [...connection.imageInputModelIds] }
        : {}),
      ...(connection.selectedModelId ? { selectedModelId: connection.selectedModelId } : {}),
      ...(connection.configuredAt ? { configuredAt: connection.configuredAt } : {}),
    }));

  return {
    version: 1,
    connections,
    ...(state.activeModel ? { activeModel: { ...state.activeModel } } : {}),
  };
}

function cloneState(state: StoredProviderState): StoredProviderState {
  return {
    version: 1,
    connections: Object.fromEntries(
      Object.entries(state.connections).map(([providerId, connection]) => [
        providerId,
        {
          ...connection,
          models: connection.models.map((model) => ({ ...model })),
          ...(connection.imageInputModelIds
            ? { imageInputModelIds: [...connection.imageInputModelIds] }
            : {}),
        },
      ]),
    ),
    ...(state.activeModel ? { activeModel: { ...state.activeModel } } : {}),
  };
}
