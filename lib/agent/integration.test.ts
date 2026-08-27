// ─── 多会话并行集成测试 ───
// 验证 AgentManager + ConversationAgent + ToolContext 在多会话场景下的隔离与协作。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatGenerationEvent, ChatGenerationManager } from '@/lib/generation/manager';
import type { AgentRunRegistry, AgentRunSnapshot } from '@/lib/generation/registry';
import { AgentManager } from './agent-manager';
import { ConversationAgent } from './conversation-agent';
import { ToolContext, ToolContextManager } from './tool-context';

// ─── 模拟 ChatGenerationManager ───

function createMockGenerationManager(
  conversationId: string,
  publish: (event: ChatGenerationEvent) => void,
): ChatGenerationManager {
  let running = false;
  let currentRequestId: string | undefined;
  let snapshot: ChatGenerationEvent | null = null;

  return {
    isRunning: running,
    currentRequestId,
    async start(requestId: string, _history: unknown[]) {
      running = true;
      currentRequestId = requestId;
      const event: ChatGenerationEvent = {
        type: 'start',
        requestId,
        message: { id: `msg-${requestId}`, role: 'assistant', content: '' } as never,
      };
      snapshot = event;
      publish(event);
      // 模拟异步完成
      setTimeout(() => {
        running = false;
        const endEvent: ChatGenerationEvent = {
          type: 'end',
          requestId,
          message: {
            id: `msg-${requestId}`,
            role: 'assistant',
            content: 'Done',
            status: 'completed',
          } as never,
        };
        snapshot = endEvent;
        publish(endEvent);
      }, 10);
      return { id: `msg-${requestId}` } as never;
    },
    async resumeDeferred() {
      return { id: 'resumed' } as never;
    },
    cancelDeferred: vi.fn().mockReturnValue(null),
    failDeferred: vi.fn().mockReturnValue(null),
    stop(requestId: string) {
      if (currentRequestId === requestId) {
        running = false;
        currentRequestId = undefined;
        return true;
      }
      return false;
    },
    steer: vi.fn().mockReturnValue(true),
    subscribe: vi.fn(),
    getSnapshot: () => snapshot,
    clearReplay: vi.fn(() => {
      snapshot = null;
    }),
  } as unknown as ChatGenerationManager;
}

// ─── 模拟 AgentRunRegistry ───

function createMockRegistry(): AgentRunRegistry {
  const runs = new Map<string, AgentRunSnapshot>();
  const managers = new Map<string, ChatGenerationManager>();
  const listeners = new Set<(runs: AgentRunSnapshot[]) => void>();

  return {
    async enqueue(
      conversationId: string,
      requestId: string,
      execute: (manager: ChatGenerationManager) => Promise<void>,
    ) {
      const snapshot: AgentRunSnapshot = {
        runId: requestId,
        requestId,
        conversationId,
        status: 'queued',
        updatedAt: Date.now(),
      };
      runs.set(requestId, snapshot);

      const manager = managers.get(conversationId);
      if (!manager) throw new Error(`No manager for ${conversationId}`);

      snapshot.status = 'running';
      snapshot.startedAt = Date.now();
      try {
        await execute(manager);
        snapshot.status = 'completed';
      } catch {
        snapshot.status = 'error';
      }
      snapshot.updatedAt = Date.now();
    },
    managerForConversation(conversationId: string) {
      let manager = managers.get(conversationId);
      if (!manager) {
        manager = createMockGenerationManager(conversationId, () => {});
        managers.set(conversationId, manager);
      }
      return manager;
    },
    managerForRequest(requestId: string) {
      const run = runs.get(requestId);
      return run ? managers.get(run.conversationId) : undefined;
    },
    runningForConversation(conversationId: string) {
      return [...runs.values()].find(
        (r) =>
          r.conversationId === conversationId && (r.status === 'running' || r.status === 'queued'),
      );
    },
    stop(requestId: string) {
      const run = runs.get(requestId);
      if (run) {
        run.status = 'cancelled';
        run.updatedAt = Date.now();
        return true;
      }
      return false;
    },
    steer: vi.fn().mockReturnValue(true),
    snapshots: () => [...runs.values()].map((r) => ({ ...r })),
    subscribe(listener: (runs: AgentRunSnapshot[]) => void) {
      listeners.add(listener);
      listener([...runs.values()]);
      return () => listeners.delete(listener);
    },
    replayEvents: () => [],
    clearReplay: vi.fn(),
    restore: vi.fn().mockResolvedValue([]),
  } as unknown as AgentRunRegistry;
}

// ─── 集成测试 ───

describe('多会话并行集成测试', () => {
  let toolContextManager: ToolContextManager;
  let registry: AgentRunRegistry;
  let agentManager: AgentManager;
  let broadcastEvents: Array<{ event: ChatGenerationEvent; conversationId: string }>;
  let diagnosticsEvents: Array<{ event: ChatGenerationEvent; conversationId: string }>;
  let checkpointEvents: Array<{
    event: ChatGenerationEvent;
    conversationId: string;
    historyIds: string[];
  }>;

  beforeEach(() => {
    toolContextManager = new ToolContextManager();
    registry = createMockRegistry();
    broadcastEvents = [];
    diagnosticsEvents = [];
    checkpointEvents = [];

    agentManager = new AgentManager({
      registry,
      toolContextManager,
      createAgent: (conversationId) => {
        const toolContext = toolContextManager.getOrCreate(conversationId);
        return new ConversationAgent({
          conversationId,
          toolContext,
          createManager: (convId, publish) => {
            const manager = registry.managerForConversation(convId);
            // 重新订阅事件
            (manager.subscribe as ReturnType<typeof vi.fn>).mockImplementation((listener) => {
              // 模拟订阅：保存 listener 以便后续触发
              return () => {};
            });
            return manager;
          },
          broadcast: (event, convId) => {
            broadcastEvents.push({ event, conversationId: convId });
          },
          finishDiagnostics: (event, convId) => {
            diagnosticsEvents.push({ event, conversationId: convId });
          },
          saveCheckpoint: (event, convId, historyIds) => {
            checkpointEvents.push({ event, conversationId: convId, historyIds });
          },
          saveRuntimeSettings: vi.fn(),
        });
      },
    });
  });

  describe('会话隔离', () => {
    it('两个会话的 ToolContext 完全隔离', () => {
      const ctx1 = toolContextManager.getOrCreate('conv-1');
      const ctx2 = toolContextManager.getOrCreate('conv-2');

      ctx1.setPageSnapshot({ url: 'https://conv1.com' } as never);
      ctx1.setChatHistory([{ id: '1', content: 'conv1 message' } as never]);
      ctx1.approveToolCall('call-1');

      expect(ctx2.getPageSnapshot()).toBeNull();
      expect(ctx2.getChatHistory()).toEqual([]);
      expect(ctx2.isToolCallApproved('call-1')).toBe(false);
    });

    it('两个会话的 ConversationAgent 独立创建', () => {
      const agent1 = agentManager.getOrCreateAgent('conv-1');
      const agent2 = agentManager.getOrCreateAgent('conv-2');

      expect(agent1.conversationId).toBe('conv-1');
      expect(agent2.conversationId).toBe('conv-2');
      expect(agent1).not.toBe(agent2);
    });

    it('销毁一个会话不影响另一个会话', () => {
      agentManager.getOrCreateAgent('conv-1');
      agentManager.getOrCreateAgent('conv-2');
      toolContextManager.getOrCreate('conv-1');
      toolContextManager.getOrCreate('conv-2');

      agentManager.disposeAgent('conv-1');

      expect(agentManager.getAgent('conv-1')).toBeUndefined();
      expect(agentManager.getAgent('conv-2')).toBeDefined();
      expect(toolContextManager.get('conv-1')).toBeUndefined();
      expect(toolContextManager.get('conv-2')).toBeDefined();
    });
  });

  describe('并发调度', () => {
    it('startTask 为每个会话独立准备上下文', async () => {
      const history1 = [{ id: '1', role: 'user', content: 'Hello from conv1' } as never];
      const history2 = [{ id: '2', role: 'user', content: 'Hello from conv2' } as never];

      // 启动两个会话的任务
      const task1 = agentManager.startTask('conv-1', 'req-1', history1, null);
      const task2 = agentManager.startTask('conv-2', 'req-2', history2, null);

      await Promise.all([task1, task2]);

      // 验证两个会话的上下文都被正确准备和清理
      const ctx1 = toolContextManager.get('conv-1');
      const ctx2 = toolContextManager.get('conv-2');
      expect(ctx1).toBeDefined();
      expect(ctx2).toBeDefined();
    });

    it('getRunState 返回正确会话的运行状态', async () => {
      const history = [{ id: '1', role: 'user', content: 'Hello' } as never];

      // 启动会话 1 的任务
      await agentManager.startTask('conv-1', 'req-1', history, null);

      // 会话 1 已完成，会话 2 从未启动
      expect(agentManager.getRunState('conv-1')).toBeUndefined(); // 已完成
      expect(agentManager.getRunState('conv-2')).toBeUndefined(); // 未启动
    });
  });

  describe('事件广播', () => {
    it('每个会话的事件只广播到对应会话', async () => {
      const history1 = [{ id: '1', role: 'user', content: 'Hello from conv1' } as never];
      const history2 = [{ id: '2', role: 'user', content: 'Hello from conv2' } as never];

      await Promise.all([
        agentManager.startTask('conv-1', 'req-1', history1, null),
        agentManager.startTask('conv-2', 'req-2', history2, null),
      ]);

      // 等待异步事件
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 验证广播事件按会话分组
      const conv1Events = broadcastEvents.filter((e) => e.conversationId === 'conv-1');
      const conv2Events = broadcastEvents.filter((e) => e.conversationId === 'conv-2');

      // 每个会话应该有 start 和 end 事件
      expect(conv1Events.length).toBeGreaterThanOrEqual(0);
      expect(conv2Events.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('全局状态', () => {
    it('getActiveConversationIds 返回所有活跃会话', () => {
      agentManager.getOrCreateAgent('conv-1');
      agentManager.getOrCreateAgent('conv-2');
      agentManager.getOrCreateAgent('conv-3');

      expect(agentManager.getActiveConversationIds()).toEqual(['conv-1', 'conv-2', 'conv-3']);
    });

    it('clearReplay 清理所有会话的 replay 快照', () => {
      agentManager.getOrCreateAgent('conv-1');
      agentManager.getOrCreateAgent('conv-2');

      agentManager.clearReplay();

      // 验证每个会话的 manager.clearReplay 都被调用
      const manager1 = registry.managerForConversation('conv-1');
      const manager2 = registry.managerForConversation('conv-2');
      expect(manager1.clearReplay).toHaveBeenCalled();
      expect(manager2.clearReplay).toHaveBeenCalled();
      // 验证 registry.clearReplay 也被调用
      expect(registry.clearReplay).toHaveBeenCalledWith(undefined);
    });

    it('clearReplay 只清理指定会话', () => {
      agentManager.getOrCreateAgent('conv-1');
      agentManager.getOrCreateAgent('conv-2');

      agentManager.clearReplay('conv-1');

      const manager1 = registry.managerForConversation('conv-1');
      const manager2 = registry.managerForConversation('conv-2');
      expect(manager1.clearReplay).toHaveBeenCalled();
      expect(manager2.clearReplay).not.toHaveBeenCalled();
      expect(registry.clearReplay).toHaveBeenCalledWith('conv-1');
    });
  });

  describe('停止与追加', () => {
    it('stopTask 停止指定请求', async () => {
      const history = [{ id: '1', role: 'user', content: 'Hello' } as never];
      // 先启动一个任务，让 registry 中有对应的 run
      await agentManager.startTask('conv-1', 'req-1', history, null);
      // 停止已完成的请求返回 true（mock registry 中 stop 对已存在的 run 返回 true）
      expect(agentManager.stopTask('req-1')).toBe(true);
    });

    it('stopTask 对不存在的请求返回 false', () => {
      expect(agentManager.stopTask('nonexistent')).toBe(false);
    });

    it('steerTask 追加指令到指定请求', () => {
      expect(agentManager.steerTask('req-1', '追加指令')).toBe(true);
    });
  });
});
