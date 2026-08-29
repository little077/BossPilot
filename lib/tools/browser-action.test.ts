import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserPageFingerprint,
  BrowserSearchScriptResult,
  PageTurnSnapshot,
} from '@/lib/domain/types';
import type { GenerationToolCall } from '@/lib/generation/types';
import { BROWSER_ACTION_TOOL, executeBrowserAction } from './browser-action';

const tabsQuery = vi.fn();
const tabsUpdate = vi.fn();
const tabsCreate = vi.fn();
const tabsGet = vi.fn();
const windowsUpdate = vi.fn();
const permissionsContains = vi.fn();
const executeScript = vi.fn();

const SNAPSHOT: PageTurnSnapshot = {
  tabId: 7,
  windowId: 3,
  url: 'https://current.example/search',
  safeUrl: 'https://current.example/search',
  origin: 'https://current.example',
  title: 'Current search',
  scheme: 'https',
  isHttp: true,
  isBoss: false,
  capturedAt: 1,
};

const BEFORE: BrowserPageFingerprint = {
  url: 'https://www.baidu.com/',
  title: '百度',
  textHash: 'before',
  textLength: 100,
  childCount: 2,
};

function call(argumentsValue: Record<string, unknown>): GenerationToolCall {
  return { id: 'tool-1', name: 'browser_action', arguments: argumentsValue };
}

function searchResult(
  overrides: Partial<BrowserSearchScriptResult> = {},
): BrowserSearchScriptResult {
  return {
    version: 1,
    ok: true,
    executionUrl: 'https://www.baidu.com/',
    control: {
      tag: 'input',
      role: 'searchbox',
      label: '搜索',
      placeholder: '请输入关键词',
      type: 'search',
      score: 230,
    },
    candidates: [],
    ambiguous: false,
    typed: true,
    submitted: true,
    submissionMethod: 'form',
    fingerprint: BEFORE,
    ...overrides,
  };
}

beforeEach(() => {
  tabsQuery.mockReset().mockResolvedValue([
    {
      id: 9,
      windowId: 3,
      url: 'https://www.baidu.com/',
      title: '百度',
      status: 'complete',
      active: false,
    },
  ]);
  tabsUpdate.mockReset().mockResolvedValue({
    id: 9,
    windowId: 3,
    url: 'https://www.baidu.com/',
    title: '百度',
    status: 'complete',
  });
  tabsCreate.mockReset();
  tabsGet.mockReset().mockResolvedValue({
    id: 9,
    windowId: 3,
    url: 'https://www.baidu.com/',
    title: '百度',
    status: 'complete',
  });
  windowsUpdate.mockReset().mockResolvedValue({});
  permissionsContains.mockReset().mockResolvedValue(true);
  executeScript.mockReset().mockImplementation((options: { args?: unknown[] }) =>
    options.args
      ? Promise.resolve([{ result: searchResult() }])
      : Promise.resolve([
          {
            result: { ...BEFORE, textHash: 'after', textLength: 160 },
          },
        ]),
  );
  vi.stubGlobal('chrome', {
    tabs: { query: tabsQuery, update: tabsUpdate, create: tabsCreate, get: tabsGet },
    windows: { update: windowsUpdate },
    permissions: { contains: permissionsContains },
    scripting: { executeScript },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('browser_action tool', () => {
  it('publishes one bounded high-level navigation and search contract', () => {
    expect(BROWSER_ACTION_TOOL).toMatchObject({
      name: 'browser_action',
      parameters: {
        required: ['action'],
        additionalProperties: false,
      },
    });
    expect(BROWSER_ACTION_TOOL.description).toContain('不要用它发送聊天');
  });

  it('rejects malformed actions, invalid searches, and an unsupported current page', async () => {
    const signal = new AbortController().signal;
    await expect(
      executeBrowserAction(call({ action: 'click' }), null, '', signal),
    ).resolves.toMatchObject({ errorCode: 'INVALID_BROWSER_ACTION' });
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: ' ' }),
        null,
        '',
        signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'INVALID_BROWSER_ACTION' });
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'x'.repeat(501) }),
        null,
        '',
        signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'INVALID_BROWSER_ACTION' });
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'current', query: 'AI' }),
        null,
        '',
        signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'INVALID_BROWSER_ACTION' });
    expect(tabsQuery).not.toHaveBeenCalled();
  });

  it('rejects the merged open_or_focus action since navigation lives in tab', async () => {
    const progress = vi.fn();
    await expect(
      executeBrowserAction(
        call({ action: 'open_or_focus', destination: 'baidu' }),
        SNAPSHOT,
        '打开百度',
        new AbortController().signal,
        progress,
      ),
    ).resolves.toMatchObject({ errorCode: 'INVALID_BROWSER_ACTION' });
    expect(tabsQuery).not.toHaveBeenCalled();
  });

  it('refuses a guessed URL, but searches an explicit user-given URL', async () => {
    const signal = new AbortController().signal;
    await expect(
      executeBrowserAction(
        call({ action: 'search', url: 'https://guess.example/', query: 'AI' }),
        SNAPSHOT,
        '帮我搜索那个网站',
        signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'UNGROUNDED_URL' });

    tabsQuery.mockResolvedValue([]);
    tabsCreate.mockResolvedValue({
      id: 12,
      windowId: 3,
      url: 'https://docs.example.com/start?secret=1',
      title: 'Docs',
      status: 'complete',
    });
    tabsGet.mockResolvedValue({
      id: 12,
      windowId: 3,
      url: 'https://docs.example.com/start?secret=1',
      title: 'Docs',
      status: 'complete',
    });
    executeScript.mockImplementation((options: { args?: unknown[] }) =>
      options.args
        ? Promise.resolve([
            {
              result: searchResult({
                executionUrl: 'https://docs.example.com/start',
                fingerprint: { ...BEFORE, url: 'https://docs.example.com/start' },
              }),
            },
          ])
        : Promise.resolve([
            {
              result: {
                ...BEFORE,
                url: 'https://docs.example.com/start',
                textHash: 'after',
              },
            },
          ]),
    );
    await expect(
      executeBrowserAction(
        call({ action: 'search', url: 'https://docs.example.com/start?secret=1', query: 'AI' }),
        SNAPSHOT,
        '在 docs.example.com 搜索 AI',
        signal,
      ),
    ).resolves.toMatchObject({
      isError: false,
      sourceOrigin: 'https://docs.example.com',
      sourceUrl: 'https://docs.example.com/start',
    });
  });

  it('searches in a newly created known-site tab and uses origin fallback metadata without a title', async () => {
    tabsQuery.mockResolvedValue([]);
    tabsCreate.mockResolvedValue({ id: 13, windowId: 3, url: 'https://www.bing.com/' });
    tabsGet.mockResolvedValue({
      id: 13,
      windowId: 3,
      url: 'https://www.bing.com/',
      status: 'complete',
    });
    executeScript.mockImplementation((options: { args?: unknown[] }) =>
      options.args
        ? Promise.resolve([
            {
              result: searchResult({
                executionUrl: 'https://www.bing.com/',
                fingerprint: { ...BEFORE, url: 'https://www.bing.com/' },
              }),
            },
          ])
        : Promise.resolve([
            {
              result: { ...BEFORE, url: 'https://www.bing.com/', textHash: 'after' },
            },
          ]),
    );
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'bing', query: 'AI' }),
        SNAPSHOT,
        '在必应搜索 AI',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      isError: false,
      sourceUrl: expect.stringContaining('https://www.bing.com'),
      sourceTitle: '必应',
    });
  });

  it('maps missing tab IDs, closed tabs, browser failures, and cancellation', async () => {
    tabsQuery.mockResolvedValue([]);
    tabsCreate.mockResolvedValue({ windowId: 3, url: 'https://www.baidu.com/' });
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'AI' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'TAB_NOT_FOUND' });

    tabsCreate.mockResolvedValue({ id: 2, windowId: 3, url: 'https://www.baidu.com/' });
    tabsGet.mockRejectedValue(new Error('closed'));
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'AI' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'TAB_NOT_FOUND' });

    tabsQuery.mockRejectedValue(new Error('chrome unavailable'));
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'AI' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'INTERACTION_FAILED' });

    const controller = new AbortController();
    controller.abort();
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'AI' }),
        SNAPSHOT,
        '',
        controller.signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'cancelled' });
  });

  it('defers a known-site search until exact interaction permission is granted', async () => {
    permissionsContains.mockResolvedValue(false);
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'AI Agent' }),
        SNAPSHOT,
        '在百度搜索 AI Agent',
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      deferred: true,
      kind: 'page_permission',
      statusText: '等待网站操作权限',
      detail: expect.stringContaining('不会发送聊天'),
      permissionPattern: 'https://www.baidu.com/*',
      permissionKind: 'interact',
      sourceOrigin: 'https://www.baidu.com',
      sourceTitle: '百度',
    });
    expect(tabsQuery).not.toHaveBeenCalled();
  });

  it('supports a grounded direct-URL search and carries its exact origin into permission UI', async () => {
    permissionsContains.mockResolvedValue(false);
    await expect(
      executeBrowserAction(
        call({ action: 'search', url: 'https://search.example/path', query: 'AI' }),
        SNAPSHOT,
        '在 search.example 搜索 AI',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      deferred: true,
      permissionPattern: 'https://search.example/*',
      sourceOrigin: 'https://search.example',
      sourceTitle: 'search.example',
    });
  });

  it.each([
    ['bing', '必应'],
    ['google', 'Google'],
    ['boss', 'Boss直聘'],
  ] as const)('uses the built-in %s identity in permission UI', async (destination, title) => {
    permissionsContains.mockResolvedValue(false);
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination, query: 'AI' }),
        SNAPSHOT,
        `在${title}搜索 AI`,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ deferred: true, sourceTitle: title });
  });

  it('maps an invalid exact-origin target and a changed current tab before permission checks', async () => {
    const invalidOrigin = { ...SNAPSHOT, url: 'https://*/page', origin: 'https://*' };
    tabsGet.mockResolvedValue({
      id: 7,
      windowId: 3,
      url: invalidOrigin.url,
      status: 'complete',
    });
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'current', query: 'AI' }),
        invalidOrigin,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'INVALID_BROWSER_ACTION' });

    tabsGet.mockResolvedValue({ id: 7, windowId: 3, url: 'https://changed.example/' });
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'current', query: 'AI' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'TAB_NOT_FOUND' });
  });

  it('defers current-page interaction when both the permission API and activeTab probe fail', async () => {
    tabsGet.mockResolvedValue({
      id: 7,
      windowId: 3,
      url: SNAPSHOT.url,
      title: '',
      status: 'complete',
    });
    permissionsContains.mockRejectedValue(new Error('permission state unavailable'));
    executeScript.mockRejectedValue(new Error('cannot inject'));
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'current', query: 'AI' }),
        { ...SNAPSHOT, title: '' },
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      deferred: true,
      sourceTitle: SNAPSHOT.origin,
    });
  });

  it('uses activeTab access for the unchanged current page without persistent permission', async () => {
    permissionsContains.mockResolvedValue(false);
    tabsGet.mockResolvedValue({
      id: 7,
      windowId: 3,
      url: SNAPSHOT.url,
      title: SNAPSHOT.title,
      status: 'complete',
    });
    executeScript
      .mockResolvedValueOnce([{ result: true }])
      .mockResolvedValueOnce([
        {
          result: searchResult({
            executionUrl: SNAPSHOT.url,
            fingerprint: { ...BEFORE, url: SNAPSHOT.url },
          }),
        },
      ])
      .mockResolvedValueOnce([
        { result: { ...BEFORE, url: SNAPSHOT.url, title: 'Results', textHash: 'after' } },
      ]);

    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'current', query: 'Agent' }),
        SNAPSHOT,
        '在当前页搜索 Agent',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      isError: false,
      statusText: '已完成并验证页面搜索',
      sourceOrigin: SNAPSHOT.origin,
    });
    expect(permissionsContains).toHaveBeenCalledWith({ origins: ['https://current.example/*'] });
    expect(tabsUpdate).toHaveBeenCalledWith(7, { active: true });
  });

  it('completes a permitted search and verifies a same-page content update', async () => {
    const progress = vi.fn();
    const result = await executeBrowserAction(
      call({ action: 'search', destination: 'baidu', query: 'AI Agent' }),
      SNAPSHOT,
      '在百度搜索 AI Agent',
      new AbortController().signal,
      progress,
    );
    expect(result).toMatchObject({
      isError: false,
      statusText: '已完成并验证页面搜索',
      detail: expect.stringContaining('页面内容已更新'),
      sourceOrigin: 'https://www.baidu.com',
    });
    expect(progress).toHaveBeenLastCalledWith('已输入并提交搜索', expect.any(String));
    if ('content' in result) {
      expect(result.content).toContain('"query":"AI Agent"');
      expect(result.content).toContain('"verifiedBy":"页面内容已更新"');
    }
  });

  it('searches in a newly created target tab and tolerates failure to focus a bound window', async () => {
    tabsQuery.mockResolvedValue([]);
    tabsCreate.mockResolvedValue({
      id: 15,
      windowId: 3,
      url: 'https://www.baidu.com/',
      title: '百度',
      status: 'complete',
    });
    tabsGet.mockResolvedValue({
      id: 15,
      windowId: 3,
      url: 'https://www.baidu.com/',
      title: '百度',
      status: 'complete',
    });
    windowsUpdate.mockRejectedValue(new Error('focus denied'));
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'AI' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      isError: false,
      detail: expect.stringContaining('新建目标标签页'),
    });

    tabsGet.mockResolvedValue({
      id: 7,
      windowId: 3,
      url: SNAPSHOT.url,
      title: SNAPSHOT.title,
      status: 'complete',
    });
    executeScript.mockImplementation((options: { args?: unknown[] }) =>
      options.args
        ? Promise.resolve([
            {
              result: searchResult({
                executionUrl: SNAPSHOT.url,
                fingerprint: { ...BEFORE, url: SNAPSHOT.url },
              }),
            },
          ])
        : Promise.resolve([{ result: { ...BEFORE, url: SNAPSHOT.url, textHash: 'after' } }]),
    );
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'current', query: 'AI' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: false });
  });

  it('also accepts a verified URL navigation after form submission', async () => {
    tabsGet
      .mockResolvedValueOnce({
        id: 9,
        windowId: 3,
        url: 'https://www.baidu.com/',
        title: '百度',
        status: 'complete',
      })
      .mockResolvedValueOnce({
        id: 9,
        windowId: 3,
        url: 'https://www.baidu.com/',
        title: '百度',
        status: 'complete',
      })
      .mockResolvedValue({
        id: 9,
        windowId: 3,
        url: 'https://www.baidu.com/s?wd=AI',
        title: 'AI - 百度',
        status: 'complete',
      });

    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'AI' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      isError: false,
      detail: expect.stringContaining('页面地址已变化'),
      sourceUrl: 'https://www.baidu.com/s',
      nextPageSnapshot: {
        tabId: 9,
        url: 'https://www.baidu.com/s?wd=AI',
      },
    });
  });

  it('waits through autocomplete DOM changes until a delayed search navigation is stable', async () => {
    vi.useFakeTimers();
    const home = {
      id: 9,
      windowId: 3,
      url: 'https://www.baidu.com/',
      title: '百度',
      status: 'complete' as const,
    };
    const loadingResults = {
      ...home,
      url: 'https://www.baidu.com/s?wd=AI',
      title: 'AI - 百度',
      status: 'loading' as const,
    };
    const completeResults = { ...loadingResults, status: 'complete' as const };
    tabsGet
      .mockResolvedValueOnce(home)
      .mockResolvedValueOnce(home)
      .mockResolvedValueOnce(home)
      .mockResolvedValueOnce(home)
      .mockResolvedValueOnce(loadingResults)
      .mockResolvedValueOnce(completeResults)
      .mockResolvedValue(completeResults);
    executeScript.mockImplementation((options: { args?: unknown[] }) =>
      options.args
        ? Promise.resolve([{ result: searchResult() }])
        : Promise.resolve([
            {
              result: {
                ...BEFORE,
                textHash: 'autocomplete-only',
                textLength: 140,
              },
            },
          ]),
    );

    const pending = executeBrowserAction(
      call({ action: 'search', destination: 'baidu', query: 'AI' }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toMatchObject({
      isError: false,
      detail: expect.stringContaining('页面地址已变化'),
      sourceUrl: 'https://www.baidu.com/s',
      nextPageSnapshot: {
        tabId: 9,
        url: 'https://www.baidu.com/s?wd=AI',
      },
    });
  });

  it('stops if the tab changes origin before injection or the result reports another origin', async () => {
    tabsGet.mockResolvedValue({
      id: 9,
      windowId: 3,
      url: 'https://other.example/',
      title: 'Other',
      status: 'complete',
    });
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'AI' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'TAB_NOT_FOUND' });
    expect(executeScript).not.toHaveBeenCalled();

    tabsGet.mockResolvedValue({
      id: 9,
      windowId: 3,
      url: 'https://www.baidu.com/',
      title: '百度',
      status: 'complete',
    });
    executeScript.mockResolvedValueOnce([
      { result: searchResult({ executionUrl: 'https://other.example/' }) },
    ]);
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'AI' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'INTERACTION_FAILED' });

    executeScript.mockResolvedValueOnce([{ result: searchResult({ executionUrl: 'not a url' }) }]);
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'AI' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'INTERACTION_FAILED' });
  });

  it.each([
    [undefined, 'INTERACTION_FAILED'],
    [{ ...searchResult(), executionUrl: 123 }, 'INTERACTION_FAILED'],
    [{ ...searchResult(), candidates: [{}] }, 'INTERACTION_FAILED'],
    [{ ...searchResult(), submissionMethod: 'double-click' }, 'INTERACTION_FAILED'],
    [{ ...searchResult(), fingerprint: { ...BEFORE, textLength: -1 } }, 'INTERACTION_FAILED'],
    [
      searchResult({
        ok: false,
        control: undefined,
        ambiguous: true,
        typed: false,
        submitted: false,
        submissionMethod: undefined,
        candidates: [
          {
            tag: 'input',
            role: 'searchbox',
            label: '职位',
            placeholder: '',
            type: 'search',
            score: 200,
          },
          {
            tag: 'input',
            role: 'searchbox',
            label: '公司',
            placeholder: '',
            type: 'search',
            score: 199,
          },
        ],
      }),
      'AMBIGUOUS_SEARCH_CONTROL',
    ],
    [
      searchResult({
        ok: false,
        control: undefined,
        error: 'NO_SEARCH_CONTROL',
        typed: false,
        submitted: false,
        submissionMethod: undefined,
      }),
      'NO_SEARCH_CONTROL',
    ],
    [
      searchResult({
        ok: false,
        control: undefined,
        error: 'INTERACTION_FAILED',
        typed: false,
        submitted: false,
        submissionMethod: undefined,
      }),
      'INTERACTION_FAILED',
    ],
  ])('maps an untrusted page result %# to a stable failure', async (value, errorCode) => {
    if (errorCode === 'NO_SEARCH_CONTROL') {
      vi.useFakeTimers();
      executeScript.mockResolvedValue([{ result: value }]);
    } else {
      executeScript.mockResolvedValueOnce([{ result: value }]);
    }
    const pending = executeBrowserAction(
      call({ action: 'search', destination: 'baidu', query: 'AI' }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    if (errorCode === 'NO_SEARCH_CONTROL') await vi.advanceTimersByTimeAsync(2_600);
    await expect(pending).resolves.toMatchObject({ errorCode });
  });

  it('briefly retries while a dynamic page is still rendering its search control', async () => {
    vi.useFakeTimers();
    const progress = vi.fn();
    const missing = searchResult({
      ok: false,
      control: undefined,
      error: 'NO_SEARCH_CONTROL',
      typed: false,
      submitted: false,
      submissionMethod: undefined,
    });
    executeScript
      .mockResolvedValueOnce([{ result: missing }])
      .mockResolvedValueOnce([{ result: searchResult() }])
      .mockResolvedValueOnce([{ result: { ...BEFORE, textHash: 'after' } }]);

    const pending = executeBrowserAction(
      call({ action: 'search', destination: 'baidu', query: 'AI' }),
      SNAPSHOT,
      '',
      new AbortController().signal,
      progress,
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(pending).resolves.toMatchObject({ isError: false });
    expect(progress).toHaveBeenCalledWith('正在等待搜索框出现', expect.any(String));
  });

  it.each([
    ['button', '点击搜索按钮'],
    ['keypress', '发送 Enter'],
  ] as const)('renders the %s submission method in verified progress', async (method, label) => {
    executeScript.mockImplementation((options: { args?: unknown[] }) =>
      options.args
        ? Promise.resolve([{ result: searchResult({ submissionMethod: method }) }])
        : Promise.resolve([{ result: { ...BEFORE, textHash: 'after' } }]),
    );
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'AI' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: false, detail: expect.stringContaining(label) });
  });

  it('handles script execution failures and non-Error browser failures', async () => {
    executeScript.mockRejectedValue(new Error('script context lost'));
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'AI' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'INTERACTION_FAILED' });

    tabsQuery.mockRejectedValue('browser unavailable');
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'AI' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'INTERACTION_FAILED' });
  });

  it('can verify a response even when the pre-action fingerprint URL is malformed', async () => {
    executeScript.mockResolvedValueOnce([
      { result: searchResult({ fingerprint: { ...BEFORE, url: 'not a url' } }) },
    ]);
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'AI' }),
        SNAPSHOT,
        '',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: false, detail: expect.stringContaining('页面地址已变化') });
  });

  it('fails verification when submission produces no observable change', async () => {
    vi.useFakeTimers();
    executeScript.mockImplementation((options: { args?: unknown[] }) =>
      options.args
        ? Promise.resolve([{ result: searchResult() }])
        : Promise.resolve([{ result: BEFORE }]),
    );
    const pending = executeBrowserAction(
      call({ action: 'search', destination: 'baidu', query: 'AI' }),
      SNAPSHOT,
      '',
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(6_250);
    await expect(pending).resolves.toMatchObject({ errorCode: 'VERIFICATION_FAILED' });
  });

  it('returns cancellation if the user stops during verification', async () => {
    vi.useFakeTimers();
    executeScript.mockImplementation((options: { args?: unknown[] }) =>
      options.args
        ? Promise.resolve([{ result: searchResult() }])
        : Promise.resolve([{ result: BEFORE }]),
    );
    const controller = new AbortController();
    const pending = executeBrowserAction(
      call({ action: 'search', destination: 'baidu', query: 'AI' }),
      SNAPSHOT,
      '',
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(250);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ errorCode: 'cancelled' });
  });

  it('cancels when the signal flips immediately before a verification delay', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    executeScript.mockResolvedValueOnce([{ result: searchResult() }]).mockImplementation(() => {
      controller.abort();
      return Promise.resolve([{ result: BEFORE }]);
    });
    await expect(
      executeBrowserAction(
        call({ action: 'search', destination: 'baidu', query: 'AI' }),
        SNAPSHOT,
        '',
        controller.signal,
      ),
    ).resolves.toMatchObject({ errorCode: 'cancelled' });
  });
});
