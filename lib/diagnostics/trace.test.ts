// ─── 最薄观测单测 ───
// jsdom 无 IndexedDB，用内存表 mock db：验证环形淘汰淘最旧、取最近一轮、清空，
// 以及 formatTraceText / buildTraceExport 纯函数的可读文本与可下载导出（含 unreported 与步骤行）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnTrace } from './trace';

const fake = vi.hoisted(() => {
  const rows: TurnTrace[] = [];
  const traces = {
    put: vi.fn(async (row: TurnTrace) => {
      const index = rows.findIndex((item) => item.id === row.id);
      if (index >= 0) rows[index] = row;
      else rows.push(row);
    }),
    clear: vi.fn(async () => {
      rows.length = 0;
    }),
    bulkDelete: vi.fn(async (ids: string[]) => {
      const removed = new Set(ids);
      const kept = rows.filter((row) => !removed.has(row.id));
      rows.length = 0;
      rows.push(...kept);
    }),
    orderBy: vi.fn((key: 'createdAt') => ({
      toArray: async () => [...rows].sort((a, b) => a[key] - b[key]),
    })),
  };
  return { rows, traces };
});

vi.mock('@/lib/storage/db', () => ({ db: { traces: fake.traces } }));

import {
  buildTraceExport,
  clearTraces,
  formatTraceText,
  latestTrace,
  putTrace,
  TRACE_MAX,
} from './trace';

function makeTrace(id: string, createdAt: number): TurnTrace {
  return {
    id,
    createdAt,
    endReason: 'completed',
    turns: 1,
    totalMs: 10,
    tokens: 'unreported',
    failedSteps: 0,
    steps: [],
  };
}

beforeEach(() => {
  fake.rows.length = 0;
  vi.clearAllMocks();
});

describe('putTrace / 环形淘汰', () => {
  it('未超限时不触发删除', async () => {
    await putTrace(makeTrace('t1', 1000));
    expect(fake.traces.bulkDelete).not.toHaveBeenCalled();
  });

  it('超出 TRACE_MAX 时按 createdAt 淘最旧，新轨迹保留', async () => {
    for (let i = 0; i < TRACE_MAX; i += 1) {
      fake.rows.push(makeTrace(`old-${i}`, 1000 + i));
    }
    const fresh = makeTrace('fresh', 9999);
    await putTrace(fresh);

    expect(fake.rows).toHaveLength(TRACE_MAX);
    expect(fake.rows.some((row) => row.id === 'old-0')).toBe(false);
    expect(fake.rows.some((row) => row.id === 'old-1')).toBe(true);
    expect(fake.rows.some((row) => row.id === 'fresh')).toBe(true);
  });
});

describe('latestTrace', () => {
  it('返回 createdAt 最大的一条；空表返回 null', async () => {
    await putTrace(makeTrace('older', 1000));
    await putTrace(makeTrace('newest', 2000));
    const latest = await latestTrace();
    expect(latest?.id).toBe('newest');

    await clearTraces();
    await expect(latestTrace()).resolves.toBeNull();
  });
});

describe('clearTraces', () => {
  it('全量清空轨迹表', async () => {
    await putTrace(makeTrace('t1', 1000));
    await clearTraces();
    expect(fake.rows).toHaveLength(0);
  });
});

describe('formatTraceText（纯函数）', () => {
  it('含结束原因/轮次/耗时/unreported，并列出每步', () => {
    const trace: TurnTrace = {
      id: 'chat-1',
      createdAt: 5,
      endReason: 'max_turns',
      turns: 2,
      totalMs: 1234,
      tokens: { input: 500, output: 120 },
      failedSteps: 1,
      steps: [
        { index: 0, kind: 'generation', ms: 300, status: 'ok', preview: '我先看看页面' },
        {
          index: 1,
          kind: 'tool',
          tool: 'read_current_page',
          ms: 45,
          status: 'error',
          errorCode: 'no_active_tab',
        },
      ],
    };
    const text = formatTraceText(trace);
    expect(text).toContain('chat-1');
    expect(text).toContain('触顶最大轮次（max_turns）');
    expect(text).toContain('轮次 2');
    expect(text).toContain('总耗时 1234ms');
    expect(text).toContain('token：输入 500 / 输出 120');
    expect(text).toContain('失败步数 1');
    expect(text).toContain('#0 generation 300ms ok');
    expect(text).toContain('我先看看页面');
    expect(text).toContain('#1 tool read_current_page 45ms error(no_active_tab)');
  });

  it('token 未上报时如实记「未上报」，无步骤时给出占位', () => {
    const text = formatTraceText(makeTrace('chat-2', 1));
    expect(text).toContain('token：未上报');
    expect(text).toContain('（无步骤记录）');
  });
});

describe('buildTraceExport（纯函数）', () => {
  it('产出带 id 的 Markdown 文件名，正文同时含可读文本与结构化 JSON', () => {
    const trace: TurnTrace = {
      id: 'chat-9',
      createdAt: 7,
      endReason: 'cancelled',
      turns: 2,
      totalMs: 500,
      tokens: { input: 10, output: 4 },
      failedSteps: 0,
      steps: [{ index: 0, kind: 'generation', ms: 120, status: 'ok' }],
    };
    const { filename, mime, body } = buildTraceExport(trace);

    expect(filename).toBe('bosspilot-trace-chat-9.md');
    expect(mime).toContain('text/markdown');
    // 人眼可读区（formatTraceText）与结构化 JSON 区都在。
    expect(body).toContain('用户已停止（cancelled）');
    expect(body).toContain('```json');
    expect(JSON.parse(body.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? '{}')).toMatchObject({
      id: 'chat-9',
      endReason: 'cancelled',
      turns: 2,
    });
  });
});
