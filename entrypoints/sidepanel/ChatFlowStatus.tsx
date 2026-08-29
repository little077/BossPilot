// ─── 会话执行状态 ───
// 参考 RedScope 原型呈现安全思考摘要与多工具时间线；
// Ask User 与页面权限请求都固定在底部，不进入这里。

import {
  Brain,
  Check,
  ChevronDown,
  CircleHelp,
  Loader2,
  LockKeyhole,
  Minus,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChatMessage } from '@/lib/domain/chat';
import type { ReasoningActivity, ToolActivity } from '@/lib/domain/types';
import { summarizeAgentRun } from '@/lib/evals/run-summary';

interface ChatFlowStatusProps {
  message: ChatMessage;
}

export function ChatFlowStatus({ message }: ChatFlowStatusProps) {
  const activities = (
    message.toolActivities ?? (message.toolActivity ? [message.toolActivity] : [])
  ).filter(({ name }) => name !== 'ask_user');
  const run = summarizeAgentRun(message);
  if (!message.reasoningActivity && activities.length === 0 && !run) return null;

  return (
    <div className="chat-flow-status">
      {message.reasoningActivity ? <ReasoningStep activity={message.reasoningActivity} /> : null}
      {activities.map((activity) => (
        <ToolStep key={activity.callId} activity={activity} />
      ))}
      {run ? (
        <details className="agent-run-summary">
          <summary>运行详情</summary>
          <dl>
            <div className="agent-run-row">
              <dt>状态</dt>
              <dd>{runStatusLabel(run.status)}</dd>
            </div>
            <div className="agent-run-row">
              <dt>模型</dt>
              <dd>{run.model}</dd>
            </div>
            <div className="agent-run-row">
              <dt>工具</dt>
              <dd>
                {run.toolCalls} 次 · 成功 {run.succeededTools} · 失败 {run.failedTools}
              </dd>
            </div>
            {run.durationMs !== undefined ? (
              <div className="agent-run-row">
                <dt>执行耗时</dt>
                <dd>{formatDuration(run.durationMs)}</dd>
              </div>
            ) : null}
            {run.totalTokens !== undefined ? (
              <div className="agent-run-row">
                <dt>Token</dt>
                <dd>{run.totalTokens.toLocaleString()}</dd>
              </div>
            ) : null}
            {run.cost !== undefined && run.cost > 0 ? (
              <div className="agent-run-row">
                <dt>模型成本</dt>
                <dd>${run.cost.toFixed(6)}</dd>
              </div>
            ) : null}
          </dl>
        </details>
      ) : null}
    </div>
  );
}

function runStatusLabel(status: NonNullable<ReturnType<typeof summarizeAgentRun>>['status']) {
  if (status === 'running') return '执行中';
  if (status === 'completed') return '已完成';
  if (status === 'cancelled') return '已取消';
  return '出错';
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

function ToolStep({ activity }: { activity: ToolActivity }) {
  const [expanded, setExpanded] = useState(false);
  const running = activity.status === 'running';
  const waitingPermission = activity.status === 'waiting_permission';
  const elapsedMs = useElapsedMs(activity.startedAt, activity.finishedAt, running);
  const canExpand = Boolean(activity.detail);

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
        <div
          className="chat-tool-status"
          role={running || waitingPermission ? 'status' : undefined}
        >
          {activity.statusText}
          {waitingPermission ? ' · 请查看底部确认面板' : ''}
        </div>
        {expanded && activity.detail ? (
          <div className="chat-tool-detail">{activity.detail}</div>
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
    case 'waiting_user':
      return <CircleHelp size={11} />;
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
