// ─── M0 基准 harness 的回归护栏测试 ───
// 验证：指标提取与日志基线口径一致；对比逻辑能识别「不劣化」与「回归」。

import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import type { ToolActivity } from '@/lib/domain/types';
import { baselineFor, XHS_SEARCH_BASELINE_20260829, XHS_SEARCH_CASE } from './baseline-20260829';
import { measureRun } from './metrics';
import { compare, compareToBaseline, regressionViolations, runAndCompare } from './runner';
import type { BenchmarkMetrics } from './types';

function userMessage(id: string, createdAt: number): ChatMessage {
  return {
    id,
    role: 'user',
    content: '加载 xhs-note-scout 技能，在小红书搜索 vibe coding 展示。',
    createdAt,
  };
}

function assistantTurn(id: string, createdAt: number, activities: ToolActivity[]): ChatMessage {
  return { id, role: 'assistant', content: '', createdAt, toolActivities: activities };
}

function activity(
  name: ToolActivity['name'],
  status: ToolActivity['status'],
  startedAt: number,
  finishedAt: number,
): ToolActivity {
  return {
    callId: `${name}-${startedAt}`,
    name,
    label: name,
    status,
    statusText: status,
    startedAt,
    finishedAt,
  };
}

/** 回放 2026-08-29 日志的工具时间线（29 次调用，分散在 16 轮）。 */
function replayBaselineTimeline(): ChatMessage[] {
  const messages: ChatMessage[] = [userMessage('user-1', 0)];
  // 元组：轮起始时间, [工具名, 状态, 耗时, 可选绝对起始时间（并行活动共用同一时刻）]
  const turns: Array<
    [number, Array<[ToolActivity['name'], ToolActivity['status'], number, number?]>]
  > = [
    [
      1000,
      [
        ['load_skill', 'succeeded', 3],
        ['read_current_page', 'succeeded', 70],
      ],
    ],
    [
      2000,
      [
        ['inspect_page', 'succeeded', 39],
        ['inspect_page', 'succeeded', 38],
      ],
    ],
    [3000, [['observe_page', 'succeeded', 38]]],
    [4000, [['tab', 'failed', 6]]],
    [5000, [['tab', 'failed', 2]]],
    [
      6000,
      [
        ['observe_visual_page', 'failed', 1],
        ['inspect_page', 'failed', 42],
      ],
    ],
    [
      6500,
      [
        ['inspect_page', 'succeeded', 33],
        ['observe_page', 'succeeded', 46],
      ],
    ],
    [10000, [['tab', 'succeeded', 3466]]],
    [
      16000,
      [
        ['read_current_page', 'succeeded', 63],
        ['inspect_page', 'succeeded', 31],
      ],
    ],
    [
      17000,
      [
        ['observe_page', 'succeeded', 24],
        ['observe_page', 'succeeded', 22],
      ],
    ],
    [21000, [['browser_action', 'succeeded', 574]]],
    [23000, [['read_current_page', 'succeeded', 44]]],
    [25000, [['tab', 'succeeded', 3151]]],
    // 15:27:20 同刻并行发起的 4 次 tab open 失败，各吃满 12s 超时
    [
      30000,
      [
        ['tab', 'failed', 12140, 30000],
        ['tab', 'failed', 12187, 30000],
        ['tab', 'failed', 12235, 30000],
        ['tab', 'failed', 12236, 30000],
      ],
    ],
    [43000, [['tab', 'succeeded', 1]]],
    // 15:27:27 同刻并行读取 5 个已打开的标签页
    [
      70000,
      [
        ['read_current_page', 'succeeded', 83, 70000],
        ['read_current_page', 'succeeded', 350, 70000],
        ['read_current_page', 'succeeded', 385, 70000],
        ['read_current_page', 'succeeded', 393, 70000],
        ['read_current_page', 'succeeded', 467, 70000],
      ],
    ],
  ];
  turns.forEach(([offset, tools], index) => {
    let cursor = offset;
    const activities = tools.map(([name, status, duration, absoluteStart]) => {
      const started = absoluteStart ?? cursor;
      cursor = started + duration;
      return activity(name, status, started, started + duration);
    });
    messages.push(assistantTurn(`assistant-${index + 1}`, offset, activities));
  });
  return messages;
}

/** 目标态执行（M1-M5 完成后）：3 轮、2 次工具调用、1 秒出头。 */
function idealTimeline(): ChatMessage[] {
  return [
    userMessage('user-1', 0),
    assistantTurn('assistant-1', 100, [
      activity('load_skill', 'succeeded', 100, 103),
      activity('browser_action', 'succeeded', 200, 774),
    ]),
    assistantTurn('assistant-2', 1000, [activity('read_current_page', 'succeeded', 1000, 1050)]),
    assistantTurn('assistant-3', 1100, []),
  ];
}

/** 比基线更差的执行：工具更多、失败更多、耗时更长。 */
function worseThanBaselineTimeline(): ChatMessage[] {
  const messages = replayBaselineTimeline();
  const last = messages[messages.length - 1]!;
  last.toolActivities = [...(last.toolActivities ?? []), activity('tab', 'failed', 70_000, 82_000)];
  return messages;
}

describe('基准指标提取（与 2026-08-29 日志口径一致）', () => {
  it('从日志回放提取出与固化基线一致的指标', () => {
    const metrics = measureRun(replayBaselineTimeline());
    expect(metrics).toEqual({
      modelTurns: 16,
      toolCalls: 29,
      succeededTools: 21,
      failedTools: 8,
      durationMs: 70_467,
      retryWastedMs: 36_660,
      safetyDecisions: 0,
      cachedReads: 0,
      unchangedContextInjections: 0,
      hintSuggestions: 0,
    });
  });

  it('无任何工具活动时返回 null', () => {
    expect(measureRun([])).toBeNull();
    expect(measureRun([userMessage('u', 1)])).toBeNull();
  });

  it('等待用户确认的工具调用计入安全决策', () => {
    const messages = [
      userMessage('u', 0),
      assistantTurn('a', 100, [
        { ...activity('tab', 'succeeded', 100, 200), authorizationStatus: 'granted' },
      ]),
    ];
    expect(measureRun(messages)?.safetyDecisions).toBe(1);
  });
});

describe('与基线对比', () => {
  it('目标态执行判定为不劣化（noRegression）', () => {
    const comparison = compareToBaseline(XHS_SEARCH_CASE, measureRun(idealTimeline())!);
    expect(comparison.noRegression).toBe(true);
    expect(regressionViolations(comparison)).toEqual([]);
    expect(comparison.deltas.toolCalls).toBeLessThan(0);
    expect(comparison.deltas.durationMs).toBeLessThan(0);
  });

  it('比基线更差的执行被判定为回归并列出原因', () => {
    const metrics = measureRun(worseThanBaselineTimeline())!;
    const comparison = compareToBaseline(XHS_SEARCH_CASE, metrics);
    expect(comparison.noRegression).toBe(false);
    const violations = regressionViolations(comparison);
    expect(violations.some((reason) => reason.includes('工具调用'))).toBe(true);
    expect(violations.some((reason) => reason.includes('失败工具'))).toBe(true);
    expect(violations.some((reason) => reason.includes('端到端耗时'))).toBe(true);
  });

  it('compare 直接对比两组指标', () => {
    const baseline: BenchmarkMetrics = {
      modelTurns: 3,
      toolCalls: 5,
      succeededTools: 4,
      failedTools: 1,
      durationMs: 10_000,
      retryWastedMs: 0,
      safetyDecisions: 0,
      cachedReads: 0,
      unchangedContextInjections: 0,
      hintSuggestions: 0,
    };
    const current: BenchmarkMetrics = {
      modelTurns: 2,
      toolCalls: 4,
      succeededTools: 4,
      failedTools: 0,
      durationMs: 8_000,
      retryWastedMs: 0,
      safetyDecisions: 0,
      cachedReads: 1,
      unchangedContextInjections: 2,
      hintSuggestions: 1,
    };
    expect(compare('case-a', baseline, current).noRegression).toBe(true);
  });

  it('M5 三项命中在报告中单独统计（缓存/差异注入/建议）', () => {
    const messages = [
      {
        ...userMessage('user-1', 0),
        content: `${userMessage('user-1', 0).content}\n<untrusted_page_context>{"active_tab":{"tabId":1,"url":"https://x.com","changedSinceLastRead":false}}</untrusted_page_context>`,
      },
      assistantTurn('assistant-1', 100, [
        { ...activity('read_current_page', 'succeeded', 100, 200), statusText: '已读取（cached）' },
        {
          ...activity('inspect_page', 'succeeded', 300, 400),
          detail: '结构摘要\n[hint] 建议下一步：并行读取全部已打开标签页。',
        },
      ]),
    ];
    const metrics = measureRun(messages)!;
    expect(metrics.cachedReads).toBe(1);
    expect(metrics.unchangedContextInjections).toBe(1);
    expect(metrics.hintSuggestions).toBe(1);
  });

  it('runAndCompare 执行并返回对比结果', async () => {
    const comparison = await runAndCompare(XHS_SEARCH_CASE, async () => idealTimeline());
    expect(comparison.caseId).toBe('xhs-search-vibe-coding');
    expect(comparison.noRegression).toBe(true);
  });

  it('缺少基线时抛错', () => {
    const unknown = { ...XHS_SEARCH_CASE, id: 'no-such-case' };
    expect(() => compareToBaseline(unknown, XHS_SEARCH_BASELINE_20260829)).toThrow(
      /缺少 case 的固化基线/,
    );
  });

  it('baselineFor 按 caseId 查找', () => {
    expect(baselineFor('xhs-search-vibe-coding')).toEqual(XHS_SEARCH_BASELINE_20260829);
    expect(baselineFor('nope')).toBeNull();
  });
});
