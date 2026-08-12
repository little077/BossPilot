import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConnectionView, ProviderStateView } from '@/lib/domain/types';
import type { ProviderCommand } from '@/lib/ipc/protocol';
import { ProviderSettings } from './ProviderSettings';

const { permissionsRequestMock, sendProviderCommandMock } = vi.hoisted(() => ({
  permissionsRequestMock:
    vi.fn<(permissions: chrome.permissions.Permissions) => Promise<boolean>>(),
  sendProviderCommandMock: vi.fn<(command: ProviderCommand) => Promise<ProviderStateView>>(),
}));

vi.mock('@/lib/providers/client', () => ({
  sendProviderCommand: sendProviderCommandMock,
}));

const EMPTY_STATE: ProviderStateView = {
  version: 1,
  connections: [],
};

function stateWith(
  connection: ProviderConnectionView,
  activeModel?: ProviderStateView['activeModel'],
): ProviderStateView {
  return {
    version: 1,
    connections: [connection],
    ...(activeModel ? { activeModel } : {}),
  };
}

const ISSUED_DEEPSEEK = stateWith({
  providerId: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  hasApiKey: false,
  apiKeyLastFour: '',
  models: [],
});

beforeEach(() => {
  sendProviderCommandMock.mockReset();
  permissionsRequestMock.mockReset();
  permissionsRequestMock.mockResolvedValue(true);
  vi.stubGlobal('chrome', {
    permissions: {
      request: permissionsRequestMock,
    },
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProviderSettings', () => {
  it('默认展示原型常用入口，并可展开完整厂商目录', async () => {
    const user = userEvent.setup();
    sendProviderCommandMock.mockResolvedValueOnce(EMPTY_STATE);

    render(<ProviderSettings />);
    await screen.findByRole('heading', { name: '发卡台' });

    expect(screen.getByRole('button', { name: /DeepSeek/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Ollama/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Anthropic/ })).not.toBeInTheDocument();

    const showMore = screen.getByRole('button', { name: /显示更多/ });
    expect(showMore).toHaveAttribute('aria-expanded', 'false');
    await user.click(showMore);

    expect(screen.getByRole('button', { name: /Anthropic/ })).toBeVisible();
    expect(screen.getByRole('button', { name: '收起更多' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('领卡后请求精确主机权限、加载目录并选择模型，且成功后不回显密钥', async () => {
    const user = userEvent.setup();
    const secret = 'sk-live-secret-ABCD';
    const connectedConnection: ProviderConnectionView = {
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      hasApiKey: true,
      apiKeyLastFour: 'ABCD',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ],
    };
    const connectedState = stateWith(connectedConnection);
    const selectedState = stateWith(
      {
        ...connectedConnection,
        selectedModelId: 'deepseek-chat',
      },
      { providerId: 'deepseek', modelId: 'deepseek-chat' },
    );

    sendProviderCommandMock
      .mockResolvedValueOnce(EMPTY_STATE)
      .mockResolvedValueOnce(ISSUED_DEEPSEEK)
      .mockResolvedValueOnce(connectedState)
      .mockResolvedValueOnce(selectedState);

    render(<ProviderSettings />);
    await screen.findByRole('heading', { name: '我的模型卡包' });

    await user.click(screen.getByRole('button', { name: /DeepSeek/ }));
    const card = await screen.findByRole('article', { name: 'DeepSeek 模型配置' });
    const keyInput = within(card).getByLabelText('API Key（仅存本机）');
    await user.type(keyInput, secret);
    await user.click(within(card).getByRole('button', { name: '开通' }));

    expect(permissionsRequestMock).toHaveBeenCalledWith({
      origins: ['https://api.deepseek.com/*'],
    });
    expect(sendProviderCommandMock).toHaveBeenNthCalledWith(3, {
      type: 'providers:connect',
      providerId: 'deepseek',
      apiKey: secret,
    });

    const modelButton = await within(card).findByRole('button', {
      name: 'DeepSeek Chat',
    });
    await waitFor(() => expect(keyInput).toHaveValue(''));
    expect(keyInput.getAttribute('placeholder')).toContain('ABCD');
    expect(document.body.textContent).not.toContain(secret);

    await user.click(modelButton);

    expect(sendProviderCommandMock).toHaveBeenNthCalledWith(4, {
      type: 'providers:select',
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
    });
    await waitFor(() => expect(modelButton).toHaveAttribute('aria-pressed', 'true'));
    expect(within(card).getByLabelText('配置完成')).toBeInTheDocument();
    expect(within(card).getByText('使用中 ✦')).toBeInTheDocument();
  });

  it('主机权限被拒绝时不向后台发送开通命令并展示可恢复错误', async () => {
    const user = userEvent.setup();
    permissionsRequestMock.mockResolvedValue(false);
    sendProviderCommandMock.mockResolvedValueOnce(ISSUED_DEEPSEEK);

    render(<ProviderSettings />);
    const card = await screen.findByRole('article', { name: 'DeepSeek 模型配置' });
    await user.type(within(card).getByLabelText('API Key（仅存本机）'), 'sk-denied');
    await user.click(within(card).getByRole('button', { name: '开通' }));

    expect(permissionsRequestMock).toHaveBeenCalledWith({
      origins: ['https://api.deepseek.com/*'],
    });
    expect(sendProviderCommandMock).toHaveBeenCalledTimes(1);
    expect(
      await within(card).findByText(/未获得该模型端点的访问权限，无法读取模型目录/),
    ).toBeInTheDocument();
  });

  it('自定义端点可以手动填写模型 ID 作为目录发现兜底', async () => {
    const user = userEvent.setup();
    const issuedCustom = stateWith({
      providerId: 'custom',
      baseUrl: '',
      hasApiKey: false,
      apiKeyLastFour: '',
      models: [],
    });
    const configuredCustom = stateWith(
      {
        providerId: 'custom',
        baseUrl: 'https://gateway.example.com/v1',
        hasApiKey: true,
        apiKeyLastFour: '5678',
        models: [{ id: 'team-model', name: 'team-model' }],
        selectedModelId: 'team-model',
      },
      { providerId: 'custom', modelId: 'team-model' },
    );

    sendProviderCommandMock
      .mockResolvedValueOnce(EMPTY_STATE)
      .mockResolvedValueOnce(issuedCustom)
      .mockResolvedValueOnce(configuredCustom);

    render(<ProviderSettings />);
    await screen.findByRole('heading', { name: '发卡台' });
    await user.click(screen.getByRole('button', { name: /自定义端点/ }));

    const card = await screen.findByRole('article', { name: '自定义端点 模型配置' });
    const keyInput = within(card).getByLabelText('API Key（仅存本机）');
    fireEvent.change(within(card).getByLabelText('Base URL（OpenAI 兼容端点）'), {
      target: { value: 'https://gateway.example.com/v1/' },
    });
    fireEvent.change(keyInput, { target: { value: 'custom-secret-5678' } });
    fireEvent.change(within(card).getByLabelText('手动模型 ID'), {
      target: { value: ' team-model ' },
    });
    await user.click(within(card).getByRole('button', { name: '添加' }));

    expect(permissionsRequestMock).toHaveBeenCalledWith({
      origins: ['https://gateway.example.com/*'],
    });
    expect(sendProviderCommandMock).toHaveBeenNthCalledWith(3, {
      type: 'providers:add-manual-model',
      providerId: 'custom',
      modelId: 'team-model',
      apiKey: 'custom-secret-5678',
      baseUrl: 'https://gateway.example.com/v1',
    });
    await waitFor(() => expect(keyInput).toHaveValue(''));
    expect(within(card).getByRole('button', { name: 'team-model' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(card).getByText('使用中 ✦')).toBeInTheDocument();
  });

  it('仅为自定义端点提供显式图片输入能力开关', async () => {
    const user = userEvent.setup();
    const customConnection: ProviderConnectionView = {
      providerId: 'custom',
      baseUrl: 'https://gateway.example.com/v1',
      hasApiKey: true,
      apiKeyLastFour: '5678',
      models: [{ id: 'team-vision', name: 'Team Vision' }],
      selectedModelId: 'team-vision',
    };
    const enabledConnection: ProviderConnectionView = {
      ...customConnection,
      imageInputModelIds: ['team-vision'],
    };
    sendProviderCommandMock
      .mockResolvedValueOnce(
        stateWith(customConnection, { providerId: 'custom', modelId: 'team-vision' }),
      )
      .mockResolvedValueOnce(
        stateWith(enabledConnection, { providerId: 'custom', modelId: 'team-vision' }),
      );

    render(<ProviderSettings />);
    const card = await screen.findByRole('article', { name: '自定义端点 模型配置' });
    const imageInput = within(card).getByRole('switch', {
      name: 'team-vision 支持图片输入',
    });
    expect(imageInput).not.toBeChecked();

    await user.click(imageInput);

    expect(sendProviderCommandMock).toHaveBeenNthCalledWith(2, {
      type: 'providers:set-image-input',
      providerId: 'custom',
      modelId: 'team-vision',
      enabled: true,
    });
    await waitFor(() => expect(imageInput).toBeChecked());
    expect(screen.getByText('team-vision 已声明支持图片输入。')).toBeVisible();
  });
});
