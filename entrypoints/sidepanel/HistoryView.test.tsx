import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ChatConversation } from '@/lib/domain/chat';
import { formatConversationTime, HistoryView } from './HistoryView';

const now = new Date('2026-08-09T12:00:00+08:00').getTime();

function conversation(overrides: Partial<ChatConversation>): ChatConversation {
  return {
    id: 'conversation-1',
    ordinal: 1,
    title: '网页总结',
    titleSource: 'ai',
    createdAt: now,
    updatedAt: now,
    lastMessagePreview: '这是最后一条回答',
    messageCount: 2,
    unread: false,
    ...overrides,
  };
}

function renderHistory(overrides: Partial<Parameters<typeof HistoryView>[0]> = {}) {
  const props: Parameters<typeof HistoryView>[0] = {
    conversations: [
      conversation({ id: 'live', title: '当前会话', unread: true }),
      conversation({ id: 'old', ordinal: 2, title: '旧会话', updatedAt: now - 86_400_000 }),
    ],
    activeConversationId: 'old',
    runningConversationId: 'live',
    chatRunning: true,
    errorMessage: '',
    onRestore: vi.fn(async () => true),
    onRename: vi.fn(async () => true),
    ...overrides,
  };
  return { ...render(<HistoryView {...props} />), props };
}

describe('HistoryView', () => {
  it('shows unread, running, and current conversation state', () => {
    renderHistory();

    expect(screen.getByRole('heading', { name: '历史会话' })).toBeVisible();
    expect(screen.getByRole('button', { name: '恢复会话：当前会话，未读' })).toBeVisible();
    expect(screen.getByText('回复中')).toBeVisible();
    expect(screen.getAllByText('当前会话')).toHaveLength(2);
  });

  it('restores a conversation through the normal chat entry point', async () => {
    const user = userEvent.setup();
    const { props } = renderHistory();

    await user.click(screen.getByRole('button', { name: '恢复会话：旧会话' }));

    expect(props.onRestore).toHaveBeenCalledWith('old');
    expect(screen.getByRole('button', { name: '恢复会话：旧会话' })).toBeDisabled();
  });

  it('reports a restore failure and allows retrying', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderHistory({ onRestore });

    const row = screen.getByRole('button', { name: '恢复会话：旧会话' });
    await user.click(row);
    expect(await screen.findByText('这条会话恢复失败，请稍后重试。')).toBeVisible();
    expect(row).toBeEnabled();

    await user.click(row);
    expect(onRestore).toHaveBeenCalledTimes(2);
  });

  it('recovers when the restore handler rejects', async () => {
    const user = userEvent.setup();
    renderHistory({ onRestore: vi.fn().mockRejectedValue(new Error('restore failed')) });

    await user.click(screen.getByRole('button', { name: '恢复会话：旧会话' }));

    expect(await screen.findByText('这条会话恢复失败，请稍后重试。')).toBeVisible();
    expect(screen.getByRole('button', { name: '恢复会话：旧会话' })).toBeEnabled();
  });

  it('renames a conversation inline and normalizes whitespace', async () => {
    const user = userEvent.setup();
    const { props } = renderHistory();
    await user.click(screen.getByRole('button', { name: '编辑会话标题：旧会话' }));

    const input = screen.getByRole('textbox', { name: '会话标题' });
    await user.clear(input);
    await user.type(input, '  手动   改名  ');
    await user.click(screen.getByRole('button', { name: '保存标题' }));

    await waitFor(() => expect(props.onRename).toHaveBeenCalledWith('old', '手动 改名'));
    expect(screen.queryByRole('textbox', { name: '会话标题' })).not.toBeInTheDocument();
  });

  it('supports escape, cancel, validation, and failed rename states', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn(async () => false);
    renderHistory({ onRename });

    const edit = () => screen.getByRole('button', { name: '编辑会话标题：旧会话' });
    await user.click(edit());
    await user.type(screen.getByRole('textbox', { name: '会话标题' }), '{Escape}');
    expect(screen.queryByRole('textbox', { name: '会话标题' })).not.toBeInTheDocument();

    await user.click(edit());
    await user.click(screen.getByRole('button', { name: '取消编辑标题' }));
    expect(screen.queryByRole('textbox', { name: '会话标题' })).not.toBeInTheDocument();

    await user.click(edit());
    const input = screen.getByRole('textbox', { name: '会话标题' });
    await user.clear(input);
    await user.click(screen.getByRole('button', { name: '保存标题' }));
    expect(await screen.findByText('标题不能为空。')).toBeVisible();

    await user.type(input, '无法保存的标题');
    await user.click(screen.getByRole('button', { name: '保存标题' }));
    expect(await screen.findByText('标题保存失败，请稍后重试。')).toBeVisible();
  });

  it('formats today, yesterday, and older timestamps compactly', () => {
    expect(formatConversationTime(now, now)).toMatch(/12:00/);
    expect(formatConversationTime(now - 86_400_000, now)).toBe('昨天');
    expect(formatConversationTime(now - 3 * 86_400_000, now)).toMatch(/8.*6/);
  });

  it('shows empty and storage-error states', () => {
    const first = renderHistory({ conversations: [], activeConversationId: null });
    expect(screen.getByText('还没有历史会话')).toBeVisible();
    first.unmount();
    renderHistory({ conversations: [], errorMessage: '本地保存失败' });
    expect(screen.getByRole('alert')).toHaveTextContent('本地保存失败');
  });

  it('shows the fallback preview for a conversation without messages', () => {
    renderHistory({
      activeConversationId: null,
      runningConversationId: null,
      chatRunning: false,
      conversations: [conversation({ lastMessagePreview: '', messageCount: 0 })],
    });

    expect(screen.getByText('等待第一条消息')).toBeVisible();
    expect(screen.queryByText('当前会话')).not.toBeInTheDocument();
  });
});
