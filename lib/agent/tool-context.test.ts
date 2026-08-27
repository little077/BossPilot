import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import type { PageTurnSnapshot } from '@/lib/domain/types';
import { ToolContext, ToolContextManager } from './tool-context';

describe('ToolContext', () => {
  let context: ToolContext;

  beforeEach(() => {
    context = new ToolContext('conv-1');
  });

  it('初始状态为空', () => {
    expect(context.getPageSnapshot()).toBeNull();
    expect(context.getChatHistory()).toEqual([]);
    expect(context.getLatestUserText()).toBe('');
    expect(context.isToolCallApproved('call-1')).toBe(false);
  });

  it('页面快照独立存储', () => {
    const snapshot = {
      url: 'https://example.com',
      title: 'Example',
    } as unknown as PageTurnSnapshot;
    context.setPageSnapshot(snapshot);
    expect(context.getPageSnapshot()).toEqual(snapshot);

    const otherContext = new ToolContext('conv-2');
    expect(otherContext.getPageSnapshot()).toBeNull();
  });

  it('对话历史独立存储', () => {
    const history = [{ id: '1', role: 'user', content: 'Hello' } as unknown as ChatMessage];
    context.setChatHistory(history);
    expect(context.getChatHistory()).toEqual(history);

    // 修改原数组不影响内部状态
    history.push({ id: '2', role: 'assistant', content: 'Hi' } as unknown as ChatMessage);
    expect(context.getChatHistory()).toHaveLength(1);
  });

  it('工具授权独立管理', () => {
    context.approveToolCall('call-1');
    expect(context.isToolCallApproved('call-1')).toBe(true);

    const otherContext = new ToolContext('conv-2');
    expect(otherContext.isToolCallApproved('call-1')).toBe(false);

    context.revokeToolCallApproval('call-1');
    expect(context.isToolCallApproved('call-1')).toBe(false);
  });

  it('Skill 审批独立管理', () => {
    context.setSkillApproval('call-1', 'always');
    expect(context.getSkillApproval('call-1')).toBe('always');

    const otherContext = new ToolContext('conv-2');
    expect(otherContext.getSkillApproval('call-1')).toBeUndefined();

    context.deleteSkillApproval('call-1');
    expect(context.getSkillApproval('call-1')).toBeUndefined();
  });

  it('取消的待处理请求独立管理', () => {
    context.cancelPendingRequest('req-1');
    expect(context.isPendingRequestCancelled('req-1')).toBe(true);

    const otherContext = new ToolContext('conv-2');
    expect(otherContext.isPendingRequestCancelled('req-1')).toBe(false);

    context.deleteCancelledPendingRequest('req-1');
    expect(context.isPendingRequestCancelled('req-1')).toBe(false);
  });

  it('诊断追踪独立管理', () => {
    const diagnostic = {
      conversationId: 'conv-1',
      requestId: 'req-1',
      targetResolved: false,
      modelRounds: 0,
    };
    context.setDiagnostic('req-1', diagnostic);
    expect(context.getDiagnostic('req-1')).toEqual(diagnostic);

    const found = context.findDiagnosticByConversation('conv-1');
    expect(found).toEqual(diagnostic);

    context.deleteDiagnostic('req-1');
    expect(context.getDiagnostic('req-1')).toBeUndefined();
  });

  it('resetForNewTask 保留授权状态', () => {
    context.setPageSnapshot({ url: 'https://example.com' } as unknown as PageTurnSnapshot);
    context.setChatHistory([{ id: '1' } as unknown as ChatMessage]);
    context.setLatestUserText('test');
    context.approveToolCall('call-1');
    context.setSkillApproval('call-1', 'once');

    context.resetForNewTask();

    expect(context.getPageSnapshot()).toBeNull();
    expect(context.getChatHistory()).toEqual([]);
    expect(context.getLatestUserText()).toBe('');
    expect(context.isToolCallApproved('call-1')).toBe(true); // 授权保留
    expect(context.getSkillApproval('call-1')).toBe('once'); // 审批保留
  });

  it('dispose 完全清理', () => {
    context.setPageSnapshot({ url: 'https://example.com' } as unknown as PageTurnSnapshot);
    context.approveToolCall('call-1');
    context.setDiagnostic('req-1', {
      conversationId: 'conv-1',
      requestId: 'req-1',
      targetResolved: false,
      modelRounds: 0,
    });

    context.dispose();

    expect(context.getPageSnapshot()).toBeNull();
    expect(context.isToolCallApproved('call-1')).toBe(false);
    expect(context.getDiagnostic('req-1')).toBeUndefined();
  });
});

describe('ToolContextManager', () => {
  let manager: ToolContextManager;

  beforeEach(() => {
    manager = new ToolContextManager();
  });

  it('getOrCreate 创建新上下文', () => {
    const context1 = manager.getOrCreate('conv-1');
    expect(context1.conversationId).toBe('conv-1');

    const context2 = manager.getOrCreate('conv-1');
    expect(context2).toBe(context1); // 返回同一实例
  });

  it('get 返回 undefined 当上下文不存在', () => {
    expect(manager.get('non-existent')).toBeUndefined();
  });

  it('dispose 销毁指定上下文', () => {
    const context = manager.getOrCreate('conv-1');
    context.approveToolCall('call-1');

    expect(manager.dispose('conv-1')).toBe(true);
    expect(manager.get('conv-1')).toBeUndefined();
    expect(manager.dispose('conv-1')).toBe(false); // 重复销毁返回 false
  });

  it('getActiveConversationIds 返回所有活跃会话', () => {
    manager.getOrCreate('conv-1');
    manager.getOrCreate('conv-2');
    manager.getOrCreate('conv-3');

    expect(manager.getActiveConversationIds()).toEqual(['conv-1', 'conv-2', 'conv-3']);
  });

  it('disposeAll 清理所有上下文', () => {
    manager.getOrCreate('conv-1');
    manager.getOrCreate('conv-2');

    manager.disposeAll();

    expect(manager.getActiveConversationIds()).toEqual([]);
  });
});
