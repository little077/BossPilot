import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendAgentContextCommand } from './client';

describe('sendAgentContextCommand', () => {
  const sendMessage = vi.fn();
  beforeEach(() => {
    sendMessage.mockReset();
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
  });

  it('returns valid state and rejects service or malformed responses', async () => {
    const state = {
      settings: { version: 1, instructions: '', memoryEnabled: false },
      memories: [],
    };
    sendMessage.mockResolvedValueOnce({ ok: true, state });
    await expect(sendAgentContextCommand({ type: 'context:get' })).resolves.toEqual(state);
    sendMessage.mockResolvedValueOnce({ ok: false, error: 'failed' });
    await expect(sendAgentContextCommand({ type: 'context:get' })).rejects.toThrow('failed');
    sendMessage.mockResolvedValueOnce({ ok: true, state: null });
    await expect(sendAgentContextCommand({ type: 'context:get' })).rejects.toThrow('无效响应');
  });
});
