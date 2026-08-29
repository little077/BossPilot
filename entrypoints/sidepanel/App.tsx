// ─── BossPilot 侧边栏主界面 ───
// 三个页签：对话（流式多轮对话）、历史（本地会话列表与恢复）、设置。
// 对话页采用 home/session 双屏结构：首屏大输入框，发送后经沉底动画过渡到会话布局。

import {
  Bot,
  FileText,
  History,
  Image,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  RotateCcw,
  ScrollText,
  Settings,
  Sparkles,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatAttachment } from '@/lib/domain/chat';
import type { ProviderStateView, TaskPhase } from '@/lib/domain/types';
import { sendProviderCommand } from '@/lib/providers/client';
import { loadConversationRuntimeSettings } from '@/lib/storage/db';
import { AskUserPanel } from './AskUserPanel';
import { ChatFlowStatus } from './ChatFlowStatus';
import { Composer, type ComposerDraft, type ComposerHandle } from './Composer';
import { ConversationRuntimeControls } from './ConversationRuntimeControls';
import { HistoryView } from './HistoryView';
import { MessageActions } from './MessageActions';
import { PagePermissionPanel } from './PagePermissionPanel';
import { TooltipProvider } from './ui/Tooltip';
import { useAgentPort } from './usePort';
import { WorkspaceView } from './WorkspaceView';

type Tab = 'chat' | 'history' | 'workspace' | 'settings';

const SettingsView = lazy(() =>
  import('./SettingsView').then((module) => ({ default: module.SettingsView })),
);

const PHASE_LABEL: Record<TaskPhase, string> = {
  idle: '就绪',
  parsing: '理解需求',
  searching: '打开搜索页',
  collecting: '采集列表',
  detailing: '读取详情',
  assessing: 'AI 评估',
  paused_captcha: '等待验证',
  done: '完成',
  error: '出错',
  cancelled: '已取消',
};

const RUNNING_PHASES = new Set<TaskPhase>([
  'parsing',
  'searching',
  'collecting',
  'detailing',
  'assessing',
  'paused_captcha',
]);

const PROGRESS_PHASES: TaskPhase[] = [
  'parsing',
  'searching',
  'collecting',
  'detailing',
  'assessing',
];

const NAV_ITEMS = [
  ['chat', MessageSquare, '对话'],
  ['history', History, '历史记录'],
  ['workspace', FileText, '产物'],
  ['settings', Settings, '设置'],
] as const;

const MARKDOWN_PLUGINS = [remarkGfm];

const EXAMPLES = [
  '总结一下我当前打开的网页，并列出三个重点',
  '读一下当前的小红书帖子，总结正文重点和评论区共识',
  '比较我打开的旅行攻略，整理一份行程建议和避坑清单',
];

/** 与 CSS 中沉底过渡时长保持一致（app.css .is-launching） */
const LAUNCH_MS = 520;
const NEW_CONVERSATION_DRAFT_KEY = 'new-conversation';

export default function App() {
  const {
    snapshot,
    messages,
    conversations,
    activeConversationId,
    runningConversationId,
    runningConversationIds,
    runs,
    historyError,
    chatRunning,
    ready,
    connected,
    sendChat,
    cancelChat,
    retryChat,
    regenerateChat,
    resolvePagePermission,
    resolveAskUser,
    downloadDiagnostics,
    startNewConversation,
    restoreConversation,
    setViewedConversationId,
    renameConversationTitle,
  } = useAgentPort();
  const safeRunningConversationIds =
    runningConversationIds ?? (runningConversationId ? [runningConversationId] : []);
  const safeRuns = runs ?? [];
  const [tab, setTab] = useState<Tab>('chat');
  const [composerDrafts, setComposerDrafts] = useState<Record<string, ComposerDraft>>({});
  const [modelSetupMessage, setModelSetupMessage] = useState('');
  const [homeComposerDraftKey, setHomeComposerDraftKey] = useState(NEW_CONVERSATION_DRAFT_KEY);
  const providerStateRef = useRef<ProviderStateView | null>(null);
  // started=false 时展示首页英雄屏；launching 期间执行沉底动画
  const [started, setStarted] = useState(false);
  const [launching, setLaunching] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const homeComposerRef = useRef<ComposerHandle>(null);
  // 沉底动画测量用：首页输入框外层
  const homeWrapRef = useRef<HTMLDivElement>(null);

  const pipelineRunning = RUNNING_PHASES.has(snapshot.phase);
  const currentConversationRunning =
    activeConversationId !== null && safeRunningConversationIds.includes(activeConversationId);
  const composerDraftKey = activeConversationId ?? NEW_CONVERSATION_DRAFT_KEY;
  const currentRun = safeRuns.find((run) => run.conversationId === activeConversationId);
  const anotherConversationRunning = safeRunningConversationIds.some(
    (conversationId) => conversationId !== activeConversationId,
  );
  const lastMessage = messages.at(-1);
  const activeAssistant = lastMessage?.role === 'assistant' ? lastMessage : undefined;
  const pendingUserQuestion =
    currentConversationRunning && activeAssistant?.status === 'streaming'
      ? activeAssistant.pendingUserQuestion
      : undefined;
  const currentToolActivity =
    activeAssistant?.toolActivities?.at(-1) ?? activeAssistant?.toolActivity;
  // 权限请求也固定呈现在底部输入区上方（与 Ask User 同一位置），
  // 避免确认卡片埋在上方消息流里被忽略；Ask User 与权限请求不会同时暂停。
  const waitingPermissionActivity =
    currentConversationRunning && currentToolActivity?.status === 'waiting_permission'
      ? currentToolActivity
      : undefined;
  const bottomPaused = pendingUserQuestion || waitingPermissionActivity;
  const chatStatusText = pendingUserQuestion
    ? '任务已暂停 · 等待你的回答'
    : currentRun?.status === 'queued'
      ? `任务排队中 · 第 ${currentRun.queuePosition ?? 1} 位`
      : currentToolActivity?.status === 'waiting_permission'
        ? currentToolActivity.permissionKind === 'interact'
          ? '等待网站操作权限'
          : '等待页面读取权限'
        : currentToolActivity?.status === 'running'
          ? `执行工具 · ${currentToolActivity.label}`
          : currentToolActivity
            ? '回复生成中…'
            : '思考中…';

  const updateComposerDraft = useCallback((key: string, draft: ComposerDraft) => {
    setComposerDrafts((current) => ({ ...current, [key]: draft }));
  }, []);

  const clearComposerDraft = useCallback((key: string) => {
    setComposerDrafts((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const applyProviderState = useCallback((state: ProviderStateView) => {
    providerStateRef.current = state;
    if (state.activeModel) setModelSetupMessage('');
  }, []);

  useEffect(() => {
    let active = true;
    void sendProviderCommand({ type: 'providers:get' })
      .then((state) => {
        if (active) applyProviderState(state);
      })
      .catch(() => {
        // 发送时会再检查一次；初始化失败不能吞掉用户已经输入的草稿。
      });
    return () => {
      active = false;
    };
  }, [applyProviderState]);

  // 回放后已有对话时跳过首页；首页发送动画期间先保持当前 DOM，
  // 避免乐观消息写入后提前切屏，让输入框能够完整落到会话区。
  useEffect(() => {
    if (ready && messages.length > 0 && !launching) setStarted(true);
  }, [launching, ready, messages.length]);

  // 首页发送后 activeConversationId 会先变更；动画结束前仍固定使用原草稿键，
  // 避免输入内容在下沉途中因编辑器重建而闪空。
  useEffect(() => {
    if (!started && !launching) setHomeComposerDraftKey(composerDraftKey);
  }, [composerDraftKey, launching, started]);

  // 消息/流式更新时对话区滚到底
  useEffect(() => {
    if (messages.length === 0) return;
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages]);

  // “已读”以用户当前打开的会话为准；历史列表本身不会把记录标记为已读。
  useEffect(() => {
    setViewedConversationId(tab === 'chat' ? activeConversationId : null);
  }, [activeConversationId, setViewedConversationId, tab]);

  const ensureModelConfigured = async (): Promise<boolean> => {
    let state = providerStateRef.current;
    if (!state) {
      try {
        state = await sendProviderCommand({ type: 'providers:get' });
        applyProviderState(state);
      } catch {
        setModelSetupMessage('暂时无法读取模型配置。请检查模型卡包后再返回对话发送。');
        setTab('settings');
        return false;
      }
    }
    if (state.activeModel) return true;
    if (activeConversationId) {
      const runtimeSettings = await loadConversationRuntimeSettings(activeConversationId).catch(
        () => null,
      );
      const identity = runtimeSettings?.modelIdentity;
      if (
        identity &&
        state.connections.some(
          (connection) =>
            connection.providerId === identity.providerId &&
            connection.models.some((model) => model.id === identity.modelId),
        )
      ) {
        return true;
      }
    }
    setModelSetupMessage(
      '发送消息前，请先领取模型卡、填写密钥并选择一个默认模型。你的输入草稿已保留。',
    );
    setTab('settings');
    return false;
  };

  const submit = async (
    text: string,
    attachments: ChatAttachment[] = [],
    draftKey = composerDraftKey,
  ): Promise<boolean> => {
    if (!text && attachments.length === 0) return false;
    if (!currentConversationRunning && !(await ensureModelConfigured())) return false;
    const accepted = sendChat(text, attachments);
    if (accepted) clearComposerDraft(draftKey);
    return accepted;
  };

  const startNewChat = () => {
    if (messages.length === 0) return;
    startNewConversation();
    setTab('chat');
    setStarted(false);
  };

  const restoreFromHistory = async (conversationId: string): Promise<boolean> => {
    const restored = await restoreConversation(conversationId);
    if (restored) {
      setTab('chat');
      setStarted(true);
    }
    return restored;
  };

  const viewRunningConversation = async () => {
    if (!runningConversationId) return;
    await restoreFromHistory(runningConversationId);
  };

  // 首页发送：先同步占用本轮请求，再播放沉底动画。
  // 发送被拒绝时不启动动画，避免输入框下沉后又回弹到首页。
  const homeSend = async (text: string, attachments: ChatAttachment[]): Promise<boolean> => {
    if ((!text && !attachments.length) || launching || !connected) return false;
    if (!(await submit(text, attachments, homeComposerDraftKey))) return false;

    const wrap = homeWrapRef.current;
    if (wrap) {
      const rect = wrap.getBoundingClientRect();
      const targetTop = window.innerHeight - 10 - rect.height;
      wrap.style.setProperty('--launch-dy', `${Math.max(0, targetTop - rect.top)}px`);
    }
    setLaunching(true);
    window.setTimeout(() => {
      setLaunching(false);
      setStarted(true);
    }, LAUNCH_MS);
    return true;
  };

  const progressIndex = PROGRESS_PHASES.indexOf(snapshot.phase);
  const progressPct =
    snapshot.phase === 'done'
      ? 100
      : progressIndex < 0
        ? 0
        : Math.round(((progressIndex + 1) / (PROGRESS_PHASES.length + 1)) * 100);

  return (
    <TooltipProvider delayDuration={180} skipDelayDuration={80} disableHoverableContent>
      <div className="redscope-app flex h-full flex-col bg-app" data-testid="app-shell">
        {/* ── 头部（左：品牌与状态 / 右：页签图标） ── */}
        <header className="redscope-topbar flex items-center gap-2 border-b px-3 py-2 backdrop-blur-xl">
          <div className="redscope-brand-mark grid h-7 w-7 shrink-0 place-items-center rounded-[10px]">
            <Bot size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="redscope-brand-name text-[14px] leading-tight">BossPilot</div>
            {chatRunning ? (
              <div className="flex items-center gap-1 truncate text-[10px] font-medium text-brand-strong">
                <Loader2 size={9} className="shrink-0 animate-spin" />
                {chatStatusText}
              </div>
            ) : pipelineRunning ? (
              <div className="flex items-center gap-1 truncate text-[10px] font-medium text-brand-strong">
                <Loader2 size={9} className="shrink-0 animate-spin" />
                {PHASE_LABEL[snapshot.phase]}
              </div>
            ) : (
              <div className="flex items-center gap-1.5 truncate text-[9.5px] text-ink-faint">
                <span className="redscope-status-dot" aria-hidden />
                BYOK · 页面按需授权
              </div>
            )}
          </div>
          {messages.length > 0 && (
            <button
              type="button"
              title="新对话"
              aria-label="新对话"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-line bg-surface text-ink-soft transition-all duration-200 hover:border-brand hover:text-brand-strong active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={messages.length === 0}
              onClick={startNewChat}
            >
              <MessageSquarePlus size={15} />
            </button>
          )}
          <nav className="flex shrink-0 items-center gap-0.5" aria-label="主导航">
            {NAV_ITEMS.map(([key, Icon, label]) => (
              <button
                key={key}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={tab === key}
                className={`relative grid h-7 w-7 place-items-center rounded-lg transition-all duration-200 ${
                  tab === key
                    ? 'bg-surface-mint text-brand'
                    : 'text-ink-faint hover:bg-surface-soft hover:text-ink-soft'
                }`}
                onClick={() => setTab(key)}
              >
                <Icon size={15} />
                {key === 'history' && conversations.some(({ unread }) => unread) && (
                  <span
                    className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-danger"
                    aria-hidden
                  />
                )}
              </button>
            ))}
          </nav>
        </header>

        {/* ── 进度条（搜索采集流水线用） ── */}
        {(pipelineRunning || snapshot.phase === 'done') && (
          <div
            className="h-0.5 w-full bg-line"
            role="progressbar"
            aria-label="任务进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPct}
          >
            <div
              className="h-full bg-brand transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}

        {/* ── 对话页 · 首屏（英雄区 + 大输入框，发送后沉底） ── */}
        {tab === 'chat' && !started && (
          <main
            className={`redscope-view redscope-home min-h-0 flex-1 overflow-y-auto ${
              launching ? 'is-launching' : ''
            }`}
          >
            <div className="redscope-home-inner flex min-h-full flex-col">
              <div className="home-hero mb-4">
                <div className="redscope-eyebrow mb-2 flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.16em] before:h-px before:w-4 before:bg-current">
                  Browser AI Agent
                </div>
                <h1 className="redscope-home-title text-[clamp(22px,6.5vw,27px)] leading-[1.22]">
                  聊两句，
                  <br />
                  让浏览和求知更省心
                </h1>
                <p className="redscope-home-copy mt-2 max-w-[320px] text-[11px] leading-5">
                  读懂当前网页、整理小红书帖子、比较旅行攻略、提炼长文重点……直接开聊。需要访问其他网站时，会先向你申请该网站权限。
                </p>
              </div>

              <div ref={homeWrapRef}>
                <Composer
                  key={homeComposerDraftKey}
                  ref={homeComposerRef}
                  autoFocus
                  clearOnSend={false}
                  disabled={!connected}
                  onSend={homeSend}
                  draft={composerDrafts[homeComposerDraftKey]}
                  onDraftChange={(draft) => updateComposerDraft(homeComposerDraftKey, draft)}
                  className={`home-composer redscope-home-composer ${
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
                      type="button"
                      className="redscope-example rounded-xl border px-3 py-2 text-left text-[11px] transition-all duration-200 hover:-translate-y-px active:translate-y-0"
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

        {/* ── 主内容（会话/历史/设置） ── */}
        {(tab !== 'chat' || started) && (
          <main
            className="redscope-view min-h-0 flex-1 overflow-y-auto"
            ref={tab === 'chat' ? scrollRef : undefined}
          >
            {tab === 'chat' && (
              <div
                className="flex flex-col gap-2.5 p-3"
                aria-live="polite"
                aria-busy={currentConversationRunning}
              >
                {anotherConversationRunning ? (
                  <div className="chat-background-banner" role="status">
                    <span>
                      另一条会话正在后台回复，完成后可继续本对话
                      {safeRunningConversationIds.filter((id) => id !== activeConversationId)
                        .length > 1
                        ? `（共 ${safeRunningConversationIds.filter((id) => id !== activeConversationId).length} 条）`
                        : ''}
                    </span>
                    <button type="button" onClick={() => void viewRunningConversation()}>
                      查看正在回复的会话
                    </button>
                  </div>
                ) : null}
                {/* 会话工具条：诊断日志属于当前会话，放在消息区内；仅 dev 构建显示。 */}
                <div className="flex items-center justify-between gap-1.5">
                  <div />
                  {import.meta.env.DEV ? (
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-[10px] font-medium text-ink-soft transition-all duration-200 hover:border-brand hover:text-brand-strong active:scale-[0.98]"
                      onClick={downloadDiagnostics}
                      title="导出执行日志和当前 Boss 页面 DOM 结构（已限量脱敏）"
                    >
                      <ScrollText size={11} /> 下载诊断日志
                    </button>
                  ) : null}
                </div>

                {messages.map((m) => {
                  const streaming = m.role === 'assistant' && m.status === 'streaming';
                  if (m.role === 'assistant' && m.pendingUserQuestion) return null;
                  if (m.role === 'user') {
                    return (
                      <div
                        key={m.id}
                        className="redscope-user-message msg-in max-w-[92%] self-end whitespace-pre-wrap rounded-[16px_16px_5px_16px] bg-brand px-3 py-2 text-xs leading-relaxed text-white"
                      >
                        <span>{m.content}</span>
                        {m.attachments?.length ? (
                          <span className="message-attachments">
                            {m.attachments.map((attachment) => (
                              <span key={attachment.id}>
                                {attachment.kind === 'image' ? (
                                  <Image size={10} />
                                ) : (
                                  <FileText size={10} />
                                )}
                                {attachment.name}
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={m.id}
                      className={`redscope-ai-message msg-in chat-md max-w-[92%] self-start rounded-[16px_16px_16px_5px] border px-3 py-2 text-xs leading-relaxed ${
                        m.error
                          ? 'border-danger/30 bg-surface text-ink'
                          : 'border-line bg-surface text-ink'
                      }`}
                    >
                      <ChatFlowStatus message={m} />
                      {streaming &&
                      !m.content &&
                      m.reasoningActivity?.status !== 'running' &&
                      m.toolActivity?.status !== 'running' &&
                      m.toolActivity?.status !== 'waiting_permission' ? (
                        <span className="chat-answer-wait">
                          <Loader2 size={12} className="animate-spin text-brand" />
                          正在组织回答…
                        </span>
                      ) : null}
                      {m.content ? (
                        <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{m.content}</ReactMarkdown>
                      ) : null}
                      {streaming && m.content ? (
                        <span
                          className="ml-1 inline-block h-3 w-0.5 animate-pulse rounded-full bg-brand align-middle"
                          role="status"
                          aria-label="正在生成"
                        />
                      ) : null}
                      {/* 已完成回答均可复制；只有会话末条回答可重新生成，避免旧消息按钮
                          错误地重跑最新一轮。断线或运行中不暴露不可执行的操作。 */}
                      {m.content && (m.status ?? 'completed') === 'completed' ? (
                        <MessageActions
                          message={m}
                          {...(m.id === lastMessage?.id && connected && !currentConversationRunning
                            ? { onRegenerate: regenerateChat }
                            : {})}
                        />
                      ) : null}
                      {m.status === 'cancelled' ? (
                        <div className="mt-1.5 border-t border-line pt-1.5 text-[10px] text-ink-faint">
                          已停止生成
                        </div>
                      ) : null}
                      {m.errorMessage ? (
                        <div className="mt-1.5 border-t border-danger/20 pt-1.5 text-[10px] leading-4 text-danger">
                          {m.errorMessage}
                          {m.retryable && m.id === lastMessage?.id ? (
                            <button
                              type="button"
                              className="mt-1 flex items-center gap-1 rounded-md border border-danger/20 px-2 py-1"
                              onClick={retryChat}
                            >
                              <RotateCcw size={10} /> 从失败处重试
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}

            {tab === 'history' && (
              <HistoryView
                conversations={conversations}
                activeConversationId={activeConversationId}
                runningConversationId={runningConversationId}
                runningConversationIds={safeRunningConversationIds}
                chatRunning={chatRunning}
                errorMessage={historyError}
                onRestore={restoreFromHistory}
                onRename={renameConversationTitle}
              />
            )}

            {tab === 'workspace' && <WorkspaceView conversationId={activeConversationId} />}

            {tab === 'settings' && (
              <Suspense fallback={<div className="p-4 text-xs text-ink-faint">加载中…</div>}>
                <SettingsView
                  modelSetupMessage={modelSetupMessage}
                  onProviderStateChange={applyProviderState}
                />
              </Suspense>
            )}
          </main>
        )}

        {/* ── 会话底部输入区（仅对话页 · 已进入会话） ── */}
        {tab === 'chat' && started && (
          <div className="redscope-dock border-t border-line bg-app p-2.5">
            <div className={bottomPaused ? 'ask-user-shell' : ''}>
              {pendingUserQuestion ? (
                <AskUserPanel
                  key={pendingUserQuestion.callId}
                  question={pendingUserQuestion}
                  onContinue={(answer) => resolveAskUser(pendingUserQuestion.requestId, answer)}
                  onCancel={cancelChat}
                />
              ) : waitingPermissionActivity ? (
                <PagePermissionPanel
                  key={waitingPermissionActivity.callId}
                  activity={waitingPermissionActivity}
                  onResolve={resolvePagePermission}
                  onCancel={cancelChat}
                />
              ) : null}
              <Composer
                key={composerDraftKey}
                autoFocus={!bottomPaused}
                running={currentConversationRunning && !bottomPaused}
                allowSteering={currentRun?.status === 'running' && !bottomPaused}
                waitingForAnswer={Boolean(bottomPaused)}
                disabled={!connected || Boolean(bottomPaused)}
                onSend={submit}
                draft={composerDrafts[composerDraftKey]}
                onDraftChange={(draft) => updateComposerDraft(composerDraftKey, draft)}
                onCancel={cancelChat}
                className={bottomPaused ? 'ask-user-composer' : ''}
                tools={
                  activeConversationId ? (
                    <ConversationRuntimeControls conversationId={activeConversationId} />
                  ) : undefined
                }
              />
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
