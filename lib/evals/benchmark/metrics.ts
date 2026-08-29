// ─── 基准指标提取 ───
// 职责：从一次任务执行后的完整历史消息中提取可对比的指标。
// 数据来源是 ChatMessage.toolActivities / usage / modelIdentity，
// 与诊断报告的台账同源，保证度量口径一致。

import type { ChatMessage } from '@/lib/domain/chat';
import type { ToolActivity } from '@/lib/domain/types';
import type { BenchmarkMetrics } from './types';

/** 从完整历史提取指标；无任何 agent 活动（工具调用或模型调用）时返回 null。 */
export function measureRun(messages: ChatMessage[]): BenchmarkMetrics | null {
  const activities = collectActivities(messages);
  const hasAgentActivity =
    activities.length > 0 ||
    messages.some(
      (message) => message.role === 'assistant' && (message.usage || message.modelIdentity),
    );
  if (!hasAgentActivity) return null;

  const firstUserAt = firstUserTimestamp(messages);
  const completed = activities.filter(
    (activity) => activity.finishedAt !== undefined && activity.status !== 'waiting_permission',
  );
  const lastFinishAt = completed.reduce(
    (max, activity) => Math.max(max, activity.finishedAt ?? 0),
    0,
  );
  const durationMs =
    firstUserAt !== null && lastFinishAt > 0 ? Math.max(0, lastFinishAt - firstUserAt) : 0;

  const succeeded = activities.filter(({ status }) => status === 'succeeded').length;
  const failed = activities.filter(({ status }) => status === 'failed').length;
  const safetyDecisions = activities.filter(
    ({ status, authorizationStatus }) =>
      status === 'waiting_permission' ||
      status === 'waiting_user' ||
      (authorizationStatus !== undefined && authorizationStatus !== 'not_required'),
  ).length;

  // M5 统计：缓存命中（statusText 含（cached）标记）、差异注入（user 消息含
  // changedSinceLastRead:false）、执行器建议（台账 detail 含 [hint]）。
  const cachedReads = activities.filter(({ statusText }) =>
    statusText.includes('（cached）'),
  ).length;
  const hintSuggestions = activities.filter(
    ({ detail }) => detail?.includes('[hint]') === true,
  ).length;
  const unchangedContextInjections = messages.filter(
    (message) =>
      message.role === 'user' && message.content.includes('"changedSinceLastRead":false'),
  ).length;

  return {
    modelTurns: countModelTurns(messages, activities),
    toolCalls: activities.length,
    succeededTools: succeeded,
    failedTools: failed,
    durationMs,
    retryWastedMs: consecutiveFailureWaste(activities),
    safetyDecisions,
    cachedReads,
    unchangedContextInjections,
    hintSuggestions,
  };
}

/** 模型请求轮次：含工具活动或模型标识/用量信息的 assistant 消息数。 */
function countModelTurns(messages: ChatMessage[], activities: ToolActivity[]): number {
  if (activities.length > 0) {
    return messages.filter(
      (message) =>
        message.role === 'assistant' &&
        (message.toolActivities?.length ||
          message.toolActivity ||
          message.usage ||
          message.modelIdentity),
    ).length;
  }
  return messages.filter((message) => message.role === 'assistant' && message.usage).length;
}

function collectActivities(messages: ChatMessage[]): ToolActivity[] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant') return [];
    if (message.toolActivities?.length) return message.toolActivities;
    return message.toolActivity ? [message.toolActivity] : [];
  });
}

function firstUserTimestamp(messages: ChatMessage[]): number | null {
  for (const message of messages) {
    if (message.role === 'user' && Number.isFinite(message.createdAt)) return message.createdAt;
  }
  return null;
}

/**
 * 连续失败重试浪费：同工具名连续失败（相邻排序）中，第 2 次及以后的耗时合计。
 * 日志中 4 次连续 tab open 超时（每次 ~12s）即被计为 ~36s 浪费。
 */
function consecutiveFailureWaste(activities: ToolActivity[]): number {
  let waste = 0;
  for (let index = 1; index < activities.length; index += 1) {
    const previous = activities[index - 1];
    const current = activities[index];
    if (
      previous &&
      current &&
      previous.status === 'failed' &&
      current.status === 'failed' &&
      previous.name === current.name
    ) {
      waste += current.finishedAt !== undefined ? current.finishedAt - current.startedAt : 0;
    }
  }
  return waste;
}
