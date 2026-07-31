import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
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
      { className?: string; onSend: (value: string) => void }
    >(function MockComposer({ className, onSend }, ref) {
      const [text, setText] = React.useState('');
      React.useImperativeHandle(ref, () => ({ setText }));
      return (
        <div className={className} data-testid="composer">
          <output data-testid="composer-text">{text}</output>
          <button type="button" onClick={() => onSend(text)}>
            触发发送
          </button>
        </div>
      );
    }),
  };
});

vi.mock('./JobList', () => ({
  JobList: () => <div>岗位结果</div>,
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
  chatRunning: false,
  ready: true,
  connected: true,
  send: vi.fn(),
  sendChat: vi.fn(),
  cancelChat: vi.fn(),
  downloadDiagnostics: vi.fn(),
  clearChat: vi.fn(),
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
        name: '西安的前端行情怎么样？15K 现实吗？',
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
        name: '西安的前端行情怎么样？15K 现实吗？',
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
          content: '西安的前端行情怎么样？15K 现实吗？',
          createdAt: 1,
        },
      ],
    };
    view.rerender(<App />);
    expect(screen.getByTestId('composer')).toHaveClass('home-composer-launching');

    act(() => vi.advanceTimersByTime(520));
    expect(screen.queryByRole('heading', { name: /聊两句/ })).not.toBeInTheDocument();
    expect(screen.getByText('西安的前端行情怎么样？15K 现实吗？')).toBeInTheDocument();
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
      name: '西安的前端行情怎么样？15K 现实吗？',
    });
    await user.click(example);
    expect(screen.getByTestId('composer-text')).toHaveTextContent(
      '西安的前端行情怎么样？15K 现实吗？',
    );

    await user.click(screen.getByRole('button', { name: '结果' }));
    expect(screen.getByText('岗位结果').closest('main')).toHaveClass('redscope-view');

    await user.click(screen.getByRole('button', { name: '设置' }));
    const settingsMain = (await screen.findByText('设置内容')).closest('main');
    expect(settingsMain).toHaveClass('redscope-view');
    expect(settingsMain).not.toHaveClass('redscope-home');
    expect(shell).toContainElement(settingsMain);
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
  });

  it('只展示对话、结果和设置，不再展示报告入口', () => {
    render(<App />);

    expect(screen.getByRole('button', { name: '对话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '对话' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '结果' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '报告' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新对话' })).not.toBeInTheDocument();
  });

  it('把新对话作为顶栏全局操作，并返回新的首页会话', async () => {
    const clearChat = vi.fn();
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
      clearChat,
    });
    const user = userEvent.setup();
    render(<App />);

    const newChat = await screen.findByRole('button', { name: '新对话' });
    expect(newChat.closest('header')).not.toBeNull();

    await user.click(newChat);

    expect(clearChat).toHaveBeenCalledOnce();
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
