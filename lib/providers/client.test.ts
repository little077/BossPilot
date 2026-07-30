import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderStateView } from '@/lib/domain/types';
import { sendProviderCommand } from '@/lib/providers/client';

const sendMessage = vi.fn();

const STATE: ProviderStateView = {
  version: 1,
  connections: [
    {
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      hasApiKey: true,
      apiKeyLastFour: '1234',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      selectedModelId: 'deepseek-chat',
    },
  ],
  activeModel: {
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
  },
};

beforeEach(() => {
  sendMessage.mockReset();
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
    },
  });
});

describe('sendProviderCommand', () => {
  it('sends the command and returns a successful provider state', async () => {
    sendMessage.mockResolvedValue({ ok: true, state: STATE });

    await expect(sendProviderCommand({ type: 'providers:get' })).resolves.toBe(STATE);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'providers:get' });
  });

  it('surfaces a background protocol error without exposing another payload', async () => {
    sendMessage.mockResolvedValue({
      ok: false,
      error: 'model provider rejected the key',
    });

    await expect(
      sendProviderCommand({
        type: 'providers:connect',
        providerId: 'deepseek',
        apiKey: 'private-key',
      }),
    ).rejects.toThrow('model provider rejected the key');
  });

  it.each([
    null,
    undefined,
    'not-an-object',
    {},
    { ok: true },
    { ok: true, state: null },
    { ok: false },
    { ok: false, error: 500 },
  ])('rejects an invalid runtime response: %j', async (response) => {
    sendMessage.mockResolvedValue(response);

    await expect(sendProviderCommand({ type: 'providers:get' })).rejects.toThrow();
  });

  it('propagates runtime transport failures', async () => {
    const transportError = new Error('extension context invalidated');
    sendMessage.mockRejectedValue(transportError);

    await expect(sendProviderCommand({ type: 'providers:get' })).rejects.toBe(transportError);
  });
});
