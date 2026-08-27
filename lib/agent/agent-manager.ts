// ─── 多会话 Agent 管理器 ───
// 职责：统一管理所有 ConversationAgent 实例的生命周期，
// 协调 AgentRunRegistry 并发调度与 ToolContextManager 上下文隔离。

import type { ConversationAgent } from '@/lib/agent/conversation-agent';
import type { ToolContextManager } from '@/lib/agent/tool-context';
import type { ChatMessage } from '@/lib/domain/chat';
import type { ChatGenerationEvent } from '@/lib/generation/manager';
import type { AgentRunRegistry, AgentRunSnapshot } from '@/lib/generation/registry';

export interface AgentManagerOptions {
  registry: AgentRunRegistry;
  toolContextManager: ToolContextManager;
  createAgent: (conversationId: string) => ConversationAgent;
}

/**
 * 多会话 Agent 管理器。
 * 是 background.ts 与底层 Agent 架构之间的唯一入口：
 * - 管理 ConversationAgent 实例的创建、获取、销毁
 * - 协调 AgentRunRegistry 的并发调度
 * - 提供统一的会话级操作接口（start/stop/steer/resume）
 */
export class AgentManager {
  private readonly agents = new Map<string, ConversationAgent>();
  private readonly registry: AgentRunRegistry;
  private readonly toolContextManager: ToolContextManager;
  private readonly createAgent: (conversationId: string) => ConversationAgent;

  constructor(options: AgentManagerOptions) {
    this.registry = options.registry;
    this.toolContextManager = options.toolContextManager;
    this.createAgent = options.createAgent;
  }

  /** 获取或创建指定会话的 Agent 实例 */
  getOrCreateAgent(conversationId: string): ConversationAgent {
    let agent = this.agents.get(conversationId);
    if (!agent) {
      agent = this.createAgent(conversationId);
      this.agents.set(conversationId, agent);
    }
    return agent;
  }

  /** 获取指定会话的 Agent 实例（不存在时返回 undefined） */
  getAgent(conversationId: string): ConversationAgent | undefined {
    return this.agents.get(conversationId);
  }

  /** 销毁指定会话的 Agent 实例 */
  disposeAgent(conversationId: string): boolean {
    const agent = this.agents.get(conversationId);
    if (agent) {
      agent.clearReplay();
      this.toolContextManager.dispose(conversationId);
      return this.agents.delete(conversationId);
    }
    return false;
  }

  /** 获取所有活跃会话 ID */
  getActiveConversationIds(): string[] {
    return [...this.agents.keys()];
  }

  /** 启动新任务 */
  async startTask(
    conversationId: string,
    requestId: string,
    history: ChatMessage[],
    snapshot: import('@/lib/domain/types').PageTurnSnapshot | null,
  ): Promise<void> {
    const agent = this.getOrCreateAgent(conversationId);
    const lastUser = [...history].reverse().find((message) => message.role === 'user');
    agent.prepareForNewTask(snapshot, history, lastUser?.content ?? '', requestId);

    try {
      await this.registry.enqueue(conversationId, requestId, async (manager) => {
        await manager.start(requestId, history);
      });
    } finally {
      agent.cleanupAfterTask(requestId);
    }
  }

  /** 停止任务 */
  stopTask(requestId: string): boolean {
    return this.registry.stop(requestId);
  }

  /** 追加指令 */
  steerTask(requestId: string, content: string): boolean {
    return this.registry.steer(requestId, content);
  }

  /** 获取会话运行状态 */
  getRunState(conversationId: string): AgentRunSnapshot | undefined {
    return this.registry.runningForConversation(conversationId);
  }

  /** 获取所有运行快照 */
  getSnapshots(): AgentRunSnapshot[] {
    return this.registry.snapshots();
  }

  /** 订阅运行状态变化 */
  subscribe(listener: (runs: AgentRunSnapshot[]) => void): () => void {
    return this.registry.subscribe(listener);
  }

  /** 获取重连 replay 事件 */
  getReplayEvents(): Array<{ conversationId: string; event: ChatGenerationEvent }> {
    return this.registry.replayEvents();
  }

  /** 清除 replay 快照 */
  clearReplay(conversationId?: string): void {
    if (conversationId) {
      this.agents.get(conversationId)?.clearReplay();
    } else {
      for (const agent of this.agents.values()) agent.clearReplay();
    }
    this.registry.clearReplay(conversationId);
  }

  /** 恢复注册表状态（SW 重启后） */
  async restore(): Promise<AgentRunSnapshot[]> {
    return this.registry.restore();
  }

  /** 获取底层注册表（仅用于兼容旧代码，新代码不应直接访问） */
  getRegistry(): AgentRunRegistry {
    return this.registry;
  }

  /** 获取底层上下文管理器（仅用于兼容旧代码） */
  getToolContextManager(): ToolContextManager {
    return this.toolContextManager;
  }
}
