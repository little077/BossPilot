import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillSettingsView } from '@/lib/skills/types';
import { SkillSettings } from './SkillSettings';

const mocks = vi.hoisted(() => ({ sendSkillCommand: vi.fn(), sendSkillRequest: vi.fn() }));
vi.mock('@/lib/skills/client', () => mocks);

const state = (enabled = true): SkillSettingsView => ({
  version: 2,
  skills: [
    {
      name: 'boss-job-search',
      description: 'Boss 求职工作流',
      version: '1.0.0',
      builtIn: true,
      enabled,
      capabilities: [],
      fileCount: 3,
    },
  ],
  grants: [],
});

const packageView = () => {
  const markdown = `---\nname: boss-job-search\ndescription: Boss 求职工作流\n---\n# Workflow`;
  return {
    name: 'boss-job-search',
    definition: {
      name: 'boss-job-search',
      description: 'Boss 求职工作流',
      instructions: '# Workflow',
      version: '1.0.0',
      builtIn: true,
      enabled: true,
      allowedTools: [],
      capabilities: [],
      references: [],
    },
    files: [
      {
        path: 'SKILL.md',
        kind: 'text' as const,
        content: markdown,
        mimeType: 'text/markdown',
        size: new TextEncoder().encode(markdown).byteLength,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
};

describe('SkillSettings', () => {
  beforeEach(() => {
    mocks.sendSkillCommand.mockReset().mockResolvedValue(state());
    mocks.sendSkillRequest.mockReset();
  });

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

  it('creates a local Skill and opens its multi-file editor', async () => {
    const markdown = `---\nname: local-skill\ndescription: Local workflow\n---\n# Workflow`;
    vi.spyOn(window, 'prompt').mockReturnValueOnce('local-skill');
    mocks.sendSkillRequest.mockResolvedValueOnce({
      ok: true,
      state: state(),
      skill: {
        name: 'local-skill',
        definition: {
          name: 'local-skill',
          description: 'Local workflow',
          instructions: '# Workflow',
          version: '1.0.0',
          builtIn: false,
          enabled: true,
          allowedTools: [],
          capabilities: [],
          references: [],
        },
        files: [
          {
            path: 'SKILL.md',
            kind: 'text',
            content: markdown,
            mimeType: 'text/markdown',
            size: new TextEncoder().encode(markdown).byteLength,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
    });
    render(<SkillSettings />);
    await screen.findByRole('switch', { name: 'boss-job-search 技能' });
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    expect(await screen.findByRole('dialog', { name: 'local-skill' })).toBeVisible();
    expect(mocks.sendSkillRequest).toHaveBeenCalledWith({
      type: 'skills:create',
      name: 'local-skill',
    });
  });

  it('views, copies, exports and deletes Skills through explicit actions', async () => {
    const withLocal = state();
    const builtin = withLocal.skills[0];
    if (!builtin) throw new Error('fixture missing');
    withLocal.skills.push({
      ...builtin,
      name: 'local-skill',
      builtIn: false,
      fileCount: 1,
    });
    withLocal.grants.push({
      id: 'local-skill:workspace.read',
      skillName: 'local-skill',
      capability: 'workspace.read',
      decision: 'allow',
      createdAt: 1,
      updatedAt: 1,
    });
    mocks.sendSkillCommand.mockResolvedValueOnce(withLocal);
    mocks.sendSkillRequest.mockImplementation(async (command: { type: string }) => ({
      ok: true,
      state: withLocal,
      ...(command.type === 'skills:get-package' ? { skill: packageView() } : {}),
      ...(command.type.startsWith('skills:export') ? { archiveBase64: 'UEs=' } : {}),
    }));
    vi.spyOn(window, 'prompt').mockReturnValueOnce('copied-skill');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    render(<SkillSettings />);
    await screen.findByRole('article', { name: 'local-skill 技能' });
    fireEvent.click(screen.getByRole('button', { name: '查看或编辑 boss-job-search' }));
    expect(await screen.findByRole('dialog', { name: 'boss-job-search' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '关闭 Skill 编辑器' }));

    fireEvent.click(screen.getByRole('button', { name: '复制 boss-job-search' }));
    await waitFor(() =>
      expect(mocks.sendSkillRequest).toHaveBeenCalledWith({
        type: 'skills:duplicate',
        name: 'boss-job-search',
        nextName: 'copied-skill',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '导出 boss-job-search' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '导出全部' }));
    await waitFor(() =>
      expect(mocks.sendSkillRequest).toHaveBeenCalledWith({ type: 'skills:export-all' }),
    );
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() =>
      expect(mocks.sendSkillRequest).toHaveBeenCalledWith({
        type: 'skills:revoke-grant',
        id: 'local-skill:workspace.read',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '删除 local-skill' }));
    await waitFor(() =>
      expect(mocks.sendSkillRequest).toHaveBeenCalledWith({
        type: 'skills:delete',
        name: 'local-skill',
      }),
    );
  });

  it('imports a bounded ZIP and reports action failures', async () => {
    mocks.sendSkillRequest
      .mockResolvedValueOnce({ ok: true, state: state(), skill: packageView() })
      .mockRejectedValueOnce(new Error('复制失败'));
    render(<SkillSettings />);
    await screen.findByRole('switch', { name: 'boss-job-search 技能' });
    const file = new File([new Uint8Array([80, 75])], 'skill.zip', { type: 'application/zip' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: vi.fn(async () => Uint8Array.from([80, 75]).buffer),
    });
    fireEvent.change(screen.getByLabelText('导入 Skill ZIP'), { target: { files: [file] } });
    expect(await screen.findByText(/已安全导入/)).toBeVisible();
    vi.spyOn(window, 'prompt').mockReturnValueOnce('copy-skill');
    fireEvent.click(screen.getByRole('button', { name: '复制 boss-job-search' }));
    expect(await screen.findByText('复制失败')).toBeVisible();
  });

  it('does not mutate data when dialogs are cancelled and rejects oversized ZIPs', async () => {
    const local = state();
    const builtin = local.skills[0];
    if (!builtin) throw new Error('fixture missing');
    local.skills.push({ ...builtin, name: 'local-skill', builtIn: false });
    mocks.sendSkillCommand.mockResolvedValueOnce(local);
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SkillSettings />);
    await screen.findByRole('article', { name: 'local-skill 技能' });
    const inputClick = vi
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: '导入 ZIP' }));
    expect(inputClick).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    fireEvent.click(screen.getByRole('button', { name: '复制 boss-job-search' }));
    fireEvent.click(screen.getByRole('button', { name: '删除 local-skill' }));
    expect(mocks.sendSkillRequest).not.toHaveBeenCalled();
    const file = new File(['x'], 'large.zip', { type: 'application/zip' });
    Object.defineProperty(file, 'size', { value: 5 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText('导入 Skill ZIP'), { target: { files: [file] } });
    expect(screen.getByRole('status')).toHaveTextContent('超过 5 MB');
  });

  it('reports missing package and archive payloads without leaving the list', async () => {
    mocks.sendSkillRequest.mockResolvedValue({ ok: true, state: state() });
    render(<SkillSettings />);
    await screen.findByRole('switch', { name: 'boss-job-search 技能' });
    fireEvent.click(screen.getByRole('button', { name: '查看或编辑 boss-job-search' }));
    expect(await screen.findByText('Skill 文件读取失败。')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '导出 boss-job-search' }));
    expect(await screen.findByText('Skill 导出失败。')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '导出全部' }));
    expect(await screen.findByText('Skills 批量导出失败。')).toBeVisible();
  });

  it('saves a local package from the editor and returns its refreshed state', async () => {
    const localState = state();
    const builtin = localState.skills[0];
    if (!builtin) throw new Error('fixture missing');
    localState.skills = [{ ...builtin, name: 'local-skill', builtIn: false }];
    const localPackage = packageView();
    localPackage.name = 'local-skill';
    localPackage.definition.name = 'local-skill';
    localPackage.definition.builtIn = false;
    const skillFile = localPackage.files[0];
    if (!skillFile) throw new Error('fixture missing');
    skillFile.content = skillFile.content.replaceAll('boss-job-search', 'local-skill');
    skillFile.size = new TextEncoder().encode(skillFile.content).byteLength;
    mocks.sendSkillCommand.mockResolvedValueOnce(localState);
    mocks.sendSkillRequest
      .mockResolvedValueOnce({ ok: true, state: localState, skill: localPackage })
      .mockResolvedValueOnce({ ok: true, state: localState, skill: localPackage });
    render(<SkillSettings />);
    await screen.findByRole('article', { name: 'local-skill 技能' });
    fireEvent.click(screen.getByRole('button', { name: '查看或编辑 local-skill' }));
    await screen.findByRole('dialog', { name: 'local-skill' });
    fireEvent.click(screen.getByRole('button', { name: '保存 Skill' }));
    await waitFor(() =>
      expect(mocks.sendSkillRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'skills:save-package', name: 'local-skill' }),
      ),
    );
    expect(await screen.findByText(/Skill 已保存/)).toBeVisible();
  });
});
