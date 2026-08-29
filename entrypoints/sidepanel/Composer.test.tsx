import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillCatalogEntry } from '@/lib/skills/types';
import { Composer, type ComposerHandle, formatVoiceTime } from './Composer';
import { TooltipProvider } from './ui/Tooltip';

const SKILLS: SkillCatalogEntry[] = [
  {
    name: 'resume-analyzer',
    description: '分析简历与 JD 匹配度',
    version: '1.0.0',
    builtIn: true,
    enabled: true,
    capabilities: [],
    fileCount: 1,
  },
];

const { sendSkillCommandMock } = vi.hoisted(() => ({
  sendSkillCommandMock: vi.fn(),
}));

vi.mock('@/lib/skills/client', () => ({
  sendSkillCommand: sendSkillCommandMock,
}));

interface FakeResultEvent {
  resultIndex: number;
  results: Array<{ isFinal: boolean; 0: { transcript: string } }>;
}

/** 可控假 SpeechRecognition：实例经 start 时收集，行为由静态开关控制。 */
class FakeRecognition {
  lang = '';
  interimResults = false;
  continuous = false;
  processLocally = false;
  onresult: ((event: FakeResultEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => {
    if (FakeRecognition.startError) throw FakeRecognition.startError;
    FakeRecognition.instances.push(this);
  });
  stop = vi.fn();
  abort = vi.fn();

  static instances: FakeRecognition[] = [];
  static startError: Error | null = null;
  static available: ((opts: unknown) => Promise<unknown>) | null = null;
  static install: ((opts: unknown) => Promise<unknown>) | null = null;

  static reset() {
    FakeRecognition.instances = [];
    FakeRecognition.startError = null;
    FakeRecognition.available = null;
    FakeRecognition.install = null;
  }
}

const fakeInstance = () => {
  const inst = FakeRecognition.instances[0];
  if (!inst) throw new Error('expected a SpeechRecognition instance');
  return inst;
};

function emitResult(inst: FakeRecognition, transcript: string, isFinal: boolean) {
  act(() => {
    inst.onresult?.({
      resultIndex: 0,
      results: [{ isFinal, 0: { transcript } }],
    });
  });
}

async function renderComposer() {
  render(
    <TooltipProvider>
      <Composer onSend={vi.fn().mockResolvedValue(true)} />
    </TooltipProvider>,
  );
  return screen.findByRole('textbox');
}

/** 点击语音按钮并等待授权探测 + 识别会话启动链完成。 */
async function startVoice() {
  fireEvent.click(screen.getByRole('button', { name: '语音输入' }));
  await act(async () => {});
}

beforeEach(() => {
  sendSkillCommandMock.mockReset().mockResolvedValue({
    version: 2,
    skills: SKILLS,
    grants: [],
  });
  FakeRecognition.reset();
  // 默认：麦克风已授权（直接进入识别），权限查询可被单个测试覆盖。
  // 用 defineProperty 而非替换整个 navigator：tiptap 依赖 navigator.platform 等属性。
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: vi.fn().mockResolvedValue({ state: 'granted' }) },
  });
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      i18n: { getUILanguage: () => 'zh-CN' },
    },
    tabs: { create: vi.fn() },
  });
  vi.stubGlobal('SpeechRecognition', FakeRecognition);
  vi.stubGlobal('webkitSpeechRecognition', undefined);
  // prosemirror-view 依赖的布局 API 在 jsdom 下缺失，补桩避免选区定位崩溃
  // （scrollToSelection → coordsAtPos 会对 textRange 创建的 Range 调用 getClientRects）
  document.elementFromPoint = () => null;
  Object.defineProperty(Text.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0 }),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Composer 技能引用', () => {
  it('已有输入时选择技能：内容保留，技能节点插入光标处', async () => {
    render(
      <TooltipProvider>
        <Composer onSend={vi.fn().mockResolvedValue(true)} />
      </TooltipProvider>,
    );
    const editor = await screen.findByRole('textbox');
    // 等待技能列表加载完成（斜杠检测依赖 slashSkillsRef 已填充）
    await waitFor(() => expect(sendSkillCommandMock).toHaveBeenCalled());

    await userEvent.type(editor, '帮我看看这篇笔记');
    fireEvent.click(screen.getByRole('combobox', { name: '选择技能' }));
    fireEvent.click(screen.getByRole('option', { name: /resume-analyzer/ }));

    await waitFor(() => {
      expect(editor.textContent).toContain('帮我看看这篇笔记');
      expect(editor.textContent).toContain('resume-analyzer');
    });
    // 技能引用是结构化 inline 节点而非纯文本
    expect(editor.querySelector('[data-type="skill-reference"]')).not.toBeNull();
  });

  it('斜杠触发选择技能：斜杠词被替换为节点，不残留游离文本', async () => {
    const ref = createRef<ComposerHandle>();
    render(
      <TooltipProvider>
        <Composer ref={ref} onSend={vi.fn().mockResolvedValue(true)} />
      </TooltipProvider>,
    );
    const editor = await screen.findByRole('textbox');
    await waitFor(() => expect(sendSkillCommandMock).toHaveBeenCalled());
    // 全量测试负载下 userEvent.type 逐字符输入会丢事件（编辑器只能收到部分字符），
    // 改用 ref handle 一次性写入：单事务、确定性强，同样会触发 onUpdate 斜杠检测。
    act(() => ref.current?.setText('/resume'));
    // 斜杠触发技能菜单自动打开（高亮会向 accessible name 插入匹配词，按文本内容断言）
    const option = await screen.findByRole('option');
    expect(option.textContent).toContain('resume-analyzer');
    fireEvent.click(option);

    await waitFor(() => {
      expect(editor.querySelector('[data-type="skill-reference"]')).not.toBeNull();
      expect(editor.textContent).toContain('resume-analyzer');
    });
  });
});

describe('formatVoiceTime', () => {
  it('0 秒显示 00:00', () => {
    expect(formatVoiceTime(0)).toBe('00:00');
  });

  it('65 秒显示 01:05', () => {
    expect(formatVoiceTime(65)).toBe('01:05');
  });

  it('600 秒显示 10:00', () => {
    expect(formatVoiceTime(600)).toBe('10:00');
  });
});

describe('Composer 语音输入（sidepanel 直连）', () => {
  it('授权已授予：点击后直接启动识别会话，显示提示条与计时', async () => {
    await renderComposer();
    await startVoice();

    expect(FakeRecognition.instances).toHaveLength(1);
    expect(screen.getByText('正在输入语音…')).toBeInTheDocument();
    expect(screen.getByText('00:00')).toBeInTheDocument();
    expect(screen.getByRole('status').className).not.toContain('is-paused');
  });

  it('中间结果实时上屏，新帧替换旧帧', async () => {
    const editor = await renderComposer();
    await startVoice();
    const inst = fakeInstance();

    emitResult(inst, '帮我', false);
    await act(async () => {});
    expect(editor.textContent).toBe('帮我');

    emitResult(inst, '帮我查一下', false);
    await act(async () => {});
    expect(editor.textContent).toBe('帮我查一下');
  });

  it('已有输入时：语音文本追加到末尾（CJK 边界不插空格）', async () => {
    const editor = await renderComposer();
    await userEvent.type(editor, '先写的内容');
    await startVoice();
    const inst = fakeInstance();

    emitResult(inst, '语音补充', false);
    await act(async () => {});
    expect(editor.textContent).toBe('先写的内容语音补充');
  });

  it('final 定稿替换未定稿后缀，后续 interim 继续追加', async () => {
    const editor = await renderComposer();
    await startVoice();
    const inst = fakeInstance();

    emitResult(inst, '帮我查', false);
    await act(async () => {});
    expect(editor.textContent).toBe('帮我查');

    emitResult(inst, '帮我查一下今天的天气', true);
    await act(async () => {});
    expect(editor.textContent).toBe('帮我查一下今天的天气');

    emitResult(inst, '谢谢', false);
    await act(async () => {});
    expect(editor.textContent).toBe('帮我查一下今天的天气谢谢');
  });

  it('两轮语音会话：上一轮残留的未定稿文本不再被下一轮剥除（追加不覆盖）', async () => {
    const editor = await renderComposer();
    await startVoice();
    // 第一轮：只有 interim（未 final）就点停止——文本已上屏，但会话结束时
    // 未定稿后缀必须作废，否则下一轮会把它误当后缀剥除（用户反馈的「覆盖」）。
    emitResult(fakeInstance(), '帮我查一下', false);
    await act(async () => {});
    expect(editor.textContent).toBe('帮我查一下');
    fireEvent.click(screen.getByRole('button', { name: '结束语音输入' }));

    // 第二轮：新会话，识别文本应追加在已有内容之后
    await startVoice();
    const second = FakeRecognition.instances[1];
    expect(second).toBeDefined();
    if (!second) throw new Error('expected a second SpeechRecognition instance');
    emitResult(second, '今天天气', false);
    await act(async () => {});
    expect(editor.textContent).toBe('帮我查一下今天天气');
  });

  it('语音识别期间占位符文案被置空（防与 voice-hint 浮层重叠），结束后空文档恢复', async () => {
    const editor = await renderComposer();
    await startVoice();
    // 识别中：占位符装饰已按空文案重算——data-placeholder 为空串，
    // 伪元素 content: attr(data-placeholder) 渲染空内容，不再显示旧文案
    const p = editor.querySelector('p');
    expect(p?.getAttribute('data-placeholder')).toBe('');

    // 未说话直接结束：文档仍空，占位符按正常文案恢复
    fireEvent.click(screen.getByRole('button', { name: '结束语音输入' }));
    await act(async () => {});
    expect(p?.getAttribute('data-placeholder')).toContain('输入消息');
  });

  it('聆听计时每秒递增（00:03）', async () => {
    // 把授权查询挂起，让识别启动链推迟到 fake timers 就绪后再完成——
    // 否则 interval 在真实时钟下注册，切换 fake timers 后不再被推进。
    let resolveQuery!: (value: PermissionStatus) => void;
    vi.mocked(navigator.permissions.query).mockImplementation(
      () => new Promise<PermissionStatus>((resolve) => (resolveQuery = resolve)),
    );
    await renderComposer();
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }));
    await act(async () => {});

    vi.useFakeTimers();
    act(() => resolveQuery({ state: 'granted' } as PermissionStatus));
    await act(async () => {});
    expect(FakeRecognition.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByText('00:03')).toBeInTheDocument();
  });

  it('聆听中再次点击：停止会话并复位按钮', async () => {
    await renderComposer();
    await startVoice();
    const inst = fakeInstance();

    fireEvent.click(screen.getByRole('button', { name: '结束语音输入' }));
    expect(inst.stop).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '结束语音输入' })).not.toBeInTheDocument();
    expect(screen.queryByText('正在输入语音…')).not.toBeInTheDocument();
  });

  it('麦克风未授权（prompt）：打开授权跳板页、展示引导、不启动识别', async () => {
    vi.mocked(navigator.permissions.query).mockResolvedValue({
      state: 'prompt',
    } as PermissionStatus);
    await renderComposer();
    await startVoice();

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test/user-permission.html?type=microphone',
    });
    expect(screen.getByText('需要麦克风授权，请在弹出的页面中允许')).toBeInTheDocument();
    expect(FakeRecognition.instances).toHaveLength(0);
    expect(screen.getByRole('status').className).toContain('is-paused');

    // 点击提示条关闭引导
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }));
    expect(screen.queryByText('需要麦克风授权，请在弹出的页面中允许')).not.toBeInTheDocument();
  });

  it('麦克风被拒绝（denied）：打开系统麦克风设置页', async () => {
    vi.mocked(navigator.permissions.query).mockResolvedValue({
      state: 'denied',
    } as PermissionStatus);
    await renderComposer();
    await startVoice();

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome://settings/content/microphone',
    });
    expect(screen.getByText('麦克风权限被拒绝，请在设置中允许 BossPilot')).toBeInTheDocument();
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it('识别错误：展示错误文案并可点击关闭', async () => {
    await renderComposer();
    await startVoice();
    const inst = fakeInstance();

    act(() => inst.onerror?.({ error: 'network' }));
    await act(async () => {});
    expect(screen.getByText('语音识别服务网络不可用')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }));
    expect(screen.queryByText('语音识别服务网络不可用')).not.toBeInTheDocument();
  });

  it('识别途中授权失效（not-allowed）：引导重新授权', async () => {
    await renderComposer();
    await startVoice();
    const inst = fakeInstance();

    act(() => inst.onerror?.({ error: 'not-allowed' }));
    await act(async () => {});
    expect(screen.getByText('麦克风授权未通过，请允许后重试')).toBeInTheDocument();
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test/user-permission.html?type=microphone',
    });
  });

  it('语言包下载中：显示准备提示，装好后自动进入聆听', async () => {
    let resolveInstall!: (value: boolean) => void;
    FakeRecognition.available = vi
      .fn()
      .mockResolvedValueOnce('downloadable')
      .mockResolvedValueOnce('available');
    FakeRecognition.install = vi.fn(
      () => new Promise<boolean>((resolve) => (resolveInstall = resolve)),
    );

    await renderComposer();
    await startVoice();
    expect(screen.getByText('正在准备语音识别…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消语音输入' })).toBeInTheDocument();

    act(() => resolveInstall(true));
    await act(async () => {});
    expect(screen.getByText('正在输入语音…')).toBeInTheDocument();
  });

  it('识别期间 composer-card 进入 is-voicing 态（隐藏占位符防重叠），结束后恢复', async () => {
    const editor = await renderComposer();
    const card = editor.closest('.composer-card');
    expect(card?.className).not.toContain('is-voicing');

    await startVoice();
    expect(card?.className).toContain('is-voicing');

    fireEvent.click(screen.getByRole('button', { name: '结束语音输入' }));
    expect(card?.className).not.toContain('is-voicing');
  });

  it('浏览器不支持语音识别：隐藏语音按钮', async () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    await renderComposer();
    expect(screen.queryByRole('button', { name: '语音输入' })).not.toBeInTheDocument();
  });
});
