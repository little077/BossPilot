import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import { MessageActions } from './MessageActions';
import { TooltipProvider } from './ui/Tooltip';

function message(content: string): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content,
    createdAt: Date.now(),
    status: 'completed',
  };
}

let clipboardWriteMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  clipboardWriteMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWriteMock },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function renderActions(content = '这是一段回答', onRegenerate?: () => boolean) {
  return render(
    <TooltipProvider>
      <MessageActions message={message(content)} {...(onRegenerate ? { onRegenerate } : {})} />
    </TooltipProvider>,
  );
}

describe('MessageActions 复制', () => {
  it('点击复制文案并进入成功态，1.6s 后恢复', async () => {
    renderActions('复制我');
    fireEvent.click(screen.getByRole('button', { name: '复制回答' }));

    // fake timers 下 waitFor 不会自动推进，这里直接 flush 剪贴板 promise 的微任务
    await act(async () => {});
    expect(clipboardWriteMock).toHaveBeenCalledWith('复制我');
    expect(screen.getByRole('button', { name: '复制回答' }).className).toContain('is-copied');
    // chip 常驻 DOM，仅通过 opacity 切换显隐（对照设计稿）
    expect(screen.getByText('已复制').className).toContain('opacity-100');

    act(() => vi.advanceTimersByTime(1_600));
    expect(screen.getByRole('button', { name: '复制回答' }).className).not.toContain('is-copied');
    expect(screen.getByText('已复制').className).toContain('opacity-0');
  });

  it('剪贴板不可用时保持默认态', async () => {
    clipboardWriteMock.mockRejectedValueOnce(new Error('denied'));
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: '复制回答' }));
    await act(async () => {});
    expect(clipboardWriteMock).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '复制回答' }).className).not.toContain('is-copied');
    expect(screen.getByText('已复制').className).toContain('opacity-0');
  });
});

describe('MessageActions 重新生成', () => {
  it('点击触发重新生成，图标旋转 600ms 后恢复', () => {
    const onRegenerate = vi.fn(() => true);
    renderActions('重新来', onRegenerate);
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }));

    expect(onRegenerate).toHaveBeenCalledTimes(1);
    const button = screen.getByRole('button', { name: '重新生成' });
    expect(button.className).toContain('is-retrying');

    act(() => vi.advanceTimersByTime(600));
    expect(button.className).not.toContain('is-retrying');
  });

  it('旋转期间重复点击只触发一次', () => {
    const onRegenerate = vi.fn(() => true);
    renderActions('重新来', onRegenerate);
    const button = screen.getByRole('button', { name: '重新生成' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it('操作未被运行时接受时不播放假成功动画', () => {
    const onRegenerate = vi.fn(() => false);
    renderActions('暂时不能重试', onRegenerate);
    const button = screen.getByRole('button', { name: '重新生成' });

    fireEvent.click(button);

    expect(onRegenerate).toHaveBeenCalledTimes(1);
    expect(button.className).not.toContain('is-retrying');
  });

  it('没有可执行回调时只保留复制操作', () => {
    renderActions('历史回答', undefined);

    expect(screen.getByRole('button', { name: '复制回答' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument();
  });
});
