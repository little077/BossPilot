import { fireEvent, render, screen } from '@testing-library/react';
import { type ComponentProps, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillCatalogEntry } from '@/lib/skills/types';
import { SkillPicker } from './SkillPicker';
import { TooltipProvider } from './ui/Tooltip';

const SKILLS: SkillCatalogEntry[] = [
  {
    name: 'boss-job-search',
    description: '搜索并匹配目标职位',
    version: '1.0.0',
    builtIn: true,
    enabled: true,
    capabilities: [],
    fileCount: 2,
  },
  {
    name: 'resume-analyzer',
    description: '分析简历与 JD 匹配度',
    version: '1.0.0',
    builtIn: true,
    enabled: true,
    capabilities: [],
    fileCount: 1,
  },
  {
    name: 'career-advisor',
    description: '职业路径规划建议',
    version: '1.0.0',
    builtIn: true,
    enabled: true,
    capabilities: [],
    fileCount: 1,
  },
];

/** 受控宿主：模拟父组件持有 open 状态（与 Composer 的用法一致）。 */
function Harness(props: Partial<ComponentProps<typeof SkillPicker>> = {}) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider delayDuration={0}>
      <SkillPicker
        skills={SKILLS}
        open={open}
        onOpenChange={setOpen}
        onSelect={vi.fn()}
        {...props}
      />
    </TooltipProvider>
  );
}

beforeEach(() => {
  // jsdom 未实现 scrollIntoView，菜单打开时选中项滚入视野会调用它。
  Element.prototype.scrollIntoView = vi.fn();
});

describe('SkillPicker', () => {
  it('渲染触发器，菜单默认关闭', () => {
    render(<Harness />);
    expect(screen.getByRole('combobox', { name: '选择技能' })).toBeVisible();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('点击触发器打开菜单，列出全部技能', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox', { name: '选择技能' }));
    expect(screen.getByRole('listbox', { name: '技能列表' })).toBeVisible();
    expect(screen.getByRole('option', { name: /boss-job-search/ })).toBeVisible();
    expect(screen.getByRole('option', { name: /resume-analyzer/ })).toBeVisible();
  });

  it('选中技能后回调 onSelect', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('combobox', { name: '选择技能' }));
    fireEvent.click(screen.getByRole('option', { name: /boss-job-search/ }));
    expect(onSelect).toHaveBeenCalledWith(SKILLS[0]);
  });

  it('触发器固定显示「技能」，不随选择变化（无下拉箭头）', () => {
    render(<Harness />);
    const trigger = screen.getByRole('combobox', { name: '选择技能' });
    expect(trigger).toHaveTextContent('技能');
    expect(trigger.querySelector('svg')).toBeNull();
    expect(trigger).not.toHaveTextContent('/');
  });

  it('搜索按名称/描述实时过滤，匹配段只加粗不着色', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox', { name: '选择技能' }));
    const input = screen.getByRole('textbox', { name: '搜索技能' });
    // 过滤词命中描述（无名称高亮，accessible name 无空格干扰）
    fireEvent.change(input, { target: { value: '简历' } });
    expect(screen.getByRole('option', { name: /resume/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: /boss/ })).not.toBeInTheDocument();

    // 过滤词命中名称（accessible name 在元素边界插入空格，按词断言）
    fireEvent.change(input, { target: { value: 'job' } });
    const option = screen.getByRole('option', { name: /boss/ });
    expect(option.querySelector('strong')?.textContent).toBe('job');
    expect(option.querySelector('mark')).toBeNull();
    expect(screen.queryByRole('option', { name: /career/ })).not.toBeInTheDocument();
  });

  it('打开时带入 initialQuery（斜杠触发语义）', () => {
    render(
      <TooltipProvider delayDuration={0}>
        <SkillPicker
          skills={SKILLS}
          open
          initialQuery="resume"
          onOpenChange={vi.fn()}
          onSelect={vi.fn()}
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole('textbox', { name: '搜索技能' })).toHaveValue('resume');
    expect(screen.getByRole('option', { name: /resume/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: /boss/ })).not.toBeInTheDocument();
  });

  it('↑↓ 循环导航，Enter 执行当前项', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('combobox', { name: '选择技能' }));
    const input = screen.getByRole('textbox', { name: '搜索技能' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /resume-analyzer/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(SKILLS[1]);
  });

  it('无匹配时显示空状态', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox', { name: '选择技能' }));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索技能' }), {
      target: { value: '不存在的技能' },
    });
    expect(screen.getByText('没有匹配的技能')).toBeVisible();
  });

  it('Esc 两级关闭：先清空搜索回到全列表，再按才关闭', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox', { name: '选择技能' }));
    const input = screen.getByRole('textbox', { name: '搜索技能' });
    fireEvent.change(input, { target: { value: 'resume' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByRole('textbox', { name: '搜索技能' })).toHaveValue('');
    expect(screen.getByRole('option', { name: /boss-job-search/ })).toBeVisible();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('点击面板外关闭菜单', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox', { name: '选择技能' }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('disabled 时触发器不可点击', () => {
    render(<Harness disabled />);
    expect(screen.getByRole('combobox', { name: '选择技能' })).toBeDisabled();
  });
});
