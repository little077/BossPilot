// ─── 诊断记录：Markdown 报告 ───
// 把内存里的 DiagnosticRun[] 渲染成一份可直接交给 AI 分析的 Markdown：
// 分析指引 + 任务概览 + 异常高亮 + 步骤时间线 + LLM 调用明细（含提示词/输出原文）
// + 步骤详情附录（DOM outline 等超长内容）。数据在入库时已脱敏。

import type { DiagnosticLlmCall, DiagnosticRun, DiagnosticStep } from './types';

const STATUS_LABEL: Record<DiagnosticRun['status'], string> = {
  completed: '✅ 完成',
  error: '❌ 出错',
  cancelled: '⏹️ 已取消',
};

const SOURCE_LABEL: Record<DiagnosticRun['source'], string> = {
  chat: '对话',
  task: '任务',
};

const KIND_LABEL: Record<DiagnosticStep['kind'], string> = {
  input: '输入',
  llm: '模型',
  note: '记录',
  error: '错误',
  page: '页面',
  tool: '工具',
};

/** 时间线表格里 detail 的内联上限，超过移入「步骤详情附录」。 */
const INLINE_DETAIL_CHARS = 160;

/** 分析指引：固定文案，让任何模型拿到日志即可上手定位问题。 */
const ANALYSIS_GUIDE = `## 分析指引（给 AI 分析者）

- 每个「任务」是一次完整的对话轮次（对话轨）或流水线任务（任务轨），按时间排序；
- 「步骤时间线」是执行主干：输入 → 页面动作（导航/抽取）→ 模型调用 → 结果/错误。
  类别为「页面」的步骤记录了导航 URL 与抽取结果（命中条数 / selectorMiss / 验证码）；
- 「LLM 调用明细」含每次调用发送的完整消息（含 system prompt）与输出全文，
  用于判断：提示词是否给足信息、模型是否理解错、输出是否被解析错；
- 「步骤详情附录」存放超长细节。选择器失配（selectorMiss）时这里有页面
  DOM 结构 outline——对照适配层的候选选择器可直接判断站点是否改版、如何修；
- 「适配器 v 版本号」是选择器契约版本；同版本下 selectorMiss 多发即提示需要升级适配层。`;

function fmtTime(ms: number | undefined): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDuration(run: DiagnosticRun): string {
  if (run.endedAt == null) return '进行中';
  const s = (run.endedAt - run.startedAt) / 1000;
  return `${s.toFixed(1)}s`;
}

/** 用四反引号围栏包裹原文，内部的三反引号无需转义即可安全渲染。 */
function fence(text: string): string {
  return `\`\`\`\`text\n${text || '（空）'}\n\`\`\`\``;
}

function renderLlmCallDetail(call: DiagnosticLlmCall, index: number): string {
  const lines: string[] = [];
  lines.push(`#### 调用 #${index + 1}${call.purpose ? ` · ${call.purpose}` : ''}`);
  lines.push('');
  const tok =
    call.promptTokens != null || call.completionTokens != null
      ? `，token in/out=${call.promptTokens ?? '?'}/${call.completionTokens ?? '?'}`
      : '';
  lines.push(
    `- 模型 \`${call.model}\`，输入 ${call.messageCount} 条/${call.promptChars} 字，` +
      `输出 ${call.outputChars} 字${tok}，耗时 ${call.latencyMs}ms` +
      `${call.fellBackToNonStream ? '（非流式降级）' : ''}`,
  );
  lines.push('');
  if (call.messages && call.messages.length > 0) {
    lines.push('**发送的消息：**');
    lines.push('');
    for (const m of call.messages) {
      lines.push(`\`${m.role}\`：`);
      lines.push('');
      lines.push(fence(m.content));
      lines.push('');
    }
  }
  if (call.outputText != null) {
    lines.push('**模型输出：**');
    lines.push('');
    lines.push(fence(call.outputText));
    lines.push('');
  }
  return lines.join('\n');
}

function renderRun(run: DiagnosticRun, index: number): string {
  const lines: string[] = [];
  lines.push(`## 任务 ${index + 1}（${SOURCE_LABEL[run.source]}） · ${STATUS_LABEL[run.status]}`);
  lines.push('');
  lines.push(`- 用户输入：${run.userInput || '（空）'}`);
  lines.push(`- 模型：\`${run.model}\` @ \`${run.baseUrlHost || '未知端点'}\``);
  lines.push(`- 开始：${fmtTime(run.startedAt)}　耗时：${fmtDuration(run)}`);
  lines.push(`- 版本：扩展 v${run.extensionVersion} / 适配器 v${run.adapterVersion}`);
  lines.push('');

  if (run.status === 'error' && run.errorSummary) {
    lines.push(`> ⚠️ **异常**：${run.errorSummary}`);
    lines.push('');
  }

  // 步骤时间线（超长 detail 移入附录，表格保持可读）
  const appendix: DiagnosticStep[] = [];
  lines.push('### 步骤时间线');
  lines.push('');
  lines.push('| # | 时刻 | 类别 | 摘要 | 细节 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const s of run.steps) {
    const raw = s.detail ?? '';
    let detail: string;
    if (raw.length > INLINE_DETAIL_CHARS || raw.includes('\n')) {
      appendix.push(s);
      detail = `见附录 #${s.seq}`;
    } else {
      detail = raw.replace(/\|/g, '\\|');
    }
    const summary = s.summary.replace(/\n/g, ' ').replace(/\|/g, '\\|');
    lines.push(
      `| ${s.seq} | +${(s.atMs / 1000).toFixed(1)}s | ${KIND_LABEL[s.kind]} | ${summary} | ${detail} |`,
    );
  }
  lines.push('');

  // LLM 调用明细（原文）
  if (run.llmCalls.length > 0) {
    lines.push('### LLM 调用明细');
    lines.push('');
    lines.push(run.llmCalls.map((c, i) => renderLlmCallDetail(c, i)).join('\n'));
  }

  // 步骤详情附录（DOM outline 等超长内容）
  if (appendix.length > 0) {
    lines.push('### 步骤详情附录');
    lines.push('');
    for (const s of appendix) {
      lines.push(`#### 附录 #${s.seq} · ${s.summary}`);
      lines.push('');
      lines.push(fence(s.detail ?? ''));
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** 生成完整诊断报告 Markdown。runs 为空时给出占位说明。 */
export function buildDiagnosticsReport(runs: DiagnosticRun[]): string {
  const head: string[] = [];
  head.push('# BossPilot 执行日志');
  head.push('');
  head.push(`- 生成时间：${fmtTime(Date.now())}`);
  head.push(`- 任务数：${runs.length}`);
  const errorCount = runs.filter((r) => r.status === 'error').length;
  if (errorCount > 0) head.push(`- ⚠️ 含 ${errorCount} 个异常任务（见下方高亮）`);
  head.push('');
  head.push(
    '> 本日志仅记录在本机、导出前已擦除密钥/凭据；用于定位真实页面上的异常，可直接发出分析。',
  );
  head.push('');

  if (runs.length === 0) {
    head.push('_暂无可导出的任务记录。先和 AI 对话一轮后再下载。_');
    return head.join('\n');
  }

  head.push(ANALYSIS_GUIDE);
  head.push('');

  const body = runs.map((r, i) => renderRun(r, i)).join('\n---\n\n');
  return `${head.join('\n')}\n${body}`;
}

/** 诊断日志文件名：bosspilot-diag-YYYYMMDD-HHmmss.md */
export function diagnosticsFileName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `BossPilot-Diagnostics/bosspilot-diag-${stamp}.md`;
}
