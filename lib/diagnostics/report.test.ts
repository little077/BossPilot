import { describe, expect, it } from 'vitest';
import type { DiagnosticPageStructureSnapshot } from '@/lib/domain/types';
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

function makePageStructure(
  overrides: Partial<DiagnosticPageStructureSnapshot> = {},
): DiagnosticPageStructureSnapshot {
  return {
    status: 'captured',
    capturedAt: 1700000000000,
    pageUrl: 'https://www.zhipin.com/web/geek/job',
    pageKind: 'job_list',
    readyState: 'complete',
    viewport: { width: 1440, height: 900 },
    nodeCount: 88,
    truncated: false,
    selectorProbes: [
      {
        group: '职位列表卡片',
        selector: 'li.job-card-wrapper',
        matches: 4,
        visibleMatches: 4,
      },
      {
        group: '详情面板根节点',
        selector: '.job-detail-box',
        matches: 0,
        visibleMatches: 0,
      },
      {
        group: '岗位正文',
        selector: '.job-sec-text',
        matches: 0,
        visibleMatches: 0,
      },
    ],
    landmarks: [
      {
        label: '职位描述',
        path: 'body > main.search-layout > section.actual-detail-panel',
      },
    ],
    outline: 'body\n  main.search-layout\n    section.actual-detail-panel "sk-abcdef123456"',
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

  it('没有运行记录时也能单独导出当前页面结构和自动改进点', () => {
    const md = buildDiagnosticsReport([], makePageStructure());

    expect(md).toContain('## 当前页面结构诊断');
    expect(md).toContain('岗位列表页（未识别到展开详情）');
    expect(md).toContain('### 自动分析出的改进点');
    expect(md).toContain('已识别到职位列表卡片');
    expect(md).toContain('详情面板根节点未命中');
    expect(md).toContain('### 当前适配器选择器命中');
    expect(md).toContain('| 岗位正文 | `.job-sec-text` | 0 | 0 |');
    expect(md).toContain('section.actual-detail-panel');
    expect(md).toContain('sk-***');
    expect(md).not.toContain('sk-abcdef123456');
    expect(md).toContain('已仅导出当前页面结构诊断');
  });

  it.each([
    ['skipped', '当前不是 Boss 页面'],
    ['failed', 'site access denied'],
  ] as const)('页面结构为 %s 时仍生成可分析报告', (status, reason) => {
    const md = buildDiagnosticsReport([makeRun()], {
      status,
      capturedAt: 1,
      pageUrl: 'https://www.zhipin.com/web/geek/job',
      reason,
    });

    expect(md).toContain('## 当前页面结构诊断');
    expect(md).toContain(status === 'skipped' ? '未采集' : '采集失败');
    expect(md).toContain(reason);
    expect(md).toContain('## 任务 1');
  });

  it('正文选择器命中和骨架截断时给出对应维护建议', () => {
    const md = buildDiagnosticsReport(
      [makeRun()],
      makePageStructure({
        truncated: true,
        selectorProbes: [
          {
            group: '岗位正文',
            selector: '.job-sec-text',
            matches: 1,
            visibleMatches: 1,
          },
        ],
        landmarks: [],
      }),
    );

    expect(md).toContain('现有岗位正文选择器已命中');
    expect(md).toContain('DOM 骨架达到安全上限');
  });

  it('页面信号和可选字段均为空时给出保守诊断', () => {
    const md = buildDiagnosticsReport([makeRun()], {
      status: 'captured',
      capturedAt: 1,
    });

    expect(md).toContain('页面：`未知页面`');
    expect(md).toContain('类型：未知；readyState=未知');
    expect(md).toContain('视口：未知；记录节点 0');
    expect(md).toContain('当前候选选择器和关键文案均未提供足够信号');
    expect(md).not.toContain('### 当前适配器选择器命中');
    expect(md).not.toContain('### 关键文案路径');
    expect(md).not.toContain('### 限量可见 DOM 骨架');
  });

  it('采集跳过且没有原因时使用安全占位', () => {
    const md = buildDiagnosticsReport([], {
      status: 'skipped',
      capturedAt: 1,
    });

    expect(md).toContain('ℹ️ 未采集：未知原因');
    expect(md).not.toContain('- 页面：');
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

  it('渲染会话、Agent 事件流、上下文快照与工具调用台账', () => {
    const run = makeRun({
      conversationId: 'conv-1',
      events: [
        { atMs: 100, type: 'tool_started', requestId: 'req-1', summary: '调用 tab 工具' },
        { atMs: 500, type: 'tool_finished', requestId: 'req-1', summary: '完成' },
      ],
      contextSnapshots: [
        { atMs: 200, phase: '任务启动', summary: '绑定发送时页面' },
        { atMs: 600, phase: '任务结束', summary: '完成', detail: 'tabId=7' },
      ],
    });
    const toolCalls = [
      {
        id: 'entry-1',
        runId: 'run-1',
        conversationId: 'conv-1',
        name: 'tab',
        risk: 'confirm' as const,
        decision: 'confirm' as const,
        approved: true,
        isError: false,
        statusText: '完成',
        costMs: 120,
        paramsSummary: 'action=list',
        createdAt: 1700000001000,
      },
      {
        id: 'entry-2',
        runId: 'run-1',
        conversationId: 'conv-1',
        name: 'tab',
        risk: 'safe' as const,
        decision: 'allow' as const,
        approved: false,
        isError: true,
        statusText: '失败',
        paramsSummary: 'action=open\nurl=x|y',
        costMs: 30,
        createdAt: undefined as unknown as number,
      },
    ];

    const md = buildDiagnosticsReport([run], undefined, toolCalls);

    expect(md).toContain('- 会话：`conv-1`');
    expect(md).toContain('### Agent 事件流');
    expect(md).toContain('`tool_started`');
    expect(md).toContain('### Agent 上下文快照');
    expect(md).toContain('（+0.2s）：绑定发送时页面');
    expect(md).toContain('  - tabId=7');
    expect(md).toContain('## 工具调用台账');
    expect(md).toContain('| 需确认 | 确认 | ✅');
    expect(md).toContain('120ms');
    expect(md).toContain('action=list');
    expect(md).toContain('url=x\\|y');
    expect(md).toContain('❌ 失败');
    expect(md).toContain('— |'); // createdAt 缺失时的时间占位
  });

  it('空台账与仅页面结构导出时给出对应占位', () => {
    const md = buildDiagnosticsReport([], makePageStructure(), []);

    expect(md).toContain('本次没有执行记录');
    expect(md).toContain('_暂无工具调用记录。_');
    expect(md).not.toContain('## 任务 1');
  });

  it('渲染结束原因、请求工具、单侧 token 与缺失的台账可选字段', () => {
    const run = makeRun({
      llmCalls: [
        {
          model: 'm1',
          messageCount: 1,
          promptChars: 5,
          outputChars: 3,
          outputText: 'ok',
          promptTokens: 10,
          latencyMs: 50,
          finishReason: 'tool',
          toolName: 'tab',
        },
        {
          model: 'm2',
          messageCount: 1,
          promptChars: 5,
          outputChars: 3,
          outputText: 'ok',
          completionTokens: 7,
          latencyMs: 60,
        },
      ],
    });
    const toolCalls = [
      {
        id: 'entry-1',
        runId: 'run-1',
        conversationId: 'conv-1',
        name: 'tab',
        risk: 'blocked' as const,
        decision: 'deny' as const,
        approved: false,
        isError: true,
        createdAt: 1700000001000,
      },
    ];

    const md = buildDiagnosticsReport([run], undefined, toolCalls);

    expect(md).toContain('结束原因 `tool`');
    expect(md).toContain('请求工具 `tab`');
    expect(md).toContain('token in/out=10/?');
    expect(md).toContain('token in/out=?/7');
    expect(md).toContain('| 禁用 | 拒绝 | — | ❌');
    expect(md).toContain('| — | — |');
  });
});

describe('diagnosticsFileName', () => {
  it('生成带时间戳的文件名', () => {
    expect(diagnosticsFileName()).toMatch(
      /^BossPilot-Diagnostics\/bosspilot-diag-\d{8}-\d{6}\.md$/,
    );
  });
});
