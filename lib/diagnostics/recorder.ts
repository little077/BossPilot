// ─── 诊断记录：记录器（内存单例） ───
// 每轮对话/流水线任务：beginRun → step/logLlm/logError → finishRun。
// 记录全程在 background 内存中，导出前统一脱敏（见 report.ts）。仅本机，无遥测。
// 保留最近若干次任务，避免内存无限增长。
//
// 双轨并发：聊天轨（chat）与任务轨（task）各持一个进行中的 run，互不覆盖——
// 用户在流水线任务执行中发起对话，两条时间线各自完整。

import { ADAPTER_VERSION } from '@/lib/adapter/zhipin';
import { hostOf, redact } from './redaction';
import type {
  DiagnosticLlmCall,
  DiagnosticRun,
  DiagnosticRunStatus,
  DiagnosticSource,
} from './types';

/** 内存里保留的历史任务上限。 */
const MAX_RUNS = 50;
/** 单条 LLM 输入消息保留的最大字符数（超出截断，AI 分析时头部信息量最大）。 */
const MAX_MESSAGE_CHARS = 8_000;
/** LLM 输出全文保留的最大字符数。 */
const MAX_OUTPUT_CHARS = 16_000;
/** 单条步骤 detail 保留的最大字符数（如 DOM outline）。 */
const MAX_DETAIL_CHARS = 6_000;

interface DiagnosticModelContext {
  model: string;
  baseUrl: string;
}

function extensionVersion(): string {
  try {
    return chrome.runtime.getManifest().version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 脱敏 + 截断：保留头部并标注被截断的原始长度。 */
function clip(text: string, maxChars: number): string {
  const clean = redact(text);
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}\n…[已截断，原文 ${clean.length} 字]`;
}

class DiagnosticsRecorder {
  private runs: DiagnosticRun[] = [];
  private current = new Map<DiagnosticSource, DiagnosticRun>();

  /** 开一个新任务；同轨道上一个未结束的任务标记为异常收尾（防泄漏 current）。 */
  beginRun(
    source: DiagnosticSource,
    userInput: string,
    config: DiagnosticModelContext,
  ): DiagnosticRun {
    if (this.current.has(source)) this.finishRun(source, 'error', '上一个任务未正常结束');
    const run: DiagnosticRun = {
      runId: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      source,
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
    this.current.set(source, run);
    this.step(source, 'input', '收到用户输入', userInput);
    return run;
  }

  /** 记录一步时间线（summary/detail 会脱敏，detail 超长截断）。 */
  step(
    source: DiagnosticSource,
    kind: DiagnosticRun['steps'][number]['kind'],
    summary: string,
    detail?: string,
  ): void {
    const run = this.current.get(source);
    if (!run) return;
    run.steps.push({
      seq: run.steps.length + 1,
      atMs: Date.now() - run.startedAt,
      kind,
      summary: redact(summary),
      detail: detail ? clip(detail, MAX_DETAIL_CHARS) : undefined,
    });
  }

  /** 记录一次 LLM 调用（含提示词与输出原文），并在时间线上落一步。 */
  logLlm(source: DiagnosticSource, call: DiagnosticLlmCall): void {
    const run = this.current.get(source);
    if (!run) return;
    run.llmCalls.push({
      ...call,
      messages: call.messages?.map((m) => ({
        role: m.role,
        content: clip(m.content, MAX_MESSAGE_CHARS),
      })),
      outputText: call.outputText != null ? clip(call.outputText, MAX_OUTPUT_CHARS) : undefined,
    });
    const usage =
      call.promptTokens != null || call.completionTokens != null
        ? `，token in/out=${call.promptTokens ?? '?'}/${call.completionTokens ?? '?'}`
        : '';
    const purpose = call.purpose ? `［${call.purpose}］` : '';
    const outcome = [
      call.finishReason ? `结束=${call.finishReason}` : '',
      call.toolName ? `工具=${call.toolName}` : '',
    ]
      .filter(Boolean)
      .join('，');
    this.step(
      source,
      'llm',
      `${purpose}调用模型 ${call.model}（${call.latencyMs}ms${call.fellBackToNonStream ? '，非流式降级' : ''}）`,
      `输入 ${call.messageCount} 条/${call.promptChars} 字，输出 ${call.outputChars} 字${usage}${outcome ? `，${outcome}` : ''}（原文见 LLM 调用明细 #${run.llmCalls.length}）`,
    );
  }

  /** 记录一次错误（会写入 errorSummary，供报告顶部高亮）。 */
  logError(source: DiagnosticSource, message: string): void {
    const run = this.current.get(source);
    if (!run) return;
    run.errorSummary = redact(message);
    this.step(source, 'error', '发生错误', message);
  }

  /** 结束当前任务并入库。 */
  finishRun(source: DiagnosticSource, status: DiagnosticRunStatus, errorSummary?: string): void {
    const run = this.current.get(source);
    if (!run) return;
    run.status = status;
    run.endedAt = Date.now();
    if (errorSummary && !run.errorSummary) run.errorSummary = redact(errorSummary);
    this.runs.push(run);
    if (this.runs.length > MAX_RUNS) this.runs = this.runs.slice(-MAX_RUNS);
    this.current.delete(source);
  }

  /** 是否有可导出的历史任务。 */
  hasData(): boolean {
    return this.runs.length > 0 || this.current.size > 0;
  }

  /** 取全部任务（含尚未结束的进行中任务）用于导出，按开始时间排序。 */
  snapshotRuns(): DiagnosticRun[] {
    return [...this.runs, ...this.current.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** 清空（「新对话」时可选调用）。 */
  clear(): void {
    this.runs = [];
    this.current.clear();
  }
}

/** background 全局单例。 */
export const recorder = new DiagnosticsRecorder();
