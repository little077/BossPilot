import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import { ChatFlowStatus } from './ChatFlowStatus';

const BASE_MESSAGE: ChatMessage = {
  id: 'assistant-1',
  role: 'assistant',
  content: '',
  createdAt: 1,
  status: 'streaming',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('ChatFlowStatus', () => {
  it('renders nothing when a message has no execution activity', () => {
    const { container } = render(<ChatFlowStatus message={BASE_MESSAGE} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a live, safe thinking summary and collapses after completion', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const { rerender } = render(
      <ChatFlowStatus
        message={{
          ...BASE_MESSAGE,
          reasoningActivity: {
            status: 'running',
            summary: '正在判断是否需要读取当前页面',
            startedAt: 1_000,
          },
        }}
      />,
    );

    expect(screen.getByRole('button', { name: /思考中/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('正在判断是否需要读取当前页面')).toBeVisible();
    expect(screen.getByText('1.0s')).toBeVisible();
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByText('1.1s')).toBeVisible();

    rerender(
      <ChatFlowStatus
        message={{
          ...BASE_MESSAGE,
          reasoningActivity: {
            status: 'completed',
            summary: '已判断需要读取当前岗位',
            startedAt: 1_000,
            finishedAt: 2_200,
          },
        }}
      />,
    );

    expect(screen.getByRole('button', { name: /已完成分析/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('已判断需要读取当前岗位')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /已完成分析/ }));
    expect(screen.getByText('已判断需要读取当前岗位')).toBeVisible();
  });

  it.each([
    ['cancelled', '分析已停止'],
    ['error', '分析未完成'],
  ] as const)('shows the %s reasoning label', (status, label) => {
    render(
      <ChatFlowStatus
        message={{
          ...BASE_MESSAGE,
          reasoningActivity: {
            status,
            summary: label,
            startedAt: 1_000,
            finishedAt: 1_500,
          },
        }}
      />,
    );
    expect(screen.getByRole('button', { name: new RegExp(label) })).toBeVisible();
  });

  it.each([
    ['running', '正在读取当前岗位'],
    ['succeeded', '已读取当前岗位'],
    ['failed', '当前不是岗位详情页'],
    ['cancelled', '已停止读取当前岗位'],
  ] as const)('renders the %s tool state', (status, statusText) => {
    render(
      <ChatFlowStatus
        message={{
          ...BASE_MESSAGE,
          toolActivity: {
            callId: 'call-1',
            name: 'read_current_job',
            label: '读取当前岗位',
            status,
            statusText,
            startedAt: 1_000,
            finishedAt: status === 'running' ? undefined : 1_800,
          },
        }}
      />,
    );

    expect(screen.getByText('读取当前岗位')).toBeVisible();
    expect(screen.getByText('read_current_job')).toBeVisible();
    expect(screen.getByText(statusText)).toBeVisible();
  });

  it('keeps non-sensitive tool details collapsed until requested', () => {
    render(
      <ChatFlowStatus
        message={{
          ...BASE_MESSAGE,
          toolActivity: {
            callId: 'call-1',
            name: 'read_current_job',
            label: '读取当前岗位',
            status: 'succeeded',
            statusText: '已读取当前岗位',
            detail: '岗位描述 1200 字',
            startedAt: 1_000,
            finishedAt: 1_800,
          },
        }}
      />,
    );

    const toggle = screen.getByRole('button', { name: /读取当前岗位/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('岗位描述 1200 字')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText('岗位描述 1200 字')).toBeVisible();
  });
});
