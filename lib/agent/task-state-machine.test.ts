// ─── TaskStateMachine 单元测试 ───
// 覆盖：转换表合法性、终态推导、正常链路落库、非法转换拒绝、
// SW 重启后无内存状态的放行、中断恢复扫描（跳过活跃 run 与终态）。

import { describe, expect, it, vi } from 'vitest';
import {
  canTransition,
  type TaskPhase,
  TaskStateMachine,
  terminalPhaseForEvent,
} from '@/lib/agent/task-state-machine';
import type { RunCheckpoint } from '@/lib/domain/chat';

const checkpoint = (phase: TaskPhase, runId = 'run-1'): RunCheckpoint => ({
  id: `checkpoint-${phase}`,
  runId,
  conversationId: 'conv-1',
  historyMessageIds: ['m1'],
  phase,
  createdAt: 1,
});

describe('转换表', () => {
  it('允许完整生命周期：排队 → 运行 → 等待用户 → 运行 → 完成', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'waiting_user')).toBe(true);
    expect(canTransition('waiting_user', 'running')).toBe(true);
    expect(canTransition('running', 'stable')).toBe(true);
  });

  it('拒绝终态复活与反向转换', () => {
    expect(canTransition('stable', 'running')).toBe(false);
    expect(canTransition('interrupted', 'waiting_user')).toBe(false);
    expect(canTransition('interrupted', 'queued')).toBe(false);
  });

  it('无前序状态（SW 重启）视为允许', () => {
    expect(canTransition(undefined, 'running')).toBe(true);
    expect(canTransition(undefined, 'interrupted')).toBe(true);
  });
});

describe('terminalPhaseForEvent', () => {
  it('出错/取消 → interrupted，完成 → stable', () => {
    expect(terminalPhaseForEvent({ type: 'error' })).toBe('interrupted');
    expect(terminalPhaseForEvent({ type: 'end', message: { status: 'cancelled' } })).toBe(
      'interrupted',
    );
    expect(terminalPhaseForEvent({ type: 'end', message: { status: 'completed' } })).toBe('stable');
  });
});

describe('TaskStateMachine', () => {
  it('合法转换落 checkpoint：相位、runId、历史 id、原因透传', async () => {
    const saveCheckpoint = vi
      .fn<(checkpoint: RunCheckpoint) => Promise<void>>()
      .mockResolvedValue(undefined);
    const machine = new TaskStateMachine({ saveCheckpoint });

    const ok = await machine.transition('conv-1', 'waiting_user', {
      runId: 'run-9',
      historyMessageIds: ['a', 'b'],
      reason: 'cancelled',
    });

    expect(ok).toBe(true);
    expect(machine.phaseOf('conv-1')).toBe('waiting_user');
    expect(saveCheckpoint).toHaveBeenCalledOnce();
    const saved = saveCheckpoint.mock.calls[0]?.[0];
    expect(saved?.phase).toBe('waiting_user');
    expect(saved?.runId).toBe('run-9');
    expect(saved?.conversationId).toBe('conv-1');
    expect(saved?.historyMessageIds).toEqual(['a', 'b']);
    expect(saved?.reason).toBe('cancelled');
  });

  it('非法转换拒绝且不落库，诊断快照记录原因', async () => {
    const saveCheckpoint = vi
      .fn<(checkpoint: RunCheckpoint) => Promise<void>>()
      .mockResolvedValue(undefined);
    const logSnapshot = vi.fn();
    const machine = new TaskStateMachine({ saveCheckpoint, logSnapshot });

    await machine.transition('conv-1', 'stable', { runId: 'r1', historyMessageIds: [] });
    const ok = await machine.transition('conv-1', 'running', {
      runId: 'r1',
      historyMessageIds: [],
    });

    expect(ok).toBe(false);
    expect(saveCheckpoint).toHaveBeenCalledOnce();
    expect(logSnapshot).toHaveBeenLastCalledWith(
      'conv-1',
      expect.any(String),
      expect.stringContaining('非法状态转换 stable → running'),
    );
  });

  it('SW 重启后无内存状态：允许直接从终态事件转换', async () => {
    const saveCheckpoint = vi
      .fn<(checkpoint: RunCheckpoint) => Promise<void>>()
      .mockResolvedValue(undefined);
    const machine = new TaskStateMachine({ saveCheckpoint });

    const ok = await machine.transition('conv-1', 'interrupted', {
      runId: 'r1',
      historyMessageIds: [],
    });

    expect(ok).toBe(true);
    expect(saveCheckpoint).toHaveBeenCalledOnce();
  });

  it('落库失败不抛出，不影响转换结果', async () => {
    const saveCheckpoint = vi
      .fn<(checkpoint: RunCheckpoint) => Promise<void>>()
      .mockRejectedValue(new Error('db down'));
    const machine = new TaskStateMachine({ saveCheckpoint });

    await expect(
      machine.transition('conv-1', 'running', { runId: 'r1', historyMessageIds: [] }),
    ).resolves.toBe(true);
  });
});

describe('recoverStaleRuns（中断恢复）', () => {
  it('把非终态且非活跃的检查点标记为 interrupted', async () => {
    const updatePhase = vi
      .fn<(id: string, phase: TaskPhase) => Promise<void>>()
      .mockResolvedValue(undefined);
    const machine = new TaskStateMachine({
      updatePhase,
      loadLatestCheckpoints: async () => [
        checkpoint('running', 'run-stale'),
        checkpoint('queued', 'run-stale-2'),
      ],
    });

    const recovered = await machine.recoverStaleRuns(() => false);

    expect(recovered.map((item) => item.runId)).toEqual(['run-stale', 'run-stale-2']);
    expect(recovered.every((item) => item.phase === 'interrupted')).toBe(true);
    expect(updatePhase).toHaveBeenCalledWith('checkpoint-running', 'interrupted');
    expect(updatePhase).toHaveBeenCalledWith('checkpoint-queued', 'interrupted');
  });

  it('跳过活跃 run 与终态检查点', async () => {
    const updatePhase = vi
      .fn<(id: string, phase: TaskPhase) => Promise<void>>()
      .mockResolvedValue(undefined);
    const machine = new TaskStateMachine({
      updatePhase,
      loadLatestCheckpoints: async () => [
        checkpoint('running', 'run-active'),
        checkpoint('stable', 'run-done'),
        checkpoint('interrupted', 'run-stopped'),
      ],
    });

    const recovered = await machine.recoverStaleRuns((runId) => runId === 'run-active');

    expect(recovered).toEqual([]);
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('读取失败时静默返回空', async () => {
    const machine = new TaskStateMachine({
      loadLatestCheckpoints: async () => {
        throw new Error('db down');
      },
    });

    await expect(machine.recoverStaleRuns(() => false)).resolves.toEqual([]);
  });
});
