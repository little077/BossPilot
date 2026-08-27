import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillReference } from './SkillReference';

let editor: Editor | undefined;

afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

describe('SkillReference', () => {
  it('renders an inline atom while preserving the existing model-facing text', () => {
    editor = new Editor({ extensions: [StarterKit, SkillReference] });

    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'skillReference', attrs: { name: 'boss-job-search' } },
            { type: 'text', text: ' 帮我筛选岗位' },
          ],
        },
      ],
    });

    expect(editor.schema.nodes.skillReference?.isInline).toBe(true);
    expect(editor.schema.nodes.skillReference?.isAtom).toBe(true);
    expect(editor.getText()).toBe('用 boss-job-search 技能： 帮我筛选岗位');
    expect(editor.getHTML()).toContain(
      'data-skill-name="boss-job-search" data-type="skill-reference"',
    );
    expect(editor.getHTML()).toContain('class="composer-skill-slash"');
  });

  it('restores the structured node from persisted HTML', () => {
    editor = new Editor({ extensions: [StarterKit, SkillReference] });

    editor.commands.setContent(
      '<p><span data-type="skill-reference" data-skill-name="xhs-note-scout">/xhs-note-scout</span></p>',
    );

    expect(editor.getJSON()).toMatchObject({
      content: [
        {
          content: [{ type: 'skillReference', attrs: { name: 'xhs-note-scout' } }],
        },
      ],
    });
    expect(editor.getText()).toBe('用 xhs-note-scout 技能：');
  });
});
