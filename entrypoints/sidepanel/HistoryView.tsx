// ─── 本地会话历史 ───
// 历史项是可恢复的会话入口，而不是只读消息详情。恢复后由标准对话页继续承载上下文。

import { Check, Clock3, Loader2, MessageCircle, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatConversation } from '@/lib/domain/chat';

interface HistoryViewProps {
  conversations: ChatConversation[];
  activeConversationId: string | null;
  runningConversationId: string | null;
  runningConversationIds?: string[];
  chatRunning: boolean;
  errorMessage: string;
  onRestore: (conversationId: string) => Promise<boolean>;
  onRename: (conversationId: string, title: string) => Promise<boolean>;
}

export function HistoryView({
  conversations,
  activeConversationId,
  runningConversationId,
  runningConversationIds,
  chatRunning,
  errorMessage,
  onRestore,
  onRename,
}: HistoryViewProps) {
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [renameError, setRenameError] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editingId) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [editingId]);

  const restore = async (conversationId: string) => {
    if (restoringId) return;
    setRestoringId(conversationId);
    setRestoreError('');
    const restored = await onRestore(conversationId).catch(() => false);
    if (!restored) {
      setRestoreError('这条会话恢复失败，请稍后重试。');
      setRestoringId(null);
    }
  };

  const beginEditing = (conversation: ChatConversation) => {
    setEditingId(conversation.id);
    setTitleDraft(conversation.title);
    setRenameError('');
  };

  const cancelEditing = () => {
    setEditingId(null);
    setTitleDraft('');
    setRenameError('');
  };

  const saveTitle = async (conversationId: string) => {
    const title = titleDraft.replace(/\s+/g, ' ').trim();
    if (!title) {
      setRenameError('标题不能为空。');
      return;
    }
    if (!(await onRename(conversationId, title))) {
      setRenameError('标题保存失败，请稍后重试。');
      return;
    }
    cancelEditing();
  };

  return (
    <section className="history-view" aria-labelledby="history-title">
      <div className="history-heading">
        <div>
          <h1 id="history-title">历史会话</h1>
          <p>选择一条会话，可恢复上下文并继续对话</p>
        </div>
        <span>{conversations.length} 条</span>
      </div>

      {errorMessage ? (
        <div className="history-notice history-notice-error" role="alert">
          {errorMessage}
        </div>
      ) : null}
      {restoreError ? (
        <div className="history-notice history-notice-error" role="alert">
          {restoreError}
        </div>
      ) : null}

      {conversations.length === 0 ? (
        <div className="history-empty">
          <MessageCircle size={22} />
          <strong>还没有历史会话</strong>
          <span>完成第一轮对话后，会自动出现在这里。</span>
        </div>
      ) : (
        <ul className="history-list">
          {conversations.map((conversation) => {
            const isCurrent = conversation.id === activeConversationId;
            const isRunning =
              chatRunning &&
              (runningConversationIds?.includes(conversation.id) ??
                conversation.id === runningConversationId);
            const isEditing = conversation.id === editingId;
            const isRestoring = conversation.id === restoringId;

            return (
              <li className="history-row-shell" key={conversation.id}>
                {isEditing ? (
                  <form
                    className="history-row history-row-editing"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveTitle(conversation.id);
                    }}
                  >
                    <span className="history-row-icon" aria-hidden>
                      <MessageCircle size={13} />
                    </span>
                    <span className="history-row-main">
                      <span className="history-row-title">
                        <label className="history-row-title-field">
                          <span className="sr-only">会话标题</span>
                          <input
                            ref={titleInputRef}
                            maxLength={60}
                            value={titleDraft}
                            onChange={(event) => setTitleDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') cancelEditing();
                            }}
                          />
                        </label>
                        {conversation.unread ? (
                          <span className="history-unread-dot" aria-hidden />
                        ) : null}
                      </span>
                      <span className="history-row-preview">
                        {conversation.lastMessagePreview || '等待第一条消息'}
                      </span>
                      <span className="history-row-meta">
                        <Clock3 size={9} />
                        {formatConversationTime(conversation.updatedAt)}
                        <span aria-hidden>·</span>
                        {conversation.messageCount} 条消息
                        {isRunning ? (
                          <>
                            <span aria-hidden>·</span>
                            <span className="history-running-label">回复中</span>
                          </>
                        ) : isCurrent ? (
                          <>
                            <span aria-hidden>·</span>
                            <span>当前会话</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <span className="history-row-editor-actions">
                      <button type="submit" aria-label="保存标题">
                        <Check size={13} />
                      </button>
                      <button type="button" aria-label="取消编辑标题" onClick={cancelEditing}>
                        <X size={13} />
                      </button>
                    </span>
                    {renameError ? (
                      <span className="history-row-rename-error" role="alert">
                        {renameError}
                      </span>
                    ) : null}
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="history-row"
                      aria-label={`恢复会话：${conversation.title}${conversation.unread ? '，未读' : ''}`}
                      disabled={Boolean(restoringId)}
                      onClick={() => void restore(conversation.id)}
                    >
                      <span className="history-row-icon" aria-hidden>
                        {isRestoring || isRunning ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <MessageCircle size={13} />
                        )}
                      </span>
                      <span className="history-row-main">
                        <span className="history-row-title">
                          <strong>{conversation.title}</strong>
                          {conversation.unread ? (
                            <span className="history-unread-dot" aria-hidden />
                          ) : null}
                        </span>
                        <span className="history-row-preview">
                          {conversation.lastMessagePreview || '等待第一条消息'}
                        </span>
                        <span className="history-row-meta">
                          <Clock3 size={9} />
                          {formatConversationTime(conversation.updatedAt)}
                          <span aria-hidden>·</span>
                          {conversation.messageCount} 条消息
                          {isRunning ? (
                            <>
                              <span aria-hidden>·</span>
                              <span className="history-running-label">回复中</span>
                            </>
                          ) : isCurrent ? (
                            <>
                              <span aria-hidden>·</span>
                              <span>当前会话</span>
                            </>
                          ) : null}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="history-row-edit"
                      aria-label={`编辑会话标题：${conversation.title}`}
                      disabled={Boolean(restoringId)}
                      onClick={() => beginEditing(conversation)}
                    >
                      <Pencil size={12} />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function formatConversationTime(timestamp: number, now = Date.now()): string {
  const value = new Date(timestamp);
  const current = new Date(now);
  const sameDay = value.toDateString() === current.toDateString();
  if (sameDay) {
    return value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  const yesterday = new Date(current);
  yesterday.setDate(current.getDate() - 1);
  if (value.toDateString() === yesterday.toDateString()) return '昨天';
  return value.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
