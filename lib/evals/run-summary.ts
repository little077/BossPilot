import type { ChatMessage } from '@/lib/domain/chat';

export interface AgentRunSummary {
  status: 'running' | 'completed' | 'cancelled' | 'error';
  model: string;
  toolCalls: number;
  succeededTools: number;
  failedTools: number;
  durationMs?: number;
  totalTokens?: number;
  cost?: number;
}

/** Derives a stable, history-safe run summary from data already persisted on the assistant message. */
export function summarizeAgentRun(message: ChatMessage): AgentRunSummary | null {
  if (message.role !== 'assistant') return null;
  const tools = message.toolActivities ?? (message.toolActivity ? [message.toolActivity] : []);
  if (!message.modelIdentity && !message.usage && !message.reasoningActivity && !tools.length) {
    return null;
  }
  const starts = [
    message.reasoningActivity?.startedAt,
    ...tools.map(({ startedAt }) => startedAt),
  ].filter((value): value is number => typeof value === 'number');
  const finishes = [
    message.reasoningActivity?.finishedAt,
    ...tools.map(({ finishedAt }) => finishedAt),
  ].filter((value): value is number => typeof value === 'number');
  const durationMs =
    starts.length && finishes.length ? Math.max(...finishes) - Math.min(...starts) : undefined;

  return {
    status:
      message.status === 'streaming'
        ? 'running'
        : (message.status ?? (message.error ? 'error' : 'completed')),
    model: message.modelIdentity
      ? `${message.modelIdentity.providerId} / ${message.modelIdentity.modelId}`
      : '旧记录（未保存模型标识）',
    toolCalls: tools.length,
    succeededTools: tools.filter(({ status }) => status === 'succeeded').length,
    failedTools: tools.filter(({ status }) => status === 'failed').length,
    ...(durationMs !== undefined ? { durationMs: Math.max(0, durationMs) } : {}),
    ...(message.usage ? { totalTokens: message.usage.totalTokens, cost: message.usage.cost } : {}),
  };
}
