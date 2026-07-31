// ─── 站点适配层（SiteAdapter）：Boss 直聘 ───
//
// 本文件是选择器与 URL 规则的「单一事实源」——所有与 zhipin.com 页面结构
// 耦合的知识都集中在这里，站点改版时只修此文件。
//
// 设计要点：
// 1. 注入函数必须自包含（chrome.scripting.executeScript 序列化后在页面执行，
//    不能引用闭包变量），因此列表/详情抽取函数内联全部选择器。
// 2. 每个抽取函数都带多组候选选择器做「宽容匹配」，并在关键选择器全部失配时
//    返回 selectorMiss 标记，供上层提示「站点可能改版」。
// 3. 适配层只做确定性抽取，产出结构化 JSON；语义判断一律不在这里做。
// 4. 选择器契约 v3（2026-07）：增加职位列表滚动容器识别，并兼容推荐列表页
//    `.job-detail-body > p.desc` 形式的右侧岗位正文。

import type {
  DiagnosticPageStructureSnapshot,
  JobPosting,
  SearchTaskParams,
} from '@/lib/domain/types';
import { cityToCode } from './city-codes';

export const ZHIPIN_ORIGIN = 'https://www.zhipin.com';

/** 适配层版本号——选择器契约变更时递增，用于诊断与缓存失效。 */
export const ADAPTER_VERSION = 3;

// ─── URL 构建 ───

/**
 * 构建搜索页 URL。Boss 的 web 搜索页形如：
 *   https://www.zhipin.com/web/geek/job?query=前端&city=101110100&page=2
 * 薪资等筛选也可 URL 传参，但编码枚举随版本变动大，MVP 选择只用
 * query + city + page 三个最稳定的参数，薪资过滤放在本地做（采集后按
 * salaryMinK/salaryMaxK 数值过滤），稳定性优先。
 */
export function buildSearchUrl(params: SearchTaskParams, page: number): string {
  const u = new URL('/web/geek/job', ZHIPIN_ORIGIN);
  const code = cityToCode(params.city);
  // 城市未收录时降级：城市名并入关键词，全国范围搜。
  u.searchParams.set('query', code ? params.keyword : `${params.city} ${params.keyword}`);
  if (code) u.searchParams.set('city', code);
  if (page > 1) u.searchParams.set('page', String(page));
  return u.toString();
}

/** 判断一个 URL 是否是 Boss 直聘站内页面。 */
export function isZhipinUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).origin === ZHIPIN_ORIGIN;
  } catch {
    return false;
  }
}

/** 判断当前页是否是可读取的 Boss 职位详情页。URL 结构知识只保留在适配层。 */
export function isZhipinJobDetailUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === ZHIPIN_ORIGIN && /^\/job_detail\/[^/]+\.html$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

// ─── 列表页抽取（注入函数，自包含） ───

export interface ListExtractResult {
  /** 关键选择器全部失配 → 疑似改版或页面未加载完。 */
  selectorMiss: boolean;
  /** 是否检测到验证码/安全拦截页。 */
  captcha: boolean;
  jobs: Array<{
    id: string;
    title: string;
    salaryText: string;
    companyName: string;
    companySize: string;
    companyTags: string[];
    jobTags: string[];
    area: string;
    recruiter: string;
    url: string;
  }>;
  /** 是否存在「下一页」（用于翻页终止判断）。 */
  hasNextPage: boolean;
  /** 仅 selectorMiss 时填充：页面 DOM 结构骨架（供 AI 分析改版原因）。 */
  domOutline?: string;
}

export interface JobListScrollState {
  /** 找不到职位列表或滚动根节点，通常意味着页面结构已变化。 */
  selectorMiss: boolean;
  /** 本次调用是否实际改变了滚动位置。 */
  moved: boolean;
  /** 本次滚动后是否已到当前内容底部；懒加载后仍需再次检查。 */
  atBottom: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * 在搜索列表页内执行：抽取当前页全部职位卡片。
 * 选择器契约（v1，2026-07 观察）：
 *   - 职位卡片: li.job-card-wrapper（旧版） / li.job-card-box（新版）
 *   - 标题: .job-name；薪资: .salary / .job-salary
 *   - 公司: .company-name / .boss-name 区域
 * 全部走多候选 + 文本兜底，尽量宽容。
 */
export function extractJobList(): ListExtractResult {
  const result: ListExtractResult = {
    selectorMiss: false,
    captcha: false,
    jobs: [],
    hasNextPage: false,
  };

  // 验证码/安全页检测：boss 安全拦截页有明显特征
  const bodyText = document.body?.innerText ?? '';
  if (
    location.href.includes('security-check') ||
    location.href.includes('captcha') ||
    /安全验证|请完成验证|异常访问/.test(bodyText.slice(0, 2000))
  ) {
    result.captcha = true;
    return result;
  }

  const text = (el: Element | null | undefined): string =>
    (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

  // DOM 骨架快照（仅 selectorMiss 时采集）。注入函数必须自包含，故内联定义。
  const domOutline = (): string => {
    const lines: string[] = [];
    const skip = /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|SVG|IFRAME)$/;
    const walk = (el: Element, depth: number): void => {
      if (lines.length >= 120 || skip.test(el.tagName)) return;
      const cls = Array.from(el.classList).slice(0, 2).join('.');
      const childCount = el.children.length;
      const preview =
        childCount === 0 ? (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      lines.push(
        `${'  '.repeat(depth)}${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${childCount ? ` (${childCount}子)` : ''}${preview ? ` "${preview}"` : ''}`,
      );
      if (depth >= 3) return;
      for (const child of Array.from(el.children)) walk(child, depth + 1);
    };
    if (document.body) walk(document.body, 0);
    return `URL: ${location.href}\n${lines.join('\n')}`.slice(0, 4000);
  };

  // 多候选卡片选择器（新旧版式）
  const cardSelectors = [
    'li.job-card-wrapper',
    'li.job-card-box',
    'div.job-card-wrapper',
    'ul.job-list-box > li',
  ];
  let cards: Element[] = [];
  for (const sel of cardSelectors) {
    cards = Array.from(document.querySelectorAll(sel));
    if (cards.length > 0) break;
  }
  if (cards.length === 0) {
    result.selectorMiss = true;
    result.domOutline = domOutline();
    return result;
  }

  for (const card of cards) {
    const link = card.querySelector<HTMLAnchorElement>(
      'a.job-card-left, a.job-card-body, a[href*="/job_detail/"]',
    );
    const href = link?.getAttribute('href') ?? '';
    // 职位加密 id：/job_detail/xxxx.html
    const idMatch = href.match(/job_detail\/([^.]+)\.html/);
    const id = idMatch?.[1] ?? href;
    if (!id) continue;

    const title = text(card.querySelector('.job-name, .job-title .job-name, .job-title'));
    const salaryText = text(card.querySelector('.salary, .job-salary'));
    const companyName = text(card.querySelector('.company-name a, .company-name, .boss-name'));
    const area = text(card.querySelector('.job-area, .company-location'));

    // 职位标签（经验/学历）与公司标签（融资/规模/行业）分属两个 tag 容器
    const jobTags = Array.from(card.querySelectorAll('.job-info .tag-list li, ul.tag-list li'))
      .map((el) => text(el))
      .filter(Boolean);
    const companyTagEls = Array.from(
      card.querySelectorAll('.company-tag-list li, .company-info .tag-list li'),
    );
    const companyTags = companyTagEls.map((el) => text(el)).filter(Boolean);
    // 公司规模通常是 companyTags 里形如「20-99人」的那条
    const companySize = companyTags.find((t) => /\d+\s*-\s*\d+人|万人以上|\d+人以上/.test(t)) ?? '';

    const recruiter = text(card.querySelector('.info-public, .job-info .info-public'));

    if (!title) continue;
    result.jobs.push({
      id,
      title,
      salaryText,
      companyName,
      companySize,
      companyTags,
      jobTags,
      area,
      recruiter,
      url: href.startsWith('http') ? href : `https://www.zhipin.com${href}`,
    });
  }

  if (result.jobs.length === 0) {
    result.selectorMiss = true;
    result.domOutline = domOutline();
  }

  // 下一页检测：分页器里未禁用的「下一页」按钮
  const nextBtn = document.querySelector(
    '.options-pages a:last-child:not(.disabled), .pagination-area a.next:not(.disabled)',
  );
  const nextDisabled = document.querySelector(
    '.options-pages a.disabled:last-child, .pagination-area a.next.disabled',
  );
  result.hasNextPage = !!nextBtn && !nextDisabled;

  return result;
}

/**
 * 把职位列表向下滚动一段，并返回可结构化克隆的滚动状态。
 *
 * 函数只负责确定性页面流程控制，不抽取岗位字段。调用方应在每次滚动前后执行
 * extractJobList()，这样即使站点启用了虚拟列表，也能把已经离开 DOM 的卡片保留下来。
 */
export function scrollJobListStep(): JobListScrollState {
  const missed: JobListScrollState = {
    selectorMiss: true,
    moved: false,
    atBottom: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };

  const card = document.querySelector(
    ['li.job-card-wrapper', 'li.job-card-box', 'div.job-card-wrapper', 'ul.job-list-box > li'].join(
      ',',
    ),
  );
  if (!card) return missed;

  const isScrollable = (element: HTMLElement): boolean => {
    const style = window.getComputedStyle(element);
    const allowsVerticalScroll = /(auto|scroll|overlay)/.test(style.overflowY);
    return allowsVerticalScroll && element.scrollHeight > element.clientHeight + 2;
  };

  let elementScroller: HTMLElement | null = card.parentElement;
  while (elementScroller && !isScrollable(elementScroller)) {
    elementScroller = elementScroller.parentElement;
  }

  const documentScroller = document.scrollingElement;
  const scroller =
    elementScroller ??
    (documentScroller instanceof HTMLElement ? documentScroller : document.documentElement);
  if (!scroller) return missed;

  const scrollTop = Math.max(0, scroller.scrollTop);
  const scrollHeight = Math.max(0, scroller.scrollHeight);
  const clientHeight = Math.max(0, scroller.clientHeight || window.innerHeight);
  const maximumTop = Math.max(0, scrollHeight - clientHeight);
  const step = Math.max(480, Math.floor(clientHeight * 0.85));
  const nextTop = Math.min(maximumTop, scrollTop + step);

  if (nextTop > scrollTop + 1) {
    scroller.scrollTo({ top: nextTop, behavior: 'auto' });
  }

  const actualTop = Math.max(0, scroller.scrollTop);
  return {
    selectorMiss: false,
    moved: actualTop > scrollTop + 1,
    atBottom: actualTop >= maximumTop - 2,
    scrollTop: actualTop,
    scrollHeight,
    clientHeight,
  };
}

// ─── 详情页抽取（注入函数，自包含） ───

export interface DetailExtractResult {
  selectorMiss: boolean;
  captcha: boolean;
  pageKind: 'standalone_detail' | 'embedded_detail' | 'unknown';
  /** 页面存在职位卡片但没有可读详情时，上层可给出“请先选中岗位”的明确提示。 */
  hasJobCards: boolean;
  title: string;
  salaryText: string;
  companyName: string;
  jobTags: string[];
  description: string;
  companyIntro: string;
  city: string;
  /** 仅 selectorMiss 时填充：页面 DOM 结构骨架（供 AI 分析改版原因）。 */
  domOutline?: string;
}

/** 在独立详情页或列表页当前展开的详情面板内执行：抽取当前单个岗位。 */
export function extractJobDetail(): DetailExtractResult {
  const result: DetailExtractResult = {
    selectorMiss: false,
    captcha: false,
    pageKind: 'unknown',
    hasJobCards: false,
    title: '',
    salaryText: '',
    companyName: '',
    jobTags: [],
    description: '',
    companyIntro: '',
    city: '',
  };

  const standaloneDetail = /^\/job_detail\/[^/]+\.html$/.test(location.pathname);
  if (standaloneDetail) result.pageKind = 'standalone_detail';

  const bodyText = document.body?.innerText ?? '';
  if (
    location.href.includes('security-check') ||
    location.href.includes('captcha') ||
    /安全验证|请完成验证|异常访问/.test(bodyText.slice(0, 2000))
  ) {
    result.captcha = true;
    return result;
  }

  const blockText = (el: Element | null): string =>
    (el?.textContent ?? '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  const inlineText = (el: Element | null): string =>
    (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

  const isReadable = (element: Element): boolean => {
    let current: Element | null = element;
    while (current) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') {
        return false;
      }
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      current = current.parentElement;
    }
    return true;
  };

  const firstElement = (selectors: string[], scopes: Array<Document | Element>): Element | null => {
    for (const selector of selectors) {
      for (const scope of scopes) {
        const candidates = Array.from(scope.querySelectorAll(selector));
        const found = candidates.find(
          (candidate) => isReadable(candidate) && inlineText(candidate).length > 0,
        );
        if (found) return found;
      }
    }
    return null;
  };

  const firstTexts = (selectors: string[], scopes: Array<Document | Element>): string[] => {
    for (const selector of selectors) {
      const values = scopes
        .flatMap((scope) => Array.from(scope.querySelectorAll(selector)))
        .filter(isReadable)
        .map(inlineText)
        .filter(Boolean);
      const unique = Array.from(new Set(values));
      if (unique.length > 0) return unique;
    }
    return [];
  };

  const descriptionSelectors = [
    '.job-detail-box .job-detail-body > p.desc',
    '.job-detail-body > p.desc',
    '.job-detail-body p.desc',
    '.job-detail-section .job-sec-text',
    '.job-detail-content .job-sec-text',
    '.job-detail-box .job-sec-text',
    '.job-detail .job-sec-text',
    '.job-description-content',
    '.job-description',
    '.job-detail .text',
    '.job-sec-text',
  ];
  const titleSelectors = [
    '.job-primary .name h1',
    '.job-primary .job-name',
    '.info-primary .name h1',
    '.job-detail-header .job-name',
    '.job-detail-header h1',
    '.job-detail-info .job-name',
    '.job-name',
    'h1',
  ];
  const salarySelectors = [
    '.job-primary .salary',
    '.info-primary .salary',
    '.job-detail-header .salary',
    '.job-detail-info .salary',
    '.job-salary',
    '.salary',
  ];
  const detailRootSelectors = [
    '.job-detail-box',
    '.job-detail-container',
    '.job-detail-content',
    '.job-detail-wrapper',
    '.job-detail',
  ];

  result.hasJobCards =
    firstElement(
      [
        'li.job-card-wrapper',
        'li.job-card-box',
        'div.job-card-wrapper',
        'ul.job-list-box > li',
        'a[href*="/job_detail/"]',
      ],
      [document],
    ) !== null;

  const descriptionElement = firstElement(descriptionSelectors, [document]);
  if (descriptionElement) {
    result.description = blockText(descriptionElement);
    if (!standaloneDetail) result.pageKind = 'embedded_detail';

    let detailRoot: Document | Element = document;
    for (const selector of detailRootSelectors) {
      const root = Array.from(document.querySelectorAll(selector)).find(
        (candidate) => isReadable(candidate) && candidate.contains(descriptionElement),
      );
      if (root) {
        detailRoot = root;
        break;
      }
    }

    if (detailRoot === document && standaloneDetail) {
      const main = firstElement(['main', 'article'], [document]);
      if (main?.contains(descriptionElement)) detailRoot = main;
    }

    const scopes =
      detailRoot === document || !standaloneDetail ? [detailRoot] : [detailRoot, document];

    result.title = inlineText(firstElement(titleSelectors, scopes));
    result.salaryText = inlineText(firstElement(salarySelectors, scopes));
    result.companyName = inlineText(
      firstElement(
        [
          '.job-primary .company-name',
          '.job-detail-header .company-name',
          '.job-detail-info .company-name',
          '.company-info .company-name',
          '.company-name a',
          '.company-name',
        ],
        scopes,
      ),
    );
    result.city = inlineText(
      firstElement(
        [
          '.job-primary .text-city',
          '.job-detail-header .text-city',
          '.job-detail-info .text-city',
          '.job-address .job-address-desc',
          '.job-address-desc',
          '.job-address .location-address',
          '.text-city',
          '.job-area',
        ],
        scopes,
      ),
    );
    result.jobTags = firstTexts(
      [
        '.job-primary .tag-list li',
        '.job-detail-header .tag-list li',
        '.job-detail-info .tag-list li',
        '.job-tags li',
        '.job-tags span',
      ],
      scopes,
    );

    const intro = firstElement(
      [
        '.company-info-box .job-sec-text',
        '.company-detail .text',
        '.job-sec.company-info .text',
        '.company-intro .text',
        '.company-intro',
      ],
      scopes,
    );
    result.companyIntro = blockText(intro);
  }

  if (!result.description) {
    result.selectorMiss = true;
    // DOM 骨架快照。注入函数必须自包含，与列表页版本刻意重复。
    const lines: string[] = [];
    const skip = /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|SVG|IFRAME)$/;
    const walk = (el: Element, depth: number): void => {
      if (lines.length >= 120 || skip.test(el.tagName)) return;
      const cls = Array.from(el.classList).slice(0, 2).join('.');
      const childCount = el.children.length;
      const preview =
        childCount === 0 ? (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      lines.push(
        `${'  '.repeat(depth)}${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${childCount ? ` (${childCount}子)` : ''}${preview ? ` "${preview}"` : ''}`,
      );
      if (depth >= 3) return;
      for (const child of Array.from(el.children)) walk(child, depth + 1);
    };
    if (document.body) walk(document.body, 0);
    result.domOutline = `URL: ${location.origin}${location.pathname}\n${lines.join('\n')}`.slice(
      0,
      4000,
    );
  }
  return result;
}

// ─── 页面结构诊断（注入函数，自包含） ───

/**
 * 下载执行日志时在当前 Boss 页面执行，生成可供适配器维护的限量结构快照。
 * 不读取表单值、链接、图片地址、Cookie、Storage 或完整网页源码。
 */
export function captureZhipinPageStructure(): DiagnosticPageStructureSnapshot {
  const capturedAt = Date.now();
  const safePageUrl = `${location.origin}${location.pathname}`;

  const normalizeText = (value: string): string =>
    value
      .replace(/\s+/g, ' ')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]')
      .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号]')
      .replace(/(?<!\d)\d{15,18}[0-9Xx]?(?!\d)/g, '[证件号]')
      .replace(/[A-Za-z0-9_-]{28,}/g, '[长标识]')
      .trim();

  const isVisible = (element: Element): boolean => {
    let current: Element | null = element;
    while (current) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') {
        return false;
      }
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      current = current.parentElement;
    }
    return true;
  };

  const classSuffix = (element: Element): string => {
    const classes = Array.from(element.classList)
      .filter((token) => /^[A-Za-z0-9_-]{1,80}$/.test(token))
      .slice(0, 4);
    return classes.length > 0 ? `.${classes.join('.')}` : '';
  };

  const signature = (element: Element): string =>
    `${element.tagName.toLowerCase()}${classSuffix(element)}`;

  const elementPath = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && parts.length < 7) {
      parts.unshift(signature(current));
      if (current === document.body) break;
      current = current.parentElement;
    }
    return parts.join(' > ');
  };

  const probeGroups = [
    {
      group: '职位列表卡片',
      selectors: [
        'li.job-card-wrapper',
        'li.job-card-box',
        'div.job-card-wrapper',
        'ul.job-list-box > li',
      ],
    },
    {
      group: '详情面板根节点',
      selectors: [
        '.job-detail-container',
        '.job-detail-box',
        '.job-detail-content',
        '.job-detail-wrapper',
        '.job-detail',
      ],
    },
    {
      group: '岗位正文',
      selectors: [
        '.job-detail-box .job-detail-body > p.desc',
        '.job-detail-body > p.desc',
        '.job-detail-body p.desc',
        '.job-detail-section .job-sec-text',
        '.job-detail-content .job-sec-text',
        '.job-detail-box .job-sec-text',
        '.job-detail .job-sec-text',
        '.job-description-content',
        '.job-description',
        '.job-detail .text',
        '.job-sec-text',
      ],
    },
    {
      group: '岗位标题',
      selectors: [
        '.job-primary .name h1',
        '.job-primary .job-name',
        '.info-primary .name h1',
        '.job-detail-header .job-name',
        '.job-detail-header h1',
        '.job-detail-info .job-name',
        '.job-name',
        'h1',
      ],
    },
    {
      group: '薪资',
      selectors: [
        '.job-primary .salary',
        '.info-primary .salary',
        '.job-detail-header .salary',
        '.job-detail-info .salary',
        '.job-salary',
        '.salary',
      ],
    },
    {
      group: '公司名称',
      selectors: [
        '.job-primary .company-name',
        '.job-detail-header .company-name',
        '.job-detail-info .company-name',
        '.company-info .company-name',
        '.company-name a',
        '.company-name',
      ],
    },
  ];

  const selectorProbes = probeGroups.flatMap(({ group, selectors }) =>
    selectors.map((selector) => {
      const matches = Array.from(document.querySelectorAll(selector));
      return {
        group,
        selector,
        matches: matches.length,
        visibleMatches: matches.filter(isVisible).length,
      };
    }),
  );

  const visibleMatchesFor = (group: string): number =>
    selectorProbes
      .filter((probe) => probe.group === group)
      .reduce((total, probe) => total + probe.visibleMatches, 0);

  const visibleDescriptions = visibleMatchesFor('岗位正文');
  const visibleDetailRoots = visibleMatchesFor('详情面板根节点');
  const visibleJobCards = visibleMatchesFor('职位列表卡片');
  const standaloneDetail = /^\/job_detail\/[^/]+\.html$/.test(location.pathname);
  const pageKind = standaloneDetail
    ? 'standalone_detail'
    : visibleDescriptions > 0 || visibleDetailRoots > 0
      ? 'embedded_detail'
      : visibleJobCards > 0
        ? 'job_list'
        : 'unknown';

  const landmarkLabels = ['职位描述', '岗位描述', '职位详情', '工作地址', '立即沟通', '收藏'];
  const landmarks: Array<{ label: string; path: string }> = [];
  const seenLandmarks = new Set<string>();
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && landmarks.length < 18) {
      const parent = node.parentElement;
      if (parent && isVisible(parent)) {
        const text = normalizeText(node.nodeValue ?? '');
        for (const label of landmarkLabels) {
          if (!text.includes(label)) continue;
          const key = `${label}:${elementPath(parent)}`;
          if (!seenLandmarks.has(key)) {
            seenLandmarks.add(key);
            landmarks.push({ label, path: elementPath(parent) });
          }
        }
      }
      node = walker.nextNode();
    }
  }

  const lines: string[] = [];
  const skip = /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|SVG|IFRAME|INPUT|TEXTAREA|SELECT|OPTION)$/;
  const previewTags = /^(H1|H2|H3|H4|H5|H6|BUTTON|LABEL)$/;
  const maxNodes = 600;
  const maxDepth = 10;
  let nodeCount = 0;
  let truncated = false;

  const walk = (element: Element, depth: number): void => {
    if (nodeCount >= maxNodes) {
      truncated = true;
      return;
    }
    if (skip.test(element.tagName) || !isVisible(element)) return;
    nodeCount += 1;

    const childElements = Array.from(element.children).filter(
      (child) => !skip.test(child.tagName) && isVisible(child),
    );
    const shouldPreview = childElements.length === 0 || previewTags.test(element.tagName);
    const preview = shouldPreview ? normalizeText(element.textContent ?? '').slice(0, 48) : '';
    lines.push(
      `${'  '.repeat(depth)}${signature(element)}${childElements.length ? ` (${childElements.length}子)` : ''}${preview ? ` "${preview}"` : ''}`,
    );

    if (depth >= maxDepth) {
      if (childElements.length > 0) truncated = true;
      return;
    }
    for (const child of childElements) walk(child, depth + 1);
  };

  if (document.body) walk(document.body, 0);
  let outline = `URL: ${safePageUrl}\n${lines.join('\n')}`;
  if (outline.length > 50_000) {
    outline = outline.slice(0, 50_000);
    truncated = true;
  }

  return {
    status: 'captured',
    capturedAt,
    pageUrl: safePageUrl,
    pageKind,
    readyState: document.readyState,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    nodeCount,
    truncated,
    selectorProbes,
    landmarks,
    outline,
  };
}

// ─── 薪资解析（后台侧纯函数） ───

/**
 * 解析 Boss 薪资文本为 K/月区间。
 * 支持：「15-25K」「15-25K·14薪」「300-500元/天」「8-12万/年」「面议」。
 * 日薪按 21.75 天/月折算；年薪按 12 月折算。解析失败返回空对象。
 */
export function parseSalary(salaryText: string): { minK?: number; maxK?: number } {
  const s = salaryText.replace(/\s/g, '');
  let m = s.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)K/i);
  if (m) return { minK: Number(m[1]), maxK: Number(m[2]) };
  m = s.match(/^(\d+(?:\.\d+)?)K/i);
  if (m) return { minK: Number(m[1]), maxK: Number(m[1]) };
  m = s.match(/^(\d+)-(\d+)元\/天/);
  if (m) return { minK: (Number(m[1]) * 21.75) / 1000, maxK: (Number(m[2]) * 21.75) / 1000 };
  m = s.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)万\/年/);
  if (m) return { minK: (Number(m[1]) * 10) / 12, maxK: (Number(m[2]) * 10) / 12 };
  return {};
}

/** 列表抽取结果 → 领域实体（补薪资数值解析）。 */
export function toJobPosting(raw: ListExtractResult['jobs'][number]): JobPosting {
  const { minK, maxK } = parseSalary(raw.salaryText);
  return {
    ...raw,
    salaryMinK: minK,
    salaryMaxK: maxK,
    companySize: raw.companySize || undefined,
    area: raw.area || undefined,
    recruiter: raw.recruiter || undefined,
  };
}

/**
 * 硬条件本地过滤：薪资区间有交集才保留（解析不出薪资的保留，交给语义层提示）。
 */
export function passesSalaryFilter(job: JobPosting, params: SearchTaskParams): boolean {
  if (params.salaryMinK == null && params.salaryMaxK == null) return true;
  if (job.salaryMinK == null || job.salaryMaxK == null) return true;
  if (params.salaryMinK != null && job.salaryMaxK < params.salaryMinK) return false;
  if (params.salaryMaxK != null && job.salaryMinK > params.salaryMaxK) return false;
  return true;
}
