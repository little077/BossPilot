import { describe, expect, it, vi } from 'vitest';
import type { ProviderModel } from '@/lib/domain/types';
import type { ProviderCommand } from '@/lib/ipc/protocol';
import type { DiscoverModelsOptions } from '@/lib/providers/discovery';
import { getProviderDefinition } from '@/lib/providers/registry';
import { ProviderService, ProviderServiceError } from '@/lib/providers/service';
import {
  createEmptyProviderState,
  type ProviderStateStore,
  type StoredProviderConnection,
  type StoredProviderState,
} from '@/lib/providers/store';

type DiscoverModels = (options: DiscoverModelsOptions) => Promise<ProviderModel[]>;

function cloneState(state: StoredProviderState): StoredProviderState {
  return structuredClone(state);
}

function createStoreHarness(initial: StoredProviderState = createEmptyProviderState()) {
  let persisted = cloneState(initial);
  const load = vi.fn(async () => cloneState(persisted));
  const save = vi.fn(async (state: StoredProviderState) => {
    persisted = cloneState(state);
  });
  const store: ProviderStateStore = { load, save };

  return {
    load,
    read: () => cloneState(persisted),
    save,
    store,
  };
}

function connection(
  providerId: string,
  overrides: Partial<StoredProviderConnection> = {},
): StoredProviderConnection {
  return {
    providerId,
    baseUrl: `https://api.${providerId}.example/v1`,
    apiKey: `${providerId}-secret`,
    models: [],
    ...overrides,
  };
}

describe('ProviderService', () => {
  it('returns an empty redacted state without writing storage', async () => {
    const harness = createStoreHarness();
    const service = new ProviderService(harness.store);

    await expect(service.handle({ type: 'providers:get' })).resolves.toEqual({
      version: 1,
      connections: [],
    });
    expect(harness.load).toHaveBeenCalledOnce();
    expect(harness.save).not.toHaveBeenCalled();
  });

  it('issues a provider card once and rejects unknown providers', async () => {
    const harness = createStoreHarness();
    const service = new ProviderService(harness.store);

    const issued = await service.handle({
      type: 'providers:issue',
      providerId: 'deepseek',
    });
    expect(issued).toEqual({
      version: 1,
      connections: [
        {
          providerId: 'deepseek',
          baseUrl: 'https://api.deepseek.com/v1',
          hasApiKey: false,
          apiKeyLastFour: '',
          models: [],
        },
      ],
    });

    await expect(
      service.handle({ type: 'providers:issue', providerId: 'deepseek' }),
    ).resolves.toEqual(issued);
    expect(Object.keys(harness.read().connections)).toEqual(['deepseek']);

    await expect(
      service.handle({ type: 'providers:issue', providerId: 'missing' }),
    ).rejects.toBeInstanceOf(ProviderServiceError);
    expect(Object.keys(harness.read().connections)).toEqual(['deepseek']);
  });

  it('discovers models, persists the secret, and returns only a masked view', async () => {
    const harness = createStoreHarness();
    const models: ProviderModel[] = [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ];
    const discover = vi.fn<DiscoverModels>().mockResolvedValue(models);
    const service = new ProviderService(harness.store, discover, () => 1_750_000);

    const view = await service.handle({
      type: 'providers:connect',
      providerId: 'deepseek',
      apiKey: '  sk-live-private-1234  ',
    });

    expect(discover).toHaveBeenCalledWith({
      provider: getProviderDefinition('deepseek'),
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-live-private-1234',
    });
    expect(view).toEqual({
      version: 1,
      connections: [
        {
          providerId: 'deepseek',
          baseUrl: 'https://api.deepseek.com/v1',
          hasApiKey: true,
          apiKeyLastFour: '1234',
          models,
          configuredAt: 1_750_000,
        },
      ],
    });
    expect(JSON.stringify(view)).not.toContain('sk-live-private');
    expect(harness.read().connections.deepseek?.apiKey).toBe('sk-live-private-1234');
  });

  it('selects only catalog models and records the active identity', async () => {
    const initial: StoredProviderState = {
      version: 1,
      connections: {
        openai: connection('openai', {
          baseUrl: 'https://api.openai.com/v1',
          models: [
            { id: 'gpt-4.1', name: 'GPT-4.1' },
            { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini' },
          ],
        }),
      },
    };
    const harness = createStoreHarness(initial);
    const service = new ProviderService(harness.store, undefined, () => 2_000);

    const selected = await service.handle({
      type: 'providers:select',
      providerId: 'openai',
      modelId: '  gpt-4.1-mini  ',
    });
    expect(selected.activeModel).toEqual({
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
    });
    expect(selected.connections[0]).toMatchObject({
      selectedModelId: 'gpt-4.1-mini',
      configuredAt: 2_000,
    });

    await expect(
      service.handle({
        type: 'providers:select',
        providerId: 'openai',
        modelId: 'not-in-catalog',
      }),
    ).rejects.toBeInstanceOf(ProviderServiceError);
    expect(harness.read().activeModel).toEqual({
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
    });
  });

  it('preserves a valid selection on refresh and clears an invalidated active model', async () => {
    const initial: StoredProviderState = {
      version: 1,
      connections: {
        openai: connection('openai', {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'stored-key-4321',
          models: [{ id: 'gpt-stable', name: 'GPT Stable' }],
          selectedModelId: 'gpt-stable',
        }),
      },
      activeModel: { providerId: 'openai', modelId: 'gpt-stable' },
    };
    const harness = createStoreHarness(initial);
    const discover = vi
      .fn<DiscoverModels>()
      .mockResolvedValueOnce([
        { id: 'gpt-stable', name: 'GPT Stable' },
        { id: 'gpt-new', name: 'GPT New' },
      ])
      .mockResolvedValueOnce([{ id: 'gpt-new', name: 'GPT New' }]);
    const service = new ProviderService(harness.store, discover, () => 3_000);
    const refreshCommand: ProviderCommand = {
      type: 'providers:connect',
      providerId: 'openai',
      apiKey: '',
    };

    const preserved = await service.handle(refreshCommand);
    expect(preserved.connections[0]?.selectedModelId).toBe('gpt-stable');
    expect(preserved.activeModel).toEqual({
      providerId: 'openai',
      modelId: 'gpt-stable',
    });
    expect(discover).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ apiKey: 'stored-key-4321' }),
    );

    const invalidated = await service.handle(refreshCommand);
    expect(invalidated.connections[0]?.selectedModelId).toBeUndefined();
    expect(invalidated.activeModel).toBeUndefined();
    expect(harness.read().connections.openai?.models).toEqual([{ id: 'gpt-new', name: 'GPT New' }]);
  });

  it('adds, normalizes, de-duplicates, and selects a manual custom model', async () => {
    const harness = createStoreHarness();
    const service = new ProviderService(harness.store, undefined, () => 4_000);
    await service.handle({ type: 'providers:issue', providerId: 'custom' });

    const command: ProviderCommand = {
      type: 'providers:add-manual-model',
      providerId: 'custom',
      modelId: '  company-model-v1  ',
      apiKey: '  optional-private-key  ',
      baseUrl: ' https://models.example.com/v1/?debug=true#section ',
    };
    const added = await service.handle(command);
    const repeated = await service.handle(command);

    expect(added).toEqual({
      version: 1,
      connections: [
        {
          providerId: 'custom',
          baseUrl: 'https://models.example.com/v1',
          hasApiKey: true,
          apiKeyLastFour: '-key',
          models: [{ id: 'company-model-v1', name: 'company-model-v1' }],
          selectedModelId: 'company-model-v1',
          configuredAt: 4_000,
        },
      ],
      activeModel: { providerId: 'custom', modelId: 'company-model-v1' },
    });
    expect(repeated.connections[0]?.models).toHaveLength(1);
    expect(harness.read().connections.custom?.apiKey).toBe('optional-private-key');
  });

  it('lets only custom endpoints explicitly declare image-capable catalog models', async () => {
    const initial: StoredProviderState = {
      version: 1,
      connections: {
        custom: connection('custom', {
          models: [
            { id: 'text-model', name: 'Text Model' },
            { id: 'vision-model', name: 'Vision Model' },
          ],
          selectedModelId: 'vision-model',
        }),
        openai: connection('openai', {
          models: [{ id: 'gpt-4.1', name: 'GPT-4.1' }],
          selectedModelId: 'gpt-4.1',
        }),
      },
      activeModel: { providerId: 'custom', modelId: 'vision-model' },
    };
    const harness = createStoreHarness(initial);
    const service = new ProviderService(harness.store);

    const enabled = await service.handle({
      type: 'providers:set-image-input',
      providerId: 'custom',
      modelId: 'vision-model',
      enabled: true,
    });
    expect(enabled.connections.find(({ providerId }) => providerId === 'custom')).toMatchObject({
      imageInputModelIds: ['vision-model'],
    });
    expect(JSON.stringify(enabled)).not.toContain('custom-secret');

    const disabled = await service.handle({
      type: 'providers:set-image-input',
      providerId: 'custom',
      modelId: 'vision-model',
      enabled: false,
    });
    expect(
      disabled.connections.find(({ providerId }) => providerId === 'custom')?.imageInputModelIds,
    ).toBeUndefined();

    await expect(
      service.handle({
        type: 'providers:set-image-input',
        providerId: 'custom',
        modelId: 'missing-model',
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(ProviderServiceError);
    await expect(
      service.handle({
        type: 'providers:set-image-input',
        providerId: 'openai',
        modelId: 'gpt-4.1',
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(ProviderServiceError);
  });

  it('removes an active provider and clears selection without automatic fallback', async () => {
    const initial: StoredProviderState = {
      version: 1,
      connections: {
        openai: connection('openai', {
          selectedModelId: 'gpt-4.1',
          models: [{ id: 'gpt-4.1', name: 'GPT-4.1' }],
        }),
        deepseek: connection('deepseek', {
          selectedModelId: 'deepseek-chat',
          models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        }),
      },
      activeModel: { providerId: 'openai', modelId: 'gpt-4.1' },
    };
    const harness = createStoreHarness(initial);
    const service = new ProviderService(harness.store);

    const firstRemoval = await service.handle({
      type: 'providers:remove',
      providerId: 'openai',
    });
    expect(firstRemoval.connections.map(({ providerId }) => providerId)).toEqual(['deepseek']);
    expect(firstRemoval.activeModel).toBeUndefined();
    expect(harness.read().activeModel).toBeUndefined();

    const secondRemoval = await service.handle({
      type: 'providers:remove',
      providerId: 'deepseek',
    });
    expect(secondRemoval).toEqual({ version: 1, connections: [] });
  });

  it('does not persist failed discovery and remains usable after an error', async () => {
    const initial: StoredProviderState = {
      version: 1,
      connections: {
        deepseek: connection('deepseek', {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'old-secret',
          models: [{ id: 'old-model', name: 'Old Model' }],
        }),
      },
    };
    const harness = createStoreHarness(initial);
    const discover = vi.fn<DiscoverModels>().mockRejectedValue(new Error('provider unavailable'));
    const service = new ProviderService(harness.store, discover);

    await expect(
      service.handle({
        type: 'providers:connect',
        providerId: 'deepseek',
        apiKey: 'new-secret',
      }),
    ).rejects.toThrow('provider unavailable');
    expect(harness.read()).toEqual(initial);
    expect(harness.save).not.toHaveBeenCalled();

    await expect(
      service.handle({ type: 'providers:issue', providerId: 'openai' }),
    ).resolves.toMatchObject({
      connections: [{ providerId: 'deepseek' }, { providerId: 'openai' }],
    });
  });

  it('rejects missing prerequisites and malformed command fields', async () => {
    const harness = createStoreHarness();
    const service = new ProviderService(harness.store);

    await expect(
      service.handle({
        type: 'providers:connect',
        providerId: 'deepseek',
        apiKey: '   ',
      }),
    ).rejects.toBeInstanceOf(ProviderServiceError);
    await expect(
      service.handle({
        type: 'providers:add-manual-model',
        providerId: 'openai',
        modelId: 'gpt-4.1',
        apiKey: 'secret',
      }),
    ).rejects.toBeInstanceOf(ProviderServiceError);

    const invalidApiKey = {
      type: 'providers:connect',
      providerId: 'deepseek',
      apiKey: 42,
    } as unknown as ProviderCommand;
    const invalidProviderId = {
      type: 'providers:issue',
      providerId: null,
    } as unknown as ProviderCommand;
    await expect(service.handle(invalidApiKey)).rejects.toBeInstanceOf(ProviderServiceError);
    await expect(service.handle(invalidProviderId)).rejects.toBeInstanceOf(ProviderServiceError);
    expect(harness.save).not.toHaveBeenCalled();
  });

  it('rejects oversized manual model identifiers without changing the card', async () => {
    const initial: StoredProviderState = {
      version: 1,
      connections: {
        custom: connection('custom', {
          baseUrl: 'https://models.example.com/v1',
          apiKey: '',
        }),
      },
    };
    const harness = createStoreHarness(initial);
    const service = new ProviderService(harness.store);

    await expect(
      service.handle({
        type: 'providers:add-manual-model',
        providerId: 'custom',
        modelId: 'm'.repeat(257),
        apiKey: '',
        baseUrl: 'https://models.example.com/v1',
      }),
    ).rejects.toBeInstanceOf(ProviderServiceError);
    expect(harness.read()).toEqual(initial);
    expect(harness.save).not.toHaveBeenCalled();
  });
});
