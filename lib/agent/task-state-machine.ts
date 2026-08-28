// ─── 任务状态机 ───
// RunCheckpoint.phase 的显式状态机：统一转换校验、落库与诊断快照。
// 目标：phase 转换不再散落在 background 各处；非法转换（终态复活等）立即暴露。
// 内存相位仅存活于 SW 生命周期；SW 重启后为空，此时允许任意转换（无 from 校验），
// 由 recoverStaleRuns 兜底把「没跑完的旧任务」标记为 interrupted。

import { recorder } from '@/lib/diagnostics/recorder';
import type { RunCheckpoint } from '@/lib/domain/chat';
import {
  latestRunCheckpoints,
  saveRunCheckpoint,
  updateRunCheckpointPhase,
} from '@/lib/storage/db';

export type TaskPhase = RunCheckpoint['phase'];

/** 合法转换表：终态（stable/interrupted）不可再转换。 */
const TRANSITIONS: Record<TaskPhase, readonly TaskPhase[]> = {
  queued: ['running', 'waiting_user', 'stable', 'interrupted'],
  running: ['waiting_user', 'stable', 'interrupted'],
  waiting_user: ['running', 'stable', 'interrupted'],
  stable: [],
  interrupted: [],
};

export const PHASE_LABEL: Record<TaskPhase, string> = {
  queued: '排队中',
  running: '运行中',
  waiting_user: '等待用户',
  stable: '已完成',
  interrupted: '已中断',
};

/** 是否允许 from → to；无 from（SW 重启后）视为允许。 */
export function canTransition(from: TaskPhase | undefined, to: TaskPhase): boolean {
  return from === undefined || TRANSITIONS[from].includes(to);
}

/** 由生成事件推导终态：取消/出错 → interrupted，其余 → stable。 */
export function terminalPhaseForEvent(event: {
  type: string;
  message?: { status?: string };
}): TaskPhase {
  return event.message?.status === 'cancelled' || event.type === 'error' ? 'interrupted' : 'stable';
}

export interface TransitionOptions {
  runId: string;
  historyMessageIds: string[];
  reason?: RunCheckpoint['reason'];
}

export interface TaskStateMachineOptions {
  saveCheckpoint?: (checkpoint: RunCheckpoint) => Promise<void>;
  loadLatestCheckpoints?: () => Promise<RunCheckpoint[]>;
  updatePhase?: (id: string, phase: TaskPhase) => Promise<void>;
  logSnapshot?: (conversationId: string, phase: string, summary: string, detail?: string) => void;
}

/** 任务状态机：每个会话一条相位轨迹，转换时统一落 checkpoint + 诊断快照。 */
export class TaskStateMachine {
  private readonly phases = new Map<string, TaskPhase>();
  private readonly saveCheckpoint: NonNullable<TaskStateMachineOptions['saveCheckpoint']>;
  private readonly loadLatestCheckpoints: NonNullable<
    TaskStateMachineOptions['loadLatestCheckpoints']
  >;
  private readonly updatePhase: NonNullable<TaskStateMachineOptions['updatePhase']>;
  private readonly logSnapshot: NonNullable<TaskStateMachineOptions['logSnapshot']>;

  constructor(options: TaskStateMachineOptions = {}) {
    this.saveCheckpoint = options.saveCheckpoint ?? saveRunCheckpoint;
    this.loadLatestCheckpoints = options.loadLatestCheckpoints ?? latestRunCheckpoints;
    this.updatePhase = options.updatePhase ?? updateRunCheckpointPhase;
    this.logSnapshot =
      options.logSnapshot ??
      ((conversationId, phase, summary, detail) =>
        recorder.logContext(conversationId, phase, summary, detail));
  }

  /** 当前内存相位（SW 生命周期内有效）。 */
  phaseOf(conversationId: string): TaskPhase | undefined {
    return this.phases.get(conversationId);
  }

  /** 状态转换：校验 → 落 checkpoint → 诊断快照。非法转换不落库并记一笔。 */
  async transition(
    conversationId: string,
    to: TaskPhase,
    options: TransitionOptions,
  ): Promise<boolean> {
    const from = this.phases.get(conversationId);
    if (!canTransition(from, to)) {
      this.logSnapshot(
        conversationId,
        PHASE_LABEL[from ?? 'interrupted'],
        `非法状态转换 ${from ?? '未知'} → ${to}，已拒绝`,
      );
      return false;
    }
    this.phases.set(conversationId, to);
    const checkpoint: RunCheckpoint = {
      id: `checkpoint-${crypto.randomUUID()}`,
      runId: options.runId,
      conversationId,
      historyMessageIds: options.historyMessageIds,
      phase: to,
      createdAt: Date.now(),
      ...(options.reason ? { reason: options.reason } : {}),
    };
    try {
      await this.saveCheckpoint(checkpoint);
    } catch {
      // 落库失败不阻塞任务主线；诊断快照仍会记录本次转换。
    }
    this.logSnapshot(
      conversationId,
      PHASE_LABEL[to],
      `状态转换 → ${PHASE_LABEL[to]}`,
      `run ${options.runId} · 历史 ${options.historyMessageIds.length} 条${
        options.reason ? ` · 原因 ${options.reason}` : ''
      }`,
    );
    return true;
  }

  /** 中断恢复：SW 重启后把「非终态且不在活跃运行」的检查点标记为 interrupted。 */
  async recoverStaleRuns(isActiveRun: (runId: string) => boolean): Promise<RunCheckpoint[]> {
    const recovered: RunCheckpoint[] = [];
    const checkpoints = await this.loadLatestCheckpoints().catch(() => []);
    for (const checkpoint of checkpoints) {
      if (isTerminal(checkpoint.phase)) continue;
      if (isActiveRun(checkpoint.runId)) continue;
      await this.updatePhase(checkpoint.id, 'interrupted').catch(() => void 0);
      recovered.push({ ...checkpoint, phase: 'interrupted' });
      this.logSnapshot(
        checkpoint.conversationId,
        '已中断',
        'SW 重启恢复：未完成任务标记为中断',
        `run ${checkpoint.runId} · 原状态 ${PHASE_LABEL[checkpoint.phase]}`,
      );
    }
    return recovered;
  }
}

function isTerminal(phase: TaskPhase): boolean {
  return phase === 'stable' || phase === 'interrupted';
}
