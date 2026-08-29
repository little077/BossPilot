import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConversation, ChatMessage } from '@/lib/domain/chat';
import App from './App';

const { sendProviderCommandMock, useAgentPortMock } = vi.hoisted(() => ({
  sendProviderCommandMock: vi.fn(),
  useAgentPortMock: vi.fn(),
}));

vi.mock('./usePort', () => ({
  useAgentPort: useAgentPortMock,
}));

vi.mock('@/lib/providers/client', () => ({
  sendProviderCommand: sendProviderCommandMock,
}));

vi.mock('@/lib/storage/db', () => ({
  loadConversationRuntimeSettings: vi.fn().mockResolvedValue(null),
  saveConversationRuntimeSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./Composer', async () => {
  const React = await import('react');
  return {
    Composer: React.forwardRef<
      { setText: (value: string) => void; focus: () => void },
      {
        className?: string;
        disabled?: boolean;
        running?: boolean;
        tools?: React.ReactNode;
        draft?: { content: { content?: Array<{ content?: Array<{ text?: string }> }> } };
        onDraftChange?: (draft: {
          content: {
            type: string;
            content: Array<{ type: string; content?: Array<{ type: string; text: string }> }>;
          };
          attachments: [];
        }) => void;
        onSend: (value: string, attachments: []) => boolean | Promise<boolean>;
      }
    >(function MockComposer(
      { className, disabled, running, tools, draft, onDraftChange, onSend },
      ref,
    ) {
      const [text, setTextState] = React.useState(
        () => draft?.content.content?.[0]?.content?.map((node) => node.text ?? '').join('') ?? '',
      );
      const setText = (value: string) => {
        setTextState(value);
        onDraftChange?.({
          content: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                ...(value ? { content: [{ type: 'text', text: value }] } : {}),
              },
            ],
          },
          attachments: [],
        });
      };
      React.useImperativeHandle(ref, () => ({ setText, focus: () => undefined }));
      return (
        <div
          className={className}
          data-disabled={disabled ? 'true' : 'false'}
          data-running={running ? 'true' : 'false'}
          data-testid="composer"
        >
          <output data-testid="composer-text">{text}</output>
          <label>
            草稿输入
            <input
              aria-label="草稿输入"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <div className="composer-tools">{tools}</div>
          <button type="button" onClick={() => void onSend(text, [])}>
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

vi.mock('./WorkspaceView', () => ({
  WorkspaceView: () => <div>会话产物内容</div>,
}));

vi.mock('./SettingsView', () => ({
  SettingsView: ({ modelSetupMessage }: { modelSetupMessage?: string }) => (
    <div>
      设置内容
      {modelSetupMessage ? <span>{modelSetupMessage}</span> : null}
    </div>
  ),
}));

const CONFIGURED_PROVIDER_STATE = {
  version: 1 as const,
  activeModel: { providerId: 'openai', modelId: 'gpt-test' },
  connections: [],
};

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
  resolveAskUser: vi.fn(async () => true),
  downloadDiagnostics: vi.fn(),
  startNewConversation: vi.fn(),
  restoreConversation: vi.fn(async () => true),
  setViewedConversationId: vi.fn(),
  renameConversationTitle: vi.fn(),
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  sendProviderCommandMock.mockResolvedValue(CONFIGURED_PROVIDER_STATE);
  useAgentPortMock.mockReturnValue({ ...basePort });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('首页发送过渡', () => {
  it('发送被拒绝时不启动沉底动画，输入框保持在首页', async () => {
    vi.useFakeTimers();
    const sendChat = vi.fn(() => false);
    useAgentPortMock.mockReturnValue({ ...basePort, sendChat });
    render(<App />);

    fireEvent.click(
      screen.getByRole('button', {
        name: '总结一下我当前打开的网页，并列出三个重点',
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '触发发送' }));
      await Promise.resolve();
    });

    expect(sendChat).toHaveBeenCalledOnce();
    expect(screen.getByTestId('composer')).not.toHaveClass('home-composer-launching');
    act(() => vi.advanceTimersByTime(520));
    expect(screen.getByRole('heading', { name: /聊两句/ })).toBeInTheDocument();
  });

  it('发送成功后保留完整沉底动画，再切换到会话输入区', async () => {
    vi.useFakeTimers();
    const sendChat = vi.fn(() => true);
    let portState = { ...basePort, activeConversationId: null as string | null, sendChat };
    useAgentPortMock.mockImplementation(() => portState);
    const view = render(<App />);

    fireEvent.click(
      screen.getByRole('button', {
        name: '总结一下我当前打开的网页，并列出三个重点',
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '触发发送' }));
      await Promise.resolve();
    });
    expect(screen.getByTestId('composer')).toHaveClass('home-composer-launching');

    portState = {
      ...portState,
      activeConversationId: 'conversation-new',
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
    expect(screen.getByTestId('composer-text')).toHaveTextContent(
      '总结一下我当前打开的网页，并列出三个重点',
    );

    act(() => vi.advanceTimersByTime(520));
    expect(screen.queryByRole('heading', { name: /聊两句/ })).not.toBeInTheDocument();
    expect(screen.getByText('总结一下我当前打开的网页，并列出三个重点')).toBeInTheDocument();
  });
});

describe('Ask User 底部暂停面板', () => {
  it('不把问题渲染进消息流，并从底部连体面板提交答案', async () => {
    const user = userEvent.setup();
    const resolveAskUser = vi.fn(async () => true);
    const cancelChat = vi.fn();
    const pendingAssistant: ChatMessage = {
      id: 'assistant-ask',
      role: 'assistant',
      content: '',
      createdAt: 2,
      status: 'streaming',
      pendingUserQuestion: {
        requestId: 'request-ask',
        callId: 'call-ask',
        question: '你更方便哪一天？',
        options: [
          { id: 'option-1', label: '周六' },
          { id: 'option-2', label: '周日' },
        ],
        allowCustom: true,
      },
    };
    useAgentPortMock.mockReturnValue({
      ...basePort,
      messages: [
        { id: 'user-1', role: 'user', content: '帮我找周末活动', createdAt: 1 },
        pendingAssistant,
      ],
      conversations: [
        {
          id: 'conversation-1',
          ordinal: 1,
          title: '历史记录 1',
          titleSource: 'fallback',
          createdAt: 1,
          updatedAt: 2,
          lastMessagePreview: '帮我找周末活动',
          messageCount: 2,
          unread: false,
        },
      ],
      activeConversationId: 'conversation-1',
      runningConversationId: 'conversation-1',
      chatRunning: true,
      resolveAskUser,
      cancelChat,
    });

    render(<App />);
    const question = screen.getByText('你更方便哪一天？');
    expect(question.closest('main')).toBeNull();
    expect(question.closest('.ask-user-shell')).not.toBeNull();
    expect(screen.getByTestId('composer')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByText('任务已暂停 · 等待你的回答')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '取消任务' }));
    expect(cancelChat).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('radio', { name: '周日' }));
    await user.click(screen.getByRole('button', { name: '继续执行' }));
    expect(resolveAskUser).toHaveBeenCalledWith('request-ask', '周日');
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

    await user.click(screen.getByRole('button', { name: '产物' }));
    expect(screen.getByText('会话产物内容').closest('main')).toHaveClass('redscope-view');

    await user.click(screen.getByRole('button', { name: '设置' }));
    const settingsMain = (await screen.findByText('设置内容')).closest('main');
    expect(settingsMain).toHaveClass('redscope-view');
    expect(settingsMain).not.toHaveClass('redscope-home');
    expect(shell).toContainElement(settingsMain);
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
  });

  it('展示对话、历史记录、会话产物和设置，不再展示旧结果与报告入口', () => {
    render(<App />);

    expect(screen.getByRole('button', { name: '对话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '对话' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '历史记录' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '产物' })).toBeInTheDocument();
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

  it('模型正在回复时仍可新建会话，让原任务转入后台', async () => {
    const user = userEvent.setup();
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
      chatRunning: true,
      runningConversationId: 'conversation-1',
      startNewConversation,
    });
    render(<App />);

    const button = await screen.findByRole('button', { name: '新对话' });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(startNewConversation).toHaveBeenCalledOnce();
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
    expect(screen.getByTestId('composer')).toHaveAttribute('data-disabled', 'false');
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

describe('Composer 草稿与模型引导', () => {
  it('未配置模型时直接进入设置，并在返回对话后恢复原草稿', async () => {
    const user = userEvent.setup();
    const sendChat = vi.fn(() => true);
    sendProviderCommandMock.mockResolvedValue({ version: 1, connections: [] });
    useAgentPortMock.mockReturnValue({ ...basePort, sendChat });
    render(<App />);

    await user.click(
      screen.getByRole('button', {
        name: '总结一下我当前打开的网页，并列出三个重点',
      }),
    );
    await user.click(screen.getByRole('button', { name: '触发发送' }));

    expect(await screen.findByText('设置内容')).toBeVisible();
    expect(screen.getByText(/你的输入草稿已保留/)).toBeVisible();
    expect(sendChat).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '对话' }));
    expect(screen.getByTestId('composer-text')).toHaveTextContent(
      '总结一下我当前打开的网页，并列出三个重点',
    );
  });

  it('按会话隔离完整草稿，切换回来时只恢复对应会话内容', async () => {
    const user = userEvent.setup();
    let portState = {
      ...basePort,
      activeConversationId: 'conversation-a' as string | null,
      messages: [{ id: 'a-user', role: 'user' as const, content: '会话 A', createdAt: 1 }],
    };
    useAgentPortMock.mockImplementation(() => portState);
    const view = render(<App />);

    const inputA = await screen.findByRole('textbox', { name: '草稿输入' });
    await user.type(inputA, 'A 的未发送草稿');

    portState = {
      ...portState,
      activeConversationId: 'conversation-b',
      messages: [{ id: 'b-user', role: 'user', content: '会话 B', createdAt: 2 }],
    };
    view.rerender(<App />);
    const inputB = await screen.findByRole('textbox', { name: '草稿输入' });
    expect(inputB).toHaveValue('');
    await user.type(inputB, 'B 的未发送草稿');

    portState = {
      ...portState,
      activeConversationId: 'conversation-a',
      messages: [{ id: 'a-user', role: 'user', content: '会话 A', createdAt: 1 }],
    };
    view.rerender(<App />);
    expect(await screen.findByRole('textbox', { name: '草稿输入' })).toHaveValue('A 的未发送草稿');
  });
});

describe('会话运行偏好（模型选择器）', () => {
  const PROVIDER_STATE = {
    version: 1 as const,
    activeModel: { providerId: 'openai', modelId: 'gpt-test' },
    connections: [
      {
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        hasApiKey: true,
        apiKeyLastFour: '1234',
        models: [
          { id: 'gpt-test', name: 'GPT 测试' },
          { id: 'gpt-pro', name: 'GPT 专业版' },
        ],
        selectedModelId: 'gpt-test',
      },
    ],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('模型选择器嵌入输入框内部工具行，不在输入框外部', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ ok: true, state: PROVIDER_STATE }),
      },
    });
    useAgentPortMock.mockReturnValue({
      ...basePort,
      activeConversationId: 'conversation-running',
      messages: [
        { id: 'user-1', role: 'user', content: '读取当前岗位', createdAt: 1 },
        { id: 'ai-1', role: 'assistant', content: '好的', createdAt: 2 },
      ],
    });
    render(<App />);

    const modelSelect = await screen.findByRole('combobox', { name: '当前会话模型' });
    const thinkingSelect = screen.getByRole('combobox', { name: '思考等级' });

    // 两个选择器位于同一内联容器，且该容器渲染在 Composer 卡片内部（工具行）
    const controlsRow = modelSelect.closest('.conversation-runtime-controls');
    expect(controlsRow).not.toBeNull();
    expect(controlsRow?.contains(thinkingSelect)).toBe(true);
    const composer = modelSelect.closest('[data-testid="composer"]');
    expect(composer).not.toBeNull();
    // 选择器渲染在输入框的工具行容器内（Enter 提示文案已移除）
    const toolsRow = modelSelect.closest('.composer-tools');
    expect(toolsRow).not.toBeNull();
    expect(toolsRow?.contains(controlsRow)).toBe(true);
    // 输入框外部（dock 独立行）不应再有选择器容器
    expect(document.querySelector('.redscope-dock > .conversation-runtime-controls')).toBeNull();
  });

  it('切换模型持久化到会话运行时设置', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ ok: true, state: PROVIDER_STATE }),
      },
    });
    useAgentPortMock.mockReturnValue({
      ...basePort,
      activeConversationId: 'conversation-running',
      messages: [
        { id: 'user-1', role: 'user', content: '读取当前岗位', createdAt: 1 },
        { id: 'ai-1', role: 'assistant', content: '好的', createdAt: 2 },
      ],
    });
    render(<App />);

    const modelSelect = await screen.findByRole('combobox', { name: '当前会话模型' });
    expect(modelSelect).toHaveTextContent('openai / GPT 测试');

    // 打开下拉后切换到另一模型（Radix Select 在 jsdom 中键盘路径最可靠）：
    // 当前项 gpt-test 高亮，ArrowDown 移到 gpt-pro，Enter 确认选中。
    await user.click(modelSelect);
    await screen.findByRole('option', { name: 'openai / GPT 专业版' });
    await user.keyboard('{ArrowDown}{Enter}');

    const { saveConversationRuntimeSettings } = await import('@/lib/storage/db');
    expect(saveConversationRuntimeSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-running',
        modelIdentity: expect.objectContaining({ providerId: 'openai', modelId: 'gpt-pro' }),
      }),
    );
  });
});
