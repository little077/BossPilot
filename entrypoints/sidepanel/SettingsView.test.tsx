import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from './SettingsView';

const accessMocks = vi.hoisted(() => ({
  listGrantedPageOrigins: vi.fn(),
  removePageOriginAccess: vi.fn(),
}));
const configMocks = vi.hoisted(() => ({
  getChatHistorySettings: vi.fn(),
  setChatHistorySettings: vi.fn(),
}));

vi.mock('./ProviderSettings', () => ({
  ProviderSettings: () => <section aria-label="模型卡包与发卡台">模型接入</section>,
}));
vi.mock('./SkillSettings', () => ({
  SkillSettings: () => <section aria-label="Agent Skills">技能设置</section>,
}));
vi.mock('./AgentContextSettings', () => ({
  AgentContextSettings: () => <section aria-label="用户上下文">用户上下文设置</section>,
}));
vi.mock('./McpSettings', () => ({
  McpSettings: () => <section aria-label="MCP 工具">MCP 设置</section>,
}));
vi.mock('./AgentHealthCheck', () => ({
  AgentHealthCheckPanel: () => <section aria-label="Agent 运行自检">自检</section>,
}));
vi.mock('@/lib/page/access', () => accessMocks);
vi.mock('@/lib/storage/config', () => configMocks);

beforeEach(() => {
  accessMocks.listGrantedPageOrigins.mockReset().mockResolvedValue([]);
  accessMocks.removePageOriginAccess.mockReset().mockResolvedValue(true);
  configMocks.getChatHistorySettings.mockReset().mockResolvedValue({ autoTitle: false });
  configMocks.setChatHistorySettings.mockReset().mockResolvedValue(undefined);
});

describe('SettingsView', () => {
  it('keeps model configuration and shows the empty page-permission manager', async () => {
    render(<SettingsView />);

    expect(screen.getByRole('region', { name: '模型卡包与发卡台' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Agent Skills' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '用户上下文' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'MCP 工具' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Agent 运行自检' })).toBeInTheDocument();
    expect(await screen.findByText('尚未长期允许其他网站')).toBeVisible();
    expect(screen.queryByText('评估设置')).not.toBeInTheDocument();
    expect(screen.queryByText(/我的档案/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存设置' })).not.toBeInTheDocument();
    expect(screen.queryByText(/隐私说明/)).not.toBeInTheDocument();
    expect(await screen.findByRole('switch', { name: '自动生成会话标题' })).not.toBeChecked();
  });

  it('explains the extra model call and persists the automatic-title switch', async () => {
    render(<SettingsView />);

    const toggle = await screen.findByRole('switch', { name: '自动生成会话标题' });
    expect(screen.getByText(/额外调用一次当前模型/)).toBeVisible();
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(configMocks.setChatHistorySettings).toHaveBeenCalledWith({ autoTitle: true }),
    );
    expect(toggle).toBeChecked();
    expect(await screen.findByText('已开启自动会话标题。')).toBeVisible();
  });

  it('restores the automatic-title switch when saving fails', async () => {
    configMocks.getChatHistorySettings.mockResolvedValue({ autoTitle: true });
    configMocks.setChatHistorySettings.mockRejectedValue(new Error('quota'));
    render(<SettingsView />);

    const toggle = await screen.findByRole('switch', { name: '自动生成会话标题' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);

    expect(await screen.findByText('自动标题设置保存失败，请稍后重试。')).toBeVisible();
    expect(toggle).toBeChecked();
  });

  it('loads an enabled switch, turns it off, and reports setting-load failure', async () => {
    configMocks.getChatHistorySettings.mockResolvedValueOnce({ autoTitle: true });
    const first = render(<SettingsView />);
    const toggle = await screen.findByRole('switch', { name: '自动生成会话标题' });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(configMocks.setChatHistorySettings).toHaveBeenCalledWith({ autoTitle: false }),
    );
    expect(await screen.findByText('已关闭自动会话标题。')).toBeVisible();
    first.unmount();

    configMocks.getChatHistorySettings.mockRejectedValueOnce(new Error('storage'));
    render(<SettingsView />);
    expect(await screen.findByText('自动标题设置读取失败，请重新打开设置。')).toBeVisible();
  });

  it('ignores late setting and permission results after the settings page unmounts', async () => {
    let resolveSettings: ((value: { autoTitle: boolean }) => void) | undefined;
    let rejectOrigins: ((reason: Error) => void) | undefined;
    configMocks.getChatHistorySettings.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSettings = resolve;
      }),
    );
    accessMocks.listGrantedPageOrigins.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectOrigins = reject;
      }),
    );

    const view = render(<SettingsView />);
    view.unmount();
    resolveSettings?.({ autoTitle: true });
    rejectOrigins?.(new Error('late failure'));
    await Promise.resolve();
  });

  it('lists and revokes one exact website permission', async () => {
    accessMocks.listGrantedPageOrigins.mockResolvedValue([
      { origin: 'https://example.com', pattern: 'https://example.com/*' },
    ]);
    render(<SettingsView />);

    expect(await screen.findByText('https://example.com')).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: '撤销 https://example.com 的页面读取权限' }),
    );
    await waitFor(() =>
      expect(accessMocks.removePageOriginAccess).toHaveBeenCalledWith('https://example.com/*'),
    );
    expect(await screen.findByText(/已撤销 https:\/\/example.com/)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: '撤销 https://example.com 的页面读取权限' }),
    ).not.toBeInTheDocument();
  });

  it('reports permission listing and revocation failures', async () => {
    accessMocks.listGrantedPageOrigins.mockRejectedValueOnce(new Error('storage failed'));
    const first = render(<SettingsView />);
    expect(await screen.findByText('网站权限列表读取失败，请重新打开设置。')).toBeVisible();
    first.unmount();

    accessMocks.listGrantedPageOrigins.mockResolvedValueOnce([
      { origin: 'https://example.com', pattern: 'https://example.com/*' },
    ]);
    accessMocks.removePageOriginAccess.mockRejectedValueOnce(new Error('remove failed'));
    render(<SettingsView />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: '撤销 https://example.com 的页面读取权限',
      }),
    );
    expect(await screen.findByText(/未能撤销 https:\/\/example.com/)).toBeVisible();
  });
});
