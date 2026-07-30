import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsView } from './SettingsView';

vi.mock('./ProviderSettings', () => ({
  ProviderSettings: () => <section aria-label="模型卡包与发卡台">模型接入</section>,
}));

describe('SettingsView', () => {
  it('一期设置页只保留模型卡包与发卡台', () => {
    render(<SettingsView />);

    expect(screen.getByRole('region', { name: '模型卡包与发卡台' })).toBeInTheDocument();
    expect(screen.queryByText('评估设置')).not.toBeInTheDocument();
    expect(screen.queryByText(/我的档案/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存设置' })).not.toBeInTheDocument();
    expect(screen.queryByText(/隐私说明/)).not.toBeInTheDocument();
  });
});
