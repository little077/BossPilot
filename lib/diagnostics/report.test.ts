import { describe, expect, it } from 'vitest';
import { buildDiagnosticsReport, diagnosticsFileName } from './report';
import type { DiagnosticRun } from './types';

function makeRun(overrides: Partial<DiagnosticRun> = {}): DiagnosticRun {
  return {
    runId: 'run-1',
    source: 'chat',
    userInput: '帮我找岗位',
    model: 'test-model',
    baseUrlHost: 'api.example.com',
    extensionVersion: '0.2.0',
    adapterVersion: 1,
    startedAt: 1700000000000,
    endedAt: 1700000005000,
    status: 'completed',
    steps: [],
    llmCalls: [],
    ...overrides,
  };
}

describe('buildDiagnosticsReport', () => {
  it('空记录时输出占位说明，不带分析指引', () => {
    const md = buildDiagnosticsReport([]);

    expect(md).toContain('# BossPilot 执行日志');
    expect(md).toContain('暂无可导出的任务记录');
    expect(md).not.toContain('分析指引');
  });

  it('渲染任务概览、来源标签与分析指引', () => {
    const md = buildDiagnosticsReport([makeRun()]);

    expect(md).toContain('## 分析指引（给 AI 分析者）');
    expect(md).toContain('## 任务 1（对话） · ✅ 完成');
    expect(md).toContain('用户输入：帮我找岗位');
    expect(md).toContain('`test-model` @ `api.example.com`');
    expect(md).toContain('耗时：5.0s');
    expect(md).toContain('扩展 v0.2.0 / 适配器 v1');
  });

  it('统计并高亮异常任务；取消与空输入有占位', () => {
    const md = buildDiagnosticsReport([
      makeRun({ status: 'error', errorSummary: '接口超时' }),
      makeRun({ runId: 'run-2', status: 'cancelled', userInput: '', baseUrlHost: '' }),
    ]);

    expect(md).toContain('含 1 个异常任务');
    expect(md).toContain('> ⚠️ **异常**：接口超时');
    expect(md).toContain('## 任务 2（对话） · ⏹️ 已取消');
    expect(md).toContain('用户输入：（空）');
    expect(md).toContain('未知端点');
  });

  it('短细节内联并转义竖线，超长/多行细节移入步骤详情附录', () => {
    const run = makeRun({
      source: 'task',
      steps: [
        { seq: 1, atMs: 0, kind: 'input', summary: '收到|输入', detail: '短|细节' },
        { seq: 2, atMs: 500, kind: 'note', summary: '无细节步骤' },
        {
          seq: 3,
          atMs: 1200,
          kind: 'page',
          summary: '选择器失配',
          detail: `URL: x\n${'a'.repeat(200)}`,
        },
      ],
    });

    const md = buildDiagnosticsReport([run]);

    expect(md).toContain('（任务）');
    expect(md).toContain('收到\\|输入');
    expect(md).toContain('短\\|细节');
    expect(md).toContain('| 页面 |');
    expect(md).toContain('见附录 #3');
    expect(md).toContain('#### 附录 #3 · 选择器失配');
    expect(md).toContain('a'.repeat(200));
  });

  it('渲染 LLM 调用明细的消息与输出原文', () => {
    const run = makeRun({
      llmCalls: [
        {
          model: 'm1',
          purpose: '意图解析',
          messageCount: 2,
          promptChars: 20,
          outputChars: 10,
          messages: [
            { role: 'system', content: '系统提示词' },
            { role: 'user', content: '用户内容' },
          ],
          outputText: '{"keyword":"前端"}',
          promptTokens: 100,
          completionTokens: 30,
          latencyMs: 800,
        },
        {
          model: 'm2',
          messageCount: 1,
          promptChars: 5,
          outputChars: 0,
          outputText: '',
          latencyMs: 100,
          fellBackToNonStream: true,
        },
      ],
    });

    const md = buildDiagnosticsReport([run]);

    expect(md).toContain('### LLM 调用明细');
    expect(md).toContain('#### 调用 #1 · 意图解析');
    expect(md).toContain('token in/out=100/30');
    expect(md).toContain('**发送的消息：**');
    expect(md).toContain('系统提示词');
    expect(md).toContain('{"keyword":"前端"}');
    expect(md).toContain('````text');
    expect(md).toContain('#### 调用 #2\n');
    expect(md).toContain('（非流式降级）');
    expect(md).toContain('（空）'); // 空输出的围栏占位
  });

  it('进行中的任务耗时显示为「进行中」', () => {
    const md = buildDiagnosticsReport([makeRun({ endedAt: undefined })]);

    expect(md).toContain('耗时：进行中');
  });
});

describe('diagnosticsFileName', () => {
  it('生成带时间戳的文件名', () => {
    expect(diagnosticsFileName()).toMatch(
      /^BossPilot-Diagnostics\/bosspilot-diag-\d{8}-\d{6}\.md$/,
    );
  });
});
