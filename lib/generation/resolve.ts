// ─── 活动生成目标解析 ───
// 职责：仅在 Background 的可信上下文中，把已选模型和私密凭据解析为一次生成调用的目标。

import type { ModelIdentity } from '@/lib/domain/types';
import { GenerationError } from '@/lib/generation/errors';
import { knownModelSupportsImageInput } from '@/lib/generation/pi-adapter';
import type { ResolvedGenerationTarget } from '@/lib/generation/types';
import {
  containsProviderHostPermission,
  normalizeProviderBaseUrl,
} from '@/lib/providers/permissions';
import { getProviderDefinition, type ProviderDefinition } from '@/lib/providers/registry';
import {
  createChromeProviderStateStore,
  type ProviderStateStore,
  type StoredProviderConnection,
} from '@/lib/providers/store';

export interface ResolveActiveGenerationTargetDependencies {
  store: ProviderStateStore;
  containsHostPermission: (baseUrl: string) => Promise<boolean>;
}

export async function resolveActiveGenerationTarget(
  dependencies: Partial<ResolveActiveGenerationTargetDependencies> = {},
): Promise<ResolvedGenerationTarget> {
  return resolveGenerationTarget(undefined, dependencies);
}

export async function resolveGenerationTarget(
  requestedIdentity?: ModelIdentity,
  dependencies: Partial<ResolveActiveGenerationTargetDependencies> = {},
): Promise<ResolvedGenerationTarget> {
  const store = dependencies.store ?? createChromeProviderStateStore();
  const containsHostPermission =
    dependencies.containsHostPermission ?? containsProviderHostPermission;
  const state = await store.load();
  const identity = requestedIdentity ?? state.activeModel;

  if (!identity) {
    throw new GenerationError('NO_ACTIVE_MODEL', '请先在模型设置中选择一个模型。');
  }

  const provider = getProviderDefinition(identity.providerId);
  const connection = state.connections[identity.providerId];
  if (!provider || !connection) {
    throw new GenerationError('PROVIDER_NOT_CONFIGURED', '当前模型的厂商配置不存在，请重新配置。');
  }

  if (!requestedIdentity && connection.selectedModelId !== identity.modelId) {
    throw new GenerationError('MODEL_NOT_FOUND', '当前模型选择已失效，请重新选择模型。');
  }

  const model = connection.models.find(({ id }) => id === identity.modelId);
  if (!model) {
    throw new GenerationError('MODEL_NOT_FOUND', '当前模型不在厂商目录中，请刷新后重新选择。');
  }

  const apiKey = connection.apiKey.trim();
  if (!provider.keyOptional && !apiKey) {
    throw new GenerationError('AUTH_REQUIRED', '当前模型缺少 API Key，请先完成厂商配置。');
  }

  const baseUrl = resolveGenerationBaseUrl(provider, connection);
  let hasPermission: boolean;
  try {
    hasPermission = await containsHostPermission(baseUrl);
  } catch {
    throw new GenerationError(
      'PERMISSION_REQUIRED',
      '无法确认模型端点权限，请返回设置页重新授权。',
    );
  }
  if (!hasPermission) {
    throw new GenerationError(
      'PERMISSION_REQUIRED',
      '模型端点尚未授权，请返回设置页重新连接并授权。',
    );
  }

  return {
    identity: { ...identity },
    providerLabel: provider.label,
    modelName: model.name,
    protocol: provider.generation,
    baseUrl,
    apiKey: provider.id === 'ollama' ? '' : apiKey,
    supportsImageInput:
      knownModelSupportsImageInput(provider.id, identity.modelId) ||
      (provider.custom === true &&
        connection.imageInputModelIds?.includes(identity.modelId) === true),
  };
}

function resolveGenerationBaseUrl(
  provider: ProviderDefinition,
  connection: StoredProviderConnection,
): string {
  const configuredBaseUrl = provider.custom
    ? connection.baseUrl
    : (provider.generationBaseUrl ?? provider.baseUrl);
  let baseUrl: string;
  try {
    baseUrl = normalizeProviderBaseUrl(configuredBaseUrl);
  } catch {
    throw new GenerationError(
      'PROVIDER_NOT_CONFIGURED',
      '当前模型的端点配置无效，请重新配置厂商。',
    );
  }

  return provider.id === 'ollama' ? `${baseUrl}/v1` : baseUrl;
}
