import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillCatalogEntry } from '@/lib/skills/types';
import { Composer, type ComposerHandle } from './Composer';

const SKILLS: SkillCatalogEntry[] = [
  {
    name: 'resume-analyzer',
    description: '分析简历与 JD 匹配度',
    version: '1.0.0',
    builtIn: true,
    enabled: true,
    capabilities: [],
    fileCount: 1,
  },
];

const { sendSkillCommandMock } = vi.hoisted(() => ({
  sendSkillCommandMock: vi.fn(),
}));

vi.mock('@/lib/skills/client', () => ({
  sendSkillCommand: sendSkillCommandMock,
}));

beforeEach(() => {
  sendSkillCommandMock.mockReset().mockResolvedValue({
    version: 2,
    skills: SKILLS,
    grants: [],
  });
  // prosemirror-view 依赖的布局 API 在 jsdom 下缺失，补桩避免选区定位崩溃
  // （scrollToSelection → coordsAtPos 会对 textRange 创建的 Range 调用 getClientRects）
  document.elementFromPoint = () => null;
  Object.defineProperty(Text.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0 }),
  });
});

describe('Composer 技能引用', () => {
  it('已有输入时选择技能：内容保留，技能节点插入光标处', async () => {
    render(<Composer onSend={vi.fn().mockResolvedValue(true)} />);
    const editor = await screen.findByRole('textbox');
    // 等待技能列表加载完成（斜杠检测依赖 slashSkillsRef 已填充）
    await waitFor(() => expect(sendSkillCommandMock).toHaveBeenCalled());

    await userEvent.type(editor, '帮我看看这篇笔记');
    fireEvent.click(screen.getByRole('combobox', { name: '选择技能' }));
    fireEvent.click(screen.getByRole('option', { name: /resume-analyzer/ }));

    await waitFor(() => {
      expect(editor.textContent).toContain('帮我看看这篇笔记');
      expect(editor.textContent).toContain('resume-analyzer');
    });
    // 技能引用是结构化 inline 节点而非纯文本
    expect(editor.querySelector('[data-type="skill-reference"]')).not.toBeNull();
  });

  it('斜杠触发选择技能：斜杠词被替换为节点，不残留游离文本', async () => {
    const ref = createRef<ComposerHandle>();
    render(<Composer ref={ref} onSend={vi.fn().mockResolvedValue(true)} />);
    const editor = await screen.findByRole('textbox');
    await waitFor(() => expect(sendSkillCommandMock).toHaveBeenCalled());
    // 全量测试负载下 userEvent.type 逐字符输入会丢事件（编辑器只能收到部分字符），
    // 改用 ref handle 一次性写入：单事务、确定性强，同样会触发 onUpdate 斜杠检测。
    act(() => ref.current?.setText('/resume'));
    // 斜杠触发技能菜单自动打开（高亮会向 accessible name 插入匹配词，按文本内容断言）
    const option = await screen.findByRole('option');
    expect(option.textContent).toContain('resume-analyzer');
    fireEvent.click(option);

    await waitFor(() => {
      expect(editor.querySelector('[data-type="skill-reference"]')).not.toBeNull();
      expect(editor.textContent).toContain('resume-analyzer');
    });
  });
});
