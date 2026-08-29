import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import {
  capturePageTurnSnapshot,
  navigationKey,
  pageContextHistory,
  safePageTitle,
  safePageUrl,
  samePageKey,
  snapshotFromTab,
  validatePageTurnSnapshot,
} from './snapshot';

const query = vi.fn();
const get = vi.fn();

beforeEach(() => {
  query.mockReset();
  get.mockReset();
  vi.stubGlobal('chrome', { tabs: { query, get } });
});

afterEach(() => vi.unstubAllGlobals());

describe('page turn snapshots', () => {
  it('captures one active tab and removes secrets from the model-facing URL', async () => {
    query.mockResolvedValue([
      {
        id: 7,
        windowId: 3,
        url: 'https://example.com/docs/page?token=secret#section',
        title: '  Example   docs ',
      },
    ]);

    await expect(capturePageTurnSnapshot()).resolves.toMatchObject({
      tabId: 7,
      windowId: 3,
      origin: 'https://example.com',
      safeUrl: 'https://example.com/docs/page',
      title: 'Example docs',
      scheme: 'https',
      isHttp: true,
      isBoss: false,
    });
    expect(query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
  });

  it('returns null without a usable active tab and rejects incomplete direct snapshots', async () => {
    query.mockResolvedValue([]);
    await expect(capturePageTurnSnapshot()).resolves.toBeNull();
    expect(() => snapshotFromTab({ id: 1 } as chrome.tabs.Tab)).toThrow(TypeError);
  });

  it('validates tab identity and navigation while allowing hash-only changes', async () => {
    const snapshot = snapshotFromTab({
      id: 7,
      windowId: 3,
      url: 'https://example.com/page?q=1#old',
      title: 'Page',
    } as chrome.tabs.Tab);
    get.mockResolvedValue({
      id: 7,
      windowId: 3,
      url: 'https://example.com/page?q=1#new',
    });
    await expect(validatePageTurnSnapshot(snapshot)).resolves.toMatchObject({ ok: true });

    get.mockResolvedValue({ id: 7, windowId: 3, url: 'https://example.com/other' });
    await expect(validatePageTurnSnapshot(snapshot)).resolves.toMatchObject({
      ok: false,
      errorCode: 'page_changed',
    });

    get.mockRejectedValue(new Error('closed'));
    await expect(validatePageTurnSnapshot(snapshot)).resolves.toMatchObject({ ok: false });
  });

  it('adds untrusted metadata only to the latest user message without mutating history', () => {
    const history: ChatMessage[] = [
      { id: 'u1', role: 'user', content: '第一问', createdAt: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: '回答',
        createdAt: 2,
        modelIdentity: { providerId: 'openai', modelId: 'gpt-test' },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 2,
          cost: 0,
        },
        reasoningActivity: { status: 'completed', summary: '完成', startedAt: 1 },
        toolActivity: {
          callId: 'call-0',
          name: 'read_current_page',
          label: '读取当前页面',
          status: 'succeeded',
          statusText: '完成',
          startedAt: 1,
        },
      },
      { id: 'u2', role: 'user', content: '总结当前页', createdAt: 3 },
    ];
    const snapshot = snapshotFromTab({
      id: 7,
      windowId: 3,
      url: 'https://example.com/page?q=secret',
      title: '<title>',
    } as chrome.tabs.Tab);

    const contextual = pageContextHistory(history, snapshot);
    expect(contextual).not.toBe(history);
    expect(contextual[0]?.content).toBe('第一问');
    expect(contextual[2]?.content).toContain('read_current_page');
    expect(contextual[2]?.content).toContain('https://example.com/page');
    expect(contextual[2]?.content).not.toContain('secret');
    expect(contextual[2]?.content).toContain('\\u003ctitle>');
    expect(history[2]?.content).toBe('总结当前页');
    expect(pageContextHistory(history, null)).toEqual(history);
    expect(
      pageContextHistory(
        [{ id: 'a-only', role: 'assistant', content: '没有用户消息', createdAt: 1 }],
        snapshot,
      ),
    ).toEqual([{ id: 'a-only', role: 'assistant', content: '没有用户消息', createdAt: 1 }]);
  });

  it('normalizes safe URLs and navigation keys defensively', () => {
    expect(safePageUrl('chrome://settings')).toBe('');
    expect(safePageUrl('not a url')).toBe('');
    expect(navigationKey('not a url')).toBe('not a url');
    expect(navigationKey('https://example.com/a#x')).toBe('https://example.com/a');
    expect(
      safePageTitle(
        'example.com/docs/page?token=secret#section',
        'https://www.example.com/docs/page?token=secret',
      ),
    ).toBe('example.com/docs/page');
    expect(safePageTitle('正常的网页标题？', 'https://example.com/page?q=1')).toBe(
      '正常的网页标题？',
    );
    expect(
      snapshotFromTab({
        id: 9,
        windowId: 3,
        url: 'data:text/plain,hello',
        title: 'x'.repeat(400),
      } as chrome.tabs.Tab),
    ).toMatchObject({ origin: '', scheme: 'data', isHttp: false, title: 'x'.repeat(300) });
    expect(
      snapshotFromTab({
        id: 10,
        windowId: 3,
        url: 'not a url',
        title: '坏地址',
      } as chrome.tabs.Tab),
    ).toMatchObject({ origin: '', scheme: '', isHttp: false });
  });

  it('treats opaque origins and replaced windows as changed or non-http', async () => {
    const snapshot = snapshotFromTab({
      id: 7,
      windowId: 3,
      url: 'https://example.com/page',
      title: 'Page',
    } as chrome.tabs.Tab);

    // 窗口被替换
    get.mockResolvedValue({ id: 7, windowId: 99, url: 'https://example.com/page' });
    await expect(validatePageTurnSnapshot(snapshot)).resolves.toMatchObject({
      ok: false,
      errorCode: 'page_changed',
    });

    // 标签页丢失 URL
    get.mockResolvedValue({ id: 7, windowId: 3 });
    await expect(validatePageTurnSnapshot(snapshot)).resolves.toMatchObject({ ok: false });

    // 非 HTTP(S) 页面退化为严格比较
    expect(samePageKey('chrome://settings/', 'chrome://settings/')).toBe(true);
    expect(samePageKey('chrome://settings/', 'chrome://history/')).toBe(false);
    expect(samePageKey('about:blank', 'about:blank')).toBe(true);

    // 标题为空的页面不做 URL 化处理
    expect(safePageTitle('', 'https://example.com/page')).toBe('');
    // 与主机同名的标题且无查询串时原样保留
    expect(safePageTitle('example.com/docs', 'https://www.example.com/docs')).toBe(
      'example.com/docs',
    );
  });
});
