// ─── Agent 工作流回归集：read → inspect → interact → verify ───
// 目的：把四个环节当作一条完整链路回归，防止跨工具契约在单测盲区里退化。
// read 用真实提取算法（page-reader 同源 extractCurrentDocument）在 jsdom 上产出摘要；
// 再以摘要为依据 inspect 定位、interact 执行、统一验证机制确认结果。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageTurnSnapshot } from '@/lib/domain/types';
import type {
  GenerationToolCall,
  GenerationToolExecutionOutcome,
  GenerationToolExecutionResult,
} from '@/lib/generation/types';
import { extractCurrentDocument } from '@/lib/page/extractor';
import { PageInteractionCoordinator } from './page-interaction';
import { readCurrentPage } from './read-current-page';

// vitest jsdom 固定运行在 https://www.zhipin.com/web/geek/job，测试页只能用同源路径。
const PAGE_URL = 'https://www.zhipin.com/agent-flow-regression';
const SNAPSHOT: PageTurnSnapshot = {
  tabId: 7,
  windowId: 3,
  url: PAGE_URL,
  safeUrl: PAGE_URL,
  origin: 'https://www.zhipin.com',
  title: '回归链路页',
  scheme: 'https',
  isHttp: true,
  isBoss: false,
  capturedAt: 1,
};

const tabsGet = vi.fn();
const tabsQuery = vi.fn();
const tabsUpdate = vi.fn();
const contains = vi.fn();
const executeScript = vi.fn();
const storageGet = vi.fn();
const storageSet = vi.fn();
const storageRemove = vi.fn();
let sessionStorage: Record<string, unknown> = {};
let currentTabUrl = PAGE_URL;

function call(
  name: 'inspect_page' | 'interact_page',
  argumentsValue: Record<string, unknown>,
): GenerationToolCall {
  return { id: 'call-flow-1', name, arguments: argumentsValue };
}

function setPage(body: string): void {
  document.title = '回归链路页';
  document.body.innerHTML = body;
}

function observationIdOf(outcome: { content: unknown }): string {
  const content = typeof outcome.content === 'string' ? outcome.content : '';
  const matched = /"observationId":"([^"]+)/u.exec(content);
  if (!matched?.[1]) throw new Error(`缺少 observationId：${content.slice(0, 160)}`);
  return matched[1];
}

// GenerationToolExecutionOutcome 是联合类型（含 deferred 分支），先收窄再断言。
function executed<T extends GenerationToolExecutionOutcome>(
  outcome: T,
): GenerationToolExecutionResult {
  if ('deferred' in outcome || outcome.isError) {
    throw new Error(`工具调用未成功完成：${JSON.stringify(outcome)}`);
  }
  return outcome;
}

beforeEach(() => {
  sessionStorage = {};
  currentTabUrl = PAGE_URL;
  history.replaceState({}, '', PAGE_URL);
  document.title = '回归链路页';
  document.body.innerHTML = '';
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
  Object.defineProperty(window, 'scrollBy', {
    configurable: true,
    value: vi.fn((options: unknown) => {
      const top =
        typeof options === 'object' &&
        options !== null &&
        'top' in options &&
        typeof options.top === 'number'
          ? options.top
          : 0;
      window.scrollY += top;
    }),
  });

  tabsGet.mockReset().mockImplementation(async () => ({
    id: SNAPSHOT.tabId,
    windowId: SNAPSHOT.windowId,
    url: currentTabUrl,
    title: '回归链路页',
    status: 'complete',
  }));
  tabsQuery.mockReset().mockImplementation(async () => [
    {
      id: SNAPSHOT.tabId,
      windowId: SNAPSHOT.windowId,
      url: currentTabUrl,
      title: '回归链路页',
      status: 'complete',
      active: true,
    },
  ]);
  tabsUpdate.mockReset().mockImplementation(async () => tabsGet());
  contains.mockReset().mockResolvedValue(true);
  executeScript
    .mockReset()
    .mockImplementation(
      async (options: {
        files?: string[];
        func?: (...args: unknown[]) => unknown;
        args?: unknown[];
      }) => {
        if (options.files) {
          // read 环节：返回与 page-reader.js 同源的真实提取算法结果。
          return [{ documentId: 'document-1', frameId: 0, result: extractCurrentDocument() }];
        }
        // inspect / interact 环节：在 jsdom 中直接执行注入函数。
        return [
          {
            documentId: 'document-1',
            frameId: 0,
            result: options.func?.(...(options.args ?? [])),
          },
        ];
      },
    );
  storageGet.mockReset().mockImplementation(async () => ({ ...sessionStorage }));
  storageSet.mockReset().mockImplementation(async (value: Record<string, unknown>) => {
    sessionStorage = { ...sessionStorage, ...value };
  });
  storageRemove.mockReset().mockImplementation(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionStorage[key];
  });
  vi.stubGlobal('chrome', {
    tabs: { get: tabsGet, query: tabsQuery, update: tabsUpdate },
    permissions: { contains },
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

describe('read → inspect → interact → verify 回归集', () => {
  it('read 摘要引导 inspect 定位搜索框，fill 后按 element_state 策略验证', async () => {
    setPage(`
      <form role="search">
        <label for="q">搜索关键词</label>
        <input id="q" aria-label="搜索关键词" />
        <button type="submit">搜索</button>
      </form>
    `);
    const signal = new AbortController().signal;

    // 1. read：真实提取算法产出控件摘要，作为下一步 inspect 的决策依据。
    const read = executed(await readCurrentPage(SNAPSHOT, signal));
    expect(read.isError).toBe(false);
    if ('content' in read) {
      expect(read.content).toContain('"structure":{"version":1');
      expect(read.content).toContain('"role":"textbox"');
      expect(read.content).toContain('"role":"button"');
    }

    // 2. inspect：按 read 摘要中的控件角色与可访问名定位。
    const coordinator = new PageInteractionCoordinator();
    const inspected = executed(
      await coordinator.inspect(
        call('inspect_page', { query: '搜索关键词', role: 'textbox' }),
        SNAPSHOT,
        signal,
        'flow-request-1',
        'flow-conversation-1',
      ),
    );
    expect(inspected.isError).toBe(false);
    if ('content' in inspected) {
      expect(inspected.content).toContain('"name":"搜索关键词"');
      expect(inspected.content).toContain('"ref":"e1"');
      expect(inspected.content).not.toContain('"path"');
    }

    // 3. interact：用观察返回的 ref 执行 fill。
    const interacted = executed(
      await coordinator.interact(
        call('interact_page', {
          action: 'fill',
          observationId: observationIdOf(inspected),
          ref: 'e1',
          value: 'React 岗位',
        }),
        SNAPSHOT,
        signal,
        'flow-request-1',
        false,
        undefined,
        'flow-conversation-1',
      ),
    );
    expect(interacted.isError).toBe(false);

    // 4. verify：element_state 策略确认输入值落库到真实 DOM。
    expect(document.querySelector<HTMLInputElement>('#q')?.value).toBe('React 岗位');
    if ('content' in interacted) {
      expect(interacted.content).toContain('previousReferencesInvalidated');
    }
  });

  it('read 摘要识别按钮后 click，按 page_effect 策略轮询到页面副作用', async () => {
    vi.useFakeTimers();
    setPage('<button id="open">打开详情</button><output id="result">未打开</output>');
    document.querySelector('#open')?.addEventListener('click', () => {
      const output = document.querySelector('#result');
      if (output) output.textContent = '已打开';
    });
    const signal = new AbortController().signal;

    const read = executed(await readCurrentPage(SNAPSHOT, signal));
    expect(read.isError).toBe(false);
    if ('content' in read) {
      expect(read.content).toContain('"role":"button"');
    }

    const coordinator = new PageInteractionCoordinator();
    const inspected = executed(
      await coordinator.inspect(
        call('inspect_page', { query: '打开详情', role: 'button' }),
        SNAPSHOT,
        signal,
        'flow-request-2',
        'flow-conversation-1',
      ),
    );
    expect(inspected.isError).toBe(false);

    const pending = coordinator.interact(
      call('interact_page', {
        action: 'click',
        observationId: observationIdOf(inspected),
        ref: 'e1',
      }),
      SNAPSHOT,
      signal,
      'flow-request-2',
      false,
      undefined,
      'flow-conversation-1',
    );
    await vi.advanceTimersByTimeAsync(3_000);
    const interacted = await pending;

    expect(document.querySelector('#result')?.textContent).toBe('已打开');
    expect(interacted).toMatchObject({
      isError: false,
      statusText: '已验证点击页面控件成功',
    });
  });

  it('read 摘要定位输入框后 keypress，按 script_evidence 策略确认分发', async () => {
    setPage(
      '<main><p>输入关键词后回车开始搜索。</p><input id="q" aria-label="搜索关键词" /></main>',
    );
    const keydown = vi.fn();
    document.querySelector('#q')?.addEventListener('keydown', keydown);
    const signal = new AbortController().signal;

    const read = executed(await readCurrentPage(SNAPSHOT, signal));
    expect(read.isError).toBe(false);

    const coordinator = new PageInteractionCoordinator();
    const inspected = executed(
      await coordinator.inspect(
        call('inspect_page', { query: '搜索关键词', role: 'textbox' }),
        SNAPSHOT,
        signal,
        'flow-request-3',
        'flow-conversation-1',
      ),
    );
    expect(inspected.isError).toBe(false);

    const interacted = executed(
      await coordinator.interact(
        call('interact_page', {
          action: 'keypress',
          observationId: observationIdOf(inspected),
          ref: 'e1',
          key: 'Enter',
        }),
        SNAPSHOT,
        signal,
        'flow-request-3',
        false,
        undefined,
        'flow-conversation-1',
      ),
    );
    expect(interacted).toMatchObject({ isError: false });
    expect(keydown).toHaveBeenCalled();
    if ('content' in interacted) {
      expect(interacted.content).toContain('已向目标控件分发 Enter 键盘事件');
    }
  });

  it('read 摘要无目标控件时 inspect 返回空结果，interact 拒绝空引用', async () => {
    setPage('<main><p>纯文本页面，没有任何交互控件。</p></main>');
    const signal = new AbortController().signal;

    const read = executed(await readCurrentPage(SNAPSHOT, signal));
    expect(read.isError).toBe(false);
    if ('content' in read) {
      expect(read.content).toContain('"controls":{"total":0');
    }

    const coordinator = new PageInteractionCoordinator();
    const inspected = executed(
      await coordinator.inspect(
        call('inspect_page', { query: '搜索', role: 'button' }),
        SNAPSHOT,
        signal,
        'flow-request-4',
        'flow-conversation-1',
      ),
    );
    expect(inspected.isError).toBe(false);
    expect(inspected.detail).toContain('找到 0 个匹配元素');
    if ('content' in inspected) {
      expect(inspected.content).toContain('"elements":[]');
    }

    // inspect 返回空结果后，interact 即使拿到 observationId 也拒绝不存在的引用。
    const interacted = await coordinator.interact(
      call('interact_page', {
        action: 'click',
        observationId: observationIdOf(inspected),
        ref: 'e1',
      }),
      SNAPSHOT,
      signal,
      'flow-request-4',
      false,
      undefined,
      'flow-conversation-1',
    );
    expect(interacted).toMatchObject({
      isError: true,
      errorCode: 'STALE_ELEMENT_REFERENCE',
    });
    if ('content' in interacted) {
      expect(interacted.content).toContain('不存在元素引用');
    }
  });
});
