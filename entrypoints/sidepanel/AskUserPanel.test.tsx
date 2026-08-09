import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PendingUserQuestion } from '@/lib/domain/types';
import { AskUserPanel } from './AskUserPanel';

const QUESTION: PendingUserQuestion = {
  requestId: 'request-1',
  callId: 'call-1',
  question: '你更方便哪一天？',
  options: [
    { id: 'option-1', label: '周六' },
    { id: 'option-2', label: '周日' },
  ],
  allowCustom: true,
  customPlaceholder: '例如：周日下午',
};

describe('AskUserPanel', () => {
  it('submits a selected option and exposes an explicit task cancellation', async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn().mockResolvedValue(true);
    const onCancel = vi.fn();
    render(<AskUserPanel question={QUESTION} onContinue={onContinue} onCancel={onCancel} />);

    const continueButton = screen.getByRole('button', { name: '继续执行' });
    expect(continueButton).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: '周日' }));
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);
    expect(onContinue).toHaveBeenCalledWith('周日');

    render(
      <AskUserPanel
        question={{ ...QUESTION, callId: 'call-2' }}
        onContinue={onContinue}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getAllByRole('button', { name: '取消任务' }).at(-1) as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('lets a custom answer override a selected option and supports Enter', async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn().mockResolvedValue(true);
    render(<AskUserPanel question={QUESTION} onContinue={onContinue} onCancel={vi.fn()} />);

    const option = screen.getByRole('radio', { name: '周六' });
    await user.click(option);
    const input = screen.getByLabelText('或者自定义回答');
    await user.type(input, '周日下午两点以后{enter}');

    expect(option).not.toBeChecked();
    expect(onContinue).toHaveBeenCalledWith('周日下午两点以后');
  });

  it('keeps the pause actionable when sending the answer fails', async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn().mockResolvedValue(false);
    render(<AskUserPanel question={QUESTION} onContinue={onContinue} onCancel={vi.fn()} />);

    await user.click(screen.getByRole('radio', { name: '周六' }));
    await user.click(screen.getByRole('button', { name: '继续执行' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('连接暂不可用'));
    expect(screen.getByRole('button', { name: '继续执行' })).toBeEnabled();
  });
});
