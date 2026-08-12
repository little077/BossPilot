import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpSettings } from './McpSettings';

const mocks = vi.hoisted(() => ({ sendMcpCommand: vi.fn(), request: vi.fn() }));
vi.mock('@/lib/mcp/client', () => ({ sendMcpCommand: mocks.sendMcpCommand }));

const state = {
  version: 1 as const,
  servers: [
    {
      id: 's1',
      name: 'Docs',
      url: 'https://mcp.example/mcp',
      enabled: true,
      tokenConfigured: true,
      tools: [{ name: 'search', description: 'Search', readOnly: true }],
      updatedAt: 1,
    },
  ],
};

describe('McpSettings', () => {
  beforeEach(() => {
    mocks.sendMcpCommand.mockReset().mockResolvedValue(state);
    mocks.request.mockReset().mockResolvedValue(true);
    vi.stubGlobal('chrome', { permissions: { request: mocks.request } });
  });

  it('lists, disables, refreshes, and removes a configured service', async () => {
    render(<McpSettings />);
    const toggle = await screen.findByRole('switch', { name: 'Docs MCP 服务' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mocks.sendMcpCommand).toHaveBeenCalledWith({
        type: 'mcp:set-enabled',
        id: 's1',
        enabled: false,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '刷新 Docs 工具目录' }));
    expect(screen.getByLabelText('MCP 地址')).toHaveValue('https://mcp.example/mcp');
    fireEvent.click(screen.getByRole('button', { name: '删除 Docs MCP 服务' }));
    await waitFor(() =>
      expect(mocks.sendMcpCommand).toHaveBeenCalledWith({ type: 'mcp:remove', id: 's1' }),
    );
  });

  it('requests exact origin permission before connecting and never reuses a displayed token', async () => {
    render(<McpSettings />);
    await screen.findByText('Docs');
    fireEvent.click(screen.getByRole('button', { name: /添加 MCP 服务/ }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Search' } });
    fireEvent.change(screen.getByLabelText('MCP 地址'), {
      target: { value: 'https://api.example/mcp' },
    });
    fireEvent.change(screen.getByLabelText(/Bearer Token/), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /连接并读取工具/ }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith({ origins: ['https://api.example/*'] }),
    );
    expect(mocks.sendMcpCommand).toHaveBeenCalledWith({
      type: 'mcp:save',
      name: 'Search',
      url: 'https://api.example/mcp',
      token: 'secret',
    });
  });

  it('reports load and permission failures', async () => {
    mocks.sendMcpCommand.mockRejectedValueOnce(new Error('load'));
    const first = render(<McpSettings />);
    expect(await screen.findByText('MCP 配置读取失败，请重新打开设置。')).toBeVisible();
    first.unmount();
    mocks.sendMcpCommand.mockResolvedValueOnce(state);
    mocks.request.mockResolvedValueOnce(false);
    render(<McpSettings />);
    await screen.findByText('Docs');
    fireEvent.click(screen.getByRole('button', { name: /添加 MCP 服务/ }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('MCP 地址'), {
      target: { value: 'https://x.example/mcp' },
    });
    fireEvent.click(screen.getByRole('button', { name: /连接并读取工具/ }));
    expect(await screen.findByText(/没有授予/)).toBeVisible();
  });
});
