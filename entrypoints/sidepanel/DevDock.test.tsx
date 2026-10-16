import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnTrace } from '@/lib/diagnostics/trace';
import { DevDock } from './DevDock';

const ACCESS = {
  apiKey: 'sk-dev-test',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
};

const TRACE: TurnTrace = {
  id: 'chat-1',
  createdAt: 5,
  endReason: 'completed',
  turns: 3,
  totalMs: 900,
  tokens: 'unreported',
  failedSteps: 0,
  steps: [{ index: 0, kind: 'generation', ms: 300, status: 'ok' }],
};

/**
 * jsdom 无对象 URL 且锚点点击会触发导航告警：桩掉 createObjectURL/revokeObjectURL，
 * 并拦截锚点 click 以捕获被下载的 <a>，从而断言文件名与 blob 来源。
 * 正文内容由 buildTraceExport 的纯函数单测覆盖，这里不再重复断言。
 */
function mockDownload() {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock');
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

  let anchor: HTMLAnchorElement | undefined;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    anchor = this;
  });

  return {
    createObjectURL,
    revokeObjectURL,
    getAnchor: () => anchor,
  };
}

describe('DevDock（DEV 可拖动悬浮球）', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('点击经 onApply 应用 .env 配置并提示成功', async () => {
    const onApply = vi.fn(() => true);
    const onApplied = vi.fn();
    render(<DevDock access={ACCESS} onApply={onApply} onApplied={onApplied} />);

    await userEvent.click(screen.getByRole('button', { name: '应用 .env 调试配置' }));

    expect(onApply).toHaveBeenCalledWith(ACCESS);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('已应用 deepseek-flash');
  });

  it('未配置 .env 密钥时提示补配置且不调用 onApply', async () => {
    const onApply = vi.fn(() => true);
    render(<DevDock access={null} onApply={onApply} />);

    await userEvent.click(screen.getByRole('button', { name: '应用 .env 调试配置' }));

    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('WXT_DEV_API_KEY');
  });

  it('后台未连接（onApply 返回 false）时提示稍后重试', async () => {
    const onApply = vi.fn(() => false);
    render(<DevDock access={ACCESS} onApply={onApply} />);

    await userEvent.click(screen.getByRole('button', { name: '应用 .env 调试配置' }));

    expect(screen.getByRole('status')).toHaveTextContent('稍后重试');
  });

  it('反馈气泡短暂展示后自动消失', async () => {
    vi.useFakeTimers();
    render(<DevDock access={ACCESS} onApply={vi.fn(() => true)} />);

    // fake timers 下 userEvent 会死等内部调度，改用同步派发的 fireEvent。
    fireEvent.click(screen.getByRole('button', { name: '应用 .env 调试配置' }));
    expect(screen.getByRole('status')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('拖拽手柄支持键盘移动：方向键改变 left/top，Home 归位', () => {
    const { getByTestId } = render(<DevDock access={ACCESS} onApply={vi.fn(() => true)} />);
    const dock = getByTestId('dev-dock');
    const grip = getByTestId('dev-dock-grip');

    const before = dock.style.left;
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    expect(dock.style.left).not.toBe(before);

    fireEvent.keyDown(grip, { key: 'Home' });
    expect(dock.style.left).toBe(before);
  });

  it('下载轨迹：getTrace 返回轨迹时打包成 Markdown 触发下载并提示轮数', async () => {
    const dl = mockDownload();
    const getTrace = vi.fn(async () => TRACE);
    render(<DevDock access={ACCESS} onApply={vi.fn(() => true)} getTrace={getTrace} />);

    await userEvent.click(screen.getByRole('button', { name: '下载最近一轮轨迹' }));

    expect(getTrace).toHaveBeenCalledTimes(1);
    expect(dl.createObjectURL).toHaveBeenCalledTimes(1);
    expect(dl.revokeObjectURL).toHaveBeenCalledTimes(1);
    const anchor = dl.getAnchor();
    expect(anchor?.download).toBe('bosspilot-trace-chat-1.md');
    expect(anchor?.href).toBe('blob:mock');
    expect(dl.createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(screen.getByRole('status')).toHaveTextContent('已下载 3 轮轨迹');
  });

  it('下载轨迹：无轨迹（getTrace 返回 null）时提示暂无且不建 URL', async () => {
    const dl = mockDownload();
    render(<DevDock access={ACCESS} onApply={vi.fn(() => true)} getTrace={async () => null} />);

    await userEvent.click(screen.getByRole('button', { name: '下载最近一轮轨迹' }));

    expect(dl.createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('暂无可下载轨迹');
  });

  it('下载轨迹：未提供 getTrace（后台未连接）时提示且不建 URL', async () => {
    const dl = mockDownload();
    render(<DevDock access={ACCESS} onApply={vi.fn(() => true)} />);

    await userEvent.click(screen.getByRole('button', { name: '下载最近一轮轨迹' }));

    expect(dl.createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('无法取轨迹');
  });
});
