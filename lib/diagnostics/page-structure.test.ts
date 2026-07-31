import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureZhipinPageStructure } from '@/lib/adapter/zhipin';
import { captureCurrentPageStructure } from './page-structure';

const tabsQuery = vi.fn();
const executeScript = vi.fn();

beforeEach(() => {
  tabsQuery.mockReset();
  executeScript.mockReset();
  vi.stubGlobal('chrome', {
    tabs: { query: tabsQuery },
    scripting: { executeScript },
  });
  tabsQuery.mockResolvedValue([
    {
      id: 7,
      url: 'https://www.zhipin.com/web/geek/job?query=frontend&token=private',
    },
  ]);
  executeScript.mockResolvedValue([
    {
      result: {
        status: 'captured',
        capturedAt: 1,
        pageUrl: 'https://www.zhipin.com/web/geek/job',
        pageKind: 'embedded_detail',
        readyState: 'complete',
        viewport: { width: 1200, height: 800 },
        nodeCount: 20,
        truncated: false,
        selectorProbes: [],
        landmarks: [],
        outline: 'body',
      },
    },
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('captureCurrentPageStructure', () => {
  it('只在当前 Boss 页面注入自包含采集函数', async () => {
    const snapshot = await captureCurrentPageStructure();

    expect(tabsQuery).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      func: captureZhipinPageStructure,
    });
    expect(snapshot).toMatchObject({
      status: 'captured',
      pageKind: 'embedded_detail',
      pageUrl: 'https://www.zhipin.com/web/geek/job',
    });
  });

  it('非 Boss 页面和缺少活动标签页时跳过采集', async () => {
    tabsQuery.mockResolvedValue([{ id: 7, url: 'https://example.com/job' }]);
    await expect(captureCurrentPageStructure()).resolves.toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('不是 Boss 直聘'),
    });
    expect(executeScript).not.toHaveBeenCalled();

    tabsQuery.mockResolvedValue([]);
    await expect(captureCurrentPageStructure()).resolves.toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('没有找到'),
    });
  });

  it('把标签页权限失败和页面注入失败转成可下载的诊断状态', async () => {
    tabsQuery.mockRejectedValueOnce(new Error('no tabs permission'));
    await expect(captureCurrentPageStructure()).resolves.toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('tabs 权限'),
    });

    executeScript.mockResolvedValueOnce([]);
    await expect(captureCurrentPageStructure()).resolves.toMatchObject({
      status: 'failed',
      pageUrl: 'https://www.zhipin.com/web/geek/job',
      reason: expect.stringContaining('没有返回结构快照'),
    });

    executeScript.mockRejectedValueOnce(new Error('site access denied'));
    await expect(captureCurrentPageStructure()).resolves.toMatchObject({
      status: 'failed',
      pageUrl: 'https://www.zhipin.com/web/geek/job',
      reason: expect.stringContaining('站点访问权限'),
    });
  });
});
