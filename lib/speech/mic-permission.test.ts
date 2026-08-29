import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMicPermissionPage, openSystemMicSettings, queryMicPermission } from './mic-permission';

describe('queryMicPermission', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      permissions: { query: vi.fn() },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('返回查询到的授权态', async () => {
    vi.mocked(navigator.permissions.query).mockResolvedValue({
      state: 'granted',
    } as PermissionStatus);
    await expect(queryMicPermission()).resolves.toBe('granted');
  });

  it('prompt / denied 原样透传', async () => {
    vi.mocked(navigator.permissions.query).mockResolvedValueOnce({
      state: 'prompt',
    } as PermissionStatus);
    await expect(queryMicPermission()).resolves.toBe('prompt');
    vi.mocked(navigator.permissions.query).mockResolvedValueOnce({
      state: 'denied',
    } as PermissionStatus);
    await expect(queryMicPermission()).resolves.toBe('denied');
  });

  it('浏览器不支持麦克风权限查询：返回 unknown', async () => {
    vi.mocked(navigator.permissions.query).mockRejectedValue(new Error('unsupported'));
    await expect(queryMicPermission()).resolves.toBe('unknown');
  });
});

describe('openMicPermissionPage / openSystemMicSettings', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
      tabs: { create: vi.fn() },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('openMicPermissionPage：打开带 type=microphone 参数的授权跳板页', () => {
    openMicPermissionPage();
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test/user-permission.html?type=microphone',
    });
  });

  it('openSystemMicSettings：打开 Chrome 麦克风设置页', () => {
    openSystemMicSettings();
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome://settings/content/microphone',
    });
  });
});
