import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageTurnSnapshot } from '@/lib/domain/types';
import { executeTab, TAB_TOOL } from './tab';

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

const query = vi.fn();
const get = vi.fn();
const update = vi.fn();
const create = vi.fn();
const reload = vi.fn();
const remove = vi.fn();
const updateWindow = vi.fn();

function call(argumentsValue: Record<string, unknown>) {
  return { id: 'call-1', name: 'tab', arguments: argumentsValue };
}

beforeEach(() => {
  query.mockReset().mockResolvedValue([
    {
      id: 7,
      windowId: 3,
      active: true,
      pinned: false,
      status: 'complete',
      title: 'Start',
      url: 'https://start.example/page?secret=1',
    },
    { id: 8, windowId: 3, active: false, pinned: false, url: 'chrome://settings/' },
    { id: 9, windowId: 3, active: false, pinned: false, url: 'not a url' },
    { id: 10, windowId: 3, active: false },
  ]);
  get.mockReset().mockResolvedValue({
    id: 7,
    windowId: 3,
    active: true,
    pinned: false,
    status: 'complete',
    title: 'Start',
    url: 'https://start.example/page',
  });
  update.mockReset().mockImplementation(async (tabId: number) => ({
    id: tabId,
    windowId: 3,
    active: true,
    pinned: false,
    status: 'complete',
    title: 'Updated',
    url: 'https://start.example/page',
  }));
  create.mockReset().mockResolvedValue({
    id: 9,
    windowId: 3,
    active: true,
    status: 'complete',
    title: 'Baidu',
    url: 'https://www.baidu.com/',
  });
  reload.mockReset().mockResolvedValue(undefined);
  remove.mockReset().mockResolvedValue(undefined);
  updateWindow.mockReset().mockResolvedValue({});
  vi.stubGlobal('chrome', {
    tabs: { query, get, update, create, reload, remove },
    windows: { update: updateWindow },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tab tool', () => {
  it('publishes a bounded tool contract and lists only HTTP(S) tabs', async () => {
    expect(TAB_TOOL).toMatchObject({ name: 'tab', parameters: { required: ['action'] } });
    const result = await executeTab(
      call({ action: 'list' }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );

    expect(result).toMatchObject({ isError: false, statusText: '已列出当前窗口标签页' });
    expect(result.content).toContain('"tabId":7');
    expect(result.content).not.toContain('chrome://settings');
    expect(query).toHaveBeenCalledWith({ windowId: 3 });
  });

  it('forces a new tab for a known destination and waits for readiness', async () => {
    get.mockResolvedValueOnce({
      id: 9,
      windowId: 3,
      active: true,
      status: 'complete',
      title: 'Baidu',
      url: 'https://www.baidu.com/',
    });
    const result = await executeTab(
      call({ action: 'open', destination: 'baidu', mode: 'new' }),
      SNAPSHOT,
      '打开百度',
      new AbortController().signal,
    );

    expect(create).toHaveBeenCalledWith({
      url: 'https://www.baidu.com/',
      active: true,
      windowId: 3,
    });
    expect(result).toMatchObject({ isError: false, nextPageSnapshot: { tabId: 9 } });
  });

  it('reports a newly created tab without an ID and tolerates focus rejection', async () => {
    create.mockResolvedValueOnce({ windowId: 3, url: 'https://www.baidu.com/' });
    await expect(
      executeTab(
        call({ action: 'open', destination: 'baidu', mode: 'new' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, errorCode: 'TAB_NOT_FOUND' });

    updateWindow.mockRejectedValueOnce(new Error('window disappeared'));
    await expect(
      executeTab(call({ action: 'switch', tabId: 7 }), SNAPSHOT, '', new AbortController().signal),
    ).resolves.toMatchObject({ isError: false, statusText: '已切换标签页' });
  });

  it('rejects an ungrounded URL and switches only a current-window web tab', async () => {
    await expect(
      executeTab(
        call({ action: 'open', url: 'https://evil.example/' }),
        SNAPSHOT,
        '打开文档',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, errorCode: 'UNGROUNDED_URL' });

    await expect(
      executeTab(call({ action: 'switch', tabId: 7 }), SNAPSHOT, '', new AbortController().signal),
    ).resolves.toMatchObject({ isError: false, statusText: '已切换标签页' });
    expect(update).toHaveBeenCalledWith(7, { active: true });

    get.mockResolvedValueOnce({ id: 12, windowId: 4, url: 'https://other.example/' });
    await expect(
      executeTab(call({ action: 'switch', tabId: 12 }), SNAPSHOT, '', new AbortController().signal),
    ).resolves.toMatchObject({ isError: true, errorCode: 'TAB_NOT_FOUND' });
  });

  it('reloads a current tab and refuses pinned or last-tab closes', async () => {
    await expect(
      executeTab(call({ action: 'reload', tabId: 7 }), SNAPSHOT, '', new AbortController().signal),
    ).resolves.toMatchObject({ isError: false, statusText: '已刷新标签页' });
    expect(reload).toHaveBeenCalledWith(7);

    get.mockResolvedValueOnce({
      id: 7,
      windowId: 3,
      pinned: true,
      url: 'https://start.example/',
    });
    await expect(
      executeTab(call({ action: 'close', tabId: 7 }), SNAPSHOT, '', new AbortController().signal),
    ).resolves.toMatchObject({ isError: true, errorCode: 'INVALID_BROWSER_ACTION' });

    query.mockResolvedValueOnce([{ id: 7, windowId: 3, url: 'https://start.example/' }]);
    await expect(
      executeTab(call({ action: 'close', tabId: 7 }), SNAPSHOT, '', new AbortController().signal),
    ).resolves.toMatchObject({ isError: true, errorCode: 'INVALID_BROWSER_ACTION' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('closes an ordinary tab and selects a remaining web tab', async () => {
    query
      .mockResolvedValueOnce([
        { id: 7, windowId: 3, active: true, url: 'https://start.example/' },
        { id: 10, windowId: 3, active: false, url: 'https://next.example/' },
      ])
      .mockResolvedValueOnce([
        {
          id: 10,
          windowId: 3,
          active: false,
          status: 'complete',
          title: 'Next',
          url: 'https://next.example/',
        },
      ]);

    const result = await executeTab(
      call({ action: 'close', tabId: 7 }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    expect(remove).toHaveBeenCalledWith(7);
    expect(update).toHaveBeenCalledWith(10, { active: true });
    expect(result).toMatchObject({ isError: false, nextPageSnapshot: { tabId: 10 } });
  });

  it('maps malformed parameters and cancellation to bounded results', async () => {
    await expect(
      executeTab(
        call({ action: 'switch', tabId: '7' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, errorCode: 'INVALID_BROWSER_ACTION' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeTab(call({ action: 'list' }), SNAPSHOT, '', controller.signal),
    ).resolves.toMatchObject({
      isError: true,
      errorCode: 'CANCELLED',
    });
  });

  it('resolves the current window without a snapshot and reports a missing window', async () => {
    query
      .mockResolvedValueOnce([{ id: 4, windowId: 6, active: true, url: 'https://example.com/' }])
      .mockResolvedValueOnce([{ id: 4, windowId: 6, active: true, url: 'https://example.com/' }]);
    await expect(
      executeTab(call({ action: 'list' }), null, '', new AbortController().signal),
    ).resolves.toMatchObject({ isError: false });
    expect(query).toHaveBeenNthCalledWith(1, { active: true, currentWindow: true });
    expect(query).toHaveBeenNthCalledWith(2, { windowId: 6 });

    query.mockResolvedValueOnce([]);
    await expect(
      executeTab(call({ action: 'list' }), null, '', new AbortController().signal),
    ).resolves.toMatchObject({ isError: true, errorCode: 'TAB_NOT_FOUND' });
  });

  it('reuses an existing target and reports a tab that disappears while switching', async () => {
    query.mockResolvedValueOnce([
      {
        id: 11,
        windowId: 3,
        active: false,
        status: 'complete',
        title: 'Baidu',
        url: 'https://www.baidu.com/',
      },
    ]);
    update.mockResolvedValueOnce({
      id: 11,
      windowId: 3,
      active: true,
      status: 'complete',
      title: 'Baidu',
      url: 'https://www.baidu.com/',
    });
    get.mockResolvedValueOnce({
      id: 11,
      windowId: 3,
      active: true,
      status: 'complete',
      title: 'Baidu',
      url: 'https://www.baidu.com/',
    });
    await expect(
      executeTab(
        call({ action: 'open', destination: 'baidu', mode: 'reuse' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: false, statusText: '已切换到已有标签页' });

    update.mockResolvedValueOnce(undefined);
    await expect(
      executeTab(call({ action: 'switch', tabId: 7 }), SNAPSHOT, '', new AbortController().signal),
    ).resolves.toMatchObject({ isError: true, errorCode: 'TAB_NOT_FOUND' });
  });

  it('rejects special tabs, negative IDs and malformed optional fields', async () => {
    get.mockResolvedValueOnce({ id: 7, windowId: 3, url: 'chrome://settings/' });
    await expect(
      executeTab(call({ action: 'switch', tabId: 7 }), SNAPSHOT, '', new AbortController().signal),
    ).resolves.toMatchObject({ isError: true, errorCode: 'TAB_NOT_FOUND' });

    for (const argumentsValue of [
      { action: 'unknown' },
      { action: 'switch', tabId: -1 },
      { action: 'open', mode: 'background' },
      { action: 'open', url: 123 },
    ]) {
      await expect(
        executeTab(call(argumentsValue), SNAPSHOT, '', new AbortController().signal),
      ).resolves.toMatchObject({ isError: true, errorCode: 'INVALID_BROWSER_ACTION' });
    }
  });

  it('returns a bounded generic error for non-Error browser failures', async () => {
    get.mockRejectedValueOnce('browser failed');
    await expect(
      executeTab(call({ action: 'switch', tabId: 7 }), SNAPSHOT, '', new AbortController().signal),
    ).resolves.toMatchObject({
      isError: true,
      errorCode: 'INVALID_BROWSER_ACTION',
      detail: '浏览器拒绝了操作。',
    });
  });

  it('can close an active tab without guessing a non-web successor', async () => {
    get.mockResolvedValueOnce({
      id: 7,
      windowId: 3,
      active: true,
      pinned: false,
      title: '',
      url: 'https://start.example/',
    });
    query
      .mockResolvedValueOnce([
        { id: 7, windowId: 3, active: true, url: 'https://start.example/' },
        { id: 8, windowId: 3, active: false, url: 'chrome://settings/' },
      ])
      .mockResolvedValueOnce([{ id: 8, windowId: 3, active: true, url: 'chrome://settings/' }]);
    const result = await executeTab(
      call({ action: 'close', tabId: 7 }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    expect(result).toMatchObject({ isError: false, statusText: '已关闭标签页' });
    expect(result).not.toHaveProperty('nextPageSnapshot');
  });
});
