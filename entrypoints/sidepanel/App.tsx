// ─── BossPilot 侧边栏主界面 ───
// 四个页签：对话（发起任务/进度/日志）、结果（岗位卡片）、报告（预览+下载）、设置。

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Briefcase,
  Download,
  FileText,
  Loader2,
  MessageSquare,
  Send,
  Settings,
  ShieldAlert,
  Square,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TaskPhase } from '@/lib/domain/types';
import { useAgentPort } from './usePort';
import { ParamsCard } from './ParamsCard';
import { JobList } from './JobList';
import { SettingsView } from './SettingsView';

type Tab = 'chat' | 'jobs' | 'report' | 'settings';

const PHASE_LABEL: Record<TaskPhase, string> = {
  idle: '就绪',
  parsing: '理解需求',
  searching: '打开搜索页',
  collecting: '采集列表',
  detailing: '读取详情',
  assessing: 'AI 评估',
  reporting: '生成报告',
  paused_captcha: '等待验证',
  done: '完成',
  error: '出错',
  cancelled: '已取消',
};

const RUNNING_PHASES: TaskPhase[] = [
  'parsing',
  'searching',
  'collecting',
  'detailing',
  'assessing',
  'reporting',
  'paused_captcha',
];

const EXAMPLES = [
  '帮我找西安的前端开发岗位，15K 以上，排除外包和驻场',
  '找 20 个杭州的 Java 后端，要求双休，最好是中大厂',
  '看看北京有哪些 3 年经验能投的产品经理岗位',
];

export default function App() {
  const { snapshot, entries, pushEntry, pendingParams, setPendingParams, send } = useAgentPort();
  const [tab, setTab] = useState<Tab>('chat');
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const running = RUNNING_PHASES.includes(snapshot.phase);
  const paused = snapshot.phase === 'paused_captcha';

  // 任务完成后自动切到结果页
  const prevPhase = useRef<TaskPhase>('idle');
  useEffect(() => {
    if (prevPhase.current !== 'done' && snapshot.phase === 'done' && snapshot.jobs.length > 0) {
      setTab('jobs');
    }
    prevPhase.current = snapshot.phase;
  }, [snapshot.phase, snapshot.jobs.length]);

  // 日志/状态更新时对话区滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries, snapshot.statusText, pendingParams]);

  const submit = () => {
    const text = input.trim();
    if (!text || running) return;
    pushEntry({ role: 'user', text });
    setInput('');
    setPendingParams(null);
    // 先解析成任务卡片让用户确认，符合「人机协同」设计
    send({ type: 'parse_only', text });
    pushEntry({ role: 'agent', level: 'info', text: '正在解析你的需求，稍后请确认任务参数…' });
  };

  const progressPct = useMemo(() => {
    const order: TaskPhase[] = ['parsing', 'searching', 'collecting', 'detailing', 'assessing', 'reporting'];
    const idx = order.indexOf(snapshot.phase);
    if (snapshot.phase === 'done') return 100;
    if (idx < 0) return 0;
    return Math.round(((idx + 1) / (order.length + 1)) * 100);
  }, [snapshot.phase]);

  return (
    <div className="flex h-full flex-col bg-app">
      {/* ── 头部 ── */}
      <header className="flex items-center gap-2 border-b border-line bg-app/90 px-3 py-2 backdrop-blur">
        <div className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-brand to-brand-strong text-white">
          <Bot size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold leading-tight">BossPilot</div>
          <div className="truncate text-[10px] text-ink-faint">Boss 直聘 AI 求职副驾 · 本地隐私</div>
        </div>
        {running && (
          <span className="flex items-center gap-1 rounded-full bg-surface-mint px-2 py-0.5 text-[10px] font-medium text-brand-strong">
            <Loader2 size={10} className="animate-spin" />
            {PHASE_LABEL[snapshot.phase]}
          </span>
        )}
      </header>

      {/* ── 进度条 ── */}
      {(running || snapshot.phase === 'done') && (
        <div className="h-0.5 w-full bg-line">
          <div
            className="h-full bg-brand transition-all duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      {/* ── 主内容 ── */}
      <main className="min-h-0 flex-1 overflow-y-auto" ref={tab === 'chat' ? scrollRef : undefined}>
        {tab === 'chat' && (
          <div className="flex flex-col gap-2.5 p-3">
            {entries.length === 0 && !pendingParams && (
              <div className="mt-6 flex flex-col items-center gap-3 text-center">
                <div className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-mint text-brand-strong">
                  <Briefcase size={22} />
                </div>
                <p className="text-xs leading-relaxed text-ink-soft">
                  用一句话描述你要找的岗位，
                  <br />
                  我来搜索、筛选、打分并生成报告。
                </p>
                <div className="flex w-full flex-col gap-1.5">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      className="rounded-xl border border-line bg-surface px-3 py-2 text-left text-[11px] text-ink-soft transition hover:border-brand hover:text-ink"
                      onClick={() => setInput(ex)}
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {entries.map((e) => (
              <div
                key={e.id}
                className={`max-w-[92%] rounded-2xl px-3 py-2 text-xs leading-relaxed ${
                  e.role === 'user'
                    ? 'self-end bg-brand text-white'
                    : e.level === 'error'
                      ? 'self-start border border-danger/30 bg-surface text-danger'
                      : e.level === 'warn'
                        ? 'self-start border border-warning/30 bg-surface-warm text-ink'
                        : 'self-start border border-line bg-surface text-ink'
                }`}
              >
                {e.text}
              </div>
            ))}

            {pendingParams && (
              <ParamsCard
                params={pendingParams}
                disabled={running}
                onRun={(p) => {
                  setPendingParams(null);
                  send({ type: 'run_params', params: p });
                }}
                onDismiss={() => setPendingParams(null)}
              />
            )}

            {running && (
              <div className="flex items-center gap-2 self-start rounded-2xl border border-line bg-surface px-3 py-2 text-xs text-ink-soft">
                <Loader2 size={12} className="shrink-0 animate-spin text-brand" />
                {snapshot.statusText || '执行中…'}
                {snapshot.collected > 0 && (
                  <span className="text-[10px] text-ink-faint">已采集 {snapshot.collected}</span>
                )}
              </div>
            )}

            {paused && (
              <div className="flex flex-col gap-2 rounded-2xl border border-warning/40 bg-surface-warm p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-warning">
                  <ShieldAlert size={13} /> 遇到安全验证
                </div>
                <p className="text-[11px] leading-relaxed text-ink-soft">
                  请切到 Boss 直聘页面手动完成验证，然后点击下方按钮继续。
                </p>
                <button
                  className="rounded-xl bg-warning py-1.5 text-xs font-semibold text-white"
                  onClick={() => send({ type: 'resume_captcha' })}
                >
                  我已完成验证，继续
                </button>
              </div>
            )}

            {snapshot.phase === 'done' && snapshot.reportMarkdown && (
              <div className="flex gap-2 self-start">
                <button
                  className="flex items-center gap-1 rounded-xl bg-brand px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-brand-strong"
                  onClick={() => setTab('report')}
                >
                  <FileText size={12} /> 查看报告
                </button>
                <button
                  className="flex items-center gap-1 rounded-xl border border-line bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink hover:border-brand"
                  onClick={() => send({ type: 'download_report' })}
                >
                  <Download size={12} /> 下载 MD
                </button>
              </div>
            )}
          </div>
        )}

        {tab === 'jobs' && <JobList jobs={snapshot.jobs} />}

        {tab === 'report' &&
          (snapshot.reportMarkdown ? (
            <div className="p-3">
              <button
                className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-xl bg-brand py-2 text-xs font-semibold text-white hover:bg-brand-strong"
                onClick={() => send({ type: 'download_report' })}
              >
                <Download size={13} /> 下载 Markdown 报告
              </button>
              <div className="report-md rounded-2xl border border-line bg-surface p-3">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{snapshot.reportMarkdown}</ReactMarkdown>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-ink-faint">
              任务完成后这里会展示 Markdown 报告。
            </div>
          ))}

        {tab === 'settings' && <SettingsView />}
      </main>

      {/* ── 输入区（仅对话页） ── */}
      {tab === 'chat' && (
        <div className="border-t border-line bg-app p-2.5">
          <div className="flex items-end gap-1.5 rounded-2xl border border-line bg-surface p-1.5 focus-within:border-brand">
            <textarea
              className="max-h-24 min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-1.5 text-xs outline-none placeholder:text-ink-faint"
              placeholder={running ? '任务执行中…' : '描述你要找的岗位，回车发送'}
              value={input}
              disabled={running}
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {running ? (
              <button
                className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-danger/10 text-danger transition hover:bg-danger/20"
                title="取消任务"
                onClick={() => send({ type: 'cancel' })}
              >
                <Square size={13} />
              </button>
            ) : (
              <button
                className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand text-white transition hover:bg-brand-strong disabled:opacity-40"
                disabled={!input.trim()}
                title="发送"
                onClick={submit}
              >
                <Send size={13} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── 底部页签 ── */}
      <nav className="grid grid-cols-4 border-t border-line bg-app">
        {(
          [
            ['chat', MessageSquare, '对话'],
            ['jobs', Briefcase, '结果'],
            ['report', FileText, '报告'],
            ['settings', Settings, '设置'],
          ] as const
        ).map(([key, Icon, label]) => (
          <button
            key={key}
            className={`flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition ${
              tab === key ? 'text-brand-strong' : 'text-ink-faint hover:text-ink-soft'
            }`}
            onClick={() => setTab(key)}
          >
            <Icon size={16} />
            {label}
            {key === 'jobs' && snapshot.jobs.length > 0 && (
              <span className="absolute" aria-hidden />
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}
