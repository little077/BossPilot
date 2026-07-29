// ─── 诊断记录：Markdown 报告 ───
// 把内存里的 DiagnosticRun[] 渲染成一份可直接发出去分析的 Markdown：
// 任务概览 + 异常高亮 + 步骤时间线 + LLM 调用摘要。数据在入库时已脱敏。

import type { DiagnosticRun, DiagnosticStep } from './types';

const STATUS_LABEL: Record<DiagnosticRun['status'], string> = {
  completed: '✅ 完成',
  error: '❌ 出错',
  cancelled: '⏹️ 已取消',
};

const KIND_LABEL: Record<DiagnosticStep['kind'], string> = {
  input: '输入',
  llm: '模型',
  note: '记录',
  error: '错误',
};

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

function renderRun(run: DiagnosticRun, index: number): string {
  const lines: string[] = [];
  lines.push(`## 任务 ${index + 1} · ${STATUS_LABEL[run.status]}`);
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

  // 步骤时间线
  lines.push('### 步骤时间线');
  lines.push('');
  lines.push('| # | 时刻 | 类别 | 摘要 | 细节 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const s of run.steps) {
    const detail = (s.detail ?? '').replace(/\n/g, ' ').replace(/\|/g, '\\|');
    const summary = s.summary.replace(/\n/g, ' ').replace(/\|/g, '\\|');
    lines.push(
      `| ${s.seq} | +${(s.atMs / 1000).toFixed(1)}s | ${KIND_LABEL[s.kind]} | ${summary} | ${detail} |`,
    );
  }
  lines.push('');

  // LLM 调用摘要
  if (run.llmCalls.length > 0) {
    lines.push('### LLM 调用摘要');
    lines.push('');
    lines.push('| # | 模型 | 输入(条/字) | 输出(字) | token in/out | 耗时 | 备注 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    run.llmCalls.forEach((c, i) => {
      const tok =
        c.promptTokens != null || c.completionTokens != null
          ? `${c.promptTokens ?? '?'}/${c.completionTokens ?? '?'}`
          : '—';
      lines.push(
        `| ${i + 1} | \`${c.model}\` | ${c.messageCount}/${c.promptChars} | ${c.outputChars} | ${tok} | ${c.latencyMs}ms | ${c.fellBackToNonStream ? '非流式降级' : '流式'} |`,
      );
    });
    lines.push('');
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
