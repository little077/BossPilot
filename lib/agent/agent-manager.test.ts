import { describe, expect, it, vi } from 'vitest';
import type { AgentRunRegistry } from '@/lib/generation/registry';
import { AgentManager } from './agent-manager';
import type { ConversationAgent } from './conversation-agent';
import { ToolContextManager } from './tool-context';

function createMockAgent(conversationId: string): ConversationAgent {
  return {
    conversationId,
    toolContext: { conversationId } as never,
    isRunning: false,
    currentRequestId: undefined,
    start: vi.fn(),
    resumeDeferred: vi.fn(),
    cancelDeferred: vi.fn(),
    failDeferred: vi.fn(),
    stop: vi.fn(),
    steer: vi.fn(),
    getSnapshot: vi.fn().mockReturnValue(null),
    clearReplay: vi.fn(),
    prepareForNewTask: vi.fn(),
    cleanupAfterTask: vi.fn(),
    prepareForResume: vi.fn(),
    cleanupAfterResume: vi.fn(),
  } as unknown as ConversationAgent;
}

function createMockRegistry(): AgentRunRegistry {
  return {
    enqueue: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockReturnValue(true),
    steer: vi.fn().mockReturnValue(true),
    runningForConversation: vi.fn().mockReturnValue(undefined),
    snapshots: vi.fn().mockReturnValue([]),
    subscribe: vi.fn().mockReturnValue(() => {}),
    replayEvents: vi.fn().mockReturnValue([]),
    clearReplay: vi.fn(),
    restore: vi.fn().mockResolvedValue([]),
  } as unknown as AgentRunRegistry;
}

function createManager(
  registry?: AgentRunRegistry,
  toolContextManager?: ToolContextManager,
): {
  manager: AgentManager;
  registry: AgentRunRegistry;
  toolContextManager: ToolContextManager;
  createdAgents: Map<string, ConversationAgent>;
} {
  const reg = registry ?? createMockRegistry();
  const tcm = toolContextManager ?? new ToolContextManager();
  const createdAgents = new Map<string, ConversationAgent>();

  const manager = new AgentManager({
    registry: reg,
    toolContextManager: tcm,
    createAgent: (conversationId) => {
      const agent = createMockAgent(conversationId);
      createdAgents.set(conversationId, agent);
      return agent;
    },
  });

  return { manager, registry: reg, toolContextManager: tcm, createdAgents };
}

describe('AgentManager', () => {
  describe('Agent 生命周期', () => {
    it('getOrCreateAgent 创建新实例', () => {
      const { manager, createdAgents } = createManager();
      const agent = manager.getOrCreateAgent('conv-1');
      expect(agent.conversationId).toBe('conv-1');
      expect(createdAgents.has('conv-1')).toBe(true);
    });

    it('getOrCreateAgent 返回同一实例', () => {
      const { manager } = createManager();
      const first = manager.getOrCreateAgent('conv-1');
      const second = manager.getOrCreateAgent('conv-1');
      expect(second).toBe(first);
    });

    it('getAgent 返回 undefined 当不存在', () => {
      const { manager } = createManager();
      expect(manager.getAgent('non-existent')).toBeUndefined();
    });

    it('disposeAgent 销毁实例并清理上下文', () => {
      const { manager, toolContextManager } = createManager();
      manager.getOrCreateAgent('conv-1');
      toolContextManager.getOrCreate('conv-1');

      expect(manager.disposeAgent('conv-1')).toBe(true);
      expect(manager.getAgent('conv-1')).toBeUndefined();
      expect(toolContextManager.get('conv-1')).toBeUndefined();
      expect(manager.disposeAgent('conv-1')).toBe(false);
    });

    it('getActiveConversationIds 返回所有活跃会话', () => {
      const { manager } = createManager();
      manager.getOrCreateAgent('conv-1');
      manager.getOrCreateAgent('conv-2');
      manager.getOrCreateAgent('conv-3');

      expect(manager.getActiveConversationIds()).toEqual(['conv-1', 'conv-2', 'conv-3']);
    });
  });

  describe('任务操作', () => {
    it('startTask 准备上下文并入队', async () => {
      const { manager, registry, createdAgents } = createManager();
      const history = [{ id: '1', role: 'user', content: 'Hello' } as never];
      const snapshot = { url: 'https://example.com' } as never;

      await manager.startTask('conv-1', 'req-1', history, snapshot);

      const agent = createdAgents.get('conv-1');
      expect(agent?.prepareForNewTask).toHaveBeenCalledWith(snapshot, history, 'Hello', 'req-1');
      expect(registry.enqueue).toHaveBeenCalledWith('conv-1', 'req-1', expect.any(Function));
      expect(agent?.cleanupAfterTask).toHaveBeenCalledWith('req-1');
    });

    it('stopTask 代理到 registry.stop', () => {
      const { manager, registry } = createManager();
      expect(manager.stopTask('req-1')).toBe(true);
      expect(registry.stop).toHaveBeenCalledWith('req-1');
    });

    it('steerTask 代理到 registry.steer', () => {
      const { manager, registry } = createManager();
      expect(manager.steerTask('req-1', '追加指令')).toBe(true);
      expect(registry.steer).toHaveBeenCalledWith('req-1', '追加指令');
    });
  });

  describe('状态查询', () => {
    it('getRunState 代理到 registry.runningForConversation', () => {
      const { manager, registry } = createManager();
      manager.getRunState('conv-1');
      expect(registry.runningForConversation).toHaveBeenCalledWith('conv-1');
    });

    it('getSnapshots 代理到 registry.snapshots', () => {
      const { manager, registry } = createManager();
      manager.getSnapshots();
      expect(registry.snapshots).toHaveBeenCalled();
    });

    it('subscribe 代理到 registry.subscribe', () => {
      const { manager, registry } = createManager();
      const listener = vi.fn();
      manager.subscribe(listener);
      expect(registry.subscribe).toHaveBeenCalledWith(listener);
    });

    it('getReplayEvents 代理到 registry.replayEvents', () => {
      const { manager, registry } = createManager();
      manager.getReplayEvents();
      expect(registry.replayEvents).toHaveBeenCalled();
    });

    it('restore 代理到 registry.restore', async () => {
      const { manager, registry } = createManager();
      await manager.restore();
      expect(registry.restore).toHaveBeenCalled();
    });
  });

  describe('replay 清理', () => {
    it('clearReplay 清理指定会话', () => {
      const { manager, registry, createdAgents } = createManager();
      manager.getOrCreateAgent('conv-1');
      manager.getOrCreateAgent('conv-2');

      manager.clearReplay('conv-1');

      expect(createdAgents.get('conv-1')?.clearReplay).toHaveBeenCalled();
      expect(createdAgents.get('conv-2')?.clearReplay).not.toHaveBeenCalled();
      expect(registry.clearReplay).toHaveBeenCalledWith('conv-1');
    });

    it('clearReplay 清理所有会话', () => {
      const { manager, registry, createdAgents } = createManager();
      manager.getOrCreateAgent('conv-1');
      manager.getOrCreateAgent('conv-2');

      manager.clearReplay();

      expect(createdAgents.get('conv-1')?.clearReplay).toHaveBeenCalled();
      expect(createdAgents.get('conv-2')?.clearReplay).toHaveBeenCalled();
      expect(registry.clearReplay).toHaveBeenCalledWith(undefined);
    });
  });

  describe('兼容接口', () => {
    it('getRegistry 返回底层注册表', () => {
      const { manager, registry } = createManager();
      expect(manager.getRegistry()).toBe(registry);
    });

    it('getToolContextManager 返回底层上下文管理器', () => {
      const { manager, toolContextManager } = createManager();
      expect(manager.getToolContextManager()).toBe(toolContextManager);
    });
  });
});
