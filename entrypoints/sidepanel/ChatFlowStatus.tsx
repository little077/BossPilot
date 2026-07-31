// ─── 会话执行状态 ───
// 参考 RedScope 原型呈现安全思考摘要与单工具时间线；不展示模型内部推理原文。

import { Brain, Check, ChevronDown, Loader2, Minus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChatMessage } from '@/lib/domain/chat';
import type { ReasoningActivity, ToolActivity } from '@/lib/domain/types';

interface ChatFlowStatusProps {
  message: ChatMessage;
}

export function ChatFlowStatus({ message }: ChatFlowStatusProps) {
  if (!message.reasoningActivity && !message.toolActivity) return null;

  return (
    <div className="chat-flow-status">
      {message.reasoningActivity ? <ReasoningStep activity={message.reasoningActivity} /> : null}
      {message.toolActivity ? <ToolStep activity={message.toolActivity} /> : null}
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

function ToolStep({ activity }: { activity: ToolActivity }) {
  const [expanded, setExpanded] = useState(false);
  const running = activity.status === 'running';
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
        <div className="chat-tool-status" role={running ? 'status' : undefined}>
          {activity.statusText}
        </div>
        {expanded && activity.detail ? (
          <div className="chat-tool-detail">{activity.detail}</div>
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
