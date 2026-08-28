import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageTurnSnapshot } from '@/lib/domain/types';
import {
  isSameTarget,
  KNOWN_BROWSER_DESTINATIONS,
  openNewTab,
  openOrFocusTab,
  resolveBrowserTarget,
  waitForTabReady,
} from './tab-router';

const query = vi.fn();
const update = vi.fn();
const create = vi.fn();
const get = vi.fn();
const updateWindow = vi.fn();

const SNAPSHOT: PageTurnSnapshot = {
  tabId: 7,
  windowId: 3,
  url: 'https://start.example/page',
  safeUrl: 'https://start.example/page',
  origin: 'https://start.example',
  title: 'Start',
  scheme: 'https',
  isHttp: true,
  isBoss: false,
  capturedAt: 1,
};

beforeEach(() => {
  query.mockReset().mockResolvedValue([]);
  update.mockReset();
  create.mockReset();
  get.mockReset();
  updateWindow.mockReset().mockResolvedValue({});
  vi.stubGlobal('chrome', {
    tabs: { query, update, create, get },
    windows: { update: updateWindow },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('browser target resolution', () => {
  it('resolves known destinations without accepting a model-supplied override', () => {
    expect(resolveBrowserTarget('baidu', 'https://evil.example/', '打开百度')).toEqual({
      ok: true,
      url: KNOWN_BROWSER_DESTINATIONS.baidu,
    });
  });

  it('accepts only an HTTP(S) URL explicitly grounded in the user message', () => {
    expect(
      resolveBrowserTarget(
        undefined,
        'https://docs.example.com/start?q=1',
        '打开 docs.example.com',
      ),
    ).toEqual({ ok: true, url: 'https://docs.example.com/start?q=1' });
    expect(
      resolveBrowserTarget(undefined, 'https://www.example.com/start', '打开 example.com'),
    ).toMatchObject({ ok: true });
    expect(resolveBrowserTarget(undefined, 'https://evil.example/', '打开文档')).toMatchObject({
      ok: false,
      error: 'UNGROUNDED_URL',
    });
    expect(resolveBrowserTarget(undefined, 'https://www.com/', 'come here')).toMatchObject({
      ok: false,
      error: 'UNGROUNDED_URL',
    });
  });

  it('rejects missing, malformed, and non-web targets', () => {
    expect(resolveBrowserTarget('current', undefined, '')).toMatchObject({
      ok: false,
      error: 'INVALID_BROWSER_ACTION',
    });
    expect(resolveBrowserTarget(undefined, 'not a url', 'not a url')).toMatchObject({
      ok: false,
      error: 'INVALID_BROWSER_ACTION',
    });
    expect(resolveBrowserTarget(undefined, 'file:///private', 'file:///private')).toMatchObject({
      ok: false,
      error: 'INVALID_BROWSER_ACTION',
    });
  });

  it('matches roots by origin and explicit paths without query or trailing-slash noise', () => {
    expect(isSameTarget('https://example.com/anything?q=1', new URL('https://example.com/'))).toBe(
      true,
    );
    expect(isSameTarget('https://example.com/docs/?q=1', new URL('https://example.com/docs'))).toBe(
      true,
    );
    expect(isSameTarget('https://example.com/other', new URL('https://example.com/docs'))).toBe(
      false,
    );
    expect(isSameTarget('https://other.example/docs', new URL('https://example.com/docs'))).toBe(
      false,
    );
    expect(isSameTarget('not a url', new URL('https://example.com/'))).toBe(false);
  });
});

describe('tab routing', () => {
  it('prefers a matching tab in the bound window, activates it, and focuses its window', async () => {
    query.mockResolvedValue([
      {
        id: 10,
        windowId: 8,
        url: 'https://www.baidu.com/s?wd=old',
        active: true,
        lastAccessed: 50,
      },
      {
        id: 11,
        windowId: 3,
        url: 'https://www.baidu.com/',
        active: false,
        lastAccessed: 1,
      },
    ]);
    update.mockResolvedValue({
      id: 11,
      windowId: 3,
      url: 'https://www.baidu.com/',
      status: 'complete',
    });

    await expect(
      openOrFocusTab('https://www.baidu.com/', SNAPSHOT, new AbortController().signal),
    ).resolves.toMatchObject({ reused: true, tab: { id: 11 } });
    expect(update).toHaveBeenCalledWith(11, { active: true });
    expect(updateWindow).toHaveBeenCalledWith(3, { focused: true });
    expect(create).not.toHaveBeenCalled();
  });

  it('otherwise chooses the active or most recently accessed match', async () => {
    query.mockResolvedValue([
      { id: 1, windowId: 1, url: 'https://example.com/', active: false, lastAccessed: 100 },
      { id: 2, windowId: 2, url: 'https://example.com/', active: true, lastAccessed: 1 },
    ]);
    update.mockResolvedValue({ id: 2, windowId: 2, url: 'https://example.com/' });
    await openOrFocusTab('https://example.com/', null, new AbortController().signal);
    expect(update).toHaveBeenCalledWith(2, { active: true });

    query.mockResolvedValue([
      { id: 3, windowId: 1, url: 'https://example.com/', active: false, lastAccessed: 20 },
      { id: 4, windowId: 2, url: 'https://example.com/', active: false, lastAccessed: 30 },
    ]);
    update.mockResolvedValue({ id: 4, windowId: 2, url: 'https://example.com/' });
    await openOrFocusTab('https://example.com/', null, new AbortController().signal);
    expect(update).toHaveBeenLastCalledWith(4, { active: true });

    query.mockResolvedValue([
      { id: 5, windowId: 1, url: 'https://example.com/', active: false },
      { id: 6, windowId: 2, url: 'https://example.com/', active: false },
    ]);
    update.mockResolvedValue({ id: 5, windowId: 1, url: 'https://example.com/' });
    await openOrFocusTab('https://example.com/', null, new AbortController().signal);
    expect(update).toHaveBeenLastCalledWith(5, { active: true });
  });

  it('creates a tab in the current window and tolerates a window-focus failure', async () => {
    query.mockResolvedValue([{ id: 2, windowId: 3, url: 'not a url' }]);
    create.mockResolvedValue({ id: 20, windowId: 3, url: 'https://example.com/' });
    updateWindow.mockRejectedValue(new Error('window gone'));

    await expect(
      openOrFocusTab('https://example.com/', SNAPSHOT, new AbortController().signal),
    ).resolves.toMatchObject({ reused: false, tab: { id: 20 } });
    expect(create).toHaveBeenCalledWith({
      url: 'https://example.com/',
      active: true,
      windowId: 3,
    });
  });

  it('always creates a fresh HTTP(S) tab when explicitly requested', async () => {
    create.mockResolvedValue({ id: 21, windowId: 3, url: 'https://example.com/' });
    await expect(
      openNewTab('https://example.com/', SNAPSHOT, new AbortController().signal),
    ).resolves.toMatchObject({ id: 21 });
    expect(query).not.toHaveBeenCalled();
    await expect(
      openNewTab('chrome://settings/', SNAPSHOT, new AbortController().signal),
    ).rejects.toThrow('INVALID_BROWSER_ACTION');
  });

  it('reports a matching tab that disappears and observes cancellation', async () => {
    query.mockResolvedValue([{ id: 10, windowId: 3, url: 'https://example.com/' }]);
    update.mockResolvedValue(undefined);
    await expect(
      openOrFocusTab('https://example.com/', SNAPSHOT, new AbortController().signal),
    ).rejects.toThrow('TAB_NOT_FOUND');

    const controller = new AbortController();
    controller.abort();
    await expect(openOrFocusTab('https://example.com/', SNAPSHOT, controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
  });
});

describe('tab readiness', () => {
  it('returns a completed tab and maps a closed tab', async () => {
    get.mockResolvedValue({
      id: 4,
      windowId: 1,
      status: 'complete',
      url: 'https://example.com/',
    });
    await expect(waitForTabReady(4, new AbortController().signal)).resolves.toMatchObject({
      id: 4,
    });

    get.mockRejectedValue(new Error('No tab'));
    await expect(waitForTabReady(4, new AbortController().signal)).rejects.toThrow('TAB_NOT_FOUND');
  });

  it('polls loading tabs, times out, and cancels a pending delay cleanly', async () => {
    vi.useFakeTimers();
    get
      .mockResolvedValueOnce({ id: 4, windowId: 1, status: 'loading', url: 'https://example.com/' })
      .mockResolvedValue({ id: 4, windowId: 1, status: 'complete', url: 'https://example.com/' });
    const ready = waitForTabReady(4, new AbortController().signal, 500);
    await vi.advanceTimersByTimeAsync(150);
    await expect(ready).resolves.toMatchObject({ status: 'complete' });

    get.mockReset().mockResolvedValue({
      id: 4,
      windowId: 1,
      status: 'loading',
      url: 'https://example.com/',
    });
    const timedOut = waitForTabReady(4, new AbortController().signal, 100);
    const timedOutAssertion = expect(timedOut).rejects.toThrow('TAB_LOAD_TIMEOUT');
    await vi.advanceTimersByTimeAsync(150);
    await timedOutAssertion;

    const controller = new AbortController();
    const cancelled = waitForTabReady(4, controller.signal, 1_000);
    const cancelledError = cancelled.catch((error: unknown) => error);
    await Promise.resolve();
    controller.abort();
    await expect(cancelledError).resolves.toBe(controller.signal.reason);
  });

  it('uses a standard AbortError if a host supplies an aborted signal without a reason', async () => {
    get.mockResolvedValue({
      id: 4,
      windowId: 1,
      status: 'loading',
      url: 'https://example.com/',
    });
    const signal = {
      aborted: true,
      reason: undefined,
      throwIfAborted: () => void 0,
    } as unknown as AbortSignal;
    await expect(waitForTabReady(4, signal, 100)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
