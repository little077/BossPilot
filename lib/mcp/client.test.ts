import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMcpCommand } from './client';

describe('sendMcpCommand', () => {
  const sendMessage = vi.fn();
  beforeEach(() => {
    sendMessage.mockReset();
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
  });

  it('returns valid state and rejects errors or malformed responses', async () => {
    const state = { version: 1, servers: [] };
    sendMessage.mockResolvedValueOnce({ ok: true, state });
    await expect(sendMcpCommand({ type: 'mcp:get' })).resolves.toEqual(state);
    sendMessage.mockResolvedValueOnce({ ok: false, error: 'failed' });
    await expect(sendMcpCommand({ type: 'mcp:get' })).rejects.toThrow('failed');
    sendMessage.mockResolvedValueOnce({ ok: true, state: null });
    await expect(sendMcpCommand({ type: 'mcp:get' })).rejects.toThrow('无效响应');
  });
});
