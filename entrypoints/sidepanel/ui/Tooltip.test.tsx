import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './Tooltip';

function TooltipExample({ side = 'top' }: { side?: 'top' | 'bottom' }) {
  return (
    <TooltipProvider delayDuration={0} disableHoverableContent>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button">目标</button>
        </TooltipTrigger>
        <TooltipContent side={side}>技能描述</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

describe('shadcn Tooltip', () => {
  it('鼠标悬停时展示提示，移出后隐藏', async () => {
    const user = userEvent.setup();
    render(<TooltipExample />);
    const trigger = screen.getByRole('button', { name: '目标' });

    await user.hover(trigger);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('技能描述');

    await user.unhover(trigger);
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('键盘聚焦时展示提示', async () => {
    const user = userEvent.setup();
    render(<TooltipExample side="bottom" />);

    await user.tab();
    expect(screen.getByRole('button', { name: '目标' })).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('技能描述');
  });

  it('允许通过 className 扩展 shadcn 内容样式', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button">目标</button>
          </TooltipTrigger>
          <TooltipContent className="max-w-48 whitespace-normal text-left">
            一段较长的完整描述
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.hover(screen.getByRole('button', { name: '目标' }));
    expect(await screen.findByRole('tooltip')).toHaveClass('max-w-48', 'whitespace-normal');
  });
});
