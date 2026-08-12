import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cityToCode, knownCities } from './city-codes';
import {
  buildSearchUrl,
  captureZhipinPageStructure,
  extractJobDetail,
  extractJobList,
  isZhipinJobDetailUrl,
  isZhipinUrl,
  parseSalary,
  passesSalaryFilter,
  scrollJobListStep,
  toJobPosting,
} from './zhipin';

beforeEach(() => {
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/web/geek/job');
});

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
    expect(isZhipinUrl('https://www.zhipin.com/web/geek/job')).toBe(true);
    expect(isZhipinUrl('https://www.zhipin.com.evil.example/job_detail/abc.html')).toBe(false);
    expect(isZhipinUrl('https://example.com')).toBe(false);
    expect(isZhipinUrl('not-a-url')).toBe(false);
    expect(isZhipinUrl(undefined)).toBe(false);
  });

  it('只把 Boss 岗位详情路径识别为可读取页面', () => {
    expect(isZhipinJobDetailUrl('https://www.zhipin.com/job_detail/abc.html?lid=1')).toBe(true);
    expect(isZhipinJobDetailUrl('https://www.zhipin.com/web/geek/job')).toBe(false);
    expect(isZhipinJobDetailUrl('https://example.com/job_detail/abc.html')).toBe(false);
    expect(isZhipinJobDetailUrl('not-a-url')).toBe(false);
    expect(isZhipinJobDetailUrl(undefined)).toBe(false);
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

  it('兼容推荐页的新版卡片包裹结构', () => {
    window.history.replaceState({}, '', '/web/geek/jobs');
    document.body.innerHTML = `
      <div class="job-list-container">
        <ul class="rec-job-list">
          <div class="card-area is-seen">
            <div class="job-card-wrap active">
              <li class="job-card-box">
                <a class="job-card-body" href="/job_detail/new123.html">
                  <span class="job-name">鸿蒙安卓开发</span>
                  <span class="job-salary">10-15K</span>
                </a>
                <div class="company-name">信华信</div>
              </li>
            </div>
          </div>
        </ul>
      </div>
    `;

    expect(extractJobList().jobs).toEqual([
      expect.objectContaining({
        id: 'new123',
        title: '鸿蒙安卓开发',
        salaryText: '10-15K',
        companyName: '信华信',
      }),
    ]);
  });

  it('优先滚动岗位卡片所在的内部滚动容器并报告底部状态', () => {
    document.body.innerHTML = `
      <div class="job-list-container" style="overflow-y: auto">
        <ul class="rec-job-list">
          <li class="job-card-box"><a href="/job_detail/a.html">岗位 A</a></li>
        </ul>
      </div>
    `;
    const scroller = document.querySelector<HTMLElement>('.job-list-container');
    if (!scroller) throw new Error('测试滚动容器不存在');
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_600 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    scroller.scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
      scroller.scrollTop =
        typeof options === 'number' ? (y ?? options) : Math.max(0, options?.top ?? 0);
    });

    expect(scrollJobListStep()).toEqual({
      selectorMiss: false,
      moved: true,
      atBottom: false,
      scrollTop: 480,
      scrollHeight: 1_600,
      clientHeight: 400,
    });
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 480, behavior: 'auto' });

    scroller.scrollTop = 1_200;
    expect(scrollJobListStep()).toMatchObject({
      selectorMiss: false,
      moved: false,
      atBottom: true,
      scrollTop: 1_200,
    });
  });

  it('岗位卡片不存在时拒绝盲目滚动页面', () => {
    document.body.innerHTML = '<main>这里没有岗位列表</main>';
    expect(scrollJobListStep()).toEqual({
      selectorMiss: true,
      moved: false,
      atBottom: false,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
    });
  });

  it('识别验证码页面和选择器失配', () => {
    document.body.innerText = '请完成安全验证后继续';
    expect(extractJobList()).toMatchObject({ captcha: true, jobs: [] });

    document.body.innerHTML = '<main>搜索无结果</main>';
    const missed = extractJobList();
    expect(missed).toMatchObject({ selectorMiss: true, jobs: [] });
    expect(missed.domOutline).toContain('URL: https://www.zhipin.com');
    expect(missed.domOutline).toContain('main "搜索无结果"');
  });

  it('卡片存在但无有效职位时也标记失配并附带 DOM 骨架', () => {
    document.body.innerHTML = `
      <ul class="job-list-box"><li><span class="salary">面议</span></li></ul>
    `;

    const res = extractJobList();

    expect(res).toMatchObject({ selectorMiss: true, jobs: [] });
    expect(res.domOutline).toContain('ul.job-list-box');
  });

  it('DOM 骨架跳过脚本、截断文本预览并限制遍历深度', () => {
    document.body.innerHTML = `
      <script>var x = 1;</script>
      <div class="a b c">
        <section class="wrap"><article><p>深层内容不展开</p></article></section>
      </div>
      <span>${'长'.repeat(60)}</span>
    `;

    const outline = extractJobList().domOutline ?? '';

    expect(outline).not.toContain('script');
    expect(outline).toContain('div.a.b'); // class 最多保留 2 个
    expect(outline).not.toContain('div.a.b.c');
    expect(outline).toContain('article'); // 深度 3 可见
    expect(outline).not.toContain('深层内容'); // 深度 4 不再展开
    expect(outline).toContain(`"${'长'.repeat(40)}"`); // 文本预览截断到 40 字
    expect(outline).not.toContain('长'.repeat(41));
  });

  it('读取独立详情页的岗位核心字段', () => {
    window.history.replaceState({}, '', '/job_detail/abc123.html?lid=1');
    document.body.innerHTML = `
      <main>
        <header class="job-primary">
          <div class="name"><h1>高级前端工程师</h1></div>
          <span class="salary">20-30K·14薪</span>
          <a class="company-name">示例科技</a>
          <span class="text-city">西安</span>
          <ul class="tag-list"><li>3-5年</li><li>本科</li></ul>
        </header>
        <section class="job-detail-section"><div class="job-sec-text">负责 React 产品开发</div></section>
        <section class="company-info-box"><div class="job-sec-text">一家重视工程质量的公司</div></section>
      </main>
    `;

    expect(extractJobDetail()).toEqual({
      selectorMiss: false,
      captcha: false,
      pageKind: 'standalone_detail',
      hasJobCards: false,
      title: '高级前端工程师',
      salaryText: '20-30K·14薪',
      companyName: '示例科技',
      jobTags: ['3-5年', '本科'],
      description: '负责 React 产品开发',
      companyIntro: '一家重视工程质量的公司',
      city: '西安',
    });
  });

  it('读取列表页中当前可见的岗位详情面板并忽略隐藏旧面板', () => {
    document.body.innerHTML = `
      <ul class="job-list-box">
        <li class="job-card-wrapper">
          <a href="/job_detail/abc123.html"><span class="job-name">列表中的岗位</span></a>
        </li>
      </ul>
      <aside class="job-detail-box" hidden>
        <header class="job-detail-header"><h2 class="job-name">已经隐藏的岗位</h2></header>
        <section class="job-detail-section"><div class="job-sec-text">旧岗位正文</div></section>
      </aside>
      <aside class="job-detail-box">
        <header class="job-detail-header">
          <h2 class="job-name">当前选中的前端岗位</h2>
          <span class="salary">18-28K</span>
          <a class="company-name">当前公司</a>
          <span class="text-city">杭州</span>
          <ul class="tag-list"><li>1-3年</li><li>本科</li></ul>
        </header>
        <section class="job-detail-section">
          <div class="job-sec-text">负责当前产品的 React 开发</div>
        </section>
        <section class="company-info-box">
          <div class="job-sec-text">当前公司的公开介绍</div>
        </section>
      </aside>
    `;

    expect(extractJobDetail()).toEqual({
      selectorMiss: false,
      captcha: false,
      pageKind: 'embedded_detail',
      hasJobCards: true,
      title: '当前选中的前端岗位',
      salaryText: '18-28K',
      companyName: '当前公司',
      jobTags: ['1-3年', '本科'],
      description: '负责当前产品的 React 开发',
      companyIntro: '当前公司的公开介绍',
      city: '杭州',
    });
  });

  it('读取真实推荐列表页的 p.desc 岗位正文并保持字段范围在右侧详情面板', () => {
    window.history.replaceState({}, '', '/web/geek/jobs');
    document.body.innerHTML = `
      <div class="job-recommend-result">
        <div class="recommend-result-job">
          <div class="job-list-container">
            <ul class="rec-job-list">
              <div class="card-area is-seen">
                <div class="job-card-wrap active">
                  <li class="job-card-box">
                    <a href="/job_detail/real123.html">
                      <span class="job-name">左侧列表岗位</span>
                      <span class="job-salary">10-15K</span>
                    </a>
                  </li>
                </div>
              </div>
            </ul>
          </div>
          <div class="job-detail-container">
            <div class="job-detail-box">
              <div class="job-detail-header">
                <div class="job-header-info">
                  <div class="job-detail-info">
                    <span class="job-name">鸿蒙安卓开发</span>
                    <span class="job-salary">10-15K</span>
                  </div>
                  <ul class="tag-list"><li>3-5年</li><li>本科</li></ul>
                </div>
              </div>
              <div class="job-detail-body">
                <h3 class="title">职位描述</h3>
                <p class="desc">负责 HarmonyOS 应用开发，熟悉 <span class="dynamic-copy">ArkUI</span>。</p>
                <div class="job-address">
                  <span class="job-address-title">工作地址</span>
                  <p class="job-address-desc">杭州余杭区西溪园区</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    expect(extractJobDetail()).toEqual({
      selectorMiss: false,
      captcha: false,
      pageKind: 'embedded_detail',
      hasJobCards: true,
      title: '鸿蒙安卓开发',
      salaryText: '10-15K',
      companyName: '',
      jobTags: ['3-5年', '本科'],
      description: '负责 HarmonyOS 应用开发，熟悉 ArkUI。',
      companyIntro: '',
      city: '杭州余杭区西溪园区',
    });
  });

  it('区分职位列表未选中岗位与无法识别的页面', () => {
    document.body.innerHTML = `
      <ul class="job-list-box">
        <li class="job-card-wrapper">
          <a href="/job_detail/abc123.html"><span class="job-name">前端工程师</span></a>
        </li>
      </ul>
    `;

    expect(extractJobDetail()).toMatchObject({
      selectorMiss: true,
      pageKind: 'unknown',
      hasJobCards: true,
      description: '',
    });

    document.body.innerHTML = '<main>这里没有岗位</main>';
    expect(extractJobDetail()).toMatchObject({
      selectorMiss: true,
      pageKind: 'unknown',
      hasJobCards: false,
    });
  });

  it('标记详情选择器失配和验证码页面', () => {
    document.body.innerHTML = `
      <script>var y = 2;</script>
      <div class="page shell extra"><section><article><p>深层</p></article></section></div>
      <main>职位已下线</main>
    `;
    const missed = extractJobDetail();
    expect(missed).toMatchObject({ selectorMiss: true, captcha: false });
    expect(missed.domOutline).toContain('URL: https://www.zhipin.com');
    expect(missed.domOutline).toContain('main "职位已下线"');
    expect(missed.domOutline).toContain('div.page.shell'); // class 最多保留 2 个
    expect(missed.domOutline).not.toContain('script');
    expect(missed.domOutline).not.toContain('深层'); // 深度 4 不再展开

    document.body.innerText = '异常访问，请完成验证';
    expect(extractJobDetail()).toMatchObject({ captcha: true, description: '' });
  });
});

describe('页面结构诊断', () => {
  it('记录真实页面类名、选择器命中与关键文案路径，但不采集敏感属性或表单值', () => {
    window.history.replaceState({}, '', '/web/geek/job?query=frontend&token=private-query-value');
    document.body.innerHTML = `
      <header>
        <input value="private-form-value" />
      </header>
      <main class="recommend-search-layout">
        <ul class="job-list-box">
          <li class="job-card-wrapper is-active">
            <a href="/job_detail/secret-job-id.html">鸿蒙安卓开发</a>
          </li>
        </ul>
        <section class="modern-current-job-panel">
          <h2>鸿蒙安卓开发</h2>
          <div class="modern-section-title">职位描述</div>
          <div class="actual-jd-copy">联系 13812345678 或 dev@example.com 获取完整信息</div>
          <button type="button">立即沟通</button>
        </section>
      </main>
    `;

    const snapshot = captureZhipinPageStructure();

    expect(snapshot).toMatchObject({
      status: 'captured',
      pageUrl: 'https://www.zhipin.com/web/geek/job',
      pageKind: 'job_list',
      truncated: false,
    });
    expect(snapshot.selectorProbes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: '职位列表卡片',
          selector: 'li.job-card-wrapper',
          matches: 1,
          visibleMatches: 1,
        }),
        expect.objectContaining({
          group: '岗位正文',
          selector: '.job-sec-text',
          matches: 0,
          visibleMatches: 0,
        }),
      ]),
    );
    expect(snapshot.landmarks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: '职位描述',
          path: expect.stringContaining('section.modern-current-job-panel'),
        }),
      ]),
    );
    expect(snapshot.outline).toContain('section.modern-current-job-panel');
    expect(snapshot.outline).toContain('"职位描述"');
    expect(snapshot.outline).toContain('[手机号]');
    expect(snapshot.outline).toContain('[邮箱]');
    expect(snapshot.outline).not.toContain('private-query-value');
    expect(snapshot.outline).not.toContain('private-form-value');
    expect(snapshot.outline).not.toContain('secret-job-id');
  });

  it('区分独立详情、列表内详情与未知页面，并统计隐藏候选', () => {
    window.history.replaceState({}, '', '/job_detail/abc123.html');
    document.body.innerHTML = `
      <main>
        <div class="job-detail-box" aria-hidden="true">
          <div class="job-sec-text">隐藏旧正文</div>
        </div>
        <div class="job-detail-box">
          <h1 class="job-name">独立详情岗位</h1>
          <div class="job-sec-text">当前正文</div>
          <button type="button">收藏</button>
        </div>
      </main>
    `;
    const standalone = captureZhipinPageStructure();
    expect(standalone.pageKind).toBe('standalone_detail');
    expect(standalone.selectorProbes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          selector: '.job-detail-box',
          matches: 2,
          visibleMatches: 1,
        }),
      ]),
    );
    expect(standalone.outline).not.toContain('隐藏旧正文');

    window.history.replaceState({}, '', '/web/geek/job');
    document.body.innerHTML = `
      <main>
        <div class="job-detail-box">
          <div class="job-sec-text">列表内当前正文</div>
        </div>
      </main>
    `;
    expect(captureZhipinPageStructure().pageKind).toBe('embedded_detail');

    document.body.innerHTML = '<main class="plain-page"><div>普通内容</div></main>';
    const unknown = captureZhipinPageStructure();
    expect(unknown.pageKind).toBe('unknown');
    expect(unknown.landmarks).toEqual([]);
  });

  it('限制深层和超大 DOM，过滤不可见节点与不安全类名', () => {
    const deep = Array.from({ length: 12 }, (_, index) => `<div class="depth-${index}">`).join('');
    const deepClose = '</div>'.repeat(12);
    const large = Array.from(
      { length: 620 },
      (_, index) =>
        `<div class="${'a'.repeat(80)} ${'b'.repeat(80)} ${'c'.repeat(80)} ${'d'.repeat(80)} invalid:class">节点${index}</div>`,
    ).join('');
    document.body.innerHTML = `
      <div style="display:none">display 隐藏</div>
      <div style="visibility:hidden">visibility 隐藏</div>
      ${deep}深层内容${deepClose}
      ${large}
    `;

    const snapshot = captureZhipinPageStructure();

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.nodeCount).toBe(600);
    expect(snapshot.outline?.length).toBe(50_000);
    expect(snapshot.outline).not.toContain('display 隐藏');
    expect(snapshot.outline).not.toContain('visibility 隐藏');
    expect(snapshot.outline).not.toContain('invalid:class');
    expect(snapshot.outline).toContain(`div.${'a'.repeat(80)}.${'b'.repeat(80)}`);
  }, 10_000);
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
