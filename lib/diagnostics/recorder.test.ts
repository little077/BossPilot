import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recorder } from './recorder';

const config = { model: 'test-model', baseUrl: 'https://api.example.com/v1' };

/** 索引访问收窄：取不到就直接让测试失败。 */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('期望的记录不存在');
  return value;
}

beforeEach(() => {
  recorder.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('beginRun', () => {
  it('记录脱敏后的输入、端点主机名，并落一条输入步骤', () => {
    const run = recorder.beginRun('chat', '帮我找岗位 sk-abcdef123456', config);

    expect(run.source).toBe('chat');
    expect(run.userInput).toBe('帮我找岗位 sk-***');
    expect(run.baseUrlHost).toBe('api.example.com');
    expect(run.extensionVersion).toBe('unknown'); // 测试环境无 chrome
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({ seq: 1, kind: 'input', summary: '收到用户输入' });
  });

  it('从 chrome manifest 读取扩展版本号，缺失时回退 unknown', () => {
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '1.2.3' }) } });
    expect(recorder.beginRun('chat', 'a', config).extensionVersion).toBe('1.2.3');
    recorder.finishRun('chat', 'completed');

    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({}) } });
    expect(recorder.beginRun('chat', 'b', config).extensionVersion).toBe('unknown');
  });

  it('同轨道重复 beginRun 会把上一个任务标记为异常收尾', () => {
    recorder.beginRun('chat', '第一轮', config);
    recorder.beginRun('chat', '第二轮', config);

    const runs = recorder.snapshotRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      userInput: '第一轮',
      status: 'error',
      errorSummary: '上一个任务未正常结束',
    });
  });

  it('聊天轨与任务轨并发时互不覆盖', () => {
    recorder.beginRun('chat', '聊天输入', config);
    recorder.beginRun('task', '任务输入', config);
    recorder.step('chat', 'note', '聊天步骤');
    recorder.step('task', 'page', '任务步骤');
    recorder.finishRun('chat', 'completed');
    recorder.finishRun('task', 'completed');

    const runs = recorder.snapshotRuns();
    expect(runs).toHaveLength(2);
    const chat = runs.find((r) => r.source === 'chat');
    const task = runs.find((r) => r.source === 'task');
    expect(chat?.steps.map((s) => s.summary)).toEqual(['收到用户输入', '聊天步骤']);
    expect(task?.steps.map((s) => s.summary)).toEqual(['收到用户输入', '任务步骤']);
  });
});

describe('step / logLlm / logError', () => {
  it('没有进行中任务时全部为 no-op', () => {
    recorder.step('task', 'note', 'x');
    recorder.logLlm('task', {
      model: 'm',
      messageCount: 1,
      promptChars: 1,
      outputChars: 1,
      latencyMs: 1,
    });
    recorder.logError('task', 'x');
    recorder.finishRun('task', 'completed');

    expect(recorder.hasData()).toBe(false);
    expect(recorder.snapshotRuns()).toEqual([]);
  });

  it('step 的超长 detail 被截断并标注原始长度', () => {
    recorder.beginRun('task', '任务', config);
    recorder.step('task', 'page', '选择器失配', 'z'.repeat(7000));

    const step = must(recorder.snapshotRuns()[0]).steps.at(-1);
    expect(step?.detail).toContain('已截断，原文 7000 字');
    expect((step?.detail ?? '').length).toBeLessThan(7000);
  });

  it('logLlm 保存脱敏截断后的消息与输出原文，并落一条 llm 步骤', () => {
    recorder.beginRun('task', '任务', config);
    recorder.logLlm('task', {
      model: 'test-model',
      purpose: '意图解析',
      messageCount: 2,
      promptChars: 9010,
      outputChars: 20000,
      messages: [
        { role: 'system', content: 'apiKey=sk-abcdef123456' },
        { role: 'user', content: 'x'.repeat(9000) },
      ],
      outputText: 'y'.repeat(20000),
      promptTokens: 100,
      completionTokens: 20,
      latencyMs: 42,
    });

    const run = must(recorder.snapshotRuns()[0]);
    const call = must(run.llmCalls[0]);
    expect(call.messages?.[0]?.content).toBe('apiKey=***');
    expect(call.messages?.[1]?.content).toContain('已截断，原文 9000 字');
    expect(call.outputText).toContain('已截断，原文 20000 字');

    const step = run.steps.at(-1);
    expect(step).toMatchObject({ kind: 'llm' });
    expect(step?.summary).toContain('［意图解析］');
    expect(step?.summary).toContain('42ms');
    expect(step?.detail).toContain('token in/out=100/20');
    expect(step?.detail).toContain('LLM 调用明细 #1');
  });

  it('logLlm 缺省字段（无用途/原文/用量）与非流式降级也能记录', () => {
    recorder.beginRun('chat', '对话', config);
    recorder.logLlm('chat', {
      model: 'test-model',
      messageCount: 1,
      promptChars: 5,
      outputChars: 0,
      latencyMs: 10,
      fellBackToNonStream: true,
    });

    const run = must(recorder.snapshotRuns()[0]);
    expect(must(run.llmCalls[0]).messages).toBeUndefined();
    expect(must(run.llmCalls[0]).outputText).toBeUndefined();
    const step = run.steps.at(-1);
    expect(step?.summary).toContain('非流式降级');
    expect(step?.summary).not.toContain('［');
    expect(step?.detail).not.toContain('token in/out');
  });

  it('logError 写入脱敏后的 errorSummary 且不被 finishRun 覆盖', () => {
    recorder.beginRun('chat', '对话', config);
    recorder.logError('chat', '请求失败 token: abc12345678');
    recorder.finishRun('chat', 'error', '后到的原因');

    const run = must(recorder.snapshotRuns()[0]);
    expect(run.errorSummary).toBe('请求失败 token: ***');
    expect(run.steps.at(-1)).toMatchObject({ kind: 'error', summary: '发生错误' });
  });
});

describe('finishRun / snapshotRuns / clear', () => {
  it('finishRun 落状态与结束时间，未设置过错误时采用传入原因', () => {
    recorder.beginRun('task', '任务', config);
    recorder.finishRun('task', 'cancelled', '用户取消');

    const run = must(recorder.snapshotRuns()[0]);
    expect(run.status).toBe('cancelled');
    expect(run.endedAt).toBeGreaterThanOrEqual(run.startedAt);
    expect(run.errorSummary).toBe('用户取消');
  });

  it('历史任务超过上限时丢弃最早的记录', () => {
    for (let i = 0; i < 55; i++) {
      recorder.beginRun('chat', `输入${i}`, config);
      recorder.finishRun('chat', 'completed');
    }

    const runs = recorder.snapshotRuns();
    expect(runs).toHaveLength(50);
    expect(must(runs[0]).userInput).toBe('输入5');
    expect(runs.at(-1)?.userInput).toBe('输入54');
  });

  it('快照包含进行中的任务并按开始时间排序；clear 清空全部', () => {
    recorder.beginRun('chat', '已完成', config);
    recorder.finishRun('chat', 'completed');
    recorder.beginRun('task', '进行中', config);

    expect(recorder.hasData()).toBe(true);
    const runs = recorder.snapshotRuns();
    expect(runs.map((r) => r.userInput)).toEqual(['已完成', '进行中']);

    recorder.clear();
    expect(recorder.hasData()).toBe(false);
    expect(recorder.snapshotRuns()).toEqual([]);
  });
});
