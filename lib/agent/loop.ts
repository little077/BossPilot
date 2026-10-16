// ─── 有界 model–tool 循环（阶段 3 核心） ───
// 把编排从「一来一回」升级为「为一个目标连续多步推进」：模型每圈自主决定「再调哪个工具 /
// 是否收敛」，而**轮次、token 预算、取消、结束原因全部由这段确定性代码裁决**——模型只选
// 工具与传参，绝不掌握流程控制（心法 1、3）。LangGraph 方案已否决（新依赖 + MV3 SW 适配
// 错位 + 调试黑盒），这里用最小手写 while 把既有 bindTools 流包一层，零新依赖、步步可断点。
//
// 上下文有界两条来源（方案 A）：
// - 源②「步进老化」在本文件：往返步数达阈值后，除最近 KEEP_RECENT_STEPS 步外，更早工具
//   步的引用卡预览撤下、只留工件编号（全文仍在档案柜，模型可 read_artifact 取回）；
// - 源①「高水位 LLM 摘要」在 compaction.ts，循环启动前对会话历史做批量压缩，本文件只接收
//   已压好的消息窗口（deps 传入），不感知摘要算法——保持「循环管流程、压缩管内容」的分层。

import { AIMessage, type BaseMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { ParsedToolCall, ToolBoundEvent } from '@/lib/chat/model';
import type { EndReason, TokenUsage } from '@/lib/diagnostics/trace';
import { type ToolArgs, type ToolContext, type ToolResult, toolError } from '@/lib/tools/types';

/** 最大轮次：硬上限，触顶即停并收尾（风控类参数，放宽需先开 Issue 讨论）。 */
export const MAX_TURNS = 8;
/** 每条用户消息的 token 预算：仅按「实测累计」核算；拿不到实测就不据此判停（不臆测）。 */
export const TOKEN_BUDGET = 50_000;
/** 步进老化起点：往返步数达到该值后才开始老化，避免过早丢预览。 */
export const AGING_START_STEPS = 5;
/** 老化时保留原文的最近步数：最近 N 步预览不撤下（保「最近上下文」）。 */
export const KEEP_RECENT_STEPS = 2;

/** 触顶/超预算后的收尾指令：基于已有结果交代进展与未完成项，绝不再调工具。 */
export const WRAP_UP_INSTRUCTION =
  '已达到本次任务的执行上限（轮次或预算）。请基于当前已获得的信息，用中文向用户如实总结：' +
  '已完成的部分、仍未完成的部分以及被中断的原因。不要再调用任何工具。';

/** 注入依赖：把「生成 / 执行 / 门禁」的副作用收口成可 mock 的接口，循环本体保持纯逻辑。 */
export interface LoopDeps {
  /** 带工具生成一轮（复用 model.streamBoundMessages）。 */
  streamBound: (messages: BaseMessage[], signal: AbortSignal) => AsyncGenerator<ToolBoundEvent>;
  /** 不带工具生成（收尾用，复用 model.streamPlainMessages）。 */
  streamPlain: (messages: BaseMessage[], signal: AbortSignal) => AsyncGenerator<string>;
  /** 确定性执行工具（registry.executeTool，内含阶段 2 落地关口）。 */
  executeTool: (name: string, args: ToolArgs, ctx: ToolContext) => Promise<ToolResult>;
  /** 门禁：每圈工具执行必经；只读工具恒放行，为阶段 5 写操作预留用户确认位点。 */
  beforeToolCall: (name: string) => boolean;
}

/** 运行选项：默认取硬编码常量，测试可注入更小的上限与假时钟。 */
export interface LoopOptions {
  maxTurns?: number;
  tokenBudget?: number;
  /** 可注入时钟（测试确定性），缺省 Date.now。 */
  now?: () => number;
  /** 事件出口：background 逐事件映射到 broadcast 与 TraceStep。 */
  onEvent: (event: LoopEvent) => void;
}

/**
 * 循环事件流：与既有编排对齐，background 据此驱动 UI 卡片与 trace。
 * - text：逐 token 正文增量（跨多步累积到同一条 assistant 消息）；
 * - step_start/step_end：一次生成或一次工具执行的边界（含耗时/状态/摘要/工件号）；
 * - loop_end：终局，携带结束原因、轮次与实测用量。
 */
export type LoopEvent =
  | { type: 'text'; text: string }
  | { type: 'step_start'; index: number; kind: 'generation' | 'tool'; tool?: string }
  | {
      type: 'step_end';
      index: number;
      kind: 'generation' | 'tool';
      tool?: string;
      status: 'ok' | 'error';
      ms: number;
      errorCode?: string;
      summary?: string;
      artifactId?: string;
    }
  | { type: 'loop_end'; endReason: EndReason; turns: number; tokens: TokenUsage };

interface LoopStep {
  call: ParsedToolCall;
  result: ToolResult;
}

/**
 * 运行有界循环。异常（API 报错）不在此吞掉——交由 background 外层 try/catch 映射为
 * 'error'/'cancelled' 终态并补记 trace，保持错误处理通道与既有编排一致。
 */
export async function runBoundedAgentLoop(
  deps: LoopDeps,
  history: BaseMessage[],
  signal: AbortSignal,
  options: LoopOptions,
): Promise<void> {
  const maxTurns = options.maxTurns ?? MAX_TURNS;
  const tokenBudget = options.tokenBudget ?? TOKEN_BUDGET;
  const now = options.now ?? Date.now;
  const emit = options.onEvent;

  let turnCount = 0;
  let stepIndex = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let measured = false;
  let endReason: EndReason | null = null;
  const steps: LoopStep[] = [];

  /** 组装本圈窗口：历史（含摘要/尾段，已由上游压好）+ 本循环往返消息（按位置决定是否老化）。 */
  const buildWindow = (): BaseMessage[] => {
    const window = [...history];
    const total = steps.length;
    for (const [i, step] of steps.entries()) {
      window.push(
        new AIMessage({
          content: '',
          tool_calls: [{ name: step.call.name, args: step.call.args, id: step.call.id }],
        }),
      );
      window.push(
        new ToolMessage({
          content: toolContentFor(step, i, total),
          tool_call_id: step.call.id,
        }),
      );
    }
    return window;
  };

  while (turnCount < maxTurns) {
    if (signal.aborted) {
      endReason = 'cancelled';
      break;
    }

    // ① 带工具生成一步
    const genIndex = stepIndex++;
    emit({ type: 'step_start', index: genIndex, kind: 'generation' });
    const genStart = now();
    let call: ParsedToolCall | null = null;
    let invalidName: string | null = null;
    for await (const event of deps.streamBound(buildWindow(), signal)) {
      if (event.type === 'text') {
        emit({ type: 'text', text: event.text });
      } else if (event.type === 'tool_call') {
        call = event.call;
      } else if (event.type === 'tool_call_invalid') {
        invalidName = event.name || '未知工具';
      } else {
        totalInput += event.input;
        totalOutput += event.output;
        measured = true;
      }
    }
    const genMs = now() - genStart;

    // 取消优先于一切终态判定
    if (signal.aborted) {
      emit({ type: 'step_end', index: genIndex, kind: 'generation', status: 'ok', ms: genMs });
      endReason = 'cancelled';
      break;
    }

    turnCount += 1;

    // 非法工具调用：如实判错终止，不猜参数、不继续生成
    if (invalidName !== null) {
      emit({
        type: 'step_end',
        index: genIndex,
        kind: 'generation',
        status: 'error',
        ms: genMs,
        errorCode: 'invalid_arguments',
      });
      endReason = 'error';
      break;
    }

    emit({ type: 'step_end', index: genIndex, kind: 'generation', status: 'ok', ms: genMs });

    // token 预算（实测累计）超限：判停并留给收尾交代
    if (measured && totalInput + totalOutput > tokenBudget) {
      endReason = 'budget_exceeded';
      break;
    }

    // ② 无工具调用 → 自然收敛完成
    if (!call) {
      endReason = 'completed';
      break;
    }

    // ③ 有工具调用：门禁每圈必经 → 确定性执行 → 成对追加到往返列表
    const resolvedCall = call;
    const toolIndex = stepIndex++;
    emit({ type: 'step_start', index: toolIndex, kind: 'tool', tool: resolvedCall.name });
    const toolStart = now();
    const result = deps.beforeToolCall(resolvedCall.name)
      ? await deps.executeTool(resolvedCall.name, resolvedCall.args, { signal })
      : toolError(
          'unknown_tool',
          `不支持的工具：${resolvedCall.name}`,
          `[工具调用被拦截] 错误码：unknown_tool，工具名：${resolvedCall.name}。请如实告知用户当前版本不支持该操作。`,
        );
    const toolMs = now() - toolStart;
    emit({
      type: 'step_end',
      index: toolIndex,
      kind: 'tool',
      tool: resolvedCall.name,
      status: result.isError ? 'error' : 'ok',
      ms: toolMs,
      errorCode: result.errorCode,
      summary: result.summary,
      artifactId: result.artifactId,
    });
    steps.push({ call: resolvedCall, result });

    // 工具阶段被取消：判停（结果已入轨迹，交给收尾/终态）
    if (signal.aborted) {
      endReason = 'cancelled';
      break;
    }
  }

  // while 条件自然耗尽（turnCount 触顶且未显式判停）→ max_turns
  if (endReason === null) endReason = 'max_turns';

  // ④ 触顶/超预算：追加一次「不带工具的收尾调用」，保证用户拿到可读交代
  if ((endReason === 'max_turns' || endReason === 'budget_exceeded') && !signal.aborted) {
    const wrapIndex = stepIndex++;
    emit({ type: 'step_start', index: wrapIndex, kind: 'generation' });
    const wrapStart = now();
    const wrapWindow = [...buildWindow(), new SystemMessage(WRAP_UP_INSTRUCTION)];
    let wrapStatus: 'ok' | 'error' = 'ok';
    let wrapErrorCode: string | undefined;
    try {
      for await (const text of deps.streamPlain(wrapWindow, signal)) {
        if (signal.aborted) break;
        emit({ type: 'text', text });
      }
    } catch {
      wrapStatus = 'error';
      wrapErrorCode = 'generation_failed';
    }
    emit({
      type: 'step_end',
      index: wrapIndex,
      kind: 'generation',
      status: wrapStatus,
      ms: now() - wrapStart,
      errorCode: wrapErrorCode,
    });
  }

  emit({
    type: 'loop_end',
    endReason,
    turns: turnCount,
    tokens: measured ? { input: totalInput, output: totalOutput } : 'unreported',
  });
}

/**
 * 单步工具消息内容：命中老化规则（步数达阈值且非最近 N 步、且有工件号）时撤下预览、
 * 只留工件引用；否则保留原 llmText。位置化判定，与「是否有用」的语义判断无关（心法 1）。
 */
function toolContentFor(step: LoopStep, index: number, total: number): string {
  const shouldMask = total >= AGING_START_STEPS && index < total - KEEP_RECENT_STEPS;
  if (shouldMask && step.result.artifactId) {
    return `[该步结果已存档为工件 #${step.result.artifactId}（预览略）]`;
  }
  return step.result.llmText;
}
