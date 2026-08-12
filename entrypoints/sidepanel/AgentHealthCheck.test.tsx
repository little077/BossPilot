import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentHealthCheckPanel } from './AgentHealthCheck';

const mocks = vi.hoisted(() => ({
  provider: vi.fn(),
  skills: vi.fn(),
  context: vi.fn(),
  mcp: vi.fn(),
}));

vi.mock('@/lib/providers/client', () => ({ sendProviderCommand: mocks.provider }));
vi.mock('@/lib/skills/client', () => ({ sendSkillCommand: mocks.skills }));
vi.mock('@/lib/memory/client', () => ({ sendAgentContextCommand: mocks.context }));
vi.mock('@/lib/mcp/client', () => ({ sendMcpCommand: mocks.mcp }));

beforeEach(() => {
  mocks.provider.mockReset().mockResolvedValue({
    version: 1,
    activeModel: { providerId: 'openai', modelId: 'gpt-test' },
    connections: [
      {
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        hasApiKey: true,
        apiKeyLastFour: 'test',
        models: [],
      },
    ],
  });
  mocks.skills.mockReset().mockResolvedValue({ version: 1, skills: [] });
  mocks.context.mockReset().mockResolvedValue({
    settings: { version: 1, instructions: '', memoryEnabled: false },
    memories: [],
  });
  mocks.mcp.mockReset().mockResolvedValue({ version: 1, servers: [] });
  vi.stubGlobal('chrome', {
    runtime: {
      getManifest: () => ({ manifest_version: 3, name: 'BossPilot', version: '0.13.0' }),
    },
  });
});

describe('AgentHealthCheckPanel', () => {
  it('runs a local check and explains the permission posture', async () => {
    render(<AgentHealthCheckPanel />);
    fireEvent.click(screen.getByRole('button', { name: '运行自检' }));
    expect(await screen.findByText('默认模型')).toBeVisible();
    expect(screen.getByText(/未发现常驻的全站网页权限/)).toBeVisible();
    expect(mocks.provider).toHaveBeenCalledWith({ type: 'providers:get' });
  });

  it('shows a recoverable error when a local service cannot respond', async () => {
    mocks.mcp.mockRejectedValueOnce(new Error('unavailable'));
    render(<AgentHealthCheckPanel />);
    fireEvent.click(screen.getByRole('button', { name: '运行自检' }));
    await waitFor(() => expect(screen.getByText(/自检未完成/)).toBeVisible());
  });
});
