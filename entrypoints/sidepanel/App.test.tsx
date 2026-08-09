import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConversation, ChatMessage } from '@/lib/domain/chat';
import App from './App';

const { useAgentPortMock } = vi.hoisted(() => ({
  useAgentPortMock: vi.fn(),
}));

vi.mock('./usePort', () => ({
  useAgentPort: useAgentPortMock,
}));

vi.mock('./Composer', async () => {
  const React = await import('react');
  return {
    Composer: React.forwardRef<
      { setText: (value: string) => void },
      { className?: string; disabled?: boolean; running?: boolean; onSend: (value: string) => void }
    >(function MockComposer({ className, disabled, running, onSend }, ref) {
      const [text, setText] = React.useState('');
      React.useImperativeHandle(ref, () => ({ setText }));
      return (
        <div
          className={className}
          data-disabled={disabled ? 'true' : 'false'}
          data-running={running ? 'true' : 'false'}
          data-testid="composer"
        >
          <output data-testid="composer-text">{text}</output>
          <button type="button" onClick={() => onSend(text)}>
            触发发送
          </button>
        </div>
      );
    }),
  };
});

vi.mock('./HistoryView', () => ({
  HistoryView: ({ onRestore }: { onRestore: (conversationId: string) => Promise<boolean> }) => (
    <div>
      历史记录列表
      <button type="button" onClick={() => void onRestore('conversation-old')}>
        恢复旧会话
      </button>
    </div>
  ),
}));

vi.mock('./SettingsView', () => ({
  SettingsView: () => <div>设置内容</div>,
}));

const basePort = {
  snapshot: {
    taskId: '',
    phase: 'idle' as const,
    statusText: '',
    collected: 0,
    assessed: 0,
    jobs: [],
  },
  messages: [] as ChatMessage[],
  conversations: [] as ChatConversation[],
  activeConversationId: null,
  runningConversationId: null,
  historyError: '',
  chatRunning: false,
  ready: true,
  connected: true,
  send: vi.fn(),
  sendChat: vi.fn(),
  cancelChat: vi.fn(),
  resolvePagePermission: vi.fn(),
  downloadDiagnostics: vi.fn(),
  startNewConversation: vi.fn(),
  restoreConversation: vi.fn(async () => true),
  setViewedConversationId: vi.fn(),
  renameConversationTitle: vi.fn(),
};

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  useAgentPortMock.mockReturnValue({ ...basePort });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('首页发送过渡', () => {
  it('发送被拒绝时不启动沉底动画，输入框保持在首页', () => {
    vi.useFakeTimers();
    const sendChat = vi.fn(() => false);
    useAgentPortMock.mockReturnValue({ ...basePort, sendChat });
    render(<App />);

    fireEvent.click(
      screen.getByRole('button', {
        name: '总结一下我当前打开的网页，并列出三个重点',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '触发发送' }));

    expect(sendChat).toHaveBeenCalledOnce();
    expect(screen.getByTestId('composer')).not.toHaveClass('home-composer-launching');
    act(() => vi.advanceTimersByTime(520));
    expect(screen.getByRole('heading', { name: /聊两句/ })).toBeInTheDocument();
  });

  it('发送成功后保留完整沉底动画，再切换到会话输入区', () => {
    vi.useFakeTimers();
    const sendChat = vi.fn(() => true);
    let portState = { ...basePort, sendChat };
    useAgentPortMock.mockImplementation(() => portState);
    const view = render(<App />);

    fireEvent.click(
      screen.getByRole('button', {
        name: '总结一下我当前打开的网页，并列出三个重点',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '触发发送' }));
    expect(screen.getByTestId('composer')).toHaveClass('home-composer-launching');

    portState = {
      ...portState,
      messages: [
        {
          id: 'optimistic-user',
          role: 'user',
          content: '总结一下我当前打开的网页，并列出三个重点',
          createdAt: 1,
        },
      ],
    };
    view.rerender(<App />);
    expect(screen.getByTestId('composer')).toHaveClass('home-composer-launching');

    act(() => vi.advanceTimersByTime(520));
    expect(screen.queryByRole('heading', { name: /聊两句/ })).not.toBeInTheDocument();
    expect(screen.getByText('总结一下我当前打开的网页，并列出三个重点')).toBeInTheDocument();
  });
});

describe('顶部导航', () => {
  it('整个应用统一使用 RedScope 主题，并保留原导航与首页交互', async () => {
    const user = userEvent.setup();
    render(<App />);

    const shell = screen.getByTestId('app-shell');
    expect(shell).toHaveClass('redscope-app');
    expect(screen.getByRole('banner')).toHaveClass('redscope-topbar');
    expect(shell).toContainElement(screen.getByRole('banner'));

    const home = screen.getByRole('main');
    expect(home).toHaveClass('redscope-view', 'redscope-home');
    expect(screen.getByTestId('composer')).toHaveClass('redscope-home-composer');
    expect(screen.queryByRole('button', { name: '报告' })).not.toBeInTheDocument();

    const example = screen.getByRole('button', {
      name: '总结一下我当前打开的网页，并列出三个重点',
    });
    await user.click(example);
    expect(screen.getByTestId('composer-text')).toHaveTextContent(
      '总结一下我当前打开的网页，并列出三个重点',
    );

    await user.click(screen.getByRole('button', { name: '历史记录' }));
    expect(screen.getByText('历史记录列表').closest('main')).toHaveClass('redscope-view');

    await user.click(screen.getByRole('button', { name: '设置' }));
    const settingsMain = (await screen.findByText('设置内容')).closest('main');
    expect(settingsMain).toHaveClass('redscope-view');
    expect(settingsMain).not.toHaveClass('redscope-home');
    expect(shell).toContainElement(settingsMain);
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
  });

  it('只展示对话、历史记录和设置，不再展示旧结果与报告入口', () => {
    render(<App />);

    expect(screen.getByRole('button', { name: '对话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '对话' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '历史记录' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '结果' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '报告' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新对话' })).not.toBeInTheDocument();
  });

  it('从历史列表恢复后回到标准对话流，而不是打开只读详情', async () => {
    const user = userEvent.setup();
    const restoreConversation = vi.fn(async () => true);
    useAgentPortMock.mockReturnValue({
      ...basePort,
      activeConversationId: 'conversation-old',
      messages: [
        { id: 'old-user', role: 'user', content: '以前的问题', createdAt: 1 },
        { id: 'old-assistant', role: 'assistant', content: '以前的回答', createdAt: 2 },
      ],
      restoreConversation,
    });
    render(<App />);

    await user.click(screen.getByRole('button', { name: '历史记录' }));
    await user.click(screen.getByRole('button', { name: '恢复旧会话' }));

    expect(restoreConversation).toHaveBeenCalledWith('conversation-old');
    expect(await screen.findByText('以前的问题')).toBeVisible();
    expect(screen.getByText('以前的回答')).toBeVisible();
    expect(screen.queryByText('历史记录列表')).not.toBeInTheDocument();
    expect(screen.getByTestId('composer')).toBeVisible();
  });

  it('把新对话作为顶栏全局操作，并返回新的首页会话', async () => {
    const startNewConversation = vi.fn();
    useAgentPortMock.mockReturnValue({
      ...basePort,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: '已有消息',
          createdAt: 1,
        },
      ],
      startNewConversation,
    });
    const user = userEvent.setup();
    render(<App />);

    const newChat = await screen.findByRole('button', { name: '新对话' });
    expect(newChat.closest('header')).not.toBeNull();

    await user.click(newChat);

    expect(startNewConversation).toHaveBeenCalledOnce();
    expect(screen.getByText(/聊两句/)).toBeInTheDocument();
  });

  it('模型正在回复时禁用新对话，避免误清空会话', async () => {
    useAgentPortMock.mockReturnValue({
      ...basePort,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: '已有消息',
          createdAt: 1,
        },
      ],
      chatRunning: true,
    });
    render(<App />);

    expect(await screen.findByRole('button', { name: '新对话' })).toBeDisabled();
  });

  it('查看另一条会话时让后台回复继续，并可一键切回运行会话', async () => {
    const user = userEvent.setup();
    const restoreConversation = vi.fn(async () => true);
    useAgentPortMock.mockReturnValue({
      ...basePort,
      activeConversationId: 'conversation-restored',
      runningConversationId: 'conversation-running',
      chatRunning: true,
      messages: [{ id: 'restored-user', role: 'user', content: '当前查看的旧会话', createdAt: 1 }],
      restoreConversation,
    });
    render(<App />);

    expect(screen.getByText('另一条会话正在后台回复，完成后可继续本对话')).toBeVisible();
    expect(screen.getByTestId('composer')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('composer')).toHaveAttribute('data-running', 'false');

    await user.click(screen.getByRole('button', { name: '查看正在回复的会话' }));
    expect(restoreConversation).toHaveBeenCalledWith('conversation-running');
  });

  it('会话工具栏下载包含当前页面结构的诊断日志', async () => {
    const downloadDiagnostics = vi.fn();
    useAgentPortMock.mockReturnValue({
      ...basePort,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: '读取当前岗位',
          createdAt: 1,
        },
      ],
      downloadDiagnostics,
    });
    const user = userEvent.setup();
    render(<App />);

    const button = await screen.findByRole('button', { name: '下载诊断日志' });
    expect(button).toHaveAttribute('title', '导出执行日志和当前 Boss 页面 DOM 结构（已限量脱敏）');
    await user.click(button);

    expect(downloadDiagnostics).toHaveBeenCalledOnce();
  });
});
