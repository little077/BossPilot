// ─── Markdown 报告生成器 ───
// 报告主体由确定性代码渲染（表格/清单/统计），LLM 只贡献「总评与建议」段。
// 保证：即使 LLM 总评失败，报告依然完整可用。

import type { AssessedJob, SearchTaskParams } from '@/lib/domain/types';

function fmtSalaryBand(jobs: AssessedJob[]): string {
  const mins = jobs.map((j) => j.salaryMinK).filter((n): n is number => n != null);
  const maxs = jobs.map((j) => j.salaryMaxK).filter((n): n is number => n != null);
  if (!mins.length || !maxs.length) return '未知';
  return `${Math.min(...mins)}K ~ ${Math.max(...maxs)}K`;
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** 生成完整 Markdown 报告。 */
export function buildReport(
  params: SearchTaskParams,
  jobs: AssessedJob[],
  summary: string,
): string {
  const passed = jobs
    .filter((j) => j.assessment.passed)
    .sort((a, b) => b.assessment.matchScore - a.assessment.matchScore);
  const excluded = jobs.filter((j) => !j.assessment.passed);
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const lines: string[] = [];
  lines.push(`# ${params.keyword} · ${params.city} 岗位搜索报告`);
  lines.push('');
  lines.push(`> 生成时间：${dateStr} ｜ 由 BossPilot 自动生成`);
  lines.push('');

  // ── 概览 ──
  lines.push('## 概览');
  lines.push('');
  lines.push(`- **搜索需求**：${params.keyword} @ ${params.city}` +
    (params.salaryMinK || params.salaryMaxK
      ? `，期望薪资 ${params.salaryMinK ?? '?'}-${params.salaryMaxK ?? '?'}K`
      : ''));
  if (params.softConditions.length) {
    lines.push(`- **软条件**：${params.softConditions.join('；')}`);
  }
  lines.push(`- **采集岗位**：${jobs.length} 个 ｜ **通过筛选**：${passed.length} 个 ｜ **被排除**：${excluded.length} 个`);
  lines.push(`- **薪资带**：${fmtSalaryBand(jobs)}`);
  lines.push('');

  // ── 总评（LLM） ──
  lines.push('## 总评与建议');
  lines.push('');
  lines.push(summary.trim());
  lines.push('');

  // ── 推荐清单 ──
  lines.push('## 推荐岗位（按匹配度排序）');
  lines.push('');
  if (passed.length === 0) {
    lines.push('*没有岗位通过筛选。*');
  } else {
    lines.push('| # | 匹配 | 职位 | 薪资 | 公司 | 区域 | 亮点 | 风险 |');
    lines.push('| - | - | - | - | - | - | - | - |');
    passed.forEach((j, i) => {
      lines.push(
        `| ${i + 1} | **${j.assessment.matchScore}** | [${esc(j.title)}](${j.url}) | ${esc(j.salaryText || '未知')} | ${esc(j.companyName)}${j.companySize ? `（${esc(j.companySize)}）` : ''} | ${esc(j.area ?? '')} | ${esc(j.assessment.highlights.join('；'))} | ${esc(j.assessment.risks.join('；'))} |`,
      );
    });
  }
  lines.push('');

  // ── 岗位详情分节（前 10 个通过者） ──
  const top = passed.slice(0, 10);
  if (top.length) {
    lines.push('## 重点岗位详情');
    lines.push('');
    for (const j of top) {
      lines.push(`### ${j.title} ｜ ${j.companyName}（匹配 ${j.assessment.matchScore}）`);
      lines.push('');
      lines.push(`- 薪资：${j.salaryText || '未知'} ｜ 区域：${j.area ?? '未知'} ｜ 招聘者：${j.recruiter ?? '未知'}`);
      if (j.jobTags.length) lines.push(`- 职位标签：${j.jobTags.join(' / ')}`);
      if (j.companyTags.length) lines.push(`- 公司标签：${j.companyTags.join(' / ')}`);
      if (j.assessment.highlights.length) lines.push(`- ✅ 亮点：${j.assessment.highlights.join('；')}`);
      if (j.assessment.risks.length) lines.push(`- ⚠️ 风险：${j.assessment.risks.join('；')}`);
      lines.push(`- 链接：${j.url}`);
      if (j.description) {
        lines.push('');
        lines.push('<details><summary>JD 摘录</summary>');
        lines.push('');
        lines.push(j.description.slice(0, 800));
        lines.push('');
        lines.push('</details>');
      }
      lines.push('');
    }
  }

  // ── 排除清单 ──
  if (excluded.length) {
    lines.push('## 被排除的岗位');
    lines.push('');
    lines.push('| 职位 | 公司 | 薪资 | 排除原因 |');
    lines.push('| - | - | - | - |');
    for (const j of excluded) {
      lines.push(
        `| [${esc(j.title)}](${j.url}) | ${esc(j.companyName)} | ${esc(j.salaryText || '未知')} | ${esc(j.assessment.excludeReason ?? '未通过软条件')} |`,
      );
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('*本报告数据来自公开页面的本地采集，仅供个人求职参考。*');
  return lines.join('\n');
}

/** 报告文件名（下载用）。 */
export function reportFileName(params: SearchTaskParams): string {
  const now = new Date();
  const d = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const safe = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_');
  return `BossPilot_${safe(params.keyword)}_${safe(params.city)}_${d}.md`;
}
