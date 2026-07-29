import { describe, expect, it } from 'vitest';
import { cityToCode, knownCities } from './city-codes';
import {
  buildSearchUrl,
  extractJobDetail,
  extractJobList,
  isZhipinUrl,
  parseSalary,
  passesSalaryFilter,
  toJobPosting,
} from './zhipin';

describe('城市与搜索 URL', () => {
  it('规范化城市名并返回城市码', () => {
    expect(cityToCode('西安市')).toBe('101110100');
    expect(cityToCode(' 不存在市 ')).toBeUndefined();
    expect(knownCities()).toContain('全国');
  });

  it('为已知城市生成精确搜索 URL', () => {
    const url = new URL(
      buildSearchUrl(
        {
          keyword: '前端开发',
          city: '西安',
          softConditions: [],
          maxJobs: 20,
          fetchDetails: true,
        },
        2,
      ),
    );

    expect(url.origin).toBe('https://www.zhipin.com');
    expect(url.searchParams.get('query')).toBe('前端开发');
    expect(url.searchParams.get('city')).toBe('101110100');
    expect(url.searchParams.get('page')).toBe('2');
  });

  it('把未知城市并入关键词并退化为全国搜索', () => {
    const url = new URL(
      buildSearchUrl(
        {
          keyword: '前端开发',
          city: '火星',
          softConditions: [],
          maxJobs: 20,
          fetchDetails: false,
        },
        1,
      ),
    );

    expect(url.searchParams.get('query')).toBe('火星 前端开发');
    expect(url.searchParams.has('city')).toBe(false);
    expect(url.searchParams.has('page')).toBe(false);
  });

  it('只接受 Boss 直聘站内 URL', () => {
    expect(isZhipinUrl('https://www.zhipin.com/job_detail/abc.html')).toBe(true);
    expect(isZhipinUrl('https://example.com')).toBe(false);
    expect(isZhipinUrl(undefined)).toBe(false);
  });
});

describe('列表与详情抽取', () => {
  it('从职位卡片提取结构化字段和下一页状态', () => {
    document.body.innerHTML = `
      <ul class="job-list-box">
        <li class="job-card-wrapper">
          <a class="job-card-left" href="/job_detail/abc123.html">
            <span class="job-name">高级前端工程师</span>
          </a>
          <span class="salary">15-25K·14薪</span>
          <div class="company-name"><a>示例科技</a></div>
          <span class="job-area">西安 雁塔区</span>
          <div class="job-info">
            <ul class="tag-list"><li>3-5年</li><li>本科</li></ul>
            <span class="info-public">李女士·HR</span>
          </div>
          <ul class="company-tag-list"><li>已上市</li><li>100-499人</li></ul>
        </li>
      </ul>
      <div class="options-pages"><a>1</a><a class="next">下一页</a></div>
    `;

    const result = extractJobList();

    expect(result).toMatchObject({
      captcha: false,
      selectorMiss: false,
      hasNextPage: true,
    });
    expect(result.jobs).toEqual([
      {
        id: 'abc123',
        title: '高级前端工程师',
        salaryText: '15-25K·14薪',
        companyName: '示例科技',
        companySize: '100-499人',
        companyTags: ['已上市', '100-499人'],
        jobTags: ['3-5年', '本科'],
        area: '西安 雁塔区',
        recruiter: '李女士·HR',
        url: 'https://www.zhipin.com/job_detail/abc123.html',
      },
    ]);
  });

  it('识别验证码页面和选择器失配', () => {
    document.body.innerText = '请完成安全验证后继续';
    expect(extractJobList()).toMatchObject({ captcha: true, jobs: [] });

    document.body.innerHTML = '<main>搜索无结果</main>';
    expect(extractJobList()).toMatchObject({ selectorMiss: true, jobs: [] });
  });

  it('读取详情页正文、公司介绍和城市', () => {
    document.body.innerHTML = `
      <section class="job-detail-section"><div class="job-sec-text">负责 React 产品开发</div></section>
      <section class="company-info-box"><div class="job-sec-text">一家重视工程质量的公司</div></section>
      <span class="text-city">西安</span>
    `;

    expect(extractJobDetail()).toEqual({
      selectorMiss: false,
      captcha: false,
      description: '负责 React 产品开发',
      companyIntro: '一家重视工程质量的公司',
      city: '西安',
    });
  });

  it('标记详情选择器失配和验证码页面', () => {
    document.body.innerHTML = '<main>职位已下线</main>';
    expect(extractJobDetail()).toMatchObject({ selectorMiss: true, captcha: false });

    document.body.innerText = '异常访问，请完成验证';
    expect(extractJobDetail()).toMatchObject({ captcha: true, description: '' });
  });
});

describe('薪资解析与过滤', () => {
  it.each([
    ['15-25K', { minK: 15, maxK: 25 }],
    ['15-25K·14薪', { minK: 15, maxK: 25 }],
    ['20K', { minK: 20, maxK: 20 }],
    ['300-500元/天', { minK: 6.525, maxK: 10.875 }],
    ['8-12万/年', { minK: 6.666666666666667, maxK: 10 }],
    ['面议', {}],
  ])('解析 %s', (input, expected) => {
    expect(parseSalary(input)).toEqual(expected);
  });

  it('把抽取结果转换为领域实体', () => {
    const job = toJobPosting({
      id: 'job-1',
      title: '前端工程师',
      salaryText: '10-20K',
      companyName: '示例公司',
      companySize: '',
      companyTags: [],
      jobTags: [],
      area: '',
      recruiter: '',
      url: 'https://www.zhipin.com/job_detail/job-1.html',
    });

    expect(job).toMatchObject({ salaryMinK: 10, salaryMaxK: 20 });
    expect(job.companySize).toBeUndefined();
    expect(job.area).toBeUndefined();
  });

  it('按薪资区间是否相交过滤，并保留无法解析的岗位', () => {
    const base = {
      id: 'job-1',
      title: '前端工程师',
      salaryText: '10-20K',
      salaryMinK: 10,
      salaryMaxK: 20,
      companyName: '示例公司',
      companyTags: [],
      jobTags: [],
      url: 'https://www.zhipin.com/job_detail/job-1.html',
    };
    const params = {
      keyword: '前端',
      city: '西安',
      salaryMinK: 15,
      salaryMaxK: 25,
      softConditions: [],
      maxJobs: 20,
      fetchDetails: false,
    };

    expect(passesSalaryFilter(base, params)).toBe(true);
    expect(passesSalaryFilter({ ...base, salaryMaxK: 14 }, params)).toBe(false);
    expect(passesSalaryFilter({ ...base, salaryMinK: 26 }, params)).toBe(false);
    expect(
      passesSalaryFilter({ ...base, salaryMinK: undefined, salaryMaxK: undefined }, params),
    ).toBe(true);
    expect(
      passesSalaryFilter(base, {
        ...params,
        salaryMinK: undefined,
        salaryMaxK: undefined,
      }),
    ).toBe(true);
  });
});
