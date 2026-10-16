// ─── 最薄观测：逐轮结构化轨迹（记录 + 导出，无重 UI） ───
// 心法 7「先能调试，再敢自主」：有界循环的失败是跨多轮的，没有每轮轨迹就无从判断
// 「第 3 轮为什么没调工具/为什么超预算」。本模块只做最薄的一片——把一轮 loop 记成结构化
// 轨迹、能导出成可下载文件定位问题；分级切换/面板聚合等重 UI 一律留到后续阶段。
// 边界（决策记忆「trace 写入收口于循环入口」）：
// - 写入只在后台：putTrace 只由 background 在 loop 结束/异常路径调用，界面侧绝不写；
// - 界面只读：侧边栏经 protocol 的 trace:latest → trace_state 拿到轨迹对象，用纯函数
//   formatTraceText / buildTraceExport 渲染后复制或下载，不直接触碰 db；
// - 落库前 preview 必须已过 sanitizeForLog（脱敏在调用方完成，这里只信任传入值）。

import { db } from '@/lib/storage/db';

/** 一轮循环的结束原因——五枚举，与 loop.ts 真实代码分支一一对应，绝不记录产生不了的状态。 */
export type EndReason = 'completed' | 'max_turns' | 'budget_exceeded' | 'cancelled' | 'error';

/** 单个步骤：一次生成或一次工具执行。 */
export interface TraceStep {
  /** 步骤序号（从 0 起）。 */
  index: number;
  kind: 'generation' | 'tool';
  /** 工具名（kind=tool 时有）。 */
  tool?: string;
  /** 该步耗时（毫秒）。 */
  ms: number;
  status: 'ok' | 'error';
  /** 稳定错误码（status=error 时有）。 */
  errorCode?: string;
  /** 脱敏后的短预览（≤TRACE_PREVIEW_CHARS 字），仅供人眼定位。 */
  preview?: string;
}

/** token 用量：拿不到实测就记 'unreported'，绝不用估算冒充实测。 */
export type TokenUsage = { input: number; output: number } | 'unreported';

/** 一轮完整轨迹。 */
export interface TurnTrace {
  /** 主键 = requestId。 */
  id: string;
  createdAt: number;
  endReason: EndReason;
  /** 循环轮次（step 圈数）。 */
  turns: number;
  /** 整轮总耗时（毫秒）。 */
  totalMs: number;
  tokens: TokenUsage;
  /** 失败步数（status=error 的步）。 */
  failedSteps: number;
  steps: TraceStep[];
}

/** 轨迹环形上限：与档案柜同款手法，超限淘最旧（风控类参数，放宽需先开 Issue 讨论）。 */
export const TRACE_MAX = 100;

/** 结束原因的中文可读标签（复制文本用）。 */
const END_REASON_LABELS: Record<EndReason, string> = {
  completed: '自然完成',
  max_turns: '触顶最大轮次',
  budget_exceeded: '超出 token 预算',
  cancelled: '用户已停止',
  error: '出错终止',
};

/**
 * 写入一轮轨迹（仅后台调用）并立即执行环形淘汰，保证轨迹表有界增长。
 */
export async function putTrace(trace: TurnTrace): Promise<void> {
  await db.traces.put(trace);
  await evictOverflow();
}

/** 取最近一轮轨迹（后台响应 trace:latest 用）；无记录返回 null。 */
export async function latestTrace(): Promise<TurnTrace | null> {
  const all = await db.traces.orderBy('createdAt').toArray();
  return all.at(-1) ?? null;
}

/** 全量清空：与「新对话」清消息时一并调用，避免留下无主轨迹。 */
export async function clearTraces(): Promise<void> {
  await db.traces.clear();
}

/**
 * 纯函数：把轨迹渲染成一段可读文本，供「复制本轮为可读文本」定位问题。
 * 不碰 db、不取时间——输入完全决定输出，便于单测与在 UI 侧安全调用。
 */
export function formatTraceText(trace: TurnTrace): string {
  const tokenText =
    trace.tokens === 'unreported'
      ? 'token：未上报'
      : `token：输入 ${trace.tokens.input} / 输出 ${trace.tokens.output}`;
  const header = [
    `BossPilot 轨迹 · ${trace.id}`,
    `结束原因：${END_REASON_LABELS[trace.endReason]}（${trace.endReason}）`,
    `轮次 ${trace.turns} · 总耗时 ${trace.totalMs}ms · ${tokenText} · 失败步数 ${trace.failedSteps}`,
  ].join('\n');

  if (trace.steps.length === 0) return `${header}\n（无步骤记录）`;

  const lines = trace.steps.map((step) => {
    const kindText = step.kind === 'tool' ? `tool ${step.tool ?? '?'}` : 'generation';
    const statusText = step.status === 'error' ? `error(${step.errorCode ?? '?'})` : 'ok';
    const head = `#${step.index} ${kindText} ${step.ms}ms ${statusText}`;
    return step.preview ? `${head}\n    ${step.preview}` : head;
  });
  return `${header}\n步骤：\n${lines.join('\n')}`;
}

/** 轨迹导出的产物：文件名 + MIME + 文本正文，交由界面侧触发下载。 */
export interface TraceExport {
  filename: string;
  mime: string;
  body: string;
}

/**
 * 纯函数：把轨迹打包成一段可直接下载投喂大模型的 Markdown 文本。
 * 同一段既含人眼可读的 formatTraceText，又含结构化 JSON 原文——把整个文件甩给
 * 大模型即可复盘「这一轮到底发生了什么」，无需额外 zip 依赖。输入完全决定输出，便于单测。
 */
export function buildTraceExport(trace: TurnTrace): TraceExport {
  const body = [
    '# BossPilot Agent 轨迹复盘',
    '',
    '下面先是人眼可读的摘要，随后是同数据的结构化 JSON 原文，可整体投喂给大模型定位问题。',
    '',
    '```text',
    formatTraceText(trace),
    '```',
    '',
    '```json',
    JSON.stringify(trace, null, 2),
    '```',
    '',
  ].join('\n');
  return {
    filename: `bosspilot-trace-${trace.id}.md`,
    mime: 'text/markdown;charset=utf-8',
    body,
  };
}

/** 超出环形上限时删除最旧的溢出部分。 */
async function evictOverflow(): Promise<void> {
  const all = await db.traces.orderBy('createdAt').toArray();
  const excess = all.length - TRACE_MAX;
  if (excess > 0) {
    await db.traces.bulkDelete(all.slice(0, excess).map((row) => row.id));
  }
}
