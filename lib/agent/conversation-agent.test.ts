import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageTurnSnapshot } from '@/lib/domain/types';
import type { ChatGenerationEvent, ChatGenerationManager } from '@/lib/generation/manager';
import { ConversationAgent } from './conversation-agent';
import { ToolContext } from './tool-context';

function createMockManager(): ChatGenerationManager {
  return {
    isRunning: false,
    currentRequestId: undefined,
    start: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    resumeDeferred: vi.fn().mockResolvedValue({ id: 'msg-2' }),
    cancelDeferred: vi.fn().mockReturnValue(null),
    failDeferred: vi.fn().mockReturnValue(null),
    stop: vi.fn().mockReturnValue(true),
    steer: vi.fn().mockReturnValue(true),
    subscribe: vi.fn(),
    getSnapshot: vi.fn().mockReturnValue(null),
    clearReplay: vi.fn(),
  } as unknown as ChatGenerationManager;
}

function createAgent(
  conversationId = 'conv-1',
  manager?: ChatGenerationManager,
): {
  agent: ConversationAgent;
  toolContext: ToolContext;
  manager: ChatGenerationManager;
  broadcast: ReturnType<typeof vi.fn>;
  finishDiagnostics: ReturnType<typeof vi.fn>;
  saveCheckpoint: ReturnType<typeof vi.fn>;
  saveRuntimeSettings: ReturnType<typeof vi.fn>;
} {
  const toolContext = new ToolContext(conversationId);
  const mgr = manager ?? createMockManager();
  const broadcast = vi.fn();
  const finishDiagnostics = vi.fn();
  const saveCheckpoint = vi.fn();
  const saveRuntimeSettings = vi.fn();

  const agent = new ConversationAgent({
    conversationId,
    toolContext,
    createManager: () => mgr,
    broadcast,
    finishDiagnostics,
    saveCheckpoint,
    saveRuntimeSettings,
  });

  return {
    agent,
    toolContext,
    manager: mgr,
    broadcast,
    finishDiagnostics,
    saveCheckpoint,
    saveRuntimeSettings,
  };
}

describe('ConversationAgent', () => {
  describe('基础属性', () => {
    it('暴露 conversationId 和 toolContext', () => {
      const { agent, toolContext } = createAgent('conv-42');
      expect(agent.conversationId).toBe('conv-42');
      expect(agent.toolContext).toBe(toolContext);
    });

    it('isRunning 和 currentRequestId 代理到底层 manager', () => {
      const manager = createMockManager();
      const { agent } = createAgent('conv-1', manager);
      expect(agent.isRunning).toBe(false);
      expect(agent.currentRequestId).toBeUndefined();
    });
  });

  describe('生命周期方法代理', () => {
    it('start 代理到 manager.start', async () => {
      const manager = createMockManager();
      const { agent } = createAgent('conv-1', manager);
      await agent.start('req-1', []);
      expect(manager.start).toHaveBeenCalledWith('req-1', []);
    });

    it('stop 代理到 manager.stop', () => {
      const manager = createMockManager();
      const { agent } = createAgent('conv-1', manager);
      expect(agent.stop('req-1')).toBe(true);
      expect(manager.stop).toHaveBeenCalledWith('req-1');
    });

    it('steer 代理到 manager.steer', () => {
      const manager = createMockManager();
      const { agent } = createAgent('conv-1', manager);
      expect(agent.steer('req-1', '追加指令')).toBe(true);
      expect(manager.steer).toHaveBeenCalledWith('req-1', '追加指令');
    });

    it('getSnapshot 代理到 manager.getSnapshot', () => {
      const manager = createMockManager();
      const { agent } = createAgent('conv-1', manager);
      expect(agent.getSnapshot()).toBeNull();
      expect(manager.getSnapshot).toHaveBeenCalled();
    });

    it('clearReplay 代理到 manager.clearReplay', () => {
      const manager = createMockManager();
      const { agent } = createAgent('conv-1', manager);
      agent.clearReplay();
      expect(manager.clearReplay).toHaveBeenCalled();
    });
  });

  describe('任务上下文管理', () => {
    it('prepareForNewTask 设置快照/历史/用户输入/诊断', () => {
      const { agent, toolContext } = createAgent();
      const snapshot = { url: 'https://example.com' } as unknown as PageTurnSnapshot;
      const history = [{ id: '1', role: 'user', content: 'Hello' } as never];

      agent.prepareForNewTask(snapshot, history, 'Hello', 'req-1');

      expect(toolContext.getPageSnapshot()).toEqual(snapshot);
      expect(toolContext.getChatHistory()).toEqual(history);
      expect(toolContext.getLatestUserText()).toBe('Hello');
      expect(toolContext.getDiagnostic('req-1')).toEqual({
        conversationId: 'conv-1',
        requestId: 'req-1',
        targetResolved: false,
        modelRounds: 0,
      });
    });

    it('cleanupAfterTask 清除诊断/用户输入/快照/历史', () => {
      const { agent, toolContext } = createAgent();
      const snapshot = { url: 'https://example.com' } as unknown as PageTurnSnapshot;
      agent.prepareForNewTask(snapshot, [{ id: '1' } as never], 'Hello', 'req-1');

      agent.cleanupAfterTask('req-1');

      expect(toolContext.getDiagnostic('req-1')).toBeUndefined();
      expect(toolContext.getLatestUserText()).toBe('');
      expect(toolContext.getPageSnapshot()).toBeNull();
      expect(toolContext.getChatHistory()).toEqual([]);
    });

    it('cleanupAfterTask 保留授权状态', () => {
      const { agent, toolContext } = createAgent();
      agent.prepareForNewTask(null, [], 'Hello', 'req-1');
      toolContext.approveToolCall('call-1');
      toolContext.setSkillApproval('call-1', 'once');

      agent.cleanupAfterTask('req-1');

      expect(toolContext.isToolCallApproved('call-1')).toBe(true);
      expect(toolContext.getSkillApproval('call-1')).toBe('once');
    });

    it('prepareForResume 设置快照/历史/用户输入但不设诊断', () => {
      const { agent, toolContext } = createAgent();
      const snapshot = { url: 'https://example.com' } as unknown as PageTurnSnapshot;
      const history = [{ id: '1' } as never];

      agent.prepareForResume(snapshot, history, 'Hello');

      expect(toolContext.getPageSnapshot()).toEqual(snapshot);
      expect(toolContext.getChatHistory()).toEqual(history);
      expect(toolContext.getLatestUserText()).toBe('Hello');
      expect(toolContext.getDiagnostic('req-1')).toBeUndefined();
    });

    it('cleanupAfterResume 清除状态并删除取消标记', () => {
      const { agent, toolContext } = createAgent();
      agent.prepareForResume(null, [{ id: '1' } as never], 'Hello');
      toolContext.cancelPendingRequest('req-1');

      agent.cleanupAfterResume('req-1');

      expect(toolContext.getLatestUserText()).toBe('');
      expect(toolContext.getPageSnapshot()).toBeNull();
      expect(toolContext.getChatHistory()).toEqual([]);
      expect(toolContext.isPendingRequestCancelled('req-1')).toBe(false);
    });
  });

  describe('事件处理', () => {
    it('事件触发广播和诊断收尾', () => {
      const manager = createMockManager();
      const { agent, broadcast, finishDiagnostics } = createAgent('conv-1', manager);

      // 模拟 manager 触发事件（通过 createManager 的 publish 回调）
      const event: ChatGenerationEvent = {
        type: 'update',
        requestId: 'req-1',
        message: { id: 'msg-1' } as never,
      };
      // 从 createManager 工厂中拿到 publish 回调
      const publishFn = (manager.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      // 实际上 ConversationAgent 内部通过 createManager 的第二个参数订阅
      // 我们需要直接调用 handleEvent 的私有路径——通过 createManager 捕获
      // 重新创建 agent 来捕获 publish
      let capturedPublish: ((event: ChatGenerationEvent) => void) | undefined;
      const agent2 = new ConversationAgent({
        conversationId: 'conv-1',
        toolContext: new ToolContext('conv-1'),
        createManager: (_id, publish) => {
          capturedPublish = publish;
          return manager;
        },
        broadcast: broadcast as (event: ChatGenerationEvent, conversationId: string) => void,
        finishDiagnostics: finishDiagnostics as (
          event: ChatGenerationEvent,
          conversationId: string,
        ) => void,
        saveCheckpoint: vi.fn(),
        saveRuntimeSettings: vi.fn(),
      });
      capturedPublish?.(event);

      expect(broadcast).toHaveBeenCalledWith(event, 'conv-1');
      expect(finishDiagnostics).toHaveBeenCalledWith(event, 'conv-1');
    });

    it('end 事件保存检查点', () => {
      const manager = createMockManager();
      const saveCheckpoint = vi.fn();
      let capturedPublish: ((event: ChatGenerationEvent) => void) | undefined;
      const toolContext = new ToolContext('conv-1');
      toolContext.setChatHistory([{ id: 'msg-1' } as never, { id: 'msg-2' } as never]);

      new ConversationAgent({
        conversationId: 'conv-1',
        toolContext,
        createManager: (_id, publish) => {
          capturedPublish = publish;
          return manager;
        },
        broadcast: vi.fn(),
        finishDiagnostics: vi.fn(),
        saveCheckpoint,
        saveRuntimeSettings: vi.fn(),
      });

      const event: ChatGenerationEvent = {
        type: 'end',
        requestId: 'req-1',
        message: { id: 'msg-2', status: 'completed' } as never,
      };
      capturedPublish?.(event);

      expect(saveCheckpoint).toHaveBeenCalledWith(event, 'conv-1', ['msg-1', 'msg-2']);
    });

    it('start 事件保存运行时设置', () => {
      const manager = createMockManager();
      const saveRuntimeSettings = vi.fn();
      let capturedPublish: ((event: ChatGenerationEvent) => void) | undefined;

      new ConversationAgent({
        conversationId: 'conv-1',
        toolContext: new ToolContext('conv-1'),
        createManager: (_id, publish) => {
          capturedPublish = publish;
          return manager;
        },
        broadcast: vi.fn(),
        finishDiagnostics: vi.fn(),
        saveCheckpoint: vi.fn(),
        saveRuntimeSettings,
      });

      const modelIdentity = { modelId: 'gpt-4', providerId: 'openai' };
      const event: ChatGenerationEvent = {
        type: 'start',
        requestId: 'req-1',
        message: { id: 'msg-1', modelIdentity } as never,
      };
      capturedPublish?.(event);

      expect(saveRuntimeSettings).toHaveBeenCalledWith('conv-1', modelIdentity);
    });
  });
});
