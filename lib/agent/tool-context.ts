// ─── 会话级工具上下文 ───
// 职责：为每个会话提供独立的工具执行状态，避免跨会话污染。
// 隔离内容：页面快照、对话历史、诊断输入、授权状态、Skill 审批。

import type { ChatMessage } from '@/lib/domain/chat';
import type { PageTurnSnapshot } from '@/lib/domain/types';
import type { SkillRunApproval } from '@/lib/tools/run-skill';

export interface ToolBatchScope {
  id: string;
  index: number;
  size: number;
}

interface ToolBatchPageState {
  baseline: PageTurnSnapshot | null;
  completed: Set<number>;
  nextSnapshots: Map<number, PageTurnSnapshot>;
}

export type ToolBatchPageCompletion =
  | { done: false }
  | { done: true; pageSnapshot: PageTurnSnapshot | null };

/** 为同一模型回合的独立工具绑定不可变页面起点，避免前一个导航污染后一个调用。 */
export class ToolBatchPageContext {
  private readonly batches = new Map<string, ToolBatchPageState>();

  bind(scope: ToolBatchScope, current: PageTurnSnapshot | null): PageTurnSnapshot | null {
    if (scope.size <= 1) return clonePageSnapshot(current);
    if (!this.batches.has(scope.id)) {
      this.batches.set(scope.id, {
        baseline: clonePageSnapshot(current),
        completed: new Set(),
        nextSnapshots: new Map(),
      });
    }
    return clonePageSnapshot(this.batches.get(scope.id)?.baseline ?? null);
  }

  complete(scope: ToolBatchScope, nextSnapshot?: PageTurnSnapshot): ToolBatchPageCompletion {
    if (scope.size <= 1) {
      return { done: true, pageSnapshot: clonePageSnapshot(nextSnapshot ?? null) };
    }
    const state = this.batches.get(scope.id);
    if (!state) return { done: false };
    state.completed.add(scope.index);
    if (nextSnapshot) state.nextSnapshots.set(scope.index, structuredClone(nextSnapshot));
    if (state.completed.size < scope.size) return { done: false };

    let pageSnapshot = state.baseline;
    for (let index = scope.size - 1; index >= 0; index -= 1) {
      const candidate = state.nextSnapshots.get(index);
      if (candidate) {
        pageSnapshot = candidate;
        break;
      }
    }
    this.batches.delete(scope.id);
    return { done: true, pageSnapshot: clonePageSnapshot(pageSnapshot) };
  }
}

export interface ToolContextState {
  /** 当前页面快照（随浏览器导航更新） */
  pageSnapshot: PageTurnSnapshot | null;
  /** 本会话由 tab.open/list 或页面工具实际返回过的可信标签页句柄。 */
  pageSnapshotsByTabId: Map<number, PageTurnSnapshot>;
  /** 当前会话的完整对话历史 */
  chatHistory: ChatMessage[];
  /** 最后一条用户输入（用于诊断和工具上下文） */
  latestUserText: string;
  /** 已授权的工具调用 ID 集合 */
  approvedToolCalls: Set<string>;
  /** Skill 运行审批（callId → 审批类型） */
  skillApprovals: Map<string, Exclude<SkillRunApproval, null>>;
  /** 已取消的待处理请求 ID 集合 */
  cancelledPendingRequests: Set<string>;
}

export interface ActiveDiagnostic {
  conversationId: string;
  requestId: string;
  targetResolved: boolean;
  modelRounds: number;
}

/**
 * 会话级工具上下文容器。
 * 每个 conversationId 对应一个实例，生命周期与会话绑定。
 */
export class ToolContext {
  readonly conversationId: string;
  private state: ToolContextState;
  private diagnostics: Map<string, ActiveDiagnostic>;

  constructor(conversationId: string) {
    this.conversationId = conversationId;
    this.state = this.createInitialState();
    this.diagnostics = new Map();
  }

  private createInitialState(): ToolContextState {
    return {
      pageSnapshot: null,
      pageSnapshotsByTabId: new Map(),
      chatHistory: [],
      latestUserText: '',
      approvedToolCalls: new Set(),
      skillApprovals: new Map(),
      cancelledPendingRequests: new Set(),
    };
  }

  // ─── 页面快照 ───

  getPageSnapshot(tabId?: number): PageTurnSnapshot | null {
    const snapshot =
      tabId === undefined ? this.state.pageSnapshot : this.state.pageSnapshotsByTabId.get(tabId);
    return snapshot ? structuredClone(snapshot) : null;
  }

  setPageSnapshot(snapshot: PageTurnSnapshot | null): void {
    this.state.pageSnapshot = snapshot ? structuredClone(snapshot) : null;
    if (snapshot) this.rememberPageSnapshot(snapshot);
  }

  rememberPageSnapshot(snapshot: PageTurnSnapshot): void {
    this.state.pageSnapshotsByTabId.set(snapshot.tabId, structuredClone(snapshot));
  }

  forgetPageSnapshot(tabId: number): boolean {
    if (this.state.pageSnapshot?.tabId === tabId) this.state.pageSnapshot = null;
    return this.state.pageSnapshotsByTabId.delete(tabId);
  }

  getPageSnapshots(): PageTurnSnapshot[] {
    return [...this.state.pageSnapshotsByTabId.values()].map((snapshot) =>
      structuredClone(snapshot),
    );
  }

  // ─── 对话历史 ───

  getChatHistory(): ChatMessage[] {
    return [...this.state.chatHistory];
  }

  setChatHistory(history: ChatMessage[]): void {
    this.state.chatHistory = [...history];
  }

  // ─── 用户输入 ───

  getLatestUserText(): string {
    return this.state.latestUserText;
  }

  setLatestUserText(text: string): void {
    this.state.latestUserText = text;
  }

  // ─── 工具授权 ───

  isToolCallApproved(callId: string): boolean {
    return this.state.approvedToolCalls.has(callId);
  }

  approveToolCall(callId: string): void {
    this.state.approvedToolCalls.add(callId);
  }

  revokeToolCallApproval(callId: string): boolean {
    return this.state.approvedToolCalls.delete(callId);
  }

  // ─── Skill 审批 ───

  getSkillApproval(callId: string): Exclude<SkillRunApproval, null> | undefined {
    return this.state.skillApprovals.get(callId);
  }

  setSkillApproval(callId: string, approval: Exclude<SkillRunApproval, null>): void {
    this.state.skillApprovals.set(callId, approval);
  }

  deleteSkillApproval(callId: string): boolean {
    return this.state.skillApprovals.delete(callId);
  }

  // ─── 取消的待处理请求 ───

  isPendingRequestCancelled(requestId: string): boolean {
    return this.state.cancelledPendingRequests.has(requestId);
  }

  cancelPendingRequest(requestId: string): void {
    this.state.cancelledPendingRequests.add(requestId);
  }

  deleteCancelledPendingRequest(requestId: string): boolean {
    return this.state.cancelledPendingRequests.delete(requestId);
  }

  // ─── 诊断追踪 ───

  getDiagnostic(requestId: string): ActiveDiagnostic | undefined {
    return this.diagnostics.get(requestId);
  }

  setDiagnostic(requestId: string, diagnostic: ActiveDiagnostic): void {
    this.diagnostics.set(requestId, diagnostic);
  }

  deleteDiagnostic(requestId: string): boolean {
    return this.diagnostics.delete(requestId);
  }

  findDiagnosticByConversation(conversationId: string): ActiveDiagnostic | undefined {
    return [...this.diagnostics.values()].find(
      (item) => item.conversationId === conversationId && !item.targetResolved,
    );
  }

  // ─── 清理 ───

  /**
   * 重置上下文状态（新任务开始时调用）。
   * 保留授权状态，清除页面快照和对话历史。
   */
  resetForNewTask(): void {
    this.state.pageSnapshot = null;
    this.state.pageSnapshotsByTabId.clear();
    this.state.chatHistory = [];
    this.state.latestUserText = '';
    this.diagnostics.clear();
  }

  /**
   * 完全清理上下文（会话结束时调用）。
   */
  dispose(): void {
    this.state = this.createInitialState();
    this.diagnostics.clear();
  }
}

/**
 * 工具上下文管理器。
 * 负责创建、获取、销毁会话级上下文实例。
 */
export class ToolContextManager {
  private readonly contexts = new Map<string, ToolContext>();

  /**
   * 获取或创建指定会话的上下文。
   */
  getOrCreate(conversationId: string): ToolContext {
    let context = this.contexts.get(conversationId);
    if (!context) {
      context = new ToolContext(conversationId);
      this.contexts.set(conversationId, context);
    }
    return context;
  }

  /**
   * 获取指定会话的上下文（不存在时返回 undefined）。
   */
  get(conversationId: string): ToolContext | undefined {
    return this.contexts.get(conversationId);
  }

  /**
   * 销毁指定会话的上下文。
   */
  dispose(conversationId: string): boolean {
    const context = this.contexts.get(conversationId);
    if (context) {
      context.dispose();
      return this.contexts.delete(conversationId);
    }
    return false;
  }

  /**
   * 获取所有活跃会话 ID。
   */
  getActiveConversationIds(): string[] {
    return [...this.contexts.keys()];
  }

  /**
   * 清理所有上下文（用于测试或 SW 关闭前）。
   */
  disposeAll(): void {
    for (const context of this.contexts.values()) {
      context.dispose();
    }
    this.contexts.clear();
  }
}

// 全局单例
export const toolContextManager = new ToolContextManager();

function clonePageSnapshot(snapshot: PageTurnSnapshot | null): PageTurnSnapshot | null {
  return snapshot ? structuredClone(snapshot) : null;
}
