// ─── 诊断记录：记录器（内存单例） ───
// 每轮对话/任务：beginRun → step/logLlm/logError → finishRun。
// 记录全程在 background 内存中，导出前统一脱敏（见 report.ts）。仅本机，无遥测。
// 保留最近若干次任务，避免内存无限增长。

import { ADAPTER_VERSION } from '@/lib/adapter/zhipin';
import type { LlmConfig } from '@/lib/domain/types';
import { hostOf, redact } from './redaction';
import type { DiagnosticLlmCall, DiagnosticRun, DiagnosticRunStatus } from './types';

/** 内存里保留的历史任务上限。 */
const MAX_RUNS = 50;

function extensionVersion(): string {
  try {
    return chrome.runtime.getManifest().version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

class DiagnosticsRecorder {
  private runs: DiagnosticRun[] = [];
  private current: DiagnosticRun | null = null;

  /** 开一个新任务；同时把上一个未结束的任务标记为异常收尾（防泄漏 current）。 */
  beginRun(userInput: string, config: LlmConfig): DiagnosticRun {
    if (this.current) this.finishRun('error', '上一个任务未正常结束');
    const run: DiagnosticRun = {
      runId: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      userInput: redact(userInput),
      model: config.model,
      baseUrlHost: hostOf(config.baseUrl),
      extensionVersion: extensionVersion(),
      adapterVersion: ADAPTER_VERSION,
      startedAt: Date.now(),
      status: 'completed',
      steps: [],
      llmCalls: [],
    };
    this.current = run;
    this.step('input', '收到用户输入', userInput);
    return run;
  }

  /** 记录一步时间线（summary/detail 会脱敏）。 */
  step(kind: DiagnosticRun['steps'][number]['kind'], summary: string, detail?: string): void {
    const run = this.current;
    if (!run) return;
    run.steps.push({
      seq: run.steps.length + 1,
      atMs: Date.now() - run.startedAt,
      kind,
      summary: redact(summary),
      detail: detail ? redact(detail) : undefined,
    });
  }

  /** 记录一次 LLM 调用摘要，并在时间线上落一步。 */
  logLlm(call: DiagnosticLlmCall): void {
    const run = this.current;
    if (!run) return;
    run.llmCalls.push(call);
    const usage =
      call.promptTokens != null || call.completionTokens != null
        ? `，token in/out=${call.promptTokens ?? '?'}/${call.completionTokens ?? '?'}`
        : '';
    this.step(
      'llm',
      `调用模型 ${call.model}（${call.latencyMs}ms${call.fellBackToNonStream ? '，非流式降级' : ''}）`,
      `输入 ${call.messageCount} 条/${call.promptChars} 字，输出 ${call.outputChars} 字${usage}`,
    );
  }

  /** 记录一次错误（会写入 errorSummary，供报告顶部高亮）。 */
  logError(message: string): void {
    const run = this.current;
    if (!run) return;
    run.errorSummary = redact(message);
    this.step('error', '发生错误', message);
  }

  /** 结束当前任务并入库。 */
  finishRun(status: DiagnosticRunStatus, errorSummary?: string): void {
    const run = this.current;
    if (!run) return;
    run.status = status;
    run.endedAt = Date.now();
    if (errorSummary && !run.errorSummary) run.errorSummary = redact(errorSummary);
    this.runs.push(run);
    if (this.runs.length > MAX_RUNS) this.runs = this.runs.slice(-MAX_RUNS);
    this.current = null;
  }

  /** 是否有可导出的历史任务。 */
  hasData(): boolean {
    return this.runs.length > 0 || this.current != null;
  }

  /** 取全部任务（含尚未结束的当前任务）用于导出。 */
  snapshotRuns(): DiagnosticRun[] {
    return this.current ? [...this.runs, this.current] : [...this.runs];
  }

  /** 清空（「新对话」时可选调用）。 */
  clear(): void {
    this.runs = [];
    this.current = null;
  }
}

/** background 全局单例。 */
export const recorder = new DiagnosticsRecorder();
