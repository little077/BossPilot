// ─── 任务参数卡片：展示/编辑解析出的结构化参数，确认后执行 ───

import { useState } from 'react';
import { Play, X } from 'lucide-react';
import type { SearchTaskParams } from '@/lib/domain/types';

export function ParamsCard(props: {
  params: SearchTaskParams;
  disabled: boolean;
  onRun: (params: SearchTaskParams) => void;
  onDismiss: () => void;
}) {
  const [p, setP] = useState<SearchTaskParams>(props.params);

  const field = (label: string, node: React.ReactNode) => (
    <label className="flex flex-col gap-1 text-[11px] text-ink-soft">
      {label}
      {node}
    </label>
  );
  const inputCls =
    'rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-ink outline-none focus:border-brand';

  return (
    <div className="rounded-2xl border border-line-strong bg-surface-mint p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-brand-deep">已解析的搜索任务（可修改）</span>
        <button
          className="rounded p-0.5 text-ink-faint hover:text-ink"
          onClick={props.onDismiss}
          title="放弃"
        >
          <X size={14} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {field(
          '关键词',
          <input
            className={inputCls}
            value={p.keyword}
            onChange={(e) => setP({ ...p, keyword: e.target.value })}
          />,
        )}
        {field(
          '城市',
          <input
            className={inputCls}
            value={p.city}
            onChange={(e) => setP({ ...p, city: e.target.value })}
          />,
        )}
        {field(
          '薪资下限（K）',
          <input
            className={inputCls}
            type="number"
            value={p.salaryMinK ?? ''}
            onChange={(e) =>
              setP({ ...p, salaryMinK: e.target.value ? Number(e.target.value) : undefined })
            }
          />,
        )}
        {field(
          '薪资上限（K）',
          <input
            className={inputCls}
            type="number"
            value={p.salaryMaxK ?? ''}
            onChange={(e) =>
              setP({ ...p, salaryMaxK: e.target.value ? Number(e.target.value) : undefined })
            }
          />,
        )}
        {field(
          '最多采集（1-40）',
          <input
            className={inputCls}
            type="number"
            min={1}
            max={40}
            value={p.maxJobs}
            onChange={(e) =>
              setP({ ...p, maxJobs: Math.min(Math.max(Number(e.target.value) || 20, 1), 40) })
            }
          />,
        )}
        {field(
          '读取 JD 全文',
          <select
            className={inputCls}
            value={p.fetchDetails ? '1' : '0'}
            onChange={(e) => setP({ ...p, fetchDetails: e.target.value === '1' })}
          >
            <option value="1">是（更准，稍慢）</option>
            <option value="0">否（只按列表信息）</option>
          </select>,
        )}
      </div>
      <div className="mt-2">
        {field(
          '软条件（每行一条，交给 AI 判断）',
          <textarea
            className={`${inputCls} min-h-[52px] resize-y`}
            value={p.softConditions.join('\n')}
            onChange={(e) =>
              setP({
                ...p,
                softConditions: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
              })
            }
          />,
        )}
      </div>
      <button
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-brand py-2 text-xs font-semibold text-white transition hover:bg-brand-strong disabled:opacity-50"
        disabled={props.disabled || !p.keyword.trim()}
        onClick={() => props.onRun(p)}
      >
        <Play size={13} /> 开始执行
      </button>
    </div>
  );
}
