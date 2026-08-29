import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ToolActivity } from '@/lib/domain/types';
import { PagePermissionPanel } from './PagePermissionPanel';

function activity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    requestId: 'request-1',
    callId: 'call-1',
    name: 'read_current_page',
    label: '读取当前页面',
    status: 'waiting_permission',
    statusText: '等待网站读取权限',
    startedAt: 1_000,
    sourceOrigin: 'https://example.com',
    permissionPattern: 'https://example.com/*',
    ...overrides,
  };
}

describe('PagePermissionPanel', () => {
  it('显示站点来源，转发用户的允许决定', async () => {
    const onResolve = vi.fn().mockResolvedValue(true);
    render(<PagePermissionPanel activity={activity()} onResolve={onResolve} onCancel={vi.fn()} />);

    expect(screen.getByText('https://example.com')).toBeVisible();
    expect(screen.getByText(/允许后可读取这个网站的可见纯文本/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '允许读取' }));
    await waitFor(() =>
      expect(onResolve).toHaveBeenCalledWith('request-1', 'https://example.com/*', true),
    );
  });

  it('连接不可用时显示可重试错误', async () => {
    const onResolve = vi.fn().mockResolvedValue(false);
    render(<PagePermissionPanel activity={activity()} onResolve={onResolve} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '不允许' }));
    expect(await screen.findByText('侧边栏连接不可用，请稍后重试。')).toBeVisible();
    expect(onResolve).toHaveBeenCalledWith('request-1', 'https://example.com/*', false);
  });

  it('区分页面操作权限与只读权限', async () => {
    const onResolve = vi.fn().mockResolvedValue(true);
    render(
      <PagePermissionPanel
        activity={activity({ permissionKind: 'interact' })}
        onResolve={onResolve}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/观察并操作这个网站当前页的可见控件/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '允许操作' }));
    await waitFor(() =>
      expect(onResolve).toHaveBeenCalledWith('request-1', 'https://example.com/*', true),
    );
  });

  it('取消任务按钮转发 onCancel', () => {
    const onCancel = vi.fn();
    render(<PagePermissionPanel activity={activity()} onResolve={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: /取消任务/ }));
    expect(onCancel).toHaveBeenCalled();
  });
});
