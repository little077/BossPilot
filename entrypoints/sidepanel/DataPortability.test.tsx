import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataPortability } from './DataPortability';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  serialize: vi.fn(),
  importBackup: vi.fn(),
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
}));

vi.mock('@/lib/portability/backup', () => ({
  backupFileName: () => 'backup.json',
  createBossPilotBackup: mocks.create,
  serializeBossPilotBackup: mocks.serialize,
  importBossPilotBackup: mocks.importBackup,
}));

beforeEach(() => {
  mocks.create.mockReset().mockResolvedValue({ app: 'BossPilot' });
  mocks.serialize.mockReset().mockReturnValue('{}');
  mocks.importBackup.mockReset().mockResolvedValue({ conversations: 1, messages: 2, memories: 3 });
  mocks.createObjectURL.mockReset().mockReturnValue('blob:test');
  mocks.revokeObjectURL.mockReset();
  vi.stubGlobal('URL', {
    createObjectURL: mocks.createObjectURL,
    revokeObjectURL: mocks.revokeObjectURL,
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

describe('DataPortability', () => {
  it('exports a secret-free local backup', async () => {
    render(<DataPortability />);
    fireEvent.click(screen.getByRole('button', { name: '导出备份' }));
    expect(await screen.findByText(/备份已生成/)).toBeVisible();
    expect(mocks.create).toHaveBeenCalled();
    expect(mocks.createObjectURL).toHaveBeenCalled();
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('imports a selected backup and reports additive counts', async () => {
    render(<DataPortability />);
    const file = { size: 100, text: vi.fn(async () => '{}') };
    fireEvent.change(screen.getByLabelText('选择 BossPilot 备份文件'), {
      target: { files: [file] },
    });
    expect(await screen.findByText(/已合并 1 个会话、2 条消息和 3 条记忆/)).toBeVisible();
    expect(mocks.importBackup).toHaveBeenCalledWith('{}');
  });

  it('blocks oversized files and surfaces import failures', async () => {
    render(<DataPortability />);
    const input = screen.getByLabelText('选择 BossPilot 备份文件');
    fireEvent.change(input, { target: { files: [{ size: 25 * 1024 * 1024 + 1 }] } });
    expect(screen.getByText(/不能超过 25 MB/)).toBeVisible();

    mocks.importBackup.mockRejectedValueOnce(new Error('备份无效'));
    fireEvent.change(input, {
      target: { files: [{ size: 1, text: vi.fn(async () => '{}') }] },
    });
    await waitFor(() => expect(screen.getByText('备份无效')).toBeVisible());
  });

  it('ignores an empty file picker and reports export failures', async () => {
    mocks.create.mockRejectedValueOnce(new Error('storage'));
    render(<DataPortability />);
    fireEvent.change(screen.getByLabelText('选择 BossPilot 备份文件'), {
      target: { files: [] },
    });
    expect(mocks.importBackup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '导出备份' }));
    expect(await screen.findByText(/备份生成失败/)).toBeVisible();
  });
});
