import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasExactPageOriginAccess,
  isExactPageOriginPattern,
  listGrantedPageOrigins,
  pageOriginPattern,
  removePageOriginAccess,
  requestPageOriginAccess,
} from './access';

const contains = vi.fn();
const request = vi.fn();
const remove = vi.fn();
const get = vi.fn();
const set = vi.fn();
let stored: Record<string, unknown>;

beforeEach(() => {
  stored = {};
  contains.mockReset();
  request.mockReset();
  remove.mockReset();
  get.mockReset().mockImplementation(async (key: string) => ({ [key]: stored[key] }));
  set.mockReset().mockImplementation(async (value: Record<string, unknown>) => {
    Object.assign(stored, value);
  });
  vi.stubGlobal('chrome', {
    permissions: { contains, request, remove },
    storage: { local: { get, set } },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('page origin access', () => {
  it('only accepts exact HTTP(S) origins', () => {
    expect(pageOriginPattern('https://example.com')).toBe('https://example.com/*');
    expect(pageOriginPattern('http://localhost:3000')).toBe('http://localhost:3000/*');
    expect(pageOriginPattern('https://example.com/path')).toBeNull();
    expect(pageOriginPattern('chrome://settings')).toBeNull();
    expect(isExactPageOriginPattern('https://example.com/*')).toBe(true);
    expect(isExactPageOriginPattern('https://*/*')).toBe(false);
  });

  it('requests and remembers only a granted exact pattern', async () => {
    request.mockResolvedValue(true);
    await expect(requestPageOriginAccess('https://example.com/*')).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: ['https://example.com/*'] });
    expect(stored).toEqual({ bosspilot_page_origins_v1: ['https://example.com/*'] });

    request.mockResolvedValue(false);
    await expect(requestPageOriginAccess('https://denied.example/*')).resolves.toBe(false);
    await expect(requestPageOriginAccess('https://*/*')).resolves.toBe(false);
  });

  it('lists only permissions still granted and removes stale records', async () => {
    stored.bosspilot_page_origins_v1 = ['https://b.example/*', 'invalid', 'https://a.example/*'];
    contains.mockImplementation(async ({ origins }: { origins: string[] }) =>
      origins[0]?.includes('a.example'),
    );

    await expect(listGrantedPageOrigins()).resolves.toEqual([
      { origin: 'https://a.example', pattern: 'https://a.example/*' },
    ]);
    expect(stored.bosspilot_page_origins_v1).toEqual(['https://a.example/*']);
  });

  it('checks and revokes exact origin access', async () => {
    contains.mockResolvedValue(true);
    remove.mockResolvedValue(true);
    stored.bosspilot_page_origins_v1 = ['https://example.com/*'];
    await expect(hasExactPageOriginAccess('https://example.com/*')).resolves.toBe(true);
    await expect(removePageOriginAccess('https://example.com/*')).resolves.toBe(true);
    expect(remove).toHaveBeenCalledWith({ origins: ['https://example.com/*'] });
    expect(stored.bosspilot_page_origins_v1).toEqual([]);
    await expect(hasExactPageOriginAccess('https://*/*')).resolves.toBe(false);
    await expect(removePageOriginAccess('bad')).resolves.toBe(false);
  });
});
