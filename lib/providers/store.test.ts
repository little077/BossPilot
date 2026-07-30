import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createChromeProviderStateStore,
  createEmptyProviderState,
  type StoredProviderState,
} from './store';

const PROVIDER_STATE_KEY = 'bosspilot:providers:v1';
const LEGACY_LLM_KEY = 'bosspilot:llm';

const storageGet = vi.fn();
const storageSet = vi.fn();

beforeEach(() => {
  storageGet.mockReset();
  storageSet.mockReset();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: storageGet,
        set: storageSet,
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createEmptyProviderState', () => {
  it('returns an independent versioned state', () => {
    const first = createEmptyProviderState();
    const second = createEmptyProviderState();

    expect(first).toEqual({ version: 1, connections: {} });
    expect(first).not.toBe(second);
    expect(first.connections).not.toBe(second.connections);
  });
});

describe('createChromeProviderStateStore', () => {
  it('loads a valid current state without consulting or rewriting the legacy value', async () => {
    storageGet.mockResolvedValue({
      [PROVIDER_STATE_KEY]: {
        version: 1,
        connections: {
          deepseek: {
            providerId: 'untrusted-provider-id',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKey: 'current-key',
            models: [
              { id: 'deepseek-chat', name: 'DeepSeek Chat' },
              { id: '', name: 'Invalid empty id' },
              { id: 'missing-name' },
              null,
            ],
            selectedModelId: 'deepseek-chat',
            configuredAt: 123,
          },
          invalid: 'not-a-connection',
        },
        activeModel: {
          providerId: 'deepseek',
          modelId: 'deepseek-chat',
        },
      },
      [LEGACY_LLM_KEY]: {
        baseUrl: 'https://legacy.example.com/v1',
        apiKey: 'legacy-key',
        model: 'legacy-model',
      },
    });

    await expect(createChromeProviderStateStore().load()).resolves.toEqual({
      version: 1,
      connections: {
        deepseek: {
          providerId: 'deepseek',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'current-key',
          models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
          selectedModelId: 'deepseek-chat',
          configuredAt: 123,
        },
      },
      activeModel: {
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
      },
    });
    expect(storageGet).toHaveBeenCalledWith([PROVIDER_STATE_KEY, LEGACY_LLM_KEY]);
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('accepts issued custom cards with empty strings and removes invalid optional fields', async () => {
    storageGet.mockResolvedValue({
      [PROVIDER_STATE_KEY]: {
        version: 1,
        connections: {
          custom: {
            baseUrl: '',
            apiKey: '',
            models: [],
            selectedModelId: '',
            configuredAt: Number.POSITIVE_INFINITY,
          },
        },
        activeModel: {
          providerId: 'custom',
          modelId: 42,
        },
      },
    });

    await expect(createChromeProviderStateStore().load()).resolves.toEqual({
      version: 1,
      connections: {
        custom: {
          providerId: 'custom',
          baseUrl: '',
          apiKey: '',
          models: [],
        },
      },
    });
  });

  it('drops connections whose required persisted fields have invalid types', async () => {
    storageGet.mockResolvedValue({
      [PROVIDER_STATE_KEY]: {
        version: 1,
        connections: {
          missingBaseUrl: {
            apiKey: 'key',
            models: [],
          },
          invalidApiKey: {
            baseUrl: 'https://api.example.com/v1',
            apiKey: 123,
            models: [],
          },
          validMinimal: {
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'key',
          },
        },
      },
    });

    await expect(createChromeProviderStateStore().load()).resolves.toEqual({
      version: 1,
      connections: {
        validMinimal: {
          providerId: 'validMinimal',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'key',
          models: [],
        },
      },
    });
  });

  it('saves the complete state under the versioned storage key', async () => {
    storageSet.mockResolvedValue(undefined);
    const state: StoredProviderState = {
      version: 1,
      connections: {
        openai: {
          providerId: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'saved-key',
          models: [{ id: 'gpt-test', name: 'GPT Test' }],
          selectedModelId: 'gpt-test',
          configuredAt: 456,
        },
      },
      activeModel: {
        providerId: 'openai',
        modelId: 'gpt-test',
      },
    };

    await createChromeProviderStateStore().save(state);

    expect(storageSet).toHaveBeenCalledOnce();
    expect(storageSet).toHaveBeenCalledWith({ [PROVIDER_STATE_KEY]: state });
  });

  it('migrates a legacy built-in provider and persists it once', async () => {
    storageGet.mockResolvedValue({
      [LEGACY_LLM_KEY]: {
        baseUrl: ' https://api.deepseek.com/v1/?debug=1#legacy ',
        apiKey: ' legacy-key ',
        model: ' deepseek-chat ',
      },
    });
    storageSet.mockResolvedValue(undefined);

    const state = await createChromeProviderStateStore(() => 1_234).load();

    expect(state).toEqual({
      version: 1,
      connections: {
        deepseek: {
          providerId: 'deepseek',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'legacy-key',
          models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }],
          selectedModelId: 'deepseek-chat',
          configuredAt: 1_234,
        },
      },
      activeModel: {
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
      },
    });
    expect(storageSet).toHaveBeenCalledWith({ [PROVIDER_STATE_KEY]: state });
  });

  it('migrates an unmatched secure legacy endpoint as a custom provider', async () => {
    storageGet.mockResolvedValue({
      [PROVIDER_STATE_KEY]: { version: 2, connections: {} },
      [LEGACY_LLM_KEY]: {
        baseUrl: 'https://models.example.com/compatible/v1/',
        apiKey: 'custom-key',
        model: 'custom-model',
      },
    });

    const state = await createChromeProviderStateStore(() => 999).load();

    expect(state.connections.custom).toEqual({
      providerId: 'custom',
      baseUrl: 'https://models.example.com/compatible/v1',
      apiKey: 'custom-key',
      models: [{ id: 'custom-model', name: 'custom-model' }],
      selectedModelId: 'custom-model',
      configuredAt: 999,
    });
    expect(state.activeModel).toEqual({
      providerId: 'custom',
      modelId: 'custom-model',
    });
    expect(storageSet).toHaveBeenCalledWith({ [PROVIDER_STATE_KEY]: state });
  });

  it.each([
    ['missing legacy value', undefined],
    [
      'blank key',
      {
        baseUrl: 'https://api.example.com/v1',
        apiKey: ' ',
        model: 'model',
      },
    ],
    [
      'blank base URL',
      {
        baseUrl: ' ',
        apiKey: 'key',
        model: 'model',
      },
    ],
    [
      'blank model',
      {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'key',
        model: ' ',
      },
    ],
    [
      'unsafe remote HTTP endpoint',
      {
        baseUrl: 'http://api.example.com/v1',
        apiKey: 'key',
        model: 'model',
      },
    ],
    [
      'URL credentials',
      {
        baseUrl: 'https://user:password@api.example.com/v1',
        apiKey: 'key',
        model: 'model',
      },
    ],
  ])('does not migrate $0', async (_caseName, legacyValue) => {
    storageGet.mockResolvedValue({ [LEGACY_LLM_KEY]: legacyValue });

    await expect(createChromeProviderStateStore().load()).resolves.toEqual({
      version: 1,
      connections: {},
    });
    expect(storageSet).not.toHaveBeenCalled();
  });
});
