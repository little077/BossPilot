import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillSettings } from './SkillSettings';

const mocks = vi.hoisted(() => ({ sendSkillCommand: vi.fn() }));
vi.mock('@/lib/skills/client', () => mocks);

const state = (enabled = true) => ({
  version: 1 as const,
  skills: [
    {
      name: 'boss-job-search',
      description: 'Boss 求职工作流',
      version: '1.0.0',
      builtIn: true,
      enabled,
    },
  ],
});

describe('SkillSettings', () => {
  beforeEach(() => mocks.sendSkillCommand.mockReset().mockResolvedValue(state()));

  it('lists the built-in skill and persists its switch', async () => {
    render(<SkillSettings />);
    const toggle = await screen.findByRole('switch', { name: 'boss-job-search 技能' });
    expect(toggle).toBeChecked();
    expect(screen.getByText('Boss 求职工作流')).toBeVisible();
    mocks.sendSkillCommand.mockResolvedValueOnce(state(false));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mocks.sendSkillCommand).toHaveBeenLastCalledWith({
        type: 'skills:set-enabled',
        name: 'boss-job-search',
        enabled: false,
      }),
    );
    expect(await screen.findByText('已停用 boss-job-search。')).toBeVisible();
    expect(toggle).not.toBeChecked();
  });

  it('reports load and save failures without losing the current state', async () => {
    mocks.sendSkillCommand.mockRejectedValueOnce(new Error('load'));
    const first = render(<SkillSettings />);
    expect(await screen.findByText('技能列表读取失败，请重新打开设置。')).toBeVisible();
    first.unmount();

    mocks.sendSkillCommand.mockResolvedValueOnce(state()).mockRejectedValueOnce(new Error('save'));
    render(<SkillSettings />);
    const toggle = await screen.findByRole('switch', { name: 'boss-job-search 技能' });
    fireEvent.click(toggle);
    expect(await screen.findByText('技能设置保存失败，请稍后重试。')).toBeVisible();
    expect(toggle).toBeChecked();
  });

  it('can enable a disabled local skill and reports the enabled state', async () => {
    const local = state(false);
    const [firstSkill] = local.skills;
    if (!firstSkill) throw new Error('skill fixture is missing');
    local.skills[0] = { ...firstSkill, builtIn: false };
    mocks.sendSkillCommand.mockResolvedValueOnce(local).mockResolvedValueOnce(state(true));
    render(<SkillSettings />);
    const toggle = await screen.findByRole('switch', { name: 'boss-job-search 技能' });
    expect(screen.getByText(/本地技能/)).toBeVisible();
    fireEvent.click(toggle);
    expect(await screen.findByText('已启用 boss-job-search。')).toBeVisible();
  });

  it('ignores late loading after unmount', async () => {
    let resolve: ((value: ReturnType<typeof state>) => void) | undefined;
    mocks.sendSkillCommand.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<SkillSettings />);
    view.unmount();
    resolve?.(state());
    await Promise.resolve();
  });
});
