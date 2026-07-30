import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    Composer: React.forwardRef<{ setText: (value: string) => void }, { className?: string }>(
      function MockComposer({ className }, ref) {
        const [text, setText] = React.useState('');
        React.useImperativeHandle(ref, () => ({ setText }));
        return (
          <div className={className} data-testid="composer">
            <output data-testid="composer-text">{text}</output>
          </div>
        );
      },
    ),
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
  messages: [],
  chatRunning: false,
  ready: true,
  send: vi.fn(),
  sendChat: vi.fn(),
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
});
