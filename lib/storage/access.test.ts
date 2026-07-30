import { describe, expect, it, vi } from 'vitest';
import { createTrustedStorageGate } from './access';

describe('createTrustedStorageGate', () => {
  it('immediately restricts local storage and reuses the successful result', async () => {
    const setAccessLevel = vi.fn(async () => undefined);

    const requireTrustedStorage = createTrustedStorageGate(setAccessLevel);

    expect(setAccessLevel).toHaveBeenCalledTimes(1);
    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    await expect(requireTrustedStorage()).resolves.toBeUndefined();
    await expect(requireTrustedStorage()).resolves.toBeUndefined();
    expect(setAccessLevel).toHaveBeenCalledTimes(1);
  });

  it('uses the Chrome storage API by default', async () => {
    const setAccessLevel = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', { storage: { local: { setAccessLevel } } });

    try {
      const requireTrustedStorage = createTrustedStorageGate();
      await expect(requireTrustedStorage()).resolves.toBeUndefined();
      expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed without exposing the browser error', async () => {
    const setAccessLevel = vi.fn(async () => {
      throw new Error('sensitive browser detail');
    });

    const requireTrustedStorage = createTrustedStorageGate(setAccessLevel);

    await expect(requireTrustedStorage()).rejects.toThrow(
      '无法启用模型密钥隔离，已停止模型配置与调用。请升级 Chrome 后重试。',
    );
    await expect(requireTrustedStorage()).rejects.not.toThrow('sensitive browser detail');
  });
});
