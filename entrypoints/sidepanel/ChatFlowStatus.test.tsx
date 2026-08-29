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

  it('renders the full multi-tool timeline but keeps Ask User out of the message flow', () => {
    render(
      <ChatFlowStatus
        message={{
          ...BASE_MESSAGE,
          toolActivities: [
            {
              callId: 'call-1',
              name: 'browser_action',
              label: '操作浏览器',
              status: 'succeeded',
              statusText: '已在百度搜索',
              startedAt: 1_000,
              finishedAt: 1_500,
            },
            {
              callId: 'call-2',
              name: 'read_current_page',
              label: '读取当前页面',
              status: 'succeeded',
              statusText: '已读取搜索结果',
              startedAt: 1_600,
              finishedAt: 2_000,
            },
            {
              callId: 'call-3',
              name: 'ask_user',
              label: '询问用户',
              status: 'waiting_user',
              statusText: '等待用户补充信息',
              startedAt: 2_100,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText('已在百度搜索')).toBeVisible();
    expect(screen.getByText('已读取搜索结果')).toBeVisible();
    expect(screen.queryByText('等待用户补充信息')).not.toBeInTheDocument();
    expect(screen.queryByText('询问用户')).not.toBeInTheDocument();
  });

  it('等待权限时只显示状态提示，确认面板在底部渲染', () => {
    render(
      <ChatFlowStatus
        message={{
          ...BASE_MESSAGE,
          toolActivity: {
            requestId: 'request-1',
            callId: 'call-1',
            name: 'read_current_page',
            label: '读取当前页面',
            status: 'waiting_permission',
            statusText: '等待网站读取权限',
            startedAt: 1_000,
            sourceOrigin: 'https://example.com',
            permissionPattern: 'https://example.com/*',
          },
        }}
      />,
    );

    expect(screen.getByText('读取当前页面')).toBeVisible();
    expect(screen.getByText(/等待网站读取权限/)).toBeVisible();
    expect(screen.getByText(/底部确认面板/)).toBeVisible();
    // 确认按钮不再嵌入消息流，避免被上方历史消息淹没
    expect(screen.queryByRole('button', { name: /允许读取/ })).not.toBeInTheDocument();
  });

  it('shows the successful page source without exposing page text', () => {
    render(
      <ChatFlowStatus
        message={{
          ...BASE_MESSAGE,
          toolActivity: {
            callId: 'call-1',
            name: 'read_current_page',
            label: '读取当前页面',
            status: 'succeeded',
            statusText: '已读取当前页面',
            startedAt: 1_000,
            finishedAt: 1_800,
            sourceOrigin: 'https://example.com',
            sourceTitle: 'Example docs',
            sourceUrl: 'https://example.com/docs',
          },
        }}
      />,
    );
    expect(screen.getByText('基于当前页面 · Example docs')).toHaveAttribute(
      'title',
      'https://example.com/docs',
    );
  });

  it('shows persisted run metrics on demand', () => {
    render(
      <ChatFlowStatus
        message={{
          ...BASE_MESSAGE,
          status: 'completed',
          modelIdentity: { providerId: 'openai', modelId: 'gpt-test' },
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 15,
            cost: 0.01,
          },
        }}
      />,
    );
    fireEvent.click(screen.getByText('运行详情'));
    expect(screen.getByText('openai / gpt-test')).toBeVisible();
    expect(screen.getByText('$0.010000')).toBeVisible();
  });

  it.each([
    ['cancelled', '已取消'],
    ['error', '出错'],
  ] as const)('labels a %s run in the persisted details', (status, label) => {
    render(
      <ChatFlowStatus
        message={{
          ...BASE_MESSAGE,
          status,
          modelIdentity: { providerId: 'openai', modelId: 'gpt-test' },
        }}
      />,
    );
    fireEvent.click(screen.getByText('运行详情'));
    expect(screen.getByText(label)).toBeVisible();
  });
});
