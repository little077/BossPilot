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
    Composer: React.forwardRef(function MockComposer() {
      return <div data-testid="composer" />;
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
