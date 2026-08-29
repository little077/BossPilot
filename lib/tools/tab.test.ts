import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageTurnSnapshot } from '@/lib/domain/types';
import { executeTab, TAB_TOOL, tabExecutionMode } from './tab';

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
const executeScript = vi.fn();

function call(argumentsValue: Record<string, unknown>) {
  return { id: 'call-1', name: 'tab', arguments: argumentsValue };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition was not met');
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
  executeScript.mockReset().mockResolvedValue([{ result: [] }]);
  vi.stubGlobal('chrome', {
    tabs: { query, get, update, create, reload, remove },
    windows: { update: updateWindow },
    scripting: { executeScript },
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
    expect(result.content).toContain('"loadStatus":"complete"');
    expect(result.pageSnapshots).toEqual([expect.objectContaining({ tabId: 7 })]);
    expect(result.content).not.toContain('chrome://settings');
    expect(query).toHaveBeenCalledWith({ windowId: 3 });
  });

  it('only marks forced new-tab opens as parallel-safe', () => {
    expect(tabExecutionMode(call({ action: 'open', destination: 'baidu', mode: 'new' }))).toBe(
      'parallel',
    );
    expect(tabExecutionMode(call({ action: 'open', destination: 'baidu' }))).toBe('serial');
    expect(tabExecutionMode(call({ action: 'list' }))).toBe('serial');
    expect(tabExecutionMode(call({ action: 'switch', tabId: 7 }))).toBe('serial');
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

  it('releases the focus lock before waiting so independent tabs load concurrently', async () => {
    const firstReady = deferred<chrome.tabs.Tab>();
    const secondReady = deferred<chrome.tabs.Tab>();
    create
      .mockResolvedValueOnce({ id: 9, windowId: 3, url: 'https://www.baidu.com/' })
      .mockResolvedValueOnce({ id: 10, windowId: 3, url: 'https://www.bing.com/' });
    get.mockImplementation((tabId: number) =>
      tabId === 9 ? firstReady.promise : secondReady.promise,
    );

    const first = executeTab(
      call({ action: 'open', destination: 'baidu', mode: 'new' }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    const second = executeTab(
      call({ action: 'open', destination: 'bing', mode: 'new' }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );

    await waitFor(() => create.mock.calls.length === 2 && get.mock.calls.length === 2);
    expect(create).toHaveBeenCalledTimes(2);
    firstReady.resolve({
      id: 9,
      windowId: 3,
      status: 'complete',
      url: 'https://www.baidu.com/',
    } as chrome.tabs.Tab);
    secondReady.resolve({
      id: 10,
      windowId: 3,
      status: 'complete',
      url: 'https://www.bing.com/',
    } as chrome.tabs.Tab);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        isError: false,
        nextPageSnapshot: expect.objectContaining({ tabId: 9 }),
      }),
      expect.objectContaining({
        isError: false,
        nextPageSnapshot: expect.objectContaining({ tabId: 10 }),
      }),
    ]);
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

  it('opens a URL that really exists in the current page links', async () => {
    // 页面注入采集：详情链接真实存在于当前页（小红书式 SPA 详情 URL）
    executeScript.mockResolvedValue([
      { result: ['https://start.example/page', 'https://detail.example/note/5?xsec_token=t'] },
    ]);
    query.mockResolvedValueOnce([]);
    create.mockResolvedValueOnce({
      id: 9,
      windowId: 3,
      active: true,
      status: 'complete',
      title: '笔记详情',
      url: 'https://detail.example/note/5?xsec_token=t',
    });
    get.mockResolvedValueOnce({
      id: 9,
      windowId: 3,
      active: true,
      status: 'complete',
      title: '笔记详情',
      url: 'https://detail.example/note/5?xsec_token=t',
    });

    const result = await executeTab(
      call({ action: 'open', url: 'https://detail.example/note/5?xsec_token=t' }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      func: expect.any(Function),
    });
    expect(create).toHaveBeenCalledWith({
      url: 'https://detail.example/note/5?xsec_token=t',
      active: true,
      windowId: 3,
    });
    expect(result).toMatchObject({ isError: false, statusText: '已打开新标签页' });
  });

  it('still rejects a URL that is not present in the current page', async () => {
    executeScript.mockResolvedValue([{ result: ['https://start.example/page'] }]);
    await expect(
      executeTab(
        call({ action: 'open', url: 'https://detail.example/note/5' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, errorCode: 'UNGROUNDED_URL' });
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps the grounded-URL failure when the page cannot be injected', async () => {
    executeScript.mockRejectedValue(new Error('Cannot access contents of the page'));
    await expect(
      executeTab(
        call({ action: 'open', url: 'https://detail.example/note/5' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, errorCode: 'UNGROUNDED_URL' });
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

  it('open returns success with loading status instead of waiting 12s for a slow SPA', async () => {
    vi.useFakeTimers();
    query.mockResolvedValueOnce([]);
    create.mockResolvedValueOnce({
      id: 99,
      windowId: 3,
      active: true,
      status: 'loading',
      title: '小红书',
      url: 'https://www.xiaohongshu.com/search_result?keyword=vibe',
    });
    get.mockReset().mockResolvedValue({
      id: 99,
      windowId: 3,
      active: true,
      status: 'loading',
      title: '小红书',
      url: 'https://www.xiaohongshu.com/search_result?keyword=vibe',
    });
    const pending = executeTab(
      call({
        action: 'open',
        mode: 'new',
        url: 'https://www.xiaohongshu.com/search_result?keyword=vibe',
      }),
      SNAPSHOT,
      'https://www.xiaohongshu.com/search_result?keyword=vibe',
      new AbortController().signal,
    );
    const pendingAssertion = expect(pending).resolves.toMatchObject({
      isError: false,
      statusText: expect.stringContaining('页面仍在加载'),
      detail: expect.stringContaining('read_current_page'),
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await pendingAssertion;
  });

  it('warns after repeatedly opening the same URL within a short window', async () => {
    const url = 'https://reopen.example/target';
    const open = () =>
      executeTab(
        call({ action: 'open', mode: 'new', url }),
        SNAPSHOT,
        url,
        new AbortController().signal,
      );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      query.mockReset().mockResolvedValueOnce([]);
      create.mockReset().mockResolvedValueOnce({
        id: 100 + attempt,
        windowId: 3,
        active: true,
        status: 'complete',
        title: 'Target',
        url,
      });
      get.mockReset().mockResolvedValueOnce({
        id: 100 + attempt,
        windowId: 3,
        active: true,
        status: 'complete',
        title: 'Target',
        url,
      });
      await open();
    }
    query.mockReset().mockResolvedValueOnce([]);
    create.mockReset().mockResolvedValueOnce({
      id: 103,
      windowId: 3,
      active: true,
      status: 'complete',
      title: 'Target',
      url,
    });
    get.mockReset().mockResolvedValueOnce({
      id: 103,
      windowId: 3,
      active: true,
      status: 'complete',
      title: 'Target',
      url,
    });
    const third = await open();
    expect(third.isError).toBe(false);
    expect(third.detail).toContain('已打开 3 次');
    expect(third.detail).toContain('ask_user');
  });

  it('keeps the ungrounded failure when page link collection is unusable', async () => {
    // 注入结果不是数组
    executeScript.mockResolvedValueOnce([{ result: 'not-an-array' }]);
    await expect(
      executeTab(
        call({ action: 'open', url: 'https://grounded.example/page' }),
        SNAPSHOT,
        '不包含链接的文本',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, errorCode: 'UNGROUNDED_URL' });

    // 数组里没有目标链接
    executeScript.mockResolvedValueOnce([{ result: ['https://other.example/x'] }]);
    await expect(
      executeTab(
        call({ action: 'open', url: 'https://grounded.example/page' }),
        SNAPSHOT,
        '不包含链接的文本',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, errorCode: 'UNGROUNDED_URL' });

    // 目标本身不是合法 URL：解析阶段直接拒绝，不进入页面链接校验
    executeScript.mockResolvedValueOnce([{ result: [] }]);
    await expect(
      executeTab(
        call({ action: 'open', url: 'not a url' }),
        SNAPSHOT,
        '不包含链接的文本',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, errorCode: 'INVALID_BROWSER_ACTION' });
  });

  it('aborts grounding when the caller cancels during link collection', async () => {
    const gate = deferred<unknown>();
    executeScript.mockImplementationOnce(() => gate.promise);
    const controller = new AbortController();
    const pending = executeTab(
      call({ action: 'open', url: 'https://grounded.example/page' }),
      SNAPSHOT,
      '不包含链接的文本',
      controller.signal,
    );
    await waitFor(() => executeScript.mock.calls.length >= 1);
    controller.abort();
    gate.resolve([{ result: ['https://grounded.example/page'] }]);
    await expect(pending).resolves.toMatchObject({ isError: true, errorCode: 'UNGROUNDED_URL' });
  });

  it('activates the first remaining web tab after closing the active one', async () => {
    get.mockReset().mockResolvedValue({
      id: 7,
      windowId: 3,
      active: true,
      pinned: false,
      status: 'complete',
      title: 'Start',
      url: 'https://start.example/page',
    });
    query
      .mockReset()
      .mockResolvedValueOnce([
        { id: 7, windowId: 3, active: true, pinned: false, url: 'https://start.example/page' },
        { id: 8, windowId: 3, active: false, pinned: false, url: 'https://next.example/' },
      ])
      .mockResolvedValue([
        { id: 8, windowId: 3, active: false, pinned: false, url: 'https://next.example/' },
        { id: 9, windowId: 3, active: false, pinned: false, url: 'chrome://settings/' },
      ]);
    update.mockReset().mockResolvedValue({
      id: 8,
      windowId: 3,
      active: true,
      pinned: false,
      status: 'complete',
      title: 'Next',
      url: 'https://next.example/',
    });
    const result = await executeTab(
      call({ action: 'close', tabId: 7 }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    expect(result).toMatchObject({ isError: false });
    expect(update).toHaveBeenCalledWith(8, { active: true });
  });

  it('rejects a negative tab id and maps non-coded browser rejections', async () => {
    const negative = await executeTab(
      call({ action: 'switch', tabId: -1 }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    expect(negative).toMatchObject({ isError: true, errorCode: 'INVALID_BROWSER_ACTION' });

    update.mockReset().mockRejectedValue(new Error('boom'));
    const rejected = await executeTab(
      call({ action: 'switch', tabId: 7 }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    expect(rejected).toMatchObject({
      isError: true,
      errorCode: 'INVALID_BROWSER_ACTION',
      detail: '浏览器拒绝了操作。',
    });
  });

  it('exposes pinned and loading state without leaking raw query strings', async () => {
    query.mockReset().mockResolvedValue([
      {
        id: 5,
        windowId: 3,
        active: false,
        pinned: true,
        status: 'loading',
        title: 'Pinned',
        url: 'https://pinned.example/x?secret=1',
      },
    ]);
    const result = await executeTab(
      call({ action: 'list' }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    expect(result).toMatchObject({ isError: false });
    expect(result.content).toContain('"pinned":true');
    expect(result.content).toContain('"loadStatus":"loading"');
    expect(result.content).not.toContain('secret');
  });

  it('skips the repeated-open warning when the target was reused', async () => {
    const url = 'https://reused.example/page';
    query.mockReset().mockResolvedValue([
      {
        id: 7,
        windowId: 3,
        active: false,
        pinned: false,
        status: 'complete',
        title: 'Reuse',
        url,
      },
    ]);
    update.mockReset().mockResolvedValue({
      id: 7,
      windowId: 3,
      active: true,
      pinned: false,
      status: 'complete',
      title: 'Reuse',
      url,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await executeTab(
        call({ action: 'open', url }),
        SNAPSHOT,
        url,
        new AbortController().signal,
      );
      expect(result).toMatchObject({ isError: false });
      expect(result.detail).not.toContain('该 URL');
    }
  });

  it('returns cancelled when a browser failure follows a caller abort', async () => {
    query.mockReset().mockResolvedValueOnce([]);
    const controller = new AbortController();
    create.mockReset().mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('boom');
    });
    const result = await executeTab(
      call({ action: 'open', mode: 'new', url: 'https://aborted.example/' }),
      SNAPSHOT,
      'https://aborted.example/',
      controller.signal,
    );
    expect(result).toMatchObject({ isError: true, errorCode: 'CANCELLED' });
  });

  it('still compares plain-http links during page grounding', async () => {
    executeScript.mockResolvedValueOnce([{ result: ['http://other.example/x'] }]);
    await expect(
      executeTab(
        call({ action: 'open', url: 'https://grounded.example/page' }),
        SNAPSHOT,
        '不包含链接的文本',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, errorCode: 'UNGROUNDED_URL' });

    // 非 http(s) 链接被规范化拒绝，同样不匹配目标
    executeScript.mockResolvedValueOnce([{ result: ['chrome://settings/'] }]);
    await expect(
      executeTab(
        call({ action: 'open', url: 'https://grounded.example/page' }),
        SNAPSHOT,
        '不包含链接的文本',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, errorCode: 'UNGROUNDED_URL' });
  });

  it('reloads and closes title-less tabs without leaking empty fields', async () => {
    get.mockReset().mockResolvedValue({
      id: 7,
      windowId: 3,
      active: true,
      pinned: false,
      status: 'complete',
      url: 'https://start.example/page',
    });
    const reloaded = await executeTab(
      call({ action: 'reload', tabId: 7 }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    expect(reloaded).toMatchObject({ isError: false, statusText: '已刷新标签页' });
    expect(reload).toHaveBeenCalledWith(7);

    query
      .mockReset()
      .mockResolvedValueOnce([
        { id: 7, windowId: 3, active: true, url: 'https://start.example/page' },
        { id: 10, windowId: 3, active: false, url: 'https://next.example/' },
      ])
      .mockResolvedValue([{ id: 10, windowId: 3, active: false, url: 'https://next.example/' }]);
    const closed = await executeTab(
      call({ action: 'close', tabId: 7 }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    expect(closed).toMatchObject({ isError: false, statusText: '已关闭标签页' });
    expect(closed.detail).toBe('目标标签页');
  });

  it('maps an empty coded message to the generic rejection detail', async () => {
    update.mockReset().mockRejectedValue(new Error('TAB_NOT_FOUND:'));
    const result = await executeTab(
      call({ action: 'switch', tabId: 7 }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      isError: true,
      errorCode: 'TAB_NOT_FOUND',
      detail: '浏览器拒绝了操作。',
    });
  });

  it('lists a title-less tab without leaking missing fields', async () => {
    query
      .mockReset()
      .mockResolvedValue([
        { id: 11, windowId: 3, active: false, status: 'loading', url: 'https://plain.example/' },
      ]);
    const result = await executeTab(
      call({ action: 'list' }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    expect(result).toMatchObject({ isError: false });
    expect(result.content).toContain('"title":""');
    expect(result.content).toContain('"loadStatus":"loading"');
  });

  it('rejects a missing tab id for tab-scoped actions', async () => {
    const result = await executeTab(
      call({ action: 'switch' }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    expect(result).toMatchObject({ isError: true, errorCode: 'INVALID_BROWSER_ACTION' });
  });
});
