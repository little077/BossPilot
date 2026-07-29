// ─── 结果列表：评估后的岗位卡片（按匹配度排序） ───

import { ExternalLink, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { AssessedJob } from '@/lib/domain/types';

function scoreColor(score: number): string {
  if (score >= 75) return 'text-success';
  if (score >= 50) return 'text-warning';
  return 'text-danger';
}

export function JobList({ jobs }: { jobs: AssessedJob[] }) {
  if (jobs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-ink-faint">
        暂无结果——先在「对话」页发起一次搜索任务。
      </div>
    );
  }
  const sorted = [...jobs].sort((a, b) => {
    if (a.assessment.passed !== b.assessment.passed) return a.assessment.passed ? -1 : 1;
    return b.assessment.matchScore - a.assessment.matchScore;
  });
  return (
    <div className="flex flex-col gap-2 p-3">
      {sorted.map((j) => (
        <div
          key={j.id}
          className={`rounded-2xl border p-3 shadow-sm ${
            j.assessment.passed
              ? 'border-line bg-surface'
              : 'border-line bg-surface-soft opacity-70'
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <a
                href={j.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex max-w-full items-center gap-1 truncate text-[13px] font-semibold text-ink hover:text-brand-strong"
              >
                <span className="truncate">{j.title}</span>
                <ExternalLink size={11} className="shrink-0 text-ink-faint" />
              </a>
              <div className="mt-0.5 truncate text-[11px] text-ink-soft">
                {j.companyName}
                {j.companySize ? ` · ${j.companySize}` : ''}
                {j.area ? ` · ${j.area}` : ''}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className={`text-base font-bold ${scoreColor(j.assessment.matchScore)}`}>
                {j.assessment.matchScore}
              </div>
              <div className="text-[10px] font-medium text-brand-strong">
                {j.salaryText || '薪资未知'}
              </div>
            </div>
          </div>

          {(j.jobTags.length > 0 || j.companyTags.length > 0) && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {Array.from(new Set([...j.jobTags, ...j.companyTags]))
                .slice(0, 6)
                .map((t) => (
                  <span
                    key={t}
                    className="rounded-md bg-surface-soft px-1.5 py-0.5 text-[10px] text-ink-soft"
                  >
                    {t}
                  </span>
                ))}
            </div>
          )}

          {!j.assessment.passed && j.assessment.excludeReason && (
            <div className="mt-1.5 flex items-start gap-1 text-[11px] text-danger">
              <ThumbsDown size={11} className="mt-0.5 shrink-0" />
              已排除：{j.assessment.excludeReason}
            </div>
          )}
          {j.assessment.highlights.length > 0 && (
            <div className="mt-1.5 flex items-start gap-1 text-[11px] text-success">
              <ThumbsUp size={11} className="mt-0.5 shrink-0" />
              {j.assessment.highlights.join('；')}
            </div>
          )}
          {j.assessment.risks.length > 0 && (
            <div className="mt-1 text-[11px] text-warning">⚠ {j.assessment.risks.join('；')}</div>
          )}
        </div>
      ))}
    </div>
  );
}
