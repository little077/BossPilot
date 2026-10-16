// ─── 有界循环单测 ───
// 用可脚本化的 mock deps 驱动 runBoundedAgentLoop，逐一验证五个结束原因都由「真实代码分支」
// 产生（而非记录产生不了的状态）、步进老化只撤旧预览、触顶/超预算后必发收尾、门禁每圈必经。

import type { BaseMessage } from '@langchain/core/messages';
import { ToolMessage as LC } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type { ToolBoundEvent } from '@/lib/chat/model';
import type { ToolArgs, ToolResult } from '@/lib/tools/types';
import type { LoopDeps, LoopEvent } from './loop';
import { AGING_START_STEPS, KEEP_RECENT_STEPS, runBoundedAgentLoop } from './loop';

function okResult(artifactId?: string): ToolResult {
  return {
    isError: false,
    summary: '已读取',
    llmText: artifactId ? `[工件 ${artifactId} · 引用卡预览…]` : '结果正文',
    artifactId,
  };
}

function toolCallEvent(name: string): ToolBoundEvent {
  return { type: 'tool_call', call: { id: `call_${name}`, name, args: {} } };
}

interface HarnessInput {
  bound: ToolBoundEvent[][];
  tool?: (name: string) => ToolResult;
  plain?: string[];
  /** 在某次工具执行时触发（用于制造中途取消）。 */
  onTool?: (name: string) => void;
}

interface Harness {
  deps: LoopDeps;
  gateNames: string[];
  toolNames: string[];
  boundWindows: BaseMessage[][];
  plainWindows: BaseMessage[][];
  events: LoopEvent[];
}

function makeHarness(input: HarnessInput): Harness {
  const gateNames: string[] = [];
  const toolNames: string[] = [];
  const boundWindows: BaseMessage[][] = [];
  const plainWindows: BaseMessage[][] = [];
  const events: LoopEvent[] = [];
  let boundIdx = 0;
  let plainDone = false;

  const deps: LoopDeps = {
    streamBound: async function* (messages: BaseMessage[]) {
      boundWindows.push(messages);
      const seq = input.bound[boundIdx] ?? [];
      boundIdx += 1;
      for (const event of seq) yield event;
    },
    streamPlain: async function* (messages: BaseMessage[]) {
      plainWindows.push(messages);
      if (input.plain && !plainDone) {
        plainDone = true;
        for (const text of input.plain) yield text;
      }
    },
    executeTool: async (name: string, _args: ToolArgs) => {
      toolNames.push(name);
      input.onTool?.(name);
      return input.tool ? input.tool(name) : okResult();
    },
    beforeToolCall: (name: string) => {
      gateNames.push(name);
      return true;
    },
  };
  return { deps, gateNames, toolNames, boundWindows, plainWindows, events };
}

function lastEvent(events: LoopEvent[]): LoopEvent {
  return events[events.length - 1] as LoopEvent;
}

describe('runBoundedAgentLoop · 结束原因', () => {
  it('completed：模型不再调用工具即自然收敛', async () => {
    const h = makeHarness({
      bound: [[toolCallEvent('read_current_page')], [{ type: 'text', text: '页面讲了三件事' }]],
      tool: () => okResult('art-1'),
    });
    const controller = new AbortController();
    await runBoundedAgentLoop(h.deps, [], controller.signal, {
      onEvent: (e) => void h.events.push(e),
    });

    expect(lastEvent(h.events)).toMatchObject({ type: 'loop_end', endReason: 'completed' });
    expect(h.toolNames).toEqual(['read_current_page']);
    // 门禁每圈必经：工具执行前 gate 被调用一次
    expect(h.gateNames).toEqual(['read_current_page']);
  });

  it('max_turns：触顶后停止并追加一次不带工具的收尾', async () => {
    const h = makeHarness({
      bound: [[toolCallEvent('read_current_page')], [toolCallEvent('read_current_page')]],
      plain: ['已达上限，交代进展'],
    });
    const controller = new AbortController();
    await runBoundedAgentLoop(h.deps, [], controller.signal, {
      maxTurns: 2,
      onEvent: (e) => void h.events.push(e),
    });

    expect(lastEvent(h.events)).toMatchObject({ type: 'loop_end', endReason: 'max_turns' });
    expect(h.toolNames).toHaveLength(2);
    // 收尾调用发生且不带工具（走 streamPlain），文本作为 text 事件产出
    expect(h.plainWindows).toHaveLength(1);
    expect(h.events.some((e) => e.type === 'text' && e.text === '已达上限，交代进展')).toBe(true);
  });

  it('budget_exceeded：实测 token 超预算即判停并收尾', async () => {
    const h = makeHarness({
      bound: [[{ type: 'usage', input: 100, output: 100 }, toolCallEvent('read_current_page')]],
      plain: ['预算用尽'],
    });
    const controller = new AbortController();
    await runBoundedAgentLoop(h.deps, [], controller.signal, {
      maxTurns: 8,
      tokenBudget: 50,
      onEvent: (e) => void h.events.push(e),
    });

    expect(lastEvent(h.events)).toMatchObject({
      type: 'loop_end',
      endReason: 'budget_exceeded',
      tokens: { input: 100, output: 100 },
    });
    // 预算在生成后、执行前判停：本轮工具未被执行
    expect(h.toolNames).toHaveLength(0);
    expect(h.plainWindows).toHaveLength(1);
  });

  it('cancelled：起始即取消不消费任何生成', async () => {
    const h = makeHarness({ bound: [[toolCallEvent('read_current_page')]] });
    const controller = new AbortController();
    controller.abort();
    await runBoundedAgentLoop(h.deps, [], controller.signal, {
      onEvent: (e) => void h.events.push(e),
    });

    expect(lastEvent(h.events)).toMatchObject({ type: 'loop_end', endReason: 'cancelled' });
    expect(h.boundWindows).toHaveLength(0);
    expect(h.toolNames).toHaveLength(0);
  });

  it('cancelled：工具执行途中取消则判停且不收尾', async () => {
    const controller = new AbortController();
    const h = makeHarness({
      bound: [[toolCallEvent('read_current_page')], [toolCallEvent('read_current_page')]],
      onTool: () => controller.abort(),
    });
    await runBoundedAgentLoop(h.deps, [], controller.signal, {
      maxTurns: 8,
      onEvent: (e) => void h.events.push(e),
    });

    expect(lastEvent(h.events)).toMatchObject({ type: 'loop_end', endReason: 'cancelled' });
    // 取消不属于触顶/超预算，故无收尾窗口
    expect(h.plainWindows).toHaveLength(0);
  });

  it('error：非法工具调用如实判错终止、不猜参数、不执行、不收尾', async () => {
    const h = makeHarness({ bound: [[{ type: 'tool_call_invalid', name: 'bad_tool' }]] });
    const controller = new AbortController();
    await runBoundedAgentLoop(h.deps, [], controller.signal, {
      onEvent: (e) => void h.events.push(e),
    });

    expect(lastEvent(h.events)).toMatchObject({ type: 'loop_end', endReason: 'error' });
    expect(h.toolNames).toHaveLength(0);
    expect(h.events.some((e) => e.type === 'step_end' && e.errorCode === 'invalid_arguments')).toBe(
      true,
    );
  });
});

describe('runBoundedAgentLoop · 步进老化', () => {
  it('步数达阈值后，除最近 KEEP_RECENT_STEPS 步外撤下预览、留工件引用', async () => {
    // 5 个工具步（=AGING_START_STEPS）+ 1 步收敛
    const bound: ToolBoundEvent[][] = [];
    for (let i = 0; i < AGING_START_STEPS; i += 1) bound.push([toolCallEvent('read_current_page')]);
    bound.push([{ type: 'text', text: '完成' }]);

    let counter = 0;
    const h = makeHarness({
      bound,
      tool: () => {
        counter += 1;
        return okResult(`art-${counter}`);
      },
    });
    const controller = new AbortController();
    await runBoundedAgentLoop(h.deps, [], controller.signal, {
      maxTurns: 8,
      onEvent: (e) => void h.events.push(e),
    });

    // 最后一轮生成前组装的窗口：含 AGING_START_STEPS 条工具往返
    const finalWindow = h.boundWindows[h.boundWindows.length - 1] as BaseMessage[];
    const toolMessages = finalWindow.filter((m): m is LC => m instanceof LC);
    expect(toolMessages).toHaveLength(AGING_START_STEPS);

    const kept = toolMessages.slice(-KEEP_RECENT_STEPS).map((m) => String(m.content));
    const aged = toolMessages
      .slice(0, toolMessages.length - KEEP_RECENT_STEPS)
      .map((m) => String(m.content));
    // 老化的旧步只留工件引用、撤下预览；最近 N 步保留原引用卡
    expect(aged.every((c) => c.includes('已存档为工件') && !c.includes('引用卡预览'))).toBe(true);
    expect(kept.every((c) => c.includes('引用卡预览'))).toBe(true);
  });
});
