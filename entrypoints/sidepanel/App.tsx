// ─── BossPilot 侧边栏主界面 ───
// 四个页签：对话（发起任务/进度/日志）、结果（岗位卡片）、报告（预览+下载）、设置。
// 对话页采用 home/session 双屏结构：首屏大输入框，发送后经沉底动画过渡到会话布局。

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Briefcase,
  Download,
  FileText,
  Loader2,
  MessageSquare,
  Settings,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TaskPhase } from '@/lib/domain/types';
import { useAgentPort } from './usePort';
import { Composer, type ComposerHandle } from './Composer';
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

/** 与 CSS 中沉底过渡时长保持一致（app.css .is-launching） */
const LAUNCH_MS = 520;

export default function App() {
  const { snapshot, entries, pushEntry, pendingParams, setPendingParams, send } = useAgentPort();
  const [tab, setTab] = useState<Tab>('chat');
  // started=false 时展示首页英雄屏；launching 期间执行沉底动画
  const [started, setStarted] = useState(false);
  const [launching, setLaunching] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const homeComposerRef = useRef<ComposerHandle>(null);
  // 沉底动画测量用：首页输入框外层
  const homeWrapRef = useRef<HTMLDivElement>(null);

  const running = RUNNING_PHASES.includes(snapshot.phase);
  const paused = snapshot.phase === 'paused_captcha';

  // 重连/回放后已有内容时跳过首页（快照非 idle 或已有对话记录）
  useEffect(() => {
    if (entries.length > 0 || snapshot.phase !== 'idle') setStarted(true);
  }, [entries.length, snapshot.phase]);

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
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [entries, snapshot.statusText, pendingParams]);

  const submit = (text: string) => {
    if (!text || running) return;
    pushEntry({ role: 'user', text });
    setPendingParams(null);
    // 先解析成任务卡片让用户确认，符合「人机协同」设计
    send({ type: 'parse_only', text });
    pushEntry({ role: 'agent', level: 'info', text: '正在解析你的需求，稍后请确认任务参数…' });
  };

  // 首页发送：先播沉底动画，动画结束后切会话屏并真正派发。
  // 位移距离现场测量：让输入框以原尺寸精确降落到会话态输入框的位置（只移动，不变形）。
  const homeSend = (text: string) => {
    if (!text || running || launching) return;
    const wrap = homeWrapRef.current;
    if (wrap) {
      const rect = wrap.getBoundingClientRect();
      // 会话态输入框顶边 = 视口底 - 输入区下边距(p-2.5=10px) - 自身高度
      const targetTop = window.innerHeight - 10 - rect.height;
      wrap.style.setProperty('--launch-dy', `${Math.max(0, targetTop - rect.top)}px`);
    }
    setLaunching(true);
    window.setTimeout(() => {
      setStarted(true);
      setLaunching(false);
      submit(text);
    }, LAUNCH_MS);
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
      {/* ── 头部（左：品牌与状态 / 右：页签图标，参考 Cebian・RedScope 顶栏布局） ── */}
      <header className="flex items-center gap-2 border-b border-line bg-app/90 px-3 py-2 backdrop-blur-xl">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-brand to-brand-strong text-white">
          <Bot size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold leading-tight">BossPilot</div>
          {running ? (
            <div className="flex items-center gap-1 truncate text-[10px] font-medium text-brand-strong">
              <Loader2 size={9} className="shrink-0 animate-spin" />
              {PHASE_LABEL[snapshot.phase]}
            </div>
          ) : (
            <div className="truncate text-[10px] text-ink-faint">AI 求职副驾 · 本地隐私</div>
          )}
        </div>
        <nav className="flex shrink-0 items-center gap-0.5">
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
              title={label}
              aria-label={label}
              className={`relative grid h-7 w-7 place-items-center rounded-lg transition-all duration-200 ${
                tab === key
                  ? 'bg-surface-mint text-brand-strong'
                  : 'text-ink-faint hover:bg-surface-soft hover:text-ink-soft'
              }`}
              onClick={() => setTab(key)}
            >
              <Icon size={15} />
              {key === 'jobs' && snapshot.jobs.length > 0 && (
                <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
              )}
            </button>
          ))}
        </nav>
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

      {/* ── 对话页 · 首屏（英雄区 + 大输入框，发送后沉底） ── */}
      {tab === 'chat' && !started && (
        <main className={`min-h-0 flex-1 overflow-y-auto ${launching ? 'is-launching' : ''}`}>
          <div className="flex min-h-full flex-col px-4 pb-6 pt-8">
            <div className="home-hero mb-4">
              <div className="mb-2 flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.16em] text-brand-strong before:h-px before:w-4 before:bg-brand-strong">
                AI Job Copilot
              </div>
              <h1 className="text-[clamp(20px,6vw,26px)] font-bold leading-[1.2] tracking-tight text-ink">
                一句话，
                <br />
                替你逛遍 Boss 直聘
              </h1>
              <p className="mt-2 max-w-[320px] text-[11px] leading-5 text-ink-soft">
                描述你要找的岗位，我来搜索、翻页、读 JD、语义过滤和匹配打分，最后给你一份可下载的推荐报告。
              </p>
            </div>

            <div ref={homeWrapRef}>
              <Composer
                ref={homeComposerRef}
                autoFocus
                clearOnSend={false}
                onSend={homeSend}
                className={`home-composer shadow-[0_14px_40px_rgba(6,79,70,0.08)] ${
                  launching ? 'home-composer-launching' : ''
                }`}
              />
            </div>

            <section className="home-extras mt-5">
              <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold text-ink-faint">
                <Sparkles size={11} className="text-brand" />
                试试这样问
              </div>
              <div className="flex flex-col gap-1.5">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    className="rounded-xl border border-line bg-surface px-3 py-2 text-left text-[11px] text-ink-soft transition-all duration-200 hover:-translate-y-px hover:border-brand hover:text-ink hover:shadow-[0_4px_14px_rgba(6,79,70,0.08)] active:translate-y-0"
                    onClick={() => homeComposerRef.current?.setText(ex)}
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </section>
          </div>
        </main>
      )}

      {/* ── 主内容（会话/结果/报告/设置） ── */}
      {(tab !== 'chat' || started) && (
        <main className="min-h-0 flex-1 overflow-y-auto" ref={tab === 'chat' ? scrollRef : undefined}>
          {tab === 'chat' && (
            <div className="flex flex-col gap-2.5 p-3">
              {entries.map((e) => (
                <div
                  key={e.id}
                  className={`msg-in max-w-[92%] px-3 py-2 text-xs leading-relaxed ${
                    e.role === 'user'
                      ? 'self-end rounded-[16px_16px_5px_16px] bg-brand text-white'
                      : e.level === 'error'
                        ? 'self-start rounded-[16px_16px_16px_5px] border border-danger/30 bg-surface text-danger'
                        : e.level === 'warn'
                          ? 'self-start rounded-[16px_16px_16px_5px] border border-warning/30 bg-surface-warm text-ink'
                          : 'self-start rounded-[16px_16px_16px_5px] border border-line bg-surface text-ink'
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

              {running && !paused && (
                <div className="msg-in flex w-full max-w-[92%] flex-col gap-2 self-start rounded-2xl border border-line bg-surface px-3 py-2.5">
                  <div className="flex items-center gap-2 text-xs text-ink-soft">
                    <Loader2 size={12} className="shrink-0 animate-spin text-brand" />
                    {snapshot.statusText || '执行中…'}
                    {snapshot.collected > 0 && (
                      <span className="text-[10px] text-ink-faint">已采集 {snapshot.collected}</span>
                    )}
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-surface-soft">
                    <i className="block h-full w-1/3 animate-[task-progress_1.4s_ease-in-out_infinite] rounded-full bg-brand" />
                  </div>
                </div>
              )}

              {paused && (
                <div className="msg-in flex flex-col gap-2 rounded-2xl border border-warning/40 bg-surface-warm p-3">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-warning">
                    <ShieldAlert size={13} /> 遇到安全验证
                  </div>
                  <p className="text-[11px] leading-relaxed text-ink-soft">
                    请切到 Boss 直聘页面手动完成验证，然后点击下方按钮继续。
                  </p>
                  <button
                    className="rounded-xl bg-warning py-1.5 text-xs font-semibold text-white transition-all duration-200 hover:shadow-md active:scale-[0.98]"
                    onClick={() => send({ type: 'resume_captcha' })}
                  >
                    我已完成验证，继续
                  </button>
                </div>
              )}

              {snapshot.phase === 'done' && snapshot.reportMarkdown && (
                <div className="msg-in flex gap-2 self-start">
                  <button
                    className="flex items-center gap-1 rounded-xl bg-brand px-3 py-1.5 text-[11px] font-semibold text-white transition-all duration-200 hover:bg-brand-strong hover:shadow-md active:scale-[0.98]"
                    onClick={() => setTab('report')}
                  >
                    <FileText size={12} /> 查看报告
                  </button>
                  <button
                    className="flex items-center gap-1 rounded-xl border border-line bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink transition-all duration-200 hover:border-brand hover:shadow-sm active:scale-[0.98]"
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
                  className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-xl bg-brand py-2 text-xs font-semibold text-white transition-all duration-200 hover:bg-brand-strong hover:shadow-md active:scale-[0.99]"
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
      )}

      {/* ── 会话底部输入区（仅对话页 · 已进入会话） ── */}
      {tab === 'chat' && started && (
        <div className="border-t border-line bg-app p-2.5">
          <Composer
            autoFocus
            running={running}
            onSend={submit}
            onCancel={() => send({ type: 'cancel' })}
          />
        </div>
      )}
    </div>
  );
}
