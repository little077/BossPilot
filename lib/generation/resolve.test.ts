import { describe, expect, it, vi } from 'vitest';
import { resolveActiveGenerationTarget } from '@/lib/generation/resolve';
import type { ProviderStateStore, StoredProviderState } from '@/lib/providers/store';

function createStore(state: StoredProviderState): ProviderStateStore {
  return {
    load: vi.fn(async () => structuredClone(state)),
    save: vi.fn(async () => void 0),
  };
}

function configuredState(
  providerId = 'openai',
  overrides: Partial<StoredProviderState['connections'][string]> = {},
): StoredProviderState {
  const modelId = 'model-1';
  return {
    version: 1,
    connections: {
      [providerId]: {
        providerId,
        baseUrl: `https://${providerId}.stored.example/v1`,
        apiKey: 'private-key',
        models: [{ id: modelId, name: 'Model One' }],
        selectedModelId: modelId,
        ...overrides,
      },
    },
    activeModel: { providerId, modelId },
  };
}

describe('resolveActiveGenerationTarget', () => {
  it('拒绝未选择活动模型', async () => {
    await expect(
      resolveActiveGenerationTarget({
        store: createStore({ version: 1, connections: {} }),
        containsHostPermission: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'NO_ACTIVE_MODEL' });
  });

  it('拒绝不存在的厂商配置', async () => {
    await expect(
      resolveActiveGenerationTarget({
        store: createStore({
          version: 1,
          connections: {},
          activeModel: { providerId: 'openai', modelId: 'model-1' },
        }),
        containsHostPermission: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('要求 connection 选择与 activeModel 严格一致且模型仍在目录中', async () => {
    const mismatch = configuredState('openai', { selectedModelId: 'model-2' });
    const missingModel = configuredState('openai', { models: [] });
    const containsHostPermission = vi.fn(async () => true);

    await expect(
      resolveActiveGenerationTarget({
        store: createStore(mismatch),
        containsHostPermission,
      }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    await expect(
      resolveActiveGenerationTarget({
        store: createStore(missingModel),
        containsHostPermission,
      }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    expect(containsHostPermission).not.toHaveBeenCalled();
  });

  it('要求非可选厂商提供密钥', async () => {
    await expect(
      resolveActiveGenerationTarget({
        store: createStore(configuredState('anthropic', { apiKey: '   ' })),
        containsHostPermission: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('内置厂商只信注册表地址，并返回显式生成协议', async () => {
    const containsHostPermission = vi.fn(async () => true);

    await expect(
      resolveActiveGenerationTarget({
        store: createStore(configuredState()),
        containsHostPermission,
      }),
    ).resolves.toEqual({
      identity: { providerId: 'openai', modelId: 'model-1' },
      providerLabel: 'OpenAI',
      modelName: 'Model One',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'private-key',
    });
    expect(containsHostPermission).toHaveBeenCalledWith('https://api.openai.com/v1');
  });

  it('自定义厂商使用已保存的规范化地址', async () => {
    const containsHostPermission = vi.fn(async () => true);
    const state = configuredState('custom', {
      baseUrl: 'https://models.example.com/v1',
      apiKey: '',
    });

    await expect(
      resolveActiveGenerationTarget({
        store: createStore(state),
        containsHostPermission,
      }),
    ).resolves.toMatchObject({
      protocol: 'openai-completions',
      baseUrl: 'https://models.example.com/v1',
      apiKey: '',
    });
  });

  it('拒绝自定义厂商的无效端点', async () => {
    await expect(
      resolveActiveGenerationTarget({
        store: createStore(
          configuredState('custom', {
            baseUrl: 'not-a-valid-provider-url',
            apiKey: '',
          }),
        ),
        containsHostPermission: vi.fn(async () => true),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('Ollama 使用 OpenAI 兼容的 /v1 地址且绝不发送密钥', async () => {
    const containsHostPermission = vi.fn(async () => true);
    const state = configuredState('ollama', {
      baseUrl: 'http://localhost:11434',
      apiKey: 'should-not-leave-storage',
    });

    await expect(
      resolveActiveGenerationTarget({
        store: createStore(state),
        containsHostPermission,
      }),
    ).resolves.toMatchObject({
      protocol: 'openai-completions',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
    });
    expect(containsHostPermission).toHaveBeenCalledWith('http://localhost:11434/v1');
  });

  it('迁移配置缺少精确 host permission 时返回稳定错误', async () => {
    const migratedState = configuredState('openai', { configuredAt: 1_700_000_000_000 });

    await expect(
      resolveActiveGenerationTarget({
        store: createStore(migratedState),
        containsHostPermission: vi.fn(async () => false),
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
  });

  it('权限查询异常时也收敛为稳定错误', async () => {
    await expect(
      resolveActiveGenerationTarget({
        store: createStore(configuredState()),
        containsHostPermission: vi.fn(async () => {
          throw new Error('chrome runtime unavailable');
        }),
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
  });
});
