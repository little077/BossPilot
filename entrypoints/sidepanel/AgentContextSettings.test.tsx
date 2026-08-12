import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentContextSettings } from './AgentContextSettings';

const mocks = vi.hoisted(() => ({ sendAgentContextCommand: vi.fn() }));
vi.mock('@/lib/memory/client', () => mocks);

const view = (memoryEnabled = false) => ({
  settings: { version: 1 as const, instructions: '请用中文', memoryEnabled },
  memories: memoryEnabled
    ? [{ id: 'm1', content: '优先远程岗位', createdAt: 1, updatedAt: 1 }]
    : [],
});

describe('AgentContextSettings', () => {
  beforeEach(() => mocks.sendAgentContextCommand.mockReset().mockResolvedValue(view()));

  it('loads, edits, and saves long-term instructions', async () => {
    render(<AgentContextSettings />);
    const textarea = await screen.findByLabelText('长期用户指令');
    expect(textarea).toHaveValue('请用中文');
    fireEvent.change(textarea, { target: { value: '回答简洁' } });
    fireEvent.click(screen.getByRole('button', { name: '保存指令' }));
    await waitFor(() =>
      expect(mocks.sendAgentContextCommand).toHaveBeenLastCalledWith({
        type: 'context:save-settings',
        instructions: '回答简洁',
        memoryEnabled: false,
      }),
    );
  });

  it('enables memory, adds, edits, deletes, and clears visible entries', async () => {
    mocks.sendAgentContextCommand
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view(true))
      .mockResolvedValue(view(true));
    render(<AgentContextSettings />);
    fireEvent.click(await screen.findByRole('switch', { name: '本地长期记忆' }));
    expect(await screen.findByText('优先远程岗位')).toBeVisible();

    fireEvent.change(screen.getByLabelText('添加本地记忆'), { target: { value: '偏好 React' } });
    fireEvent.click(screen.getByRole('button', { name: '保存本地记忆' }));
    await waitFor(() =>
      expect(mocks.sendAgentContextCommand).toHaveBeenCalledWith({
        type: 'context:add-memory',
        content: '偏好 React',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑记忆 优先远程岗位' }));
    fireEvent.change(screen.getByLabelText('编辑记忆 优先远程岗位'), {
      target: { value: '优先混合办公' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存编辑后的记忆' }));
    await waitFor(() =>
      expect(mocks.sendAgentContextCommand).toHaveBeenCalledWith({
        type: 'context:update-memory',
        id: 'm1',
        content: '优先混合办公',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '删除记忆 优先远程岗位' }));
    await waitFor(() =>
      expect(mocks.sendAgentContextCommand).toHaveBeenCalledWith({
        type: 'context:remove-memory',
        id: 'm1',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /清空全部记忆/ }));
    await waitFor(() =>
      expect(mocks.sendAgentContextCommand).toHaveBeenCalledWith({
        type: 'context:clear-memories',
      }),
    );
  });

  it('reports load and save errors and ignores late loads', async () => {
    mocks.sendAgentContextCommand.mockRejectedValueOnce(new Error('load'));
    const first = render(<AgentContextSettings />);
    expect(await screen.findByText('用户指令与记忆读取失败，请重新打开设置。')).toBeVisible();
    first.unmount();

    mocks.sendAgentContextCommand
      .mockResolvedValueOnce(view())
      .mockRejectedValueOnce(new Error('save'));
    const second = render(<AgentContextSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '保存指令' }));
    expect(await screen.findByText('保存失败，请稍后重试。')).toBeVisible();
    second.unmount();

    let resolve: ((value: ReturnType<typeof view>) => void) | undefined;
    mocks.sendAgentContextCommand.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const third = render(<AgentContextSettings />);
    third.unmount();
    resolve?.(view());
    await Promise.resolve();
  });
});
