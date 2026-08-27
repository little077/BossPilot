// ─── 诊断记录：Markdown 报告 ───
// 把内存里的 DiagnosticRun[] 渲染成一份可直接交给 AI 分析的 Markdown：
// 分析指引 + 任务概览 + 异常高亮 + 步骤时间线 + LLM 调用明细（含提示词/输出原文）
// + 步骤详情附录（DOM outline 等超长内容）。数据在入库时已脱敏。

import type { DiagnosticPageStructureSnapshot } from '@/lib/domain/types';
import { redact } from './redaction';
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

const PAGE_KIND_LABEL: Record<NonNullable<DiagnosticPageStructureSnapshot['pageKind']>, string> = {
  standalone_detail: '独立岗位详情页',
  embedded_detail: '列表页内展开的岗位详情',
  job_list: '岗位列表页（未识别到展开详情）',
  unknown: '未知 Boss 页面结构',
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
- 「当前页面结构诊断」是在下载瞬间重新采集的活动 Boss 标签页，包含候选选择器
  命中数、固定文案的 DOM 祖先路径与限量可见 DOM 骨架；优先用它修复当前页面适配；
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
      `${call.finishReason ? `，结束原因 \`${call.finishReason}\`` : ''}` +
      `${call.toolName ? `，请求工具 \`${call.toolName}\`` : ''}` +
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
  if (run.conversationId) lines.push(`- 会话：\`${run.conversationId}\``);
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

  // Agent 事件流（ChatGenerationEvent 逐条摘要，与 UI 广播一一对应）
  const events = run.events ?? [];
  if (events.length > 0) {
    lines.push('### Agent 事件流');
    lines.push('');
    lines.push('| 时刻 | 事件 | 摘要 |');
    lines.push('| --- | --- | --- |');
    for (const event of events) {
      lines.push(
        `| +${(event.atMs / 1000).toFixed(1)}s | \`${event.type}\` | ${event.summary.replace(/\|/g, '\\|')} |`,
      );
    }
    lines.push('');
  }

  // Agent 内部状态快照（ToolContext 内容、运行状态等关键节点）
  const snapshots = run.contextSnapshots ?? [];
  if (snapshots.length > 0) {
    lines.push('### Agent 上下文快照');
    lines.push('');
    for (const snapshot of snapshots) {
      lines.push(
        `- **${snapshot.phase}**（+${(snapshot.atMs / 1000).toFixed(1)}s）：${snapshot.summary}`,
      );
      if (snapshot.detail) lines.push(`  - ${snapshot.detail}`);
    }
    lines.push('');
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

function visibleMatches(snapshot: DiagnosticPageStructureSnapshot, group: string): number {
  return (snapshot.selectorProbes ?? [])
    .filter((probe) => probe.group === group)
    .reduce((total, probe) => total + probe.visibleMatches, 0);
}

function renderPageFindings(snapshot: DiagnosticPageStructureSnapshot): string[] {
  const findings: string[] = [];
  const jobCards = visibleMatches(snapshot, '职位列表卡片');
  const detailRoots = visibleMatches(snapshot, '详情面板根节点');
  const descriptions = visibleMatches(snapshot, '岗位正文');
  const hasDescriptionLandmark = (snapshot.landmarks ?? []).some(({ label }) =>
    /职位描述|岗位描述|职位详情/.test(label),
  );

  if (jobCards > 0 && descriptions === 0) {
    findings.push(
      '已识别到职位列表卡片，但现有“岗位正文”候选选择器全部未命中；需要从 DOM 骨架中为真实 JD 容器追加候选选择器。',
    );
  }
  if (hasDescriptionLandmark && detailRoots === 0) {
    findings.push(
      '页面存在“职位描述/岗位描述”可见文字，但详情面板根节点未命中；需要根据“关键文案路径”补充详情根节点选择器。',
    );
  }
  if (hasDescriptionLandmark && descriptions === 0) {
    findings.push(
      '页面肉眼存在岗位正文入口，但正文选择器未命中；优先沿关键文案路径向上定位正文容器，并为该结构增加脱敏 DOM 回归测试。',
    );
  }
  if (descriptions > 0) {
    findings.push(
      '现有岗位正文选择器已命中；若工具仍失败，应重点检查详情根节点范围、隐藏面板过滤和当前活动标签页选择。',
    );
  }
  if (snapshot.truncated) {
    findings.push(
      'DOM 骨架达到安全上限并被截断；如关键详情结构未出现在报告中，应进一步收敛到“职位描述”关键文案附近采集。',
    );
  }
  if (findings.length === 0) {
    findings.push(
      '当前候选选择器和关键文案均未提供足够信号；请结合 DOM 骨架确认页面是否尚未加载完成、处于验证码页或使用了全新结构。',
    );
  }
  return findings;
}

function renderPageStructure(snapshot: DiagnosticPageStructureSnapshot): string {
  const lines: string[] = ['## 当前页面结构诊断', ''];
  if (snapshot.status !== 'captured') {
    lines.push(
      `> ${snapshot.status === 'skipped' ? 'ℹ️ 未采集' : '⚠️ 采集失败'}：${redact(snapshot.reason) || '未知原因'}`,
    );
    if (snapshot.pageUrl) lines.push(`- 页面：\`${redact(snapshot.pageUrl)}\``);
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`- 页面：\`${redact(snapshot.pageUrl) || '未知页面'}\``);
  lines.push(
    `- 类型：${snapshot.pageKind ? PAGE_KIND_LABEL[snapshot.pageKind] : '未知'}；readyState=${snapshot.readyState ?? '未知'}`,
  );
  lines.push(
    `- 视口：${snapshot.viewport ? `${snapshot.viewport.width}×${snapshot.viewport.height}` : '未知'}；记录节点 ${snapshot.nodeCount ?? 0}${snapshot.truncated ? '（已达安全上限并截断）' : ''}`,
  );
  lines.push('');
  lines.push(
    '> 隐私说明：页面诊断不包含表单值、Cookie、Storage、链接地址和查询参数；DOM 骨架仅保留 class、层级及最多 48 字的脱敏可见文本片段。',
  );
  lines.push('');

  lines.push('### 自动分析出的改进点');
  lines.push('');
  for (const finding of renderPageFindings(snapshot)) lines.push(`- ${finding}`);
  lines.push('');

  const probes = snapshot.selectorProbes ?? [];
  if (probes.length > 0) {
    lines.push('### 当前适配器选择器命中');
    lines.push('');
    lines.push('| 字段 | 候选选择器 | 全部命中 | 可见命中 |');
    lines.push('| --- | --- | ---: | ---: |');
    for (const probe of probes) {
      lines.push(
        `| ${probe.group} | \`${probe.selector}\` | ${probe.matches} | ${probe.visibleMatches} |`,
      );
    }
    lines.push('');
  }

  const landmarks = snapshot.landmarks ?? [];
  if (landmarks.length > 0) {
    lines.push('### 关键文案路径');
    lines.push('');
    lines.push('| 文案 | DOM 祖先路径 |');
    lines.push('| --- | --- |');
    for (const landmark of landmarks) {
      lines.push(`| ${landmark.label} | \`${redact(landmark.path)}\` |`);
    }
    lines.push('');
  }

  if (snapshot.outline) {
    lines.push('### 限量可见 DOM 骨架');
    lines.push('');
    lines.push(fence(redact(snapshot.outline)));
    lines.push('');
  }
  return lines.join('\n');
}

/** 生成完整诊断报告 Markdown；即使没有运行记录，也可以只导出当前页面结构。 */
export function buildDiagnosticsReport(
  runs: DiagnosticRun[],
  pageStructure?: DiagnosticPageStructureSnapshot,
): string {
  const head: string[] = [];
  head.push('# BossPilot 执行日志');
  head.push('');
  head.push(`- 生成时间：${fmtTime(Date.now())}`);
  head.push(`- 任务数：${runs.length}`);
  const errorCount = runs.filter((r) => r.status === 'error').length;
  if (errorCount > 0) head.push(`- ⚠️ 含 ${errorCount} 个异常任务（见下方高亮）`);
  head.push('');
  head.push(
    '> 本日志仅记录在本机、导出前已擦除密钥/凭据；如包含页面结构，分享前仍建议快速检查可见文本片段。',
  );
  head.push('');

  if (runs.length === 0 && !pageStructure) {
    head.push('_暂无可导出的任务记录。先和 AI 对话一轮后再下载。_');
    return head.join('\n');
  }

  if (pageStructure) {
    head.push(renderPageStructure(pageStructure));
    head.push('');
  }

  head.push(ANALYSIS_GUIDE);
  head.push('');

  if (runs.length === 0) {
    head.push('_本次没有执行记录，已仅导出当前页面结构诊断。_');
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
