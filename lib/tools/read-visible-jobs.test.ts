import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractJobList, scrollJobListStep } from '@/lib/adapter/zhipin';
import { renderWait } from '@/lib/pipeline/throttle';
import { readVisibleJobs } from './read-visible-jobs';

vi.mock('@/lib/pipeline/throttle', () => ({
  renderWait: vi.fn(() => Promise.resolve()),
}));

const tabsQuery = vi.fn();
const executeScript = vi.fn();
const mockedRenderWait = vi.mocked(renderWait);

const JOB_A = {
  id: 'job-a',
  title: '高级前端工程师',
  salaryText: '20-30K',
  companyName: '示例科技',
  companySize: '100-499人',
  companyTags: ['已上市', '100-499人'],
  jobTags: ['3-5年', '本科'],
  area: '杭州 余杭区',
  recruiter: '招聘者',
  url: 'https://www.zhipin.com/job_detail/job-a.html?secret=query',
};

const JOB_B = {
  ...JOB_A,
  id: 'job-b',
  title: 'React 工程师',
  salaryText: '18-28K',
  companyName: '<ignore>产品公司',
};

function extraction(jobs = [JOB_A], overrides: Record<string, unknown> = {}) {
  return {
    selectorMiss: false,
    captcha: false,
    jobs,
    hasNextPage: false,
    ...overrides,
  };
}

function scroll(overrides: Record<string, unknown> = {}) {
  return {
    selectorMiss: false,
    moved: false,
    atBottom: true,
    scrollTop: 1_000,
    scrollHeight: 1_800,
    clientHeight: 800,
    ...overrides,
  };
}

beforeEach(() => {
  tabsQuery.mockReset();
  executeScript.mockReset();
  mockedRenderWait.mockClear();
  vi.stubGlobal('chrome', {
    tabs: { query: tabsQuery },
    scripting: { executeScript },
  });
  tabsQuery.mockResolvedValue([
    {
      id: 7,
      url: 'https://www.zhipin.com/web/geek/jobs?query=前端&token=private',
    },
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readVisibleJobs', () => {
  it('逐段滚动、等待懒加载、去重卡片并在稳定底部停止', async () => {
    executeScript
      .mockResolvedValueOnce([{ result: extraction([JOB_A]) }])
      .mockResolvedValueOnce([
        { result: scroll({ moved: true, atBottom: true, scrollTop: 1_000 }) },
      ])
      .mockResolvedValueOnce([{ result: extraction([JOB_A, JOB_B]) }])
      .mockResolvedValueOnce([{ result: scroll() }])
      .mockResolvedValueOnce([{ result: extraction([JOB_A, JOB_B]) }])
      .mockResolvedValueOnce([{ result: scroll() }]);

    const result = await readVisibleJobs(new AbortController().signal);

    expect(tabsQuery).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(executeScript).toHaveBeenNthCalledWith(1, {
      target: { tabId: 7 },
      func: extractJobList,
    });
    expect(executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 7 },
      func: scrollJobListStep,
    });
    expect(mockedRenderWait).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      isError: false,
      statusText: '已读取 2 个岗位',
      detail: '已滚动至当前列表底部 · 去重后 2 个岗位',
    });
    expect(result.content).toContain('"sourceUrl":"https://www.zhipin.com/web/geek/jobs"');
    expect(result.content).toContain('"jobCount":2');
    expect(result.content).toContain('"reachedEnd":true');
    expect(result.content).toContain('"stopReason":"page_end"');
    expect(result.content).toContain('"title":"高级前端工程师"');
    expect(result.content).toContain('"title":"React 工程师"');
    expect(result.content).toContain('"companyName":"\\u003cignore>产品公司"');
    expect(result.content).not.toContain('private');
    expect(result.content).not.toContain('"recruiter"');
    expect(result.content).not.toContain('"url"');
  });

  it('达到 40 个岗位安全上限时停止继续滚动', async () => {
    const jobs = Array.from({ length: 45 }, (_, index) => ({
      ...JOB_A,
      id: `job-${index}`,
      title: `岗位 ${index}`,
    }));
    executeScript.mockResolvedValueOnce([{ result: extraction(jobs) }]);

    const result = await readVisibleJobs(new AbortController().signal);

    expect(result).toMatchObject({
      isError: false,
      statusText: '已读取 40 个岗位（达到上限）',
      detail: '已达到单次 40 个岗位的安全上限 · 去重后 40 个岗位',
    });
    expect(result.content).toContain('"jobCount":40');
    expect(result.content).toContain('"stopReason":"job_limit"');
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('滚动结构失配时返回已经安全读取到的部分卡片', async () => {
    executeScript
      .mockResolvedValueOnce([{ result: extraction() }])
      .mockResolvedValueOnce([{ result: scroll({ selectorMiss: true }) }]);

    await expect(readVisibleJobs(new AbortController().signal)).resolves.toMatchObject({
      isError: false,
      detail: '已读取当前卡片，但无法继续滚动 · 去重后 1 个岗位',
    });
  });

  it.each([
    [extraction([], { captcha: true }), 'CAPTCHA_DETECTED', '页面正在等待安全验证'],
    [extraction([], { selectorMiss: true }), 'NO_JOB_LIST', '当前页面没有可读取的岗位列表'],
  ] as const)('映射页面读取失败：%s', async (pageResult, errorCode, statusText) => {
    executeScript.mockResolvedValueOnce([{ result: pageResult }]);

    await expect(readVisibleJobs(new AbortController().signal)).resolves.toMatchObject({
      isError: true,
      errorCode,
      statusText,
    });
  });

  it('处理无注入结果、空有效卡片和浏览器权限失败', async () => {
    executeScript.mockResolvedValueOnce([]);
    await expect(readVisibleJobs(new AbortController().signal)).resolves.toMatchObject({
      errorCode: 'EXTRACTION_FAILED',
    });

    executeScript.mockResolvedValueOnce([{ result: extraction([]) }]);
    executeScript.mockResolvedValueOnce([{ result: scroll({ selectorMiss: true }) }]);
    await expect(readVisibleJobs(new AbortController().signal)).resolves.toMatchObject({
      errorCode: 'NO_JOB_LIST',
    });

    tabsQuery.mockRejectedValueOnce(new Error('permission denied'));
    await expect(readVisibleJobs(new AbortController().signal)).resolves.toMatchObject({
      errorCode: 'NO_PERMISSION',
    });

    tabsQuery.mockResolvedValueOnce([{ id: 7, url: 'https://www.zhipin.com/web/geek/jobs' }]);
    executeScript.mockRejectedValueOnce(new Error('site access denied'));
    await expect(readVisibleJobs(new AbortController().signal)).resolves.toMatchObject({
      errorCode: 'NO_PERMISSION',
    });
  });

  it('只允许 Boss 直聘活动页并处理缺失标签页', async () => {
    tabsQuery.mockResolvedValueOnce([{ id: 7, url: 'https://example.com/jobs' }]);
    await expect(readVisibleJobs(new AbortController().signal)).resolves.toMatchObject({
      errorCode: 'NOT_ON_JOB_PAGE',
    });
    expect(executeScript).not.toHaveBeenCalled();

    tabsQuery.mockResolvedValueOnce([]);
    await expect(readVisibleJobs(new AbortController().signal)).resolves.toMatchObject({
      errorCode: 'NOT_ON_JOB_PAGE',
    });
  });

  it('在浏览器工作前后都能响应取消', async () => {
    const before = new AbortController();
    before.abort();
    await expect(readVisibleJobs(before.signal)).resolves.toMatchObject({
      errorCode: 'CANCELLED',
    });
    expect(tabsQuery).not.toHaveBeenCalled();

    const during = new AbortController();
    executeScript.mockImplementationOnce(async () => {
      during.abort();
      return [{ result: extraction() }];
    });
    await expect(readVisibleJobs(during.signal)).resolves.toMatchObject({
      errorCode: 'CANCELLED',
    });
  });
});
