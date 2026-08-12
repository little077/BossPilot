import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendSkillCommand } from './client';

describe('sendSkillCommand', () => {
  const sendMessage = vi.fn();

  beforeEach(() => {
    sendMessage.mockReset();
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
  });

  it('returns a validated successful response', async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      state: { version: 1, skills: [] },
    });
    await expect(sendSkillCommand({ type: 'skills:get' })).resolves.toEqual({
      version: 1,
      skills: [],
    });
  });

  it('surfaces service errors and rejects malformed responses', async () => {
    sendMessage.mockResolvedValueOnce({ ok: false, error: 'failed' });
    await expect(sendSkillCommand({ type: 'skills:get' })).rejects.toThrow('failed');
    sendMessage.mockResolvedValueOnce({ ok: true, state: null });
    await expect(sendSkillCommand({ type: 'skills:get' })).rejects.toThrow('无效响应');
    sendMessage.mockResolvedValueOnce({ ok: false, error: 42 });
    await expect(sendSkillCommand({ type: 'skills:get' })).rejects.toThrow('无效响应');
  });
});
