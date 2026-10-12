import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevDock } from './DevDock';

const ACCESS = {
  apiKey: 'sk-dev-test',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
};

describe('DevDock（DEV 悬浮球）', () => {
  afterEach(() => {
    vi.useRealTimers();
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
});
