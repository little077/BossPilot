// ─── 会话级 Agent 封装 ───
// 职责：把单个会话的 ChatGenerationManager + ToolContext 封装为统一实例，
// 让 AgentRunRegistry 只负责并发调度，不关心 Agent 内部如何工作。

import type { ToolContext } from '@/lib/agent/tool-context';
import type { ChatMessage } from '@/lib/domain/chat';
import type {
  ChatGenerationEvent,
  ChatGenerationManager,
  DeferredGenerationTurn,
} from '@/lib/generation/manager';
import type { GenerationToolExecutionResult } from '@/lib/generation/types';

export interface ConversationAgentOptions {
  conversationId: string;
  toolContext: ToolContext;
  createManager: (
    conversationId: string,
    publish: (event: ChatGenerationEvent) => void,
  ) => ChatGenerationManager;
  /** 事件广播（background 注入，把事件推给所有连接的 Port） */
  broadcast: (event: ChatGenerationEvent, conversationId: string) => void;
  /** 诊断收尾（end/error 时记录） */
  finishDiagnostics: (event: ChatGenerationEvent, conversationId: string) => void;
  /** 运行结束后的检查点保存 */
  saveCheckpoint: (
    event: ChatGenerationEvent,
    conversationId: string,
    historyIds: string[],
  ) => void;
  /** 首轮启动时保存运行时设置 */
  saveRuntimeSettings: (conversationId: string, modelIdentity: unknown) => void;
}

/**
 * 会话级 Agent 实例。
 * 每个 conversationId 对应一个实例，持有独立的 ToolContext 和 ChatGenerationManager。
 * 生命周期由 AgentManager 管理。
 */
export class ConversationAgent {
  readonly conversationId: string;
  readonly toolContext: ToolContext;
  private readonly manager: ChatGenerationManager;
  private readonly broadcast: ConversationAgentOptions['broadcast'];
  private readonly finishDiagnostics: ConversationAgentOptions['finishDiagnostics'];
  private readonly saveCheckpoint: ConversationAgentOptions['saveCheckpoint'];
  private readonly saveRuntimeSettings: ConversationAgentOptions['saveRuntimeSettings'];

  constructor(options: ConversationAgentOptions) {
    this.conversationId = options.conversationId;
    this.toolContext = options.toolContext;
    this.broadcast = options.broadcast;
    this.finishDiagnostics = options.finishDiagnostics;
    this.saveCheckpoint = options.saveCheckpoint;
    this.saveRuntimeSettings = options.saveRuntimeSettings;

    this.manager = options.createManager(options.conversationId, (event) => {
      this.handleEvent(event);
    });
  }

  /** 当前是否有正在运行的请求 */
  get isRunning(): boolean {
    return this.manager.isRunning;
  }

  /** 当前运行中的 requestId */
  get currentRequestId(): string | undefined {
    return this.manager.currentRequestId;
  }

  /** 启动新一轮生成 */
  async start(requestId: string, history: ChatMessage[]): Promise<ChatMessage> {
    return this.manager.start(requestId, history);
  }

  /** 恢复被暂停的生成（页面授权/用户回答后） */
  async resumeDeferred(
    state: DeferredGenerationTurn,
    history: ChatMessage[],
    override?: GenerationToolExecutionResult,
  ): Promise<ChatMessage> {
    return this.manager.resumeDeferred(state, history, override);
  }

  /** 取消被暂停的生成 */
  cancelDeferred(state: DeferredGenerationTurn): ChatMessage | null {
    return this.manager.cancelDeferred(state);
  }

  /** 标记被暂停的生成为失败 */
  failDeferred(state: DeferredGenerationTurn, error: unknown): ChatMessage | null {
    return this.manager.failDeferred(state, error);
  }

  /** 停止当前运行 */
  stop(requestId: string): boolean {
    return this.manager.stop(requestId);
  }

  /** 追加用户指令（运行中 steering） */
  steer(requestId: string, content: string): boolean {
    return this.manager.steer(requestId, content);
  }

  /** 获取当前快照（用于重连 replay） */
  getSnapshot(): ChatGenerationEvent | null {
    return this.manager.getSnapshot();
  }

  /** 清除 replay 快照 */
  clearReplay(): void {
    this.manager.clearReplay();
  }

  /** 准备新一轮任务：重置上下文状态，保留授权 */
  prepareForNewTask(
    snapshot: import('@/lib/domain/types').PageTurnSnapshot | null,
    history: ChatMessage[],
    latestUserText: string,
    requestId: string,
  ): void {
    this.toolContext.setPageSnapshot(snapshot);
    this.toolContext.setChatHistory(history);
    this.toolContext.setLatestUserText(latestUserText);
    this.toolContext.setDiagnostic(requestId, {
      conversationId: this.conversationId,
      requestId,
      targetResolved: false,
      modelRounds: 0,
    });
  }

  /** 任务结束后的上下文清理 */
  cleanupAfterTask(requestId: string): void {
    this.toolContext.deleteDiagnostic(requestId);
    this.toolContext.setLatestUserText('');
    this.toolContext.setPageSnapshot(null);
    this.toolContext.setChatHistory([]);
  }

  /** 恢复暂停点时的上下文准备 */
  prepareForResume(
    snapshot: import('@/lib/domain/types').PageTurnSnapshot | null,
    history: ChatMessage[],
    latestUserText: string,
  ): void {
    this.toolContext.setPageSnapshot(snapshot);
    this.toolContext.setChatHistory(history);
    this.toolContext.setLatestUserText(latestUserText);
  }

  /** 恢复暂停点后的上下文清理 */
  cleanupAfterResume(requestId: string): void {
    this.toolContext.setLatestUserText('');
    this.toolContext.setPageSnapshot(null);
    this.toolContext.setChatHistory([]);
    this.toolContext.deleteCancelledPendingRequest(requestId);
  }

  private handleEvent(event: ChatGenerationEvent): void {
    this.broadcast(event, this.conversationId);
    this.finishDiagnostics(event, this.conversationId);

    if (event.type === 'end' || event.type === 'error') {
      const historyMessageIds = this.toolContext.getChatHistory().map(({ id }) => id);
      this.saveCheckpoint(event, this.conversationId, historyMessageIds);
    }

    if (event.type === 'start' && event.message.modelIdentity) {
      this.saveRuntimeSettings(this.conversationId, event.message.modelIdentity);
    }
  }
}
