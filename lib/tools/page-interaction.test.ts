import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PageInteractionObservationResult,
  PageInteractiveElementCandidate,
  PageTurnSnapshot,
} from '@/lib/domain/types';
import type { GenerationToolCall } from '@/lib/generation/types';
import {
  captureInteractivePage,
  INTERACT_PAGE_TOOL,
  OBSERVE_PAGE_TOOL,
  PageInteractionCoordinator,
  performPageInteraction,
} from './page-interaction';

const PAGE_URL = 'https://www.zhipin.com/interaction-test';
const SNAPSHOT: PageTurnSnapshot = {
  tabId: 7,
  windowId: 3,
  url: PAGE_URL,
  safeUrl: PAGE_URL,
  origin: 'https://www.zhipin.com',
  title: '交互测试',
  scheme: 'https',
  isHttp: true,
  isBoss: true,
  capturedAt: 1,
};

const tabsGet = vi.fn();
const tabsGoBack = vi.fn();
const tabsGoForward = vi.fn();
const permissionsContains = vi.fn();
const executeScript = vi.fn();
const storageGet = vi.fn();
const storageSet = vi.fn();
const storageRemove = vi.fn();
let sessionValue: unknown;

function call(
  name: 'observe_page' | 'interact_page',
  argumentsValue: Record<string, unknown>,
): GenerationToolCall {
  return { id: 'call-1', name, arguments: argumentsValue };
}

function setPage(body: string): void {
  document.title = '交互测试';
  document.body.innerHTML = body;
}

function observe(limit = 50, query = ''): PageInteractionObservationResult {
  return captureInteractivePage(limit, query);
}

function locatorByName(name: string): PageInteractiveElementCandidate {
  const element = observe().elements.find((candidate) => candidate.name === name);
  if (!element) throw new Error(`Missing locator: ${name}`);
  return element;
}

beforeEach(() => {
  sessionValue = undefined;
  history.replaceState({}, '', PAGE_URL);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 10,
    y: 10,
    top: 10,
    left: 10,
    right: 210,
    bottom: 50,
    width: 200,
    height: 40,
    toJSON: () => ({}),
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(window, 'scrollBy', { configurable: true, value: vi.fn() });

  tabsGet.mockReset().mockResolvedValue({
    id: 7,
    windowId: 3,
    url: PAGE_URL,
    title: '交互测试',
    status: 'complete',
  });
  tabsGoBack.mockReset().mockResolvedValue(undefined);
  tabsGoForward.mockReset().mockResolvedValue(undefined);
  permissionsContains.mockReset().mockResolvedValue(true);
  executeScript
    .mockReset()
    .mockImplementation(
      async (options: { func: (...args: unknown[]) => unknown; args?: unknown[] }) => [
        {
          documentId: 'document-1',
          frameId: 0,
          result: options.func(...(options.args ?? [])),
        },
      ],
    );
  storageGet.mockReset().mockImplementation(async () => ({
    bosspilot_page_observation_v1: sessionValue,
  }));
  storageSet.mockReset().mockImplementation(async (value: Record<string, unknown>) => {
    sessionValue = value.bosspilot_page_observation_v1;
  });
  storageRemove.mockReset().mockImplementation(async () => {
    sessionValue = undefined;
  });
  vi.stubGlobal('chrome', {
    tabs: { get: tabsGet, goBack: tabsGoBack, goForward: tabsGoForward },
    permissions: { contains: permissionsContains },
    scripting: { executeScript },
    storage: {
      session: { get: storageGet, set: storageSet, remove: storageRemove },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('page interaction tool contracts', () => {
  it('exposes separate observation and constrained action tools', () => {
    expect(OBSERVE_PAGE_TOOL).toMatchObject({
      name: 'observe_page',
      parameters: { additionalProperties: false },
    });
    expect(INTERACT_PAGE_TOOL).toMatchObject({
      name: 'interact_page',
      parameters: { required: ['action'], additionalProperties: false },
    });
    expect(INTERACT_PAGE_TOOL.description).toContain('密码和文件输入始终禁止');
  });
});

describe('captureInteractivePage', () => {
  it('returns visible semantic controls without exposing text-field values or URL paths', () => {
    setPage(`
      <a href="https://example.com/private?q=secret">查看详情</a>
      <button aria-label="打开菜单">☰</button>
      <label for="name">姓名</label><input id="name" value="张三" />
      <label for="password">密码</label><input id="password" type="password" value="secret" />
      <label for="city">城市</label><select id="city"><option selected>北京</option></select>
      <label><input type="checkbox" checked />接受条款</label>
      <div role="switch" aria-label="夜间模式" aria-checked="false" tabindex="0"></div>
    `);

    const result = observe();

    expect(result.version).toBe(1);
    expect(result.elements.map(({ name }) => name)).toEqual([
      '查看详情',
      '打开菜单',
      '姓名',
      '密码',
      '城市',
      '接受条款',
      '夜间模式',
    ]);
    expect(result.elements[0]).toMatchObject({
      role: 'link',
      destinationOrigin: 'https://example.com',
    });
    expect(result.elements.find(({ name }) => name === '姓名')).toMatchObject({ hasValue: true });
    expect(result.elements.find(({ name }) => name === '密码')).toMatchObject({
      risk: 'blocked',
      type: 'password',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.elements.find(({ name }) => name === '城市')).toMatchObject({
      selectedText: '北京',
    });
    expect(result.elements.find(({ name }) => name === '接受条款')).toMatchObject({
      checked: true,
    });
  });

  it('filters hidden and off-screen controls, supports query, and reports truncation', () => {
    setPage(`
      <button>保留一</button><button>保留二</button><button>保留三</button>
      <button style="display:none">隐藏</button>
      <div style="opacity:0"><button>祖先隐藏</button></div>
      <button id="offscreen">屏外</button>
    `);
    const offscreen = document.querySelector('#offscreen');
    Object.defineProperty(offscreen, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 10,
        y: 900,
        top: 900,
        left: 10,
        right: 110,
        bottom: 940,
        width: 100,
        height: 40,
        toJSON: () => ({}),
      }),
    });

    expect(observe(2)).toMatchObject({
      truncated: true,
      elements: [{ name: '保留一' }, { name: '保留二' }],
    });
    expect(observe(50, '保留三').elements).toEqual([
      expect.objectContaining({ name: '保留三', role: 'button' }),
    ]);
  });

  it('recognizes contenteditable, tabindex, onclick and search-form submit as safe', () => {
    setPage(`
      <div contenteditable="true" aria-label="备注"></div>
      <div tabindex="0" aria-label="自定义焦点"></div>
      <div onclick="void 0" aria-label="旧式点击"></div>
      <form role="search"><button type="submit">搜索</button></form>
      <form><button type="submit">提交资料</button></form>
      <input type="file" aria-label="上传文件" />
    `);
    const elements = observe().elements;

    expect(elements.find(({ name }) => name === '备注')).toMatchObject({ role: 'textbox' });
    expect(elements.find(({ name }) => name === '自定义焦点')).toBeDefined();
    expect(elements.find(({ name }) => name === '旧式点击')).toBeDefined();
    expect(elements.find(({ name }) => name === '搜索')).toMatchObject({ risk: 'safe' });
    expect(elements.find(({ name }) => name === '提交资料')).toMatchObject({ risk: 'confirm' });
    expect(elements.find(({ name }) => name === '上传文件')).toMatchObject({ risk: 'blocked' });
  });

  it('uses accessible-name fallbacks and recognizes native control roles', () => {
    setPage(`
      <span id="first">组合</span><span id="second">标签</span>
      <input aria-labelledby="first second missing" />
      <textarea title="补充说明"></textarea>
      <summary aria-label="展开摘要"></summary>
      <input type="button" value="输入按钮" />
      <input type="radio" name="channel" />
      <input type="range" aria-label="音量" />
      <input type="search" placeholder="搜索关键词" />
      <a>没有地址</a>
      <a href="http://[" aria-label="异常链接"></a>
      <button aria-disabled="true">不可用操作</button>
    `);

    const elements = observe().elements;

    expect(elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '组合 标签', role: 'textbox' }),
        expect.objectContaining({ name: '补充说明', role: 'textbox' }),
        expect.objectContaining({ name: '展开摘要', role: 'button' }),
        expect.objectContaining({ name: '输入按钮', role: 'button' }),
        expect.objectContaining({ name: 'channel', role: 'radio' }),
        expect.objectContaining({ name: '音量', role: 'slider' }),
        expect.objectContaining({ name: '搜索关键词', role: 'searchbox' }),
        expect.objectContaining({ name: '异常链接', role: 'link' }),
        expect.objectContaining({ name: '不可用操作', disabled: true }),
      ]),
    );
    expect(elements.some(({ tag, name }) => tag === 'a' && name === '没有地址')).toBe(false);
    expect(elements.find(({ name }) => name === '异常链接')?.destinationOrigin).toBeUndefined();
  });

  it('rejects pointer-disabled, ancestor-hidden and undersized controls', () => {
    setPage(`
      <button style="pointer-events:none">无指针</button>
      <div style="visibility:hidden"><button>祖先不可见</button></div>
      <button id="tiny">太小</button>
      <div role="menuitem" aria-label="菜单项"></div>
    `);
    const tiny = document.querySelector('#tiny');
    Object.defineProperty(tiny, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 10,
        y: 10,
        top: 10,
        left: 10,
        right: 12,
        bottom: 12,
        width: 2,
        height: 2,
        toJSON: () => ({}),
      }),
    });

    expect(observe().elements).toEqual([expect.objectContaining({ name: '菜单项' })]);
  });

  it('bounds observation defaults and clips unusually long accessible names', () => {
    setPage(`<button>${'超长按钮'.repeat(60)}</button>`);

    const result = captureInteractivePage(0, '');

    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]?.name).toHaveLength(160);
  });
});

describe('performPageInteraction', () => {
  it('clicks, fills, selects and checks only the observed element identity', () => {
    setPage(`
      <button id="open">打开详情</button>
      <label for="name">姓名</label><input id="name" />
      <label for="city">城市</label><select id="city"><option value="bj">北京</option><option value="sh">上海</option></select>
      <label><input id="terms" type="checkbox" />接受条款</label>
    `);
    const clicked = vi.fn();
    document.querySelector('#open')?.addEventListener('click', clicked);

    expect(
      performPageInteraction({
        action: 'click',
        locator: locatorByName('打开详情'),
        approved: false,
      }),
    ).toMatchObject({ ok: true, risk: 'safe' });
    expect(clicked).toHaveBeenCalledOnce();

    expect(
      performPageInteraction({
        action: 'fill',
        locator: locatorByName('姓名'),
        value: '李四',
        approved: false,
      }),
    ).toMatchObject({ ok: true });
    expect(document.querySelector<HTMLInputElement>('#name')?.value).toBe('李四');

    expect(
      performPageInteraction({
        action: 'select',
        locator: locatorByName('城市'),
        value: '上海',
        approved: false,
      }),
    ).toMatchObject({ ok: true, detail: expect.stringContaining('上海') });
    expect(document.querySelector<HTMLSelectElement>('#city')?.value).toBe('sh');

    expect(
      performPageInteraction({
        action: 'check',
        locator: locatorByName('接受条款'),
        checked: true,
        approved: false,
      }),
    ).toMatchObject({ ok: true });
    expect(document.querySelector<HTMLInputElement>('#terms')?.checked).toBe(true);
  });

  it('requires confirmation for external-impact buttons and executes only after approval', () => {
    setPage('<form><button type="submit">提交申请</button></form>');
    const locator = locatorByName('提交申请');
    const submit = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('form')?.addEventListener('submit', submit);

    expect(performPageInteraction({ action: 'click', locator, approved: false })).toMatchObject({
      ok: false,
      risk: 'confirm',
    });
    expect(submit).not.toHaveBeenCalled();
    expect(performPageInteraction({ action: 'click', locator, approved: true })).toMatchObject({
      ok: true,
      risk: 'confirm',
    });
    expect(submit).toHaveBeenCalledOnce();
  });

  it('blocks password/file controls and rejects stale, disabled or unsupported targets', () => {
    setPage(`
      <label for="password">密码</label><input id="password" type="password" />
      <label for="file">文件</label><input id="file" type="file" />
      <button disabled>禁用按钮</button>
      <button>会改名</button>
      <div role="button" aria-label="透明按钮" style="opacity:0"></div>
    `);

    for (const name of ['密码', '文件']) {
      expect(
        performPageInteraction({
          action: 'fill',
          locator: locatorByName(name),
          value: 'secret',
          approved: true,
        }),
      ).toMatchObject({ ok: false, error: 'SENSITIVE_INPUT_BLOCKED' });
    }
    expect(
      performPageInteraction({
        action: 'click',
        locator: locatorByName('禁用按钮'),
        approved: true,
      }),
    ).toMatchObject({ error: 'ELEMENT_NOT_INTERACTABLE' });

    const stale = locatorByName('会改名');
    const renamed = document.querySelector('button:not([disabled])');
    if (renamed) renamed.textContent = '新名字';
    expect(
      performPageInteraction({ action: 'click', locator: stale, approved: true }),
    ).toMatchObject({
      error: 'STALE_ELEMENT_REFERENCE',
    });
    expect(
      performPageInteraction({ action: 'click', locator: undefined, approved: true }),
    ).toMatchObject({ error: 'OBSERVATION_REQUIRED' });
  });

  it('handles contenteditable, custom checkbox, scroll and invalid select/check targets', () => {
    setPage(`
      <div contenteditable="true" aria-label="备注"></div>
      <div role="checkbox" aria-label="自定义勾选" aria-checked="false" tabindex="0"></div>
      <button>普通按钮</button>
      <select aria-label="城市"><option disabled>禁用项</option></select>
    `);
    const custom = document.querySelector('[role="checkbox"]');
    custom?.addEventListener('click', () => custom.setAttribute('aria-checked', 'true'));

    expect(
      performPageInteraction({
        action: 'fill',
        locator: locatorByName('备注'),
        value: '新的备注',
        approved: false,
      }),
    ).toMatchObject({ ok: true });
    expect(document.querySelector('[contenteditable]')?.textContent).toBe('新的备注');
    expect(
      performPageInteraction({
        action: 'check',
        locator: locatorByName('自定义勾选'),
        checked: true,
        approved: false,
      }),
    ).toMatchObject({ ok: true });
    expect(custom?.getAttribute('aria-checked')).toBe('true');
    expect(
      performPageInteraction({
        action: 'select',
        locator: locatorByName('城市'),
        value: '不存在',
        approved: false,
      }),
    ).toMatchObject({ error: 'ELEMENT_NOT_FOUND' });
    expect(
      performPageInteraction({
        action: 'check',
        locator: locatorByName('普通按钮'),
        checked: true,
        approved: false,
      }),
    ).toMatchObject({ error: 'ELEMENT_NOT_INTERACTABLE' });
    expect(
      performPageInteraction({ action: 'scroll', deltaY: 9_999, approved: true }),
    ).toMatchObject({
      ok: true,
      detail: expect.stringContaining('1500'),
    });
    expect(window.scrollBy).toHaveBeenCalled();
  });

  it('rejects changed paths, hidden targets and mismatched action kinds', () => {
    setPage(`
      <button id="plain"></button>
      <textarea aria-label="说明"></textarea>
      <div id="select-wrap"><select aria-label="城市"><option value="disabled" disabled>禁用项</option></select></div>
      <label><input type="radio" checked />单选</label>
    `);
    const plain = locatorByName('');
    expect(
      performPageInteraction({ action: 'click', locator: plain, approved: false }),
    ).toMatchObject({ ok: true, detail: expect.stringContaining('目标控件') });

    const textarea = locatorByName('说明');
    expect(
      performPageInteraction({
        action: 'fill',
        locator: textarea,
        value: 'a'.repeat(2_100),
        approved: false,
      }),
    ).toMatchObject({ ok: true });
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toHaveLength(2_000);
    expect(
      performPageInteraction({ action: 'select', locator: textarea, value: 'x', approved: false }),
    ).toMatchObject({ error: 'ELEMENT_NOT_INTERACTABLE' });
    expect(
      performPageInteraction({
        action: 'select',
        locator: locatorByName('城市'),
        value: 'disabled',
        approved: false,
      }),
    ).toMatchObject({ error: 'ELEMENT_NOT_FOUND' });
    expect(
      performPageInteraction({
        action: 'check',
        locator: locatorByName('单选'),
        checked: true,
        approved: false,
      }),
    ).toMatchObject({ ok: true, detail: expect.stringContaining('选中') });

    const stalePath = { ...textarea, path: [...textarea.path, 99] };
    expect(
      performPageInteraction({ action: 'fill', locator: stalePath, value: 'x', approved: false }),
    ).toMatchObject({ error: 'STALE_ELEMENT_REFERENCE' });

    const hidden = locatorByName('城市');
    const select = document.querySelector('select');
    if (select) select.style.pointerEvents = 'none';
    expect(
      performPageInteraction({
        action: 'select',
        locator: hidden,
        value: 'disabled',
        approved: false,
      }),
    ).toMatchObject({ error: 'ELEMENT_NOT_INTERACTABLE' });

    if (select) select.style.pointerEvents = '';
    const wrapper = document.querySelector<HTMLElement>('#select-wrap');
    if (wrapper) wrapper.style.visibility = 'hidden';
    expect(
      performPageInteraction({
        action: 'select',
        locator: hidden,
        value: 'disabled',
        approved: false,
      }),
    ).toMatchObject({ error: 'ELEMENT_NOT_INTERACTABLE' });

    expect(
      performPageInteraction({
        action: 'click',
        locator: plain,
        approved: false,
        expectedUrl: 'https://example.com/other',
      }),
    ).toMatchObject({ error: 'STALE_ELEMENT_REFERENCE' });

    expect(
      performPageInteraction({ action: 'wait' as never, locator: plain, approved: false }),
    ).toMatchObject({ error: 'INVALID_PAGE_INTERACTION' });
  });

  it('uses safe defaults for scrolling and can act on observed links and search fields', () => {
    setPage(`
      <a href="https://example.com" aria-label="示例链接"></a>
      <input type="search" placeholder="站内搜索" />
    `);
    const link = locatorByName('示例链接');
    const search = locatorByName('站内搜索');
    document.querySelector('a')?.addEventListener('click', (event) => event.preventDefault());

    expect(
      performPageInteraction({ action: 'click', locator: link, approved: false }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      performPageInteraction({ action: 'fill', locator: search, value: 'Agent', approved: false }),
    ).toMatchObject({ ok: true });
    expect(performPageInteraction({ action: 'scroll', approved: true })).toMatchObject({
      ok: true,
      detail: expect.stringContaining('600'),
    });
  });
});

describe('PageInteractionCoordinator', () => {
  it('observes, stores private locators, and exposes only temporary refs to the model', async () => {
    setPage('<button>打开详情</button><label for="q">关键词</label><input id="q" />');
    const coordinator = new PageInteractionCoordinator();

    const outcome = await coordinator.observe(
      call('observe_page', {}),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );

    expect(outcome).toMatchObject({
      isError: false,
      statusText: '已观察当前页面控件',
      nextPageSnapshot: { tabId: 7, url: PAGE_URL },
    });
    if (!('deferred' in outcome)) {
      expect(outcome.content).toContain('"observationId":"obs-');
      expect(outcome.content).toContain('"ref":"e1"');
      expect(outcome.content).not.toContain('"path"');
    }
    expect(sessionValue).toMatchObject({
      requestId: 'request-1',
      elements: expect.arrayContaining([
        expect.objectContaining({ ref: 'e1', path: expect.any(Array) }),
      ]),
    });
  });

  it('defers observation for exact-origin permission and maps malformed page results', async () => {
    setPage('<button>按钮</button>');
    const coordinator = new PageInteractionCoordinator();
    permissionsContains.mockResolvedValue(false);
    executeScript.mockRejectedValue(new Error('Cannot access contents of the page'));

    await expect(
      coordinator.observe(
        call('observe_page', {}),
        SNAPSHOT,
        new AbortController().signal,
        'request-1',
      ),
    ).resolves.toMatchObject({
      deferred: true,
      kind: 'page_permission',
      permissionKind: 'interact',
      permissionPattern: 'https://www.zhipin.com/*',
    });

    permissionsContains.mockResolvedValue(true);
    executeScript.mockResolvedValue([{ result: { version: 2 } }]);
    await expect(
      coordinator.observe(
        call('observe_page', {}),
        SNAPSHOT,
        new AbortController().signal,
        'request-1',
      ),
    ).resolves.toMatchObject({ errorCode: 'STALE_ELEMENT_REFERENCE' });
  });

  it('rejects unsupported pages, changed tabs, invalid requests and stale refs', async () => {
    const coordinator = new PageInteractionCoordinator();
    await expect(
      coordinator.observe(
        call('observe_page', {}),
        null,
        new AbortController().signal,
        'request-1',
      ),
    ).resolves.toMatchObject({ errorCode: 'OBSERVATION_REQUIRED' });
    tabsGet.mockResolvedValue({
      id: 7,
      windowId: 3,
      url: `${PAGE_URL}/changed`,
      status: 'complete',
    });
    await expect(
      coordinator.observe(
        call('observe_page', {}),
        SNAPSHOT,
        new AbortController().signal,
        'request-1',
      ),
    ).resolves.toMatchObject({ errorCode: 'STALE_ELEMENT_REFERENCE' });

    tabsGet.mockResolvedValue({ id: 7, windowId: 3, url: PAGE_URL, status: 'complete' });
    await expect(
      coordinator.interact(
        call('interact_page', { action: 'unknown' }),
        SNAPSHOT,
        new AbortController().signal,
        'request-1',
      ),
    ).resolves.toMatchObject({ errorCode: 'INVALID_PAGE_INTERACTION' });
    await expect(
      coordinator.interact(
        call('interact_page', { action: 'click' }),
        SNAPSHOT,
        new AbortController().signal,
        'request-1',
      ),
    ).resolves.toMatchObject({ errorCode: 'OBSERVATION_REQUIRED' });
    await expect(
      coordinator.interact(
        call('interact_page', { action: 'click', observationId: 'old', ref: 'e1' }),
        SNAPSHOT,
        new AbortController().signal,
        'request-1',
      ),
    ).resolves.toMatchObject({ errorCode: 'STALE_ELEMENT_REFERENCE' });
  });

  it('preserves another request observation and expires malformed or old observations', async () => {
    setPage('<button>按钮</button>');
    const coordinator = new PageInteractionCoordinator();
    const observed = await coordinator.observe(
      call('observe_page', {}),
      SNAPSHOT,
      new AbortController().signal,
      'request-current',
    );
    if ('deferred' in observed || observed.isError) throw new Error('Observation failed');

    await expect(
      coordinator.interact(
        call('interact_page', { action: 'click', observationId: 'other', ref: 'e1' }),
        SNAPSHOT,
        new AbortController().signal,
        'request-other',
      ),
    ).resolves.toMatchObject({ errorCode: 'STALE_ELEMENT_REFERENCE' });
    expect(sessionValue).toMatchObject({ requestId: 'request-current' });

    sessionValue = { ...(sessionValue as Record<string, unknown>), expiresAt: 0 };
    await expect(
      coordinator.interact(
        call('interact_page', { action: 'click', observationId: 'old', ref: 'e1' }),
        SNAPSHOT,
        new AbortController().signal,
        'request-current',
      ),
    ).resolves.toMatchObject({ errorCode: 'STALE_ELEMENT_REFERENCE' });
    expect(sessionValue).toBeUndefined();

    sessionValue = { version: 1, requestId: 'request-current' };
    await expect(
      coordinator.interact(
        call('interact_page', { action: 'click', observationId: 'bad', ref: 'e1' }),
        SNAPSHOT,
        new AbortController().signal,
        'request-current',
      ),
    ).resolves.toMatchObject({ errorCode: 'STALE_ELEMENT_REFERENCE' });
    expect(sessionValue).toBeUndefined();
  });

  it('maps cancellation and browser execution failures to safe public errors', async () => {
    const coordinator = new PageInteractionCoordinator();
    const aborted = new AbortController();
    aborted.abort('stop');
    await expect(
      coordinator.interact(
        call('interact_page', { action: 'scroll' }),
        SNAPSHOT,
        aborted.signal,
        'request-1',
      ),
    ).resolves.toMatchObject({ errorCode: 'cancelled' });

    for (const [error, detail] of [
      [new Error('No tab with id 7'), '目标标签页已经关闭'],
      [new Error('Permission not allowed'), '当前没有目标页面的操作权限'],
      ['unexpected failure', '浏览器没有完成页面交互'],
    ] as const) {
      executeScript.mockRejectedValueOnce(error);
      await expect(
        coordinator.interact(
          call('interact_page', { action: 'scroll' }),
          SNAPSHOT,
          new AbortController().signal,
          'request-1',
        ),
      ).resolves.toMatchObject({
        errorCode: 'INTERACTION_FAILED',
        detail: expect.stringContaining(detail),
      });
    }
  });

  it('rejects changed observations, missing refs and malformed action-script results', async () => {
    setPage('<button>按钮</button>');
    const coordinator = new PageInteractionCoordinator();
    const observed = await coordinator.observe(
      call('observe_page', {}),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    if ('deferred' in observed || observed.isError) throw new Error('Observation failed');
    const observationId = /"observationId":"([^"]+)/u.exec(observed.content)?.[1];
    const changedUrl = `${PAGE_URL}?changed=1`;

    await expect(
      coordinator.interact(
        call('interact_page', { action: 'click', observationId, ref: 'e1' }),
        { ...SNAPSHOT, url: changedUrl, safeUrl: changedUrl },
        new AbortController().signal,
        'request-1',
      ),
    ).resolves.toMatchObject({ errorCode: 'STALE_ELEMENT_REFERENCE' });

    await coordinator.observe(
      call('observe_page', {}),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    const latestId = (sessionValue as { observationId?: string })?.observationId;
    await expect(
      coordinator.interact(
        call('interact_page', { action: 'click', observationId: latestId, ref: 'e99' }),
        SNAPSHOT,
        new AbortController().signal,
        'request-1',
      ),
    ).resolves.toMatchObject({ errorCode: 'STALE_ELEMENT_REFERENCE' });

    executeScript.mockResolvedValueOnce([{ result: { version: 1 } }]);
    await expect(
      coordinator.interact(
        call('interact_page', { action: 'scroll' }),
        SNAPSHOT,
        new AbortController().signal,
        'request-1',
      ),
    ).resolves.toMatchObject({ errorCode: 'INTERACTION_FAILED' });

    executeScript.mockResolvedValueOnce([
      {
        result: {
          version: 1,
          ok: false,
          executionUrl: PAGE_URL,
          action: 'scroll',
          risk: 'safe',
          detail: '找不到目标',
          error: 'ELEMENT_NOT_FOUND',
        },
      },
    ]);
    await expect(
      coordinator.interact(
        call('interact_page', { action: 'scroll' }),
        SNAPSHOT,
        new AbortController().signal,
        'request-1',
      ),
    ).resolves.toMatchObject({ errorCode: 'ELEMENT_NOT_FOUND' });
  });

  it('revalidates the tab immediately before using an observed ref', async () => {
    setPage('<button id="open">打开</button>');
    const clicked = vi.fn();
    document.querySelector('#open')?.addEventListener('click', clicked);
    const coordinator = new PageInteractionCoordinator();
    const observed = await coordinator.observe(
      call('observe_page', {}),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    if ('deferred' in observed || observed.isError) throw new Error('Observation failed');
    const observationId = /"observationId":"([^"]+)/u.exec(observed.content)?.[1];
    tabsGet.mockResolvedValue({
      id: 7,
      windowId: 3,
      url: 'https://www.zhipin.com/replaced',
      title: '新页面',
      status: 'complete',
    });

    await expect(
      coordinator.interact(
        call('interact_page', { action: 'click', observationId, ref: 'e1' }),
        SNAPSHOT,
        new AbortController().signal,
        'request-1',
      ),
    ).resolves.toMatchObject({ errorCode: 'STALE_ELEMENT_REFERENCE' });
    expect(clicked).not.toHaveBeenCalled();
    expect(sessionValue).toBeUndefined();
  });

  it('binds element refs to the exact observed document across same-URL reloads', async () => {
    setPage('<button id="open">打开</button>');
    const clicked = vi.fn();
    document.querySelector('#open')?.addEventListener('click', clicked);
    const coordinator = new PageInteractionCoordinator();
    const observed = await coordinator.observe(
      call('observe_page', {}),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    if ('deferred' in observed || observed.isError) throw new Error('Observation failed');
    const observationId = /"observationId":"([^"]+)/u.exec(observed.content)?.[1];
    executeScript.mockResolvedValueOnce([]);

    await expect(
      coordinator.interact(
        call('interact_page', { action: 'click', observationId, ref: 'e1' }),
        SNAPSHOT,
        new AbortController().signal,
        'request-1',
      ),
    ).resolves.toMatchObject({ errorCode: 'STALE_ELEMENT_REFERENCE' });
    expect(clicked).not.toHaveBeenCalled();
  });

  it('executes a safe ref, invalidates it, and returns a fresh observation', async () => {
    vi.useFakeTimers();
    setPage('<button id="open">打开详情</button><output id="result">未打开</output>');
    document.querySelector('#open')?.addEventListener('click', () => {
      const output = document.querySelector('#result');
      if (output) output.textContent = '已打开';
    });
    const coordinator = new PageInteractionCoordinator();
    const observed = await coordinator.observe(
      call('observe_page', {}),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    if ('deferred' in observed || observed.isError) throw new Error('Observation failed');
    const observationId = /"observationId":"([^"]+)/u.exec(observed.content)?.[1];

    const pending = coordinator.interact(
      call('interact_page', { action: 'click', observationId, ref: 'e1' }),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await pending;

    expect(document.querySelector('#result')?.textContent).toBe('已打开');
    expect(outcome).toMatchObject({ isError: false, statusText: '点击页面控件并更新了页面观察' });
    if (!('deferred' in outcome)) {
      expect(outcome.content).toContain('previousReferencesInvalidated');
      expect(outcome.content).toContain('"observationId":"obs-');
    }
  });

  it('defers risky clicks and executes the exact original ref after one-time approval', async () => {
    vi.useFakeTimers();
    setPage('<form><button type="submit">提交申请</button></form><output>未提交</output>');
    const form = document.querySelector('form');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const output = document.querySelector('output');
      if (output) output.textContent = '已提交';
    });
    const coordinator = new PageInteractionCoordinator();
    const observed = await coordinator.observe(
      call('observe_page', {}),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    if ('deferred' in observed || observed.isError) throw new Error('Observation failed');
    const observationId = /"observationId":"([^"]+)/u.exec(observed.content)?.[1];
    const interaction = call('interact_page', { action: 'click', observationId, ref: 'e1' });

    await expect(
      coordinator.interact(interaction, SNAPSHOT, new AbortController().signal, 'request-1'),
    ).resolves.toMatchObject({
      deferred: true,
      kind: 'user_input',
      allowCustom: false,
      options: [
        { id: 'confirm-action', label: '确认执行' },
        { id: 'decline-action', label: '不执行' },
      ],
    });
    expect(document.querySelector('output')?.textContent).toBe('未提交');

    const approved = coordinator.interact(
      interaction,
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
      true,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(approved).resolves.toMatchObject({ isError: false });
    expect(document.querySelector('output')?.textContent).toBe('已提交');
  });

  it('validates fill/select/check arguments before injection', async () => {
    setPage('<label for="q">关键词</label><input id="q" />');
    const coordinator = new PageInteractionCoordinator();
    const observed = await coordinator.observe(
      call('observe_page', {}),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    if ('deferred' in observed || observed.isError) throw new Error('Observation failed');
    const observationId = /"observationId":"([^"]+)/u.exec(observed.content)?.[1];

    for (const argumentsValue of [
      { action: 'fill', observationId, ref: 'e1' },
      { action: 'select', observationId, ref: 'e1' },
      { action: 'check', observationId, ref: 'e1' },
    ]) {
      await expect(
        coordinator.interact(
          call('interact_page', argumentsValue),
          SNAPSHOT,
          new AbortController().signal,
          'request-1',
        ),
      ).resolves.toMatchObject({ errorCode: 'INVALID_PAGE_INTERACTION' });
    }
  });

  it('supports bounded scroll, wait, back and forward and can clear persisted refs', async () => {
    vi.useFakeTimers();
    setPage('<button>按钮</button>');
    const coordinator = new PageInteractionCoordinator();

    for (const argumentsValue of [
      { action: 'scroll', deltaY: 800 },
      { action: 'wait', waitMs: 300 },
      { action: 'back' },
      { action: 'forward' },
    ]) {
      const pending = coordinator.interact(
        call('interact_page', argumentsValue),
        SNAPSHOT,
        new AbortController().signal,
        'request-1',
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(pending).resolves.toMatchObject({ isError: false });
    }
    expect(tabsGoBack).toHaveBeenCalledWith(7);
    expect(tabsGoForward).toHaveBeenCalledWith(7);

    await coordinator.clear('request-1');
    expect(sessionValue).toBeUndefined();
    await coordinator.clear();
    expect(storageRemove).toHaveBeenCalled();
  });
});
