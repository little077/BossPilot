import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SkillPackage } from '@/lib/skills/types';
import { SkillEditor } from './SkillEditor';

function skill(readOnly = false, markdown = validMarkdown()): SkillPackage {
  return {
    name: 'local-skill',
    definition: {
      name: 'local-skill',
      description: 'Local workflow',
      instructions: '# Workflow',
      version: '1.0.0',
      builtIn: readOnly,
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
  };
}

function validMarkdown() {
  return `---\nname: local-skill\ndescription: Local workflow\n---\n# Workflow`;
}

describe('SkillEditor', () => {
  it('adds and removes a safe file, then saves all files', async () => {
    const onSave = vi.fn(async () => undefined);
    vi.spyOn(window, 'prompt').mockReturnValueOnce('references/guide.md');
    render(<SkillEditor skill={skill()} readOnly={false} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: '新建文件' }));
    expect(screen.getByRole('button', { name: /references\/guide.md/ })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '保存 Skill' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ path: 'references/guide.md' })]),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '删除文件' }));
    expect(screen.queryByRole('button', { name: /references\/guide.md/ })).toBeNull();
  });

  it('locates frontmatter errors and prevents saving', () => {
    render(
      <SkillEditor
        skill={skill(false, '---\nname: wrong-name\ndescription: Test\n---\n# Workflow')}
        readOnly={false}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('第 1 行');
    expect(screen.getByRole('button', { name: '保存 Skill' })).toBeDisabled();
  });

  it('rejects unsafe paths and reports save failures', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('磁盘不可用');
    });
    vi.spyOn(window, 'prompt').mockReturnValueOnce('../secret.md');
    render(<SkillEditor skill={skill()} readOnly={false} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: '新建文件' }));
    expect(screen.getByRole('status')).toHaveTextContent('路径无效');
    fireEvent.click(screen.getByRole('button', { name: '保存 Skill' }));
    expect(await screen.findByText('磁盘不可用')).toBeVisible();
  });

  it('renders built-in packages read-only and closes without mutation', () => {
    const close = vi.fn();
    render(<SkillEditor skill={skill(true)} readOnly onClose={close} onSave={vi.fn()} />);
    expect(screen.getByText('内置 Skill · 只读')).toBeVisible();
    expect(screen.queryByRole('button', { name: '保存 Skill' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭 Skill 编辑器' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps binary assets visible without exposing a text editor', () => {
    const binary = skill();
    binary.files.push({
      path: 'assets/icon.png',
      kind: 'binary',
      content: 'AQID',
      mimeType: 'image/png',
      size: 3,
    });
    render(<SkillEditor skill={binary} readOnly={false} onClose={vi.fn()} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /assets\/icon.png/ }));
    expect(screen.getByText(/二进制资源只支持保留和导出/)).toBeVisible();
  });

  it('propagates CodeMirror document changes into the saved package', async () => {
    const onSave = vi.fn(async () => undefined);
    const view = render(
      <SkillEditor skill={skill()} readOnly={false} onClose={vi.fn()} onSave={onSave} />,
    );
    const editorElement = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>('.cm-editor');
      if (!element) throw new Error('editor not ready');
      return element;
    });
    const editor = EditorView.findFromDOM(editorElement);
    if (!editor) throw new Error('editor view not ready');
    await act(async () => {
      editor.dispatch({ changes: { from: editor.state.doc.length, insert: '\n\nUpdated.' } });
    });
    await waitFor(() =>
      expect(view.container.querySelector('.cm-content')).toHaveTextContent('Updated.'),
    );
    fireEvent.click(screen.getByRole('button', { name: '保存 Skill' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith([
        expect.objectContaining({ content: expect.stringContaining('Updated.') }),
      ]),
    );
  });
});
