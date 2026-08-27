// ─── 通用选择框（SmartSelect）测试 ───

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Select, type SelectOption } from './Select';

const OPTIONS: SelectOption<'a' | 'b' | 'c'>[] = [
  { value: 'a', label: '选项 A' },
  { value: 'b', label: '选项 B', hint: '轻度思考' },
  { value: 'c', label: '选项 C' },
];

function Harness({
  onChange = vi.fn(),
  value: initial = '',
}: {
  onChange?: (value: 'a' | 'b' | 'c') => void;
  value?: 'a' | 'b' | 'c' | '';
}) {
  const [value, setValue] = useState(initial);
  return (
    <Select
      value={value}
      options={OPTIONS}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      ariaLabel="测试选择"
      placeholder="请选择"
    />
  );
}

describe('Select', () => {
  it('未选中时显示占位文案，展开后列出全部选项', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: '测试选择' });
    expect(trigger).toHaveTextContent('请选择');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('option', { name: '选项 A' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '选项 B，轻度思考' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '选项 C' })).toBeInTheDocument();
  });

  it('点击选项触发 onChange 并回显选中值', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: '测试选择' }));
    await user.click(screen.getByRole('option', { name: '选项 B，轻度思考' }));

    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.getByRole('button', { name: '测试选择' })).toHaveTextContent('选项 B');
    // 选中后列表关闭
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('选中项显示勾选标记', async () => {
    const user = userEvent.setup();
    render(<Harness value="a" />);

    await user.click(screen.getByRole('button', { name: '测试选择' }));
    expect(screen.getByRole('option', { name: '选项 A' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: '选项 C' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('键盘导航：ArrowDown 打开并移动高亮，Enter 选中', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const trigger = screen.getByRole('button', { name: '测试选择' });
    await user.click(trigger);

    const list = screen.getByRole('listbox');
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(onChange).toHaveBeenCalledWith('b');
    expect(list).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent('选项 B');
  });

  it('Escape 关闭列表且不改变选中值', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness value="c" onChange={onChange} />);

    const trigger = screen.getByRole('button', { name: '测试选择' });
    await user.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger).toHaveTextContent('选项 C');
  });

  it('点击组件外部关闭列表', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Harness />
        <button type="button">外部按钮</button>
      </div>,
    );

    await user.click(screen.getByRole('button', { name: '测试选择' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '外部按钮' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('空选项可恢复为未选择状态', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness value="a" onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: '测试选择' }));
    await user.click(screen.getByRole('option', { name: '请选择' }));

    expect(onChange).toHaveBeenCalledWith('');
    expect(screen.getByRole('button', { name: '测试选择' })).toHaveTextContent('请选择');
  });

  it('disabled 时不可展开', async () => {
    const user = userEvent.setup();
    render(
      <Select
        value=""
        options={OPTIONS}
        onChange={vi.fn()}
        ariaLabel="测试选择"
        placeholder="请选择"
        disabled
      />,
    );

    const trigger = screen.getByRole('button', { name: '测试选择' });
    expect(trigger).toBeDisabled();
    await user.click(trigger);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
