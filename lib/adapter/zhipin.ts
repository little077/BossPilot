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

import type { JobPosting, SearchTaskParams } from '@/lib/domain/types';
import { cityToCode } from './city-codes';

export const ZHIPIN_ORIGIN = 'https://www.zhipin.com';

/** 适配层版本号——选择器契约变更时递增，用于诊断与缓存失效。 */
export const ADAPTER_VERSION = 1;

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
export function isZhipinUrl(url: string | undefined): boolean {
  return !!url && url.startsWith(ZHIPIN_ORIGIN);
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
    const companyName = text(
      card.querySelector('.company-name a, .company-name, .boss-name'),
    );
    const area = text(card.querySelector('.job-area, .company-location'));

    // 职位标签（经验/学历）与公司标签（融资/规模/行业）分属两个 tag 容器
    const jobTags = Array.from(
      card.querySelectorAll('.job-info .tag-list li, ul.tag-list li'),
    ).map((el) => text(el)).filter(Boolean);
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
      url: href.startsWith('http') ? href : 'https://www.zhipin.com' + href,
    });
  }

  if (result.jobs.length === 0) result.selectorMiss = true;

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

// ─── 详情页抽取（注入函数，自包含） ───

export interface DetailExtractResult {
  selectorMiss: boolean;
  captcha: boolean;
  description: string;
  companyIntro: string;
  city: string;
}

/** 在职位详情页内执行：抽取完整 JD 与公司介绍。 */
export function extractJobDetail(): DetailExtractResult {
  const result: DetailExtractResult = {
    selectorMiss: false,
    captcha: false,
    description: '',
    companyIntro: '',
    city: '',
  };

  const bodyText = document.body?.innerText ?? '';
  if (
    location.href.includes('security-check') ||
    /安全验证|请完成验证|异常访问/.test(bodyText.slice(0, 2000))
  ) {
    result.captcha = true;
    return result;
  }

  const text = (el: Element | null): string =>
    (el?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  const desc = document.querySelector(
    '.job-sec-text, .job-detail-section .job-sec-text, .job-detail .text',
  );
  result.description = text(desc);

  const intro = document.querySelector(
    '.company-info-box .job-sec-text, .company-detail .text, .job-sec.company-info .text',
  );
  result.companyIntro = text(intro);

  const cityEl = document.querySelector('.text-city, .job-primary .text-city');
  result.city = text(cityEl);

  if (!result.description) result.selectorMiss = true;
  return result;
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
