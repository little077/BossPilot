// ─── Background 任务编排器（三段式流水线核心） ───
//
// ① 意图解析（1 次 LLM）→ ② 确定性采集（0 次 LLM，适配层 + chrome.scripting）
// → ③ 批量语义评估（1~N 次 LLM）。
//
// 设计要点：
// - 单例：同一时刻只允许一个任务在跑（风控 + 简化状态管理）。
// - 快照广播：所有状态变化都通过 onSnapshot 回调推给已连接的侧边栏。
// - 验证码人机协同：检测到验证码 → phase=paused_captcha，等用户在页面上
//   手动通过后点「继续」（resumeCaptcha()）。
// - 取消：AbortController 贯穿所有 sleep / fetch / 循环检查点。

import {
  buildSearchUrl,
  extractJobDetail,
  extractJobList,
  isZhipinUrl,
  type ListExtractResult,
  passesSalaryFilter,
  toJobPosting,
} from '@/lib/adapter/zhipin';
import type {
  AssessedJob,
  JobAssessment,
  JobPosting,
  SearchTaskParams,
  TaskSnapshot,
} from '@/lib/domain/types';
import { assessJobs, parseIntent } from '@/lib/llm/prompts';
import { getLlmConfig, getUserProfile } from '@/lib/storage/config';
import { detailDelay, pageDelay, renderWait, sleep } from './throttle';

type SnapshotListener = (snapshot: TaskSnapshot) => void;
type LogListener = (level: 'info' | 'warn' | 'error', text: string) => void;

/** 验证码等待的挂起句柄。 */
interface CaptchaGate {
  resolve: () => void;
  reject: (e: unknown) => void;
}

const MAX_PAGES = 5; // 翻页硬上限（风控）

export class Orchestrator {
  private snapshot: TaskSnapshot = emptySnapshot();
  private abort: AbortController | null = null;
  private captchaGate: CaptchaGate | null = null;
  private workTabId: number | null = null;
  private snapshotListeners = new Set<SnapshotListener>();
  private logListeners = new Set<LogListener>();

  // ─── 订阅 ───

  onSnapshot(fn: SnapshotListener): () => void {
    this.snapshotListeners.add(fn);
    return () => this.snapshotListeners.delete(fn);
  }

  onLog(fn: LogListener): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }

  getSnapshot(): TaskSnapshot {
    return this.snapshot;
  }

  get running(): boolean {
    const p = this.snapshot.phase;
    return p !== 'idle' && p !== 'done' && p !== 'error' && p !== 'cancelled';
  }

  // ─── 对外操作 ───

  /** 仅解析意图，不执行（UI「先确认再跑」）。 */
  async parseOnly(text: string): Promise<SearchTaskParams> {
    const config = await getLlmConfig();
    return parseIntent(config, text);
  }

  /** 自然语言直接跑：解析 → 执行。 */
  async runNaturalLanguage(text: string): Promise<void> {
    if (this.running) throw new Error('已有任务在执行中，请先取消。');
    this.reset();
    this.patch({ phase: 'parsing', statusText: '正在理解你的需求…' });
    let params: SearchTaskParams;
    try {
      const config = await getLlmConfig();
      params = await parseIntent(config, text, this.requireSignal());
    } catch (e) {
      this.fail(e);
      return;
    }
    this.log(
      'info',
      `解析完成：${params.keyword} @ ${params.city}，软条件 ${params.softConditions.length} 条，目标 ${params.maxJobs} 个岗位。`,
    );
    await this.execute(params);
  }

  /** 用结构化参数直接跑（任务卡片确认后）。 */
  async runWithParams(params: SearchTaskParams): Promise<void> {
    if (this.running) throw new Error('已有任务在执行中，请先取消。');
    this.reset();
    await this.execute(params);
  }

  /** 取消当前任务。 */
  cancel(): void {
    if (!this.running) return;
    this.abort?.abort();
    this.captchaGate?.reject(new DOMException('Aborted', 'AbortError'));
    this.captchaGate = null;
    this.patch({ phase: 'cancelled', statusText: '任务已取消。' });
  }

  /** 用户宣布已手动通过验证码，恢复流水线。 */
  resumeCaptcha(): void {
    if (this.snapshot.phase !== 'paused_captcha' || !this.captchaGate) return;
    const gate = this.captchaGate;
    this.captchaGate = null;
    gate.resolve();
  }

  // ─── 流水线主体 ───

  private async execute(params: SearchTaskParams): Promise<void> {
    const signal = this.requireSignal();
    this.patch({ params });
    try {
      const config = await getLlmConfig();

      // ── ② 确定性采集 ──
      const jobs = await this.collect(params, signal);
      if (jobs.length === 0) {
        this.patch({
          phase: 'done',
          statusText: '没有采集到岗位——可能是搜索无结果，或站点改版导致适配层失配。',
        });
        return;
      }

      // 详情抓取（可选）
      if (params.fetchDetails) {
        await this.fillDetails(jobs, signal);
      }

      // ── ③ 批量语义评估 ──
      this.patch({ phase: 'assessing', statusText: `正在对 ${jobs.length} 个岗位做语义评估…` });
      const profile = await getUserProfile();
      const batchSize = Math.max(1, config.batchSize ?? 10);
      const assessments: JobAssessment[] = [];
      for (let i = 0; i < jobs.length; i += batchSize) {
        throwIfAborted(signal);
        const batch = jobs.slice(i, i + batchSize);
        this.patch({
          statusText: `语义评估中（${Math.min(i + batch.length, jobs.length)}/${jobs.length}）…`,
        });
        const res = await assessJobs(config, batch, params, profile, signal);
        assessments.push(...res);
        this.patch({
          assessed: assessments.length,
          jobs: mergeAssessed(jobs, assessments),
        });
      }
      const assessed = mergeAssessed(jobs, assessments);
      const passedCount = assessed.filter((j) => j.assessment.passed).length;
      this.patch({
        phase: 'done',
        statusText: `完成：共 ${assessed.length} 个岗位，${passedCount} 个通过筛选。`,
        jobs: assessed,
      });
      this.log('info', '岗位评估完成，可在「结果」页查看。');
    } catch (e) {
      if (isAbort(e)) {
        // cancel() 已把 phase 置为 cancelled；这里不覆盖
        if (this.snapshot.phase !== 'cancelled') {
          this.patch({ phase: 'cancelled', statusText: '任务已取消。' });
        }
        return;
      }
      this.fail(e);
    }
  }

  /** ② 确定性采集：开工作页 → 逐页导航 → 注入抽取 → 本地硬过滤。 */
  private async collect(params: SearchTaskParams, signal: AbortSignal): Promise<JobPosting[]> {
    this.patch({ phase: 'searching', statusText: '正在打开 Boss 直聘搜索页…' });
    const collected: JobPosting[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= MAX_PAGES; page++) {
      throwIfAborted(signal);
      const url = buildSearchUrl(params, page);
      await this.navigate(url, signal);
      await renderWait(signal);

      this.patch({ phase: 'collecting', statusText: `正在采集第 ${page} 页…` });
      const res = await this.runExtraction(page, signal);

      if (res.selectorMiss) {
        this.log(
          'warn',
          `第 ${page} 页未匹配到职位卡片——站点可能改版（适配层 v1），或搜索无结果。`,
        );
        break;
      }

      for (const raw of res.jobs) {
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        const job = toJobPosting(raw);
        if (!passesSalaryFilter(job, params)) continue;
        collected.push(job);
        if (collected.length >= params.maxJobs) break;
      }
      this.patch({
        collected: collected.length,
        statusText: `已采集 ${collected.length}/${params.maxJobs} 个岗位（第 ${page} 页）…`,
      });

      if (collected.length >= params.maxJobs || !res.hasNextPage) break;
      await pageDelay(signal);
    }
    return collected;
  }

  /** 列表抽取 + 验证码人机协同重试（同一页最多等 1 次验证码）。 */
  private async runExtraction(page: number, signal: AbortSignal): Promise<ListExtractResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      throwIfAborted(signal);
      const res = await this.inject(extractJobList);
      if (!res.captcha) return res;
      this.log('warn', `第 ${page} 页遇到安全验证，请在页面上手动完成验证后点击「继续」。`);
      await this.waitCaptcha(signal);
      await renderWait(signal);
    }
    // 两次仍是验证码：放弃这一页
    return { selectorMiss: true, captcha: true, jobs: [], hasNextPage: false };
  }

  /** 详情抓取：逐个导航到详情页，注入抽取 JD 全文。 */
  private async fillDetails(jobs: JobPosting[], signal: AbortSignal): Promise<void> {
    this.patch({ phase: 'detailing', statusText: '正在读取岗位详情…' });
    for (const [index, job] of jobs.entries()) {
      throwIfAborted(signal);
      this.patch({ statusText: `读取详情（${index + 1}/${jobs.length}）：${job.title}` });
      try {
        await this.navigate(job.url, signal);
        await renderWait(signal);
        let res = await this.inject(extractJobDetail);
        if (res.captcha) {
          this.log('warn', '详情页遇到安全验证，请手动完成后点击「继续」。');
          await this.waitCaptcha(signal);
          await renderWait(signal);
          res = await this.inject(extractJobDetail);
        }
        if (!res.captcha && !res.selectorMiss) {
          job.description = res.description || undefined;
          job.companyIntro = res.companyIntro || undefined;
          if (!job.city && res.city) job.city = res.city;
          // 详情页薪资可能比列表更准——不覆盖，列表数据已够用
        }
      } catch (e) {
        if (isAbort(e)) throw e;
        this.log('warn', `读取「${job.title}」详情失败，按列表信息评估。`);
      }
      if (index < jobs.length - 1) await detailDelay(signal);
    }
  }

  // ─── 浏览器操作 ───

  /** 获取（或创建）专用工作标签页并导航到目标 URL。 */
  private async navigate(url: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    let tab: chrome.tabs.Tab | undefined;
    if (this.workTabId != null) {
      tab = await chrome.tabs.get(this.workTabId).catch(() => undefined);
    }
    if (!tab) {
      // 优先复用已打开的 zhipin 标签页（保留登录态所在会话）
      const existing = await chrome.tabs.query({ url: 'https://www.zhipin.com/*' });
      tab = existing[0];
    }
    if (tab?.id != null) {
      this.workTabId = tab.id;
      await chrome.tabs.update(tab.id, { url, active: true });
    } else {
      const created = await chrome.tabs.create({ url, active: true });
      this.workTabId = created.id ?? null;
    }
    if (this.workTabId == null) throw new Error('无法创建工作标签页。');
    await this.waitTabComplete(this.workTabId, signal);
  }

  /** 等待标签页加载完成（轮询 status，SPA 另有 renderWait 兜底）。 */
  private async waitTabComplete(tabId: number, signal: AbortSignal): Promise<void> {
    for (let i = 0; i < 60; i++) {
      throwIfAborted(signal);
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab) throw new Error('工作标签页已被关闭。');
      if (tab.status === 'complete' && isZhipinUrl(tab.url)) return;
      if (tab.status === 'complete' && tab.url && !isZhipinUrl(tab.url)) {
        // 被重定向出站（如登录页跳转）——交给上层的 selectorMiss/captcha 处理
        return;
      }
      await sleep(500, signal);
    }
    throw new Error('页面加载超时。');
  }

  /** 在工作标签页注入自包含函数并取回结构化结果。 */
  private async inject<T>(fn: () => T): Promise<T> {
    if (this.workTabId == null) throw new Error('工作标签页不存在。');
    const results = await chrome.scripting.executeScript({
      target: { tabId: this.workTabId },
      func: fn,
    });
    const value = results?.[0]?.result;
    if (value == null) throw new Error('页面脚本执行失败（可能页面还在加载）。');
    return value as T;
  }

  /** 挂起等待用户手动通过验证码。 */
  private waitCaptcha(signal: AbortSignal): Promise<void> {
    const prevPhase = this.snapshot.phase;
    this.patch({
      phase: 'paused_captcha',
      statusText: '遇到安全验证：请在页面上手动完成验证，然后点击「继续」。',
    });
    return new Promise<void>((resolve, reject) => {
      this.captchaGate = {
        resolve: () => {
          this.patch({ phase: prevPhase, statusText: '验证已通过，继续执行…' });
          resolve();
        },
        reject,
      };
      signal.addEventListener(
        'abort',
        () => {
          if (this.captchaGate) {
            this.captchaGate = null;
            reject(new DOMException('Aborted', 'AbortError'));
          }
        },
        { once: true },
      );
    });
  }

  /** 由 content script 上报验证码（用户手动浏览详情时也可能触发）。 */
  notifyCaptchaFromContent(): void {
    if (this.running && this.snapshot.phase !== 'paused_captcha') {
      this.log('warn', '页面检测到安全验证。');
    }
  }

  // ─── 内部状态 ───

  private requireSignal(): AbortSignal {
    if (!this.abort) throw new Error('任务控制器尚未初始化。');
    return this.abort.signal;
  }

  private reset(): void {
    this.abort?.abort();
    this.abort = new AbortController();
    this.captchaGate = null;
    this.snapshot = {
      ...emptySnapshot(),
      taskId: `task-${Date.now().toString(36)}`,
    };
    this.emit();
  }

  private patch(p: Partial<TaskSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...p };
    this.emit();
  }

  private emit(): void {
    for (const fn of this.snapshotListeners) fn(this.snapshot);
  }

  private log(level: 'info' | 'warn' | 'error', text: string): void {
    for (const fn of this.logListeners) fn(level, text);
  }

  private fail(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.patch({ phase: 'error', statusText: `任务失败：${msg}`, error: msg });
    this.log('error', msg);
  }
}

// ─── 工具函数 ───

function emptySnapshot(): TaskSnapshot {
  return {
    taskId: '',
    phase: 'idle',
    statusText: '',
    collected: 0,
    assessed: 0,
    jobs: [],
  };
}

function mergeAssessed(jobs: JobPosting[], assessments: JobAssessment[]): AssessedJob[] {
  const byId = new Map(assessments.map((a) => [a.jobId, a]));
  return jobs.flatMap((job) => {
    const assessment = byId.get(job.id);
    return assessment ? [{ ...job, assessment }] : [];
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

/** background 全局单例。 */
export const orchestrator = new Orchestrator();
