import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PageInteractionObservationResult,
  PageInteractiveElementCandidate,
  PageTurnSnapshot,
} from '@/lib/domain/types';
import type { GenerationToolCall, GenerationToolExecutionContext } from '@/lib/generation/types';
import {
  captureInteractivePage,
  INTERACT_PAGE_TOOL,
  OBSERVE_PAGE_TOOL,
  OBSERVE_VISUAL_PAGE_TOOL,
  PageInteractionCoordinator,
  performPageInteraction,
  verifyPageElementState,
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
const tabsQuery = vi.fn();
const tabsUpdate = vi.fn();
const tabsGoBack = vi.fn();
const tabsGoForward = vi.fn();
const captureVisibleTab = vi.fn();
const permissionsContains = vi.fn();
const executeScript = vi.fn();
const storageGet = vi.fn();
const storageSet = vi.fn();
const storageRemove = vi.fn();
let sessionValue: unknown;
let sessionValueMirror: unknown;
let sessionStorage: Record<string, unknown> = {};
let currentTabUrl = PAGE_URL;

function call(
  name: 'observe_page' | 'observe_visual_page' | 'interact_page',
  argumentsValue: Record<string, unknown>,
): GenerationToolCall {
  return { id: 'call-1', name, arguments: argumentsValue };
}

const VISION_CONTEXT: GenerationToolExecutionContext = {
  model: {
    providerLabel: 'OpenAI',
    modelName: 'Vision Test',
    supportsImageInput: true,
  },
};

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
  sessionValueMirror = undefined;
  sessionStorage = {};
  currentTabUrl = PAGE_URL;
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
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
  const scrollByMock = vi.fn((options: unknown) => {
    const top =
      typeof options === 'object' &&
      options !== null &&
      'top' in options &&
      typeof options.top === 'number'
        ? options.top
        : 0;
    window.scrollY += top;
  });
  Object.defineProperty(window, 'scrollBy', { configurable: true, value: scrollByMock });

  tabsGet.mockReset().mockImplementation(async () => ({
    id: 7,
    windowId: 3,
    url: currentTabUrl,
    title: '交互测试',
    status: 'complete',
  }));
  tabsQuery.mockReset().mockImplementation(async () => [
    {
      id: 7,
      windowId: 3,
      url: currentTabUrl,
      title: '交互测试',
      status: 'complete',
      active: true,
    },
  ]);
  tabsUpdate.mockReset().mockImplementation(async () => tabsGet());
  tabsGoBack.mockReset().mockImplementation(async () => {
    currentTabUrl = 'https://www.zhipin.com/back';
  });
  tabsGoForward.mockReset().mockImplementation(async () => {
    currentTabUrl = 'https://www.zhipin.com/forward';
  });
  captureVisibleTab.mockReset().mockResolvedValue('data:image/jpeg;base64,YWJj');
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
  storageGet.mockReset().mockImplementation(async () => {
    if (sessionValue !== sessionValueMirror) {
      sessionStorage =
        sessionValue === undefined ? {} : { bosspilot_page_observation_v1: sessionValue };
      sessionValueMirror = sessionValue;
    }
    return { ...sessionStorage };
  });
  storageSet.mockReset().mockImplementation(async (value: Record<string, unknown>) => {
    sessionStorage = { ...sessionStorage, ...value };
    const collection = value.bosspilot_page_observations_v2 as
      | { observations?: Record<string, unknown> }
      | undefined;
    if (collection?.observations) {
      sessionValue = Object.values(collection.observations)[0];
      sessionValueMirror = sessionValue;
    }
  });
  storageRemove.mockReset().mockImplementation(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionStorage[key];
    const collection = sessionStorage.bosspilot_page_observations_v2 as
      | { observations?: Record<string, unknown> }
      | undefined;
    sessionValue = collection?.observations ? Object.values(collection.observations)[0] : undefined;
    sessionValueMirror = sessionValue;
  });
  vi.stubGlobal('chrome', {
    tabs: {
      get: tabsGet,
      query: tabsQuery,
      update: tabsUpdate,
      goBack: tabsGoBack,
      goForward: tabsGoForward,
      captureVisibleTab,
    },
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
    expect(OBSERVE_VISUAL_PAGE_TOOL).toMatchObject({
      name: 'observe_visual_page',
      parameters: { required: ['reason'], additionalProperties: false },
    });
  });
});

describe('visual page observation', () => {
  it('fails closed before page access when the selected model has no image capability', async () => {
    const coordinator = new PageInteractionCoordinator();
    const result = await coordinator.observeVisual(
      call('observe_visual_page', { reason: '需要读取图表' }),
      SNAPSHOT,
      new AbortController().signal,
      'request-vision',
      false,
      undefined,
      {
        model: { ...VISION_CONTEXT.model, supportsImageInput: false },
      },
    );

    expect(result).toMatchObject({ isError: true, errorCode: 'VISION_MODEL_REQUIRED' });
    expect(executeScript).not.toHaveBeenCalled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it('requires a bounded reason and a normal bound web page', async () => {
    const coordinator = new PageInteractionCoordinator();
    await expect(
      coordinator.observeVisual(
        call('observe_visual_page', {}),
        SNAPSHOT,
        new AbortController().signal,
        'request-vision',
        false,
        undefined,
        VISION_CONTEXT,
      ),
    ).resolves.toMatchObject({ isError: true, errorCode: 'VISUAL_CAPTURE_FAILED' });
    await expect(
      coordinator.observeVisual(
        call('observe_visual_page', { reason: '看图' }),
        null,
        new AbortController().signal,
        'request-vision',
        false,
        undefined,
        VISION_CONTEXT,
      ),
    ).resolves.toMatchObject({ isError: true, errorCode: 'STALE_VISUAL_OBSERVATION' });
  });

  it('asks for one-time consent after proving page access without taking a screenshot', async () => {
    setPage('<button type="button" aria-label="筛选"></button>');
    const coordinator = new PageInteractionCoordinator();
    const result = await coordinator.observeVisual(
      call('observe_visual_page', { reason: '图标没有可读文字' }),
      SNAPSHOT,
      new AbortController().signal,
      'request-vision',
      false,
      undefined,
      VISION_CONTEXT,
    );

    expect(result).toMatchObject({
      deferred: true,
      kind: 'user_input',
      statusText: '等待视觉观察授权',
      allowCustom: false,
      options: [
        { id: 'allow-once', label: '仅本次允许' },
        { id: 'cancel-visual', label: '取消' },
      ],
    });
    expect(result).toHaveProperty('question', expect.stringContaining('OpenAI · Vision Test'));
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it('explains screenshot transmission in the exact-origin permission prompt', async () => {
    permissionsContains.mockResolvedValue(false);
    executeScript.mockRejectedValueOnce(new Error('Cannot access contents of the page'));
    const coordinator = new PageInteractionCoordinator();
    const result = await coordinator.observeVisual(
      call('observe_visual_page', { reason: '读取画布' }),
      SNAPSHOT,
      new AbortController().signal,
      'request-vision',
      false,
      undefined,
      VISION_CONTEXT,
    );

    expect(result).toMatchObject({ deferred: true, kind: 'page_permission' });
    expect(result).toHaveProperty('detail', expect.stringContaining('当前可见区域截图'));
  });

  it('returns a marked image block and reusable grounded refs only after approval', async () => {
    setPage(`
      <label>关键词<input value="private query"></label>
      <button type="button" aria-label="打开筛选"></button>
    `);
    const progress = vi.fn();
    const coordinator = new PageInteractionCoordinator();
    const result = await coordinator.observeVisual(
      call('observe_visual_page', { reason: '需要识别无文字图标', limit: 30 }),
      SNAPSHOT,
      new AbortController().signal,
      'request-vision',
      true,
      progress,
      VISION_CONTEXT,
    );

    expect(result).toMatchObject({
      isError: false,
      statusText: '已完成视觉观察',
      images: [{ data: 'YWJj', mimeType: 'image/jpeg' }],
    });
    if ('deferred' in result) throw new Error('unexpected deferred visual result');
    expect(result.content).toContain('"observationId":"obs-');
    expect(result.content).toContain('"ref":"e1"');
    expect(result.content).not.toContain('private query');
    expect(captureVisibleTab).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith(
      '正在获取页面视觉信息',
      expect.stringContaining('不写入历史'),
    );
    expect(document.querySelector('[id^="bosspilot-visual-"]')).toBeNull();
  });

  it('returns a bounded visual error without attaching an invalid image', async () => {
    setPage('<button type="button">查看图表</button>');
    captureVisibleTab.mockResolvedValue('invalid-image');
    const coordinator = new PageInteractionCoordinator();
    const result = await coordinator.observeVisual(
      call('observe_visual_page', { reason: '读取图表' }),
      SNAPSHOT,
      new AbortController().signal,
      'request-vision',
      true,
      undefined,
      VISION_CONTEXT,
    );

    expect(result).toMatchObject({ isError: true, errorCode: 'VISUAL_CAPTURE_FAILED' });
    expect(result).not.toHaveProperty('images');
  });

  it('turns Chrome activeTab capture rejection into an actionable bounded error', async () => {
    setPage('<button type="button">查看图表</button>');
    captureVisibleTab.mockRejectedValue(
      new Error("Either the '<all_urls>' or 'activeTab' permission is required."),
    );
    const coordinator = new PageInteractionCoordinator();
    const result = await coordinator.observeVisual(
      call('observe_visual_page', { reason: '读取图表' }),
      SNAPSHOT,
      new AbortController().signal,
      'request-vision',
      true,
      undefined,
      VISION_CONTEXT,
    );

    expect(result).toMatchObject({
      isError: true,
      errorCode: 'VISUAL_CAPTURE_FAILED',
      detail: expect.stringContaining('点击 BossPilot 扩展图标'),
      content: expect.stringContaining('未把截图发送给模型'),
    });
    expect(result).not.toHaveProperty('images');
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

  it('distinguishes oversized and stale visual captures', async () => {
    setPage('<button type="button">查看图表</button>');
    const coordinator = new PageInteractionCoordinator();
    for (const [message, errorCode] of [
      ['截图超过大小上限', 'VISUAL_CAPTURE_TOO_LARGE'],
      ['页面文档已经变化', 'STALE_VISUAL_OBSERVATION'],
    ] as const) {
      captureVisibleTab.mockRejectedValueOnce(new Error(message));
      await expect(
        coordinator.observeVisual(
          call('observe_visual_page', { reason: '读取图表' }),
          SNAPSHOT,
          new AbortController().signal,
          `request-${errorCode}`,
          true,
          undefined,
          VISION_CONTEXT,
        ),
      ).resolves.toMatchObject({ isError: true, errorCode });
    }
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

describe('verifyPageElementState', () => {
  it('rechecks fill, select and check state without returning field values', () => {
    setPage(`
      <label for="name">姓名</label><input id="name" value="张三" />
      <label for="city">城市</label><select id="city"><option value="sh" selected>上海</option></select>
      <label><input id="updates" type="checkbox" checked />接收更新</label>
    `);

    const fill = verifyPageElementState({
      action: 'fill',
      locator: locatorByName('姓名'),
      value: '张三',
      expectedUrl: PAGE_URL,
    });
    const select = verifyPageElementState({
      action: 'select',
      locator: locatorByName('城市'),
      value: '上海',
      expectedUrl: PAGE_URL,
    });
    const check = verifyPageElementState({
      action: 'check',
      locator: locatorByName('接收更新'),
      checked: true,
      expectedUrl: PAGE_URL,
    });

    expect(fill).toMatchObject({ ok: true, evidence: 'input_value_matches' });
    expect(select).toMatchObject({ ok: true, evidence: 'selected_option_matches' });
    expect(check).toMatchObject({ ok: true, evidence: 'checked_state_matches' });
    expect(JSON.stringify([fill, select, check])).not.toContain('张三');
  });

  it('reports controlled-field rollback and stale page identity', () => {
    setPage('<label for="name">姓名</label><input id="name" value="旧值" />');
    const locator = locatorByName('姓名');

    expect(
      verifyPageElementState({
        action: 'fill',
        locator,
        value: '新值',
        expectedUrl: PAGE_URL,
      }),
    ).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    expect(
      verifyPageElementState({
        action: 'fill',
        locator,
        value: '旧值',
        expectedUrl: 'https://example.com/other',
      }),
    ).toMatchObject({ ok: false, error: 'STALE_ELEMENT_REFERENCE' });
  });

  it('rejects stale locator shapes and verifies editable/custom-control variants', () => {
    setPage(`
      <div contenteditable="true" aria-label="说明">目标说明</div>
      <div role="switch" aria-label="通知" aria-checked="false"></div>
      <button>普通按钮</button>
      <select aria-label="城市"><option value="sh" selected>上海</option></select>
    `);
    const editable = locatorByName('说明');
    const button = locatorByName('普通按钮');
    const city = locatorByName('城市');

    expect(
      verifyPageElementState({
        action: 'fill',
        locator: editable,
        value: '目标说明',
        expectedUrl: PAGE_URL,
      }),
    ).toMatchObject({ ok: true, evidence: 'input_value_matches' });
    expect(
      verifyPageElementState({
        action: 'check',
        locator: locatorByName('通知'),
        checked: false,
        expectedUrl: PAGE_URL,
      }),
    ).toMatchObject({ ok: true, evidence: 'checked_state_matches' });
    expect(
      verifyPageElementState({
        action: 'select',
        locator: city,
        value: 'sh',
        expectedUrl: PAGE_URL,
      }),
    ).toMatchObject({ ok: true });
    expect(
      verifyPageElementState({
        action: 'fill',
        locator: button,
        value: '',
        expectedUrl: PAGE_URL,
      }),
    ).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    expect(
      verifyPageElementState({
        action: 'select',
        locator: button,
        value: '',
        expectedUrl: PAGE_URL,
      }),
    ).toMatchObject({ ok: false, error: 'STALE_ELEMENT_REFERENCE' });
    expect(
      verifyPageElementState({
        action: 'fill',
        locator: { ...editable, path: [...editable.path, 99] },
        value: '目标说明',
        expectedUrl: PAGE_URL,
      }),
    ).toMatchObject({ ok: false, error: 'STALE_ELEMENT_REFERENCE' });
    expect(
      verifyPageElementState({
        action: 'fill',
        locator: { ...editable, tag: 'button' },
        value: '目标说明',
        expectedUrl: PAGE_URL,
      }),
    ).toMatchObject({ ok: false, error: 'STALE_ELEMENT_REFERENCE' });
    expect(
      verifyPageElementState({
        action: 'fill',
        locator: editable,
        value: '目标说明',
        expectedUrl: 'not a valid URL',
      }),
    ).toMatchObject({ ok: false, error: 'STALE_ELEMENT_REFERENCE' });
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

    const malformedCandidate = observe();
    executeScript.mockResolvedValueOnce([
      { documentId: 'document-1', result: { ...malformedCandidate, elements: [{}] } },
    ]);
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

  it('isolates observations by conversation, request and tab', async () => {
    setPage('<button>按钮</button>');
    const coordinator = new PageInteractionCoordinator();
    await coordinator.observe(
      call('observe_page', {}),
      SNAPSHOT,
      new AbortController().signal,
      'shared-request',
      'conversation-a',
    );
    await coordinator.observe(
      call('observe_page', {}),
      SNAPSHOT,
      new AbortController().signal,
      'shared-request',
      'conversation-b',
    );

    const collection = sessionStorage.bosspilot_page_observations_v2 as {
      observations: Record<string, { conversationId: string }>;
    };
    expect(
      Object.values(collection.observations).map(({ conversationId }) => conversationId),
    ).toEqual(['conversation-a', 'conversation-b']);

    await coordinator.clear('shared-request', 'conversation-a', SNAPSHOT.tabId);
    const remaining = sessionStorage.bosspilot_page_observations_v2 as {
      observations: Record<string, { conversationId: string }>;
    };
    expect(Object.values(remaining.observations)).toEqual([
      expect.objectContaining({ conversationId: 'conversation-b' }),
    ]);
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
          stateVerified: false,
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
    executeScript
      .mockImplementationOnce(
        async (options: { func: (...args: unknown[]) => unknown; args?: unknown[] }) => [
          {
            documentId: 'document-1',
            frameId: 0,
            result: options.func(...(options.args ?? [])),
          },
        ],
      )
      .mockResolvedValueOnce([]);

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
    expect(outcome).toMatchObject({ isError: false, statusText: '已验证点击页面控件成功' });
    if (!('deferred' in outcome)) {
      expect(outcome.content).toContain('previousReferencesInvalidated');
      expect(outcome.content).toContain('"observationId":"obs-');
    }
  });

  it('does not repeat a click when the page shows no observable result', async () => {
    vi.useFakeTimers();
    setPage('<button id="noop">无响应按钮</button>');
    const clicked = vi.fn();
    document.querySelector('#noop')?.addEventListener('click', clicked);
    const progress = vi.fn();
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
      false,
      progress,
    );
    await vi.advanceTimersByTimeAsync(4_000);
    const outcome = await pending;

    expect(outcome).toMatchObject({
      isError: true,
      errorCode: 'VERIFICATION_FAILED',
      statusText: '页面操作未验证成功',
    });
    if (!('deferred' in outcome)) expect(outcome.content).toContain('"status":"not_verified"');
    expect(clicked).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith(
      '正在验证页面操作',
      '只观察页面结果，不会重复执行刚才的动作。',
    );
  });

  it('follows and verifies the single tab opened by a click', async () => {
    vi.useFakeTimers();
    setPage('<button id="open-tab">打开报告</button>');
    const coordinator = new PageInteractionCoordinator();
    const observed = await coordinator.observe(
      call('observe_page', {}),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    if ('deferred' in observed || observed.isError) throw new Error('Observation failed');
    const observationId = /"observationId":"([^"]+)/u.exec(observed.content)?.[1];
    let queryCount = 0;
    tabsQuery.mockImplementation(async () => {
      queryCount += 1;
      const original = { id: 7, windowId: 3, url: PAGE_URL, status: 'complete', active: true };
      return queryCount === 1
        ? [original]
        : [
            { ...original, active: false },
            {
              id: 9,
              windowId: 3,
              url: 'https://example.com/report',
              title: '报告',
              status: 'complete',
              active: true,
            },
          ];
    });
    tabsGet.mockImplementation(async (tabId: number) =>
      tabId === 9
        ? {
            id: 9,
            windowId: 3,
            url: 'https://example.com/report',
            title: '报告',
            status: 'complete',
          }
        : {
            id: 7,
            windowId: 3,
            url: PAGE_URL,
            title: '交互测试',
            status: 'complete',
          },
    );
    tabsUpdate.mockImplementation(async () => tabsGet(9));

    const pending = coordinator.interact(
      call('interact_page', { action: 'click', observationId, ref: 'e1' }),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    await vi.advanceTimersByTimeAsync(1_500);
    const outcome = await pending;

    expect(outcome).toMatchObject({
      isError: false,
      statusText: '已验证点击页面控件成功',
      nextPageSnapshot: { tabId: 9, url: 'https://example.com/report' },
    });
    expect(tabsUpdate).toHaveBeenCalledWith(9, { active: true });
  });

  it('reports multiple newly opened tabs without guessing which one to follow', async () => {
    vi.useFakeTimers();
    setPage('<button>打开多个页面</button>');
    const coordinator = new PageInteractionCoordinator();
    const observed = await coordinator.observe(
      call('observe_page', {}),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    if ('deferred' in observed || observed.isError) throw new Error('Observation failed');
    const observationId = /"observationId":"([^"]+)/u.exec(observed.content)?.[1];
    let queryCount = 0;
    tabsQuery.mockImplementation(async () => {
      queryCount += 1;
      const original = { id: 7, windowId: 3, url: PAGE_URL, status: 'complete', active: true };
      return queryCount === 1
        ? [original]
        : [
            original,
            { id: 9, windowId: 3, url: 'https://example.com/a', status: 'complete' },
            { id: 10, windowId: 3, url: 'https://example.com/b', status: 'complete' },
          ];
    });

    const pending = coordinator.interact(
      call('interact_page', { action: 'click', observationId, ref: 'e1' }),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await pending;

    expect(outcome).toMatchObject({
      isError: false,
      detail: '点击后打开了 2 个新标签页，未自动选择目标',
      nextPageSnapshot: { tabId: 7 },
    });
    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  it('verifies a click through same-tab navigation evidence', async () => {
    vi.useFakeTimers();
    setPage('<button id="navigate">进入详情</button>');
    document.querySelector('#navigate')?.addEventListener('click', () => {
      currentTabUrl = 'https://www.zhipin.com/detail';
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

    expect(outcome).toMatchObject({
      isError: false,
      detail: '点击后页面地址已变化',
      nextPageSnapshot: { url: 'https://www.zhipin.com/detail' },
    });
  });

  it('fails verification when scrolling or history navigation has no effect', async () => {
    vi.useFakeTimers();
    setPage('<button>按钮</button>');
    Object.defineProperty(window, 'scrollBy', { configurable: true, value: vi.fn() });
    tabsGoBack.mockResolvedValue(undefined);
    const coordinator = new PageInteractionCoordinator();

    const scroll = coordinator.interact(
      call('interact_page', { action: 'scroll', deltaY: 600 }),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(scroll).resolves.toMatchObject({
      isError: true,
      errorCode: 'VERIFICATION_FAILED',
      detail: expect.stringContaining('视口没有发生变化'),
    });

    const back = coordinator.interact(
      call('interact_page', { action: 'back' }),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(back).resolves.toMatchObject({
      isError: true,
      errorCode: 'VERIFICATION_FAILED',
      detail: expect.stringContaining('没有观察到页面地址变化'),
    });
  });

  it('detects a controlled input that rolls back after the action', async () => {
    vi.useFakeTimers();
    setPage('<label for="name">姓名</label><input id="name" />');
    const input = document.querySelector<HTMLInputElement>('#name');
    input?.addEventListener('input', () => {
      setTimeout(() => {
        if (input) input.value = '';
      }, 50);
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
      call('interact_page', {
        action: 'fill',
        observationId,
        ref: 'e1',
        value: '张三',
      }),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    await vi.advanceTimersByTimeAsync(1_500);
    const outcome = await pending;

    expect(input?.value).toBe('');
    expect(outcome).toMatchObject({ isError: true, errorCode: 'VERIFICATION_FAILED' });
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
      { action: 'fill', observationId, ref: 'e1', value: 'x'.repeat(2_001) },
      { action: 'scroll_until', deltaY: -10 },
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

  it('scrolls deterministically until the page bottom within a hard step limit', async () => {
    vi.useFakeTimers();
    setPage('<main>长页面</main>');
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 1_800,
    });
    const progress = vi.fn();
    const coordinator = new PageInteractionCoordinator();
    const pending = coordinator.interact(
      call('interact_page', { action: 'scroll_until', deltaY: 700, maxSteps: 5 }),
      SNAPSHOT,
      new AbortController().signal,
      'request-scroll',
      false,
      progress,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await pending;

    expect(outcome).toMatchObject({ isError: false, statusText: '已滚动到页面底部' });
    if (!('deferred' in outcome)) {
      expect(outcome.content).toContain('"passes":2');
      expect(outcome.content).toContain('"stopReason":"bottom"');
    }
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it('finds a visible target before scrolling and stops after maxSteps when absent', async () => {
    setPage('<button>下载报告</button>');
    const coordinator = new PageInteractionCoordinator();
    const found = await coordinator.interact(
      call('interact_page', { action: 'scroll_until', query: '下载报告', maxSteps: 3 }),
      SNAPSHOT,
      new AbortController().signal,
      'request-found',
    );
    expect(found).toMatchObject({ isError: false, statusText: '已找到目标控件' });
    expect(window.scrollBy).not.toHaveBeenCalled();

    vi.useFakeTimers();
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 10_000,
    });
    const progress = vi.fn();
    const missing = coordinator.interact(
      call('interact_page', { action: 'scroll_until', query: '不存在的控件', maxSteps: 2 }),
      SNAPSHOT,
      new AbortController().signal,
      'request-missing',
      false,
      progress,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(missing).resolves.toMatchObject({
      isError: true,
      errorCode: 'ELEMENT_NOT_FOUND',
      statusText: '自动滚动后未找到目标',
    });
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it('stops at the bottom when a scroll target is absent', async () => {
    setPage('<main>短页面</main>');
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 700,
    });
    const coordinator = new PageInteractionCoordinator();
    await expect(
      coordinator.interact(
        call('interact_page', { action: 'scroll_until', query: '不存在' }),
        SNAPSHOT,
        new AbortController().signal,
        'request-bottom-missing',
      ),
    ).resolves.toMatchObject({
      isError: true,
      errorCode: 'ELEMENT_NOT_FOUND',
      detail: expect.stringContaining('页面底部'),
    });
  });

  it('uses safe scroll defaults and stops immediately when the viewport cannot move', async () => {
    setPage('<main>无法滚动</main>');
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 10_000,
    });
    Object.defineProperty(window, 'scrollBy', { configurable: true, value: vi.fn() });
    const coordinator = new PageInteractionCoordinator();
    const outcome = await coordinator.interact(
      call('interact_page', { action: 'scroll_until' }),
      SNAPSHOT,
      new AbortController().signal,
      'request-no-progress',
    );
    expect(outcome).toMatchObject({
      isError: true,
      errorCode: 'VERIFICATION_FAILED',
      detail: expect.stringContaining('没有产生新位置'),
    });
  });

  it('propagates permission deferral and missing scoped observations during auto-scroll', async () => {
    setPage('<main>页面</main>');
    const coordinator = new PageInteractionCoordinator();
    permissionsContains.mockResolvedValueOnce(false);
    executeScript.mockRejectedValueOnce(new Error('Cannot access contents of the page'));
    await expect(
      coordinator.interact(
        call('interact_page', { action: 'scroll_until', query: '目标' }),
        SNAPSHOT,
        new AbortController().signal,
        'request-deferred-scroll',
      ),
    ).resolves.toMatchObject({ deferred: true, kind: 'page_permission' });

    permissionsContains.mockResolvedValue(true);
    storageSet.mockResolvedValueOnce(undefined);
    await expect(
      coordinator.interact(
        call('interact_page', { action: 'scroll_until', query: '目标' }),
        SNAPSHOT,
        new AbortController().signal,
        'request-missing-observation',
      ),
    ).resolves.toMatchObject({
      isError: true,
      errorCode: 'STALE_ELEMENT_REFERENCE',
      detail: expect.stringContaining('自动滚动期间'),
    });
  });

  it('stops when a bounded scroll script fails or returns to the same observable state', async () => {
    setPage('<main>动态页面</main>');
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 10_000,
    });
    const coordinator = new PageInteractionCoordinator();
    executeScript.mockImplementation(
      async (options: { func: (...args: unknown[]) => unknown; args?: unknown[] }) => [
        {
          documentId: 'document-1',
          frameId: 0,
          result:
            options.func.name === 'performPageInteraction'
              ? { version: 2 }
              : options.func(...(options.args ?? [])),
        },
      ],
    );
    await expect(
      coordinator.interact(
        call('interact_page', { action: 'scroll_until', query: '目标', maxSteps: 2 }),
        SNAPSHOT,
        new AbortController().signal,
        'request-script-error',
      ),
    ).resolves.toMatchObject({ isError: true, errorCode: 'INTERACTION_FAILED' });

    vi.useFakeTimers();
    executeScript.mockImplementation(
      async (options: { func: (...args: unknown[]) => unknown; args?: unknown[] }) => {
        const result = options.func(...(options.args ?? []));
        if (options.func.name === 'performPageInteraction') window.scrollY = 0;
        return [{ documentId: 'document-1', frameId: 0, result }];
      },
    );
    const repeated = coordinator.interact(
      call('interact_page', { action: 'scroll_until', query: '目标' }),
      SNAPSHOT,
      new AbortController().signal,
      'request-repeated-state',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(repeated).resolves.toMatchObject({
      isError: true,
      errorCode: 'ELEMENT_NOT_FOUND',
      detail: expect.stringContaining('没有产生新位置'),
    });
  });

  it('supports bounded scroll, wait, back and forward and can clear persisted refs', async () => {
    vi.useFakeTimers();
    setPage('<button>按钮</button>');
    const coordinator = new PageInteractionCoordinator();

    for (const argumentsValue of [
      { action: 'scroll', deltaY: 800 },
      { action: 'wait', waitMs: 300 },
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

    const back = coordinator.interact(
      call('interact_page', { action: 'back' }),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(back).resolves.toMatchObject({ isError: false });

    currentTabUrl = PAGE_URL;
    const forward = coordinator.interact(
      call('interact_page', { action: 'forward' }),
      SNAPSHOT,
      new AbortController().signal,
      'request-1',
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(forward).resolves.toMatchObject({ isError: false });
    expect(tabsGoBack).toHaveBeenCalledWith(7);
    expect(tabsGoForward).toHaveBeenCalledWith(7);

    await coordinator.clear('request-1');
    expect(sessionValue).toBeUndefined();
    await coordinator.clear();
    expect(storageRemove).toHaveBeenCalled();
  });
});
