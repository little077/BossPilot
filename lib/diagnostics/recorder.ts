// ─── 诊断记录：记录器（内存单例） ───
// 每轮对话/流水线任务：beginRun → step/logLlm/logError → finishRun。
// 记录全程在 background 内存中，导出前统一脱敏（见 report.ts）。仅本机，无遥测。
// 保留最近若干次任务，避免内存无限增长。
//
// 双轨并发：聊天轨（chat）与任务轨（task）各持进行中的 run，互不覆盖——
// 用户在流水线任务执行中发起对话，两条时间线各自完整。
// 多会话并行：chat 轨按 conversationId 隔离（Map<conversationId, run>），
// 每个会话一条独立时间线；不带 conversationId 的调用归入全局占位轨。

import { ADAPTER_VERSION } from '@/lib/adapter/zhipin';
import { hostOf, redact } from './redaction';
import type {
  DiagnosticContextSnapshot,
  DiagnosticEvent,
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
/** 不带 conversationId 的 chat 调用使用的占位轨道（兼容旧调用方）。 */
const GLOBAL_CHAT_KEY = '__global__';

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
  /** chat 轨：conversationId → 进行中的 run（多会话隔离）。 */
  private currentChat = new Map<string, DiagnosticRun>();
  /** task 轨：单个进行中的 run。 */
  private currentTask: DiagnosticRun | null = null;

  /** 定位进行中的 run；chat 轨按 conversationId 隔离。 */
  private currentRun(source: DiagnosticSource, conversationId?: string): DiagnosticRun | undefined {
    return source === 'task'
      ? (this.currentTask ?? undefined)
      : this.currentChat.get(conversationId ?? GLOBAL_CHAT_KEY);
  }

  private setCurrentRun(
    source: DiagnosticSource,
    run: DiagnosticRun | null,
    conversationId?: string,
  ): void {
    if (source === 'task') this.currentTask = run;
    else if (run) this.currentChat.set(conversationId ?? GLOBAL_CHAT_KEY, run);
    else this.currentChat.delete(conversationId ?? GLOBAL_CHAT_KEY);
  }

  /** 开一个新任务；同轨道（同会话）上一个未结束的任务标记为异常收尾（防泄漏 current）。 */
  beginRun(
    source: DiagnosticSource,
    userInput: string,
    config: DiagnosticModelContext,
    conversationId?: string,
  ): DiagnosticRun {
    const previous = this.currentRun(source, conversationId);
    if (previous) this.finishRun(source, 'error', '上一个任务未正常结束', conversationId);
    const run: DiagnosticRun = {
      runId: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      source,
      userInput: redact(userInput),
      conversationId: source === 'chat' ? conversationId : undefined,
      model: config.model,
      baseUrlHost: hostOf(config.baseUrl),
      extensionVersion: extensionVersion(),
      adapterVersion: ADAPTER_VERSION,
      startedAt: Date.now(),
      status: 'completed',
      steps: [],
      llmCalls: [],
      events: [],
      contextSnapshots: [],
    };
    this.setCurrentRun(source, run, conversationId);
    this.step(source, 'input', '收到用户输入', userInput, conversationId);
    return run;
  }

  /** 记录一步时间线（summary/detail 会脱敏，detail 超长截断）。 */
  step(
    source: DiagnosticSource,
    kind: DiagnosticRun['steps'][number]['kind'],
    summary: string,
    detail?: string,
    conversationId?: string,
  ): void {
    const run = this.currentRun(source, conversationId);
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
  logLlm(source: DiagnosticSource, call: DiagnosticLlmCall, conversationId?: string): void {
    const run = this.currentRun(source, conversationId);
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
      conversationId,
    );
  }

  /** 记录一次错误（会写入 errorSummary，供报告顶部高亮）。 */
  logError(source: DiagnosticSource, message: string, conversationId?: string): void {
    const run = this.currentRun(source, conversationId);
    if (!run) return;
    run.errorSummary = redact(message);
    this.step(source, 'error', '发生错误', message, conversationId);
  }

  /** 记录一条 Agent 事件流摘要（ChatGenerationEvent）。 */
  logEvent(
    conversationId: string | undefined,
    event: { type: string; requestId: string; summary: string },
  ): void {
    const run = this.currentChat.get(conversationId ?? GLOBAL_CHAT_KEY);
    if (!run) return;
    const entry: DiagnosticEvent = {
      atMs: Date.now() - run.startedAt,
      type: event.type,
      requestId: event.requestId,
      summary: redact(event.summary),
    };
    run.events = run.events ?? [];
    run.events.push(entry);
  }

  /** 记录一条 Agent 内部状态快照（ToolContext 内容、运行状态等）。 */
  logContext(
    conversationId: string | undefined,
    phase: string,
    summary: string,
    detail?: string,
  ): void {
    const run = this.currentChat.get(conversationId ?? GLOBAL_CHAT_KEY);
    if (!run) return;
    const entry: DiagnosticContextSnapshot = {
      atMs: Date.now() - run.startedAt,
      phase,
      summary: redact(summary),
      detail: detail ? clip(detail, MAX_DETAIL_CHARS) : undefined,
    };
    run.contextSnapshots = run.contextSnapshots ?? [];
    run.contextSnapshots.push(entry);
  }

  /** 结束当前任务并入库。 */
  finishRun(
    source: DiagnosticSource,
    status: DiagnosticRunStatus,
    errorSummary?: string,
    conversationId?: string,
  ): void {
    const run = this.currentRun(source, conversationId);
    if (!run) return;
    run.status = status;
    run.endedAt = Date.now();
    if (errorSummary && !run.errorSummary) run.errorSummary = redact(errorSummary);
    this.runs.push(run);
    if (this.runs.length > MAX_RUNS) this.runs = this.runs.slice(-MAX_RUNS);
    this.setCurrentRun(source, null, conversationId);
  }

  /** 是否有可导出的历史任务。 */
  hasData(): boolean {
    return this.runs.length > 0 || this.currentChat.size > 0 || this.currentTask !== null;
  }

  /** 取全部任务（含尚未结束的进行中任务）用于导出，按开始时间排序。 */
  snapshotRuns(): DiagnosticRun[] {
    return [
      ...this.runs,
      ...this.currentChat.values(),
      ...(this.currentTask ? [this.currentTask] : []),
    ].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** 清空（「新对话」时可选调用；不传清全部，传 conversationId 只清该会话 chat 轨）。 */
  clear(conversationId?: string): void {
    if (conversationId) {
      this.currentChat.delete(conversationId);
      this.runs = this.runs.filter((run) => run.conversationId !== conversationId);
      return;
    }
    this.runs = [];
    this.currentChat.clear();
    this.currentTask = null;
  }
}

/** background 全局单例。 */
export const recorder = new DiagnosticsRecorder();
