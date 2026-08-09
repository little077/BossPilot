// ─── 会话执行状态 ───
// 参考 RedScope 原型呈现安全思考摘要与单工具时间线；不展示模型内部推理原文。

import { Brain, Check, ChevronDown, Loader2, LockKeyhole, Minus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChatMessage } from '@/lib/domain/chat';
import type { ReasoningActivity, ToolActivity } from '@/lib/domain/types';

interface ChatFlowStatusProps {
  message: ChatMessage;
  onResolvePagePermission?: (
    requestId: string,
    permissionPattern: string,
    allow: boolean,
  ) => Promise<boolean>;
}

export function ChatFlowStatus({ message, onResolvePagePermission }: ChatFlowStatusProps) {
  if (!message.reasoningActivity && !message.toolActivity) return null;

  return (
    <div className="chat-flow-status">
      {message.reasoningActivity ? <ReasoningStep activity={message.reasoningActivity} /> : null}
      {message.toolActivity ? (
        <ToolStep activity={message.toolActivity} onResolve={onResolvePagePermission} />
      ) : null}
    </div>
  );
}

function ReasoningStep({ activity }: { activity: ReasoningActivity }) {
  const running = activity.status === 'running';
  const [expanded, setExpanded] = useState(running);
  const elapsedMs = useElapsedMs(activity.startedAt, activity.finishedAt, running);

  useEffect(() => {
    if (!running) setExpanded(false);
  }, [running]);

  const label =
    activity.status === 'running'
      ? '思考中…'
      : activity.status === 'completed'
        ? '已完成分析'
        : activity.status === 'cancelled'
          ? '分析已停止'
          : '分析未完成';

  return (
    <section className={`chat-reasoning ${running ? 'is-running' : ''}`}>
      <button
        type="button"
        className="chat-reasoning-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Brain size={13} aria-hidden />
        <span className="chat-reasoning-label">{label}</span>
        <span className="chat-step-time">{formatDuration(elapsedMs)}</span>
        <ChevronDown
          size={12}
          className={`chat-step-chevron ${expanded ? 'is-open' : ''}`}
          aria-hidden
        />
      </button>
      {expanded ? <p className="chat-reasoning-body">{activity.summary}</p> : null}
    </section>
  );
}

function ToolStep({
  activity,
  onResolve,
}: {
  activity: ToolActivity;
  onResolve?: ChatFlowStatusProps['onResolvePagePermission'];
}) {
  const [expanded, setExpanded] = useState(false);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionError, setPermissionError] = useState('');
  const running = activity.status === 'running';
  const waitingPermission = activity.status === 'waiting_permission';
  const interactionPermission = activity.permissionKind === 'interact';
  const elapsedMs = useElapsedMs(activity.startedAt, activity.finishedAt, running);
  const canExpand = Boolean(activity.detail);
  const canResolvePermission = Boolean(
    waitingPermission && activity.requestId && activity.permissionPattern && onResolve,
  );

  const resolvePermission = async (allow: boolean) => {
    if (!canResolvePermission || !activity.requestId || !activity.permissionPattern || !onResolve) {
      return;
    }
    setPermissionBusy(true);
    setPermissionError('');
    const sent = await onResolve(activity.requestId, activity.permissionPattern, allow);
    if (!sent) {
      setPermissionBusy(false);
      setPermissionError('侧边栏连接不可用，请稍后重试。');
    }
  };

  return (
    <section className={`chat-tool-step is-${activity.status}`}>
      <div className="chat-tool-rail" aria-hidden>
        <span className="chat-tool-icon">{toolIcon(activity.status)}</span>
      </div>
      <div className="chat-tool-main">
        <button
          type="button"
          className="chat-tool-head"
          disabled={!canExpand}
          aria-expanded={canExpand ? expanded : undefined}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="chat-tool-label">{activity.label}</span>
          <span className="chat-tool-code">{activity.name}</span>
          <span className="chat-step-time">{running ? '' : formatDuration(elapsedMs)}</span>
          {canExpand ? (
            <ChevronDown
              size={12}
              className={`chat-step-chevron ${expanded ? 'is-open' : ''}`}
              aria-hidden
            />
          ) : null}
        </button>
        <div className="chat-tool-status" role={running ? 'status' : undefined}>
          {activity.statusText}
        </div>
        {expanded && activity.detail ? (
          <div className="chat-tool-detail">{activity.detail}</div>
        ) : null}
        {waitingPermission ? (
          <section
            className="chat-permission-card"
            aria-label={interactionPermission ? '页面操作权限' : '页面读取权限'}
          >
            <div className="chat-permission-origin">
              <LockKeyhole size={11} aria-hidden />
              <span>{activity.sourceOrigin ?? '当前网站'}</span>
            </div>
            <p>
              {interactionPermission
                ? '允许后可识别并操作这个网站的搜索框，用于输入你本轮提供的搜索词并提交；不会发送聊天、登录、支付、投递或发布内容。可随时在设置中撤销。'
                : '允许后可读取这个网站的可见纯文本，并把回答所需内容发送给你当前选择的模型供应商；不会点击、输入或操作页面。可随时在设置中撤销。'}
            </p>
            <div className="chat-permission-actions">
              <button
                type="button"
                className="chat-permission-deny"
                disabled={!canResolvePermission || permissionBusy}
                onClick={() => void resolvePermission(false)}
              >
                不允许
              </button>
              <button
                type="button"
                className="chat-permission-allow"
                disabled={!canResolvePermission || permissionBusy}
                onClick={() => void resolvePermission(true)}
              >
                {permissionBusy ? <Loader2 size={10} className="animate-spin" /> : null}
                {interactionPermission ? '允许操作' : '允许读取'}
              </button>
            </div>
            {permissionError ? (
              <div className="chat-permission-error">{permissionError}</div>
            ) : null}
          </section>
        ) : null}
        {activity.status === 'succeeded' && activity.sourceOrigin ? (
          <div className="chat-page-source" title={activity.sourceUrl}>
            基于当前页面 · {activity.sourceTitle || activity.sourceOrigin}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function useElapsedMs(startedAt: number, finishedAt: number | undefined, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running]);

  return Math.max(0, (finishedAt ?? now) - startedAt);
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function toolIcon(status: ToolActivity['status']) {
  switch (status) {
    case 'waiting_permission':
      return <LockKeyhole size={11} />;
    case 'running':
      return <Loader2 size={12} className="animate-spin" />;
    case 'succeeded':
      return <Check size={12} />;
    case 'failed':
      return <X size={12} />;
    case 'cancelled':
      return <Minus size={12} />;
  }
}
