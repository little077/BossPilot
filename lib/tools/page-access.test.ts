import { afterEach, describe, expect, it, vi } from 'vitest';
import { injectExtraction, resolveActiveTab } from './page-access';

/** 用最小 chrome 桩替换全局；setup.ts 只 restore mocks，所以这里必须 unstub globals。 */
function stubChrome() {
  const query = vi.fn();
  const executeScript = vi.fn();
  vi.stubGlobal('chrome', { tabs: { query }, scripting: { executeScript } });
  return { query, executeScript };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveActiveTab', () => {
  it('返回活动标签页的 id 与 url', async () => {
    const { query } = stubChrome();
    query.mockResolvedValue([{ id: 7, url: 'https://example.com/page' }]);

    const result = await resolveActiveTab();
    expect(result).toEqual({ ok: true, tab: { tabId: 7, url: 'https://example.com/page' } });
    expect(query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });

  it('没有标签页时返回 no_active_tab', async () => {
    const { query } = stubChrome();
    query.mockResolvedValue([]);
    expect(await resolveActiveTab()).toEqual({ ok: false, errorCode: 'no_active_tab' });
  });

  it('标签页缺少 id 时返回 no_active_tab', async () => {
    const { query } = stubChrome();
    query.mockResolvedValue([{ url: 'https://example.com' }]);
    expect(await resolveActiveTab()).toEqual({ ok: false, errorCode: 'no_active_tab' });
  });

  it('查询抛错时返回 no_active_tab', async () => {
    const { query } = stubChrome();
    query.mockRejectedValue(new Error('tabs unavailable'));
    expect(await resolveActiveTab()).toEqual({ ok: false, errorCode: 'no_active_tab' });
  });

  it('url 不可见（无 activeTab 授权）时返回 page_access_denied', async () => {
    const { query } = stubChrome();
    query.mockResolvedValue([{ id: 1 }]);
    expect(await resolveActiveTab()).toEqual({ ok: false, errorCode: 'page_access_denied' });
  });

  it('url 缺失时用 pendingUrl 兜底', async () => {
    const { query } = stubChrome();
    query.mockResolvedValue([{ id: 1, pendingUrl: 'https://pending.example/' }]);
    expect(await resolveActiveTab()).toEqual({
      ok: true,
      tab: { tabId: 1, url: 'https://pending.example/' },
    });
  });

  it('非 http(s) 页面（chrome:// 等）返回 unsupported_page', async () => {
    const { query } = stubChrome();
    query.mockResolvedValue([{ id: 1, url: 'chrome://settings' }]);
    expect(await resolveActiveTab()).toEqual({ ok: false, errorCode: 'unsupported_page' });
  });
});

describe('injectExtraction', () => {
  it('注入成功时取回函数返回值', async () => {
    const { executeScript } = stubChrome();
    executeScript.mockResolvedValue([{ result: { title: '页面' } }]);
    const func = () => ({ title: '页面' });

    const result = await injectExtraction(7, func);
    expect(result).toEqual({ ok: true, value: { title: '页面' } });
    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, func });
  });

  it('返回结果为空（null / 空数组）时归为 injection_failed', async () => {
    const { executeScript } = stubChrome();
    executeScript.mockResolvedValue([{ result: null }]);
    expect(await injectExtraction(7, () => null)).toEqual({
      ok: false,
      errorCode: 'injection_failed',
    });

    executeScript.mockResolvedValue([]);
    expect(await injectExtraction(7, () => null)).toEqual({
      ok: false,
      errorCode: 'injection_failed',
    });
  });

  it('权限类错误（cannot access）归为 page_access_denied', async () => {
    const { executeScript } = stubChrome();
    executeScript.mockRejectedValue(
      new Error('Cannot access contents of the page. Extension manifest must request permission.'),
    );
    expect(await injectExtraction(7, () => null)).toEqual({
      ok: false,
      errorCode: 'page_access_denied',
    });
  });

  it('其它注入错误归为 injection_failed', async () => {
    const { executeScript } = stubChrome();
    executeScript.mockRejectedValue(new Error('frame detached'));
    expect(await injectExtraction(7, () => null)).toEqual({
      ok: false,
      errorCode: 'injection_failed',
    });
  });
});
