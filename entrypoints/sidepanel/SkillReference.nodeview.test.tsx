// ─── SkillReference NodeView 测试 ───
// 覆盖：chip 渲染（data-type 属性保留、名称文本）、× 删除按钮点击直接移除节点、
// hover 节点显示技能描述 tooltip（使用 shadcn Tooltip 组合 API）。

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/core';
import { EditorContent, type NodeViewProps, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillReference, SkillReferenceView } from './SkillReference';
import { TooltipProvider } from './ui/Tooltip';

const HTML_CONTENT =
  '<p><span data-type="skill-reference" data-skill-name="resume-analyzer" data-skill-description="分析简历与 JD 匹配度">/resume-analyzer</span> 帮我看看</p>';

function TestEditor({ onReady }: { onReady: (editor: Editor) => void }) {
  const editor = useEditor({
    extensions: [StarterKit, SkillReference],
    content: HTML_CONTENT,
  });
  useEffect(() => {
    if (editor) onReady(editor);
  }, [editor, onReady]);
  return editor ? (
    <TooltipProvider delayDuration={0}>
      <EditorContent editor={editor} />
    </TooltipProvider>
  ) : null;
}

beforeEach(() => {
  // prosemirror-view 依赖的布局 API 在 jsdom 下缺失，补桩避免选区定位崩溃
  // （与 Composer.test.tsx 同一模式：scrollToSelection → coordsAtPos）
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

describe('SkillReference NodeView', () => {
  it('渲染 chip：保留 data-type 属性与名称文本，并提供移除按钮', async () => {
    const editorRef: { current: Editor | null } = { current: null };
    render(<TestEditor onReady={(editor) => (editorRef.current = editor)} />);
    await waitFor(() => expect(editorRef.current).not.toBeNull());

    const chip = document.querySelector('[data-type="skill-reference"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('resume-analyzer');
    expect(screen.getByRole('button', { name: '移除技能 resume-analyzer' })).toBeTruthy();
  });

  it('点击 × 直接删除技能节点，其余输入保留', async () => {
    const editorRef: { current: Editor | null } = { current: null };
    render(<TestEditor onReady={(editor) => (editorRef.current = editor)} />);
    await waitFor(() => expect(editorRef.current).not.toBeNull());

    const removeButton = screen.getByRole('button', { name: '移除技能 resume-analyzer' });
    // mousedown preventDefault 与 click 删除都真实触发（与用户交互一致）
    fireEvent.mouseDown(removeButton);
    fireEvent.click(removeButton);
    await waitFor(() => {
      expect(document.querySelector('[data-type="skill-reference"]')).toBeNull();
    });
    expect(editorRef.current?.getText()).toContain('帮我看看');
    expect(editorRef.current?.getText()).not.toContain('resume-analyzer');
  });

  it('hover 节点显示技能描述 tooltip（多行完整描述）', async () => {
    const user = userEvent.setup();
    render(<TestEditor onReady={vi.fn()} />);
    // chip 内 / 与名称分属两个子 span，按 data-type 定位整体节点再 hover
    await waitFor(() => {
      expect(document.querySelector('[data-type="skill-reference"]')).not.toBeNull();
    });
    const chip = document.querySelector('[data-type="skill-reference"]') as HTMLElement;
    await user.hover(chip);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('resume-analyzer');
    expect(tooltip.textContent).toContain('分析简历与 JD 匹配度');
    expect(tooltip).toHaveClass('whitespace-normal', 'text-left');
  });

  it('description 为空时不包 Tooltip，直接渲染 chip', () => {
    const chain = {
      focus: vi.fn().mockReturnThis(),
      deleteRange: vi.fn().mockReturnThis(),
      run: vi.fn(),
    };
    const editor = { chain: vi.fn(() => chain) } as unknown as Editor;
    // attrs 缺省（undefined）：name/description 兜底为空串，无描述时不渲染 Tooltip
    const node = { attrs: {}, nodeSize: 3 } as never;
    render(
      <TooltipProvider delayDuration={0}>
        <SkillReferenceView {...({ node, editor, getPos: () => 0 } as unknown as NodeViewProps)} />
      </TooltipProvider>,
    );
    expect(document.querySelector('[data-type="skill-reference"]')).not.toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('getPos 异常（undefined）时不执行删除', () => {
    const chain = {
      focus: vi.fn().mockReturnThis(),
      deleteRange: vi.fn().mockReturnThis(),
      run: vi.fn(),
    };
    const editor = { chain: vi.fn(() => chain) } as unknown as Editor;
    const node = { attrs: { name: 'x', description: 'y' }, nodeSize: 3 } as never;
    render(
      <TooltipProvider delayDuration={0}>
        <SkillReferenceView
          {...({ node, editor, getPos: () => undefined as never } as unknown as NodeViewProps)}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '移除技能 x' }));
    expect(editor.chain).not.toHaveBeenCalled();
  });

  it('getPos 缺失时不执行删除', () => {
    const chain = {
      focus: vi.fn().mockReturnThis(),
      deleteRange: vi.fn().mockReturnThis(),
      run: vi.fn(),
    };
    const editor = { chain: vi.fn(() => chain) } as unknown as Editor;
    const node = { attrs: { name: 'x', description: 'y' }, nodeSize: 3 } as never;
    render(
      <TooltipProvider delayDuration={0}>
        <SkillReferenceView
          {...({ node, editor, getPos: undefined as never } as unknown as NodeViewProps)}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '移除技能 x' }));
    expect(editor.chain).not.toHaveBeenCalled();
  });
});
