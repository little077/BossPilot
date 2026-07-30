// ─── 多模型配置存储 ───
// 职责：仅在受信任扩展上下文持久化厂商密钥、模型目录和激活模型，并兼容旧单模型配置。

import type { ModelIdentity, ProviderModel } from '@/lib/domain/types';
import { normalizeProviderBaseUrl } from '@/lib/providers/permissions';
import { PROVIDERS } from '@/lib/providers/registry';

const PROVIDER_STATE_KEY = 'bosspilot:providers:v1';
const LEGACY_LLM_KEY = 'bosspilot:llm';

export interface StoredProviderConnection {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  models: ProviderModel[];
  selectedModelId?: string;
  configuredAt?: number;
}

export interface StoredProviderState {
  version: 1;
  connections: Record<string, StoredProviderConnection>;
  activeModel?: ModelIdentity;
}

export interface ProviderStateStore {
  load(): Promise<StoredProviderState>;
  save(state: StoredProviderState): Promise<void>;
}

export function createEmptyProviderState(): StoredProviderState {
  return { version: 1, connections: {} };
}

export function createChromeProviderStateStore(now: () => number = Date.now): ProviderStateStore {
  return {
    async load() {
      const values = await chrome.storage.local.get([PROVIDER_STATE_KEY, LEGACY_LLM_KEY]);
      const current = parseStoredProviderState(values[PROVIDER_STATE_KEY]);
      if (current) return current;

      const migrated = migrateLegacyConfig(values[LEGACY_LLM_KEY], now());
      if (Object.keys(migrated.connections).length > 0) {
        await chrome.storage.local.set({ [PROVIDER_STATE_KEY]: migrated });
      }
      return migrated;
    },
    async save(state) {
      await chrome.storage.local.set({ [PROVIDER_STATE_KEY]: state });
    },
  };
}

function migrateLegacyConfig(value: unknown, configuredAt: number): StoredProviderState {
  if (!isRecord(value)) return createEmptyProviderState();
  const apiKey = readString(value.apiKey)?.trim();
  const rawBaseUrl = readString(value.baseUrl)?.trim();
  const modelId = readString(value.model)?.trim();
  if (!apiKey || !rawBaseUrl || !modelId) return createEmptyProviderState();

  let baseUrl: string;
  try {
    baseUrl = normalizeProviderBaseUrl(rawBaseUrl);
  } catch {
    return createEmptyProviderState();
  }

  const matched = PROVIDERS.find(
    (provider) =>
      !provider.custom &&
      normalizeComparableUrl(provider.baseUrl) === normalizeComparableUrl(baseUrl),
  );
  const providerId = matched?.id ?? 'custom';
  const connection: StoredProviderConnection = {
    providerId,
    baseUrl,
    apiKey,
    models: [{ id: modelId, name: modelId }],
    selectedModelId: modelId,
    configuredAt,
  };

  return {
    version: 1,
    connections: { [providerId]: connection },
    activeModel: { providerId, modelId },
  };
}

function parseStoredProviderState(value: unknown): StoredProviderState | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.connections)) return null;

  const connections: Record<string, StoredProviderConnection> = {};
  for (const [providerId, rawConnection] of Object.entries(value.connections)) {
    const connection = parseConnection(providerId, rawConnection);
    if (connection) connections[providerId] = connection;
  }

  const activeModel = parseModelIdentity(value.activeModel);
  return {
    version: 1,
    connections,
    ...(activeModel ? { activeModel } : {}),
  };
}

function parseConnection(providerId: string, value: unknown): StoredProviderConnection | undefined {
  if (!isRecord(value)) return undefined;
  const baseUrl = readString(value.baseUrl);
  const apiKey = readString(value.apiKey);
  if (baseUrl === undefined || apiKey === undefined) return undefined;

  const models = Array.isArray(value.models)
    ? value.models.flatMap((model) => {
        if (!isRecord(model)) return [];
        const id = readString(model.id);
        const name = readString(model.name);
        return id && name ? [{ id, name }] : [];
      })
    : [];
  const selectedModelId = readString(value.selectedModelId);
  const configuredAt =
    typeof value.configuredAt === 'number' && Number.isFinite(value.configuredAt)
      ? value.configuredAt
      : undefined;

  return {
    providerId,
    baseUrl,
    apiKey,
    models,
    ...(selectedModelId ? { selectedModelId } : {}),
    ...(configuredAt ? { configuredAt } : {}),
  };
}

function parseModelIdentity(value: unknown): ModelIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const providerId = readString(value.providerId);
  const modelId = readString(value.modelId);
  return providerId && modelId ? { providerId, modelId } : undefined;
}

function normalizeComparableUrl(value: string): string {
  try {
    return normalizeProviderBaseUrl(value).toLowerCase();
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
