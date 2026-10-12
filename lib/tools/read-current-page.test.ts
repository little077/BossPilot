import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./page-access', () => ({
  resolveActiveTab: vi.fn(),
  injectExtraction: vi.fn(),
}));

import { extractPageContent, MIN_CONTENT_CHARS, type PageExtraction } from './extract';
import { injectExtraction, resolveActiveTab } from './page-access';
import { readCurrentPageTool } from './read-current-page';

const mockedResolveActiveTab = vi.mocked(resolveActiveTab);
const mockedInjectExtraction = vi.mocked(injectExtraction);

const extraction: PageExtraction = {
  url: 'https://example.com/article',
  title: '标签页标题',
  description: '页面简介',
  content: '正文'.repeat(20),
};

const ctx = (signal?: AbortSignal): { signal: AbortSignal } => ({
  signal: signal ?? new AbortController().signal,
});

const okTab = (): void => {
  mockedResolveActiveTab.mockResolvedValue({
    ok: true,
    tab: { tabId: 1, url: extraction.url },
  });
};

beforeEach(() => {
  // setup.ts 的 restoreAllMocks 不清理 vi.fn 调用历史，这里显式清理以保证「未被调用」断言可靠。
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

it('成功：注入抽取后返回双形态结果与摘要', async () => {
  okTab();
  mockedInjectExtraction.mockResolvedValue({ ok: true, value: extraction });

  const result = await readCurrentPageTool.execute({}, ctx());
  expect(result.isError).toBe(false);
  expect(result.errorCode).toBeUndefined();
  expect(result.summary).toBe('已读取《标签页标题》· 40 字');
  expect(result.llmText).toContain('标题：标签页标题');
  expect(result.data).toMatchObject({ url: extraction.url, charCount: 40, truncated: false });
  // 注入的必须是那个自包含抽取函数，tabId 来自 resolveActiveTab。
  expect(mockedInjectExtraction).toHaveBeenCalledWith(1, extractPageContent);
});

it('正文过短：返回 empty_content', async () => {
  okTab();
  mockedInjectExtraction.mockResolvedValue({
    ok: true,
    value: { ...extraction, content: 'a'.repeat(MIN_CONTENT_CHARS - 1) },
  });

  const result = await readCurrentPageTool.execute({}, ctx());
  expect(result.isError).toBe(true);
  expect(result.errorCode).toBe('empty_content');
});

it('标签页解析失败：透传错误码且不执行注入', async () => {
  mockedResolveActiveTab.mockResolvedValue({ ok: false, errorCode: 'unsupported_page' });

  const result = await readCurrentPageTool.execute({}, ctx());
  expect(result.errorCode).toBe('unsupported_page');
  expect(mockedInjectExtraction).not.toHaveBeenCalled();
});

it('注入失败：透传错误码并附带人话说明', async () => {
  okTab();
  mockedInjectExtraction.mockResolvedValue({ ok: false, errorCode: 'page_access_denied' });

  const result = await readCurrentPageTool.execute({}, ctx());
  expect(result.errorCode).toBe('page_access_denied');
  expect(result.summary).toContain('点击一次工具栏的扩展图标');
  expect(result.llmText).toContain('page_access_denied');
});

it('注入抛错：归为 injection_failed', async () => {
  okTab();
  mockedInjectExtraction.mockRejectedValue(new Error('frame detached'));

  const result = await readCurrentPageTool.execute({}, ctx());
  expect(result.errorCode).toBe('injection_failed');
});

it('预取消：直接返回 cancelled 且不触碰浏览器 API', async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await readCurrentPageTool.execute({}, ctx(controller.signal));
  expect(result.errorCode).toBe('cancelled');
  expect(mockedResolveActiveTab).not.toHaveBeenCalled();
});

it('注入超时：10 秒后返回 timeout，迟到结果被丢弃', async () => {
  vi.useFakeTimers();
  okTab();
  mockedInjectExtraction.mockReturnValue(new Promise<never>(() => {}));

  const promise = readCurrentPageTool.execute({}, ctx());
  // 先让微任务链推进到注入阶段（注册超时定时器），再推进时钟。
  await vi.advanceTimersByTimeAsync(0);
  expect(mockedInjectExtraction).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);

  const result = await promise;
  expect(result.errorCode).toBe('timeout');
  expect(result.summary).toContain('超时');
});

it('执行中被取消：abort 立即返回 cancelled', async () => {
  const controller = new AbortController();
  okTab();
  mockedInjectExtraction.mockReturnValue(new Promise<never>(() => {}));

  const promise = readCurrentPageTool.execute({}, ctx(controller.signal));
  await vi.waitFor(() => expect(mockedInjectExtraction).toHaveBeenCalled());
  controller.abort();

  const result = await promise;
  expect(result.errorCode).toBe('cancelled');
});
