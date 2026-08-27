// ─── Composer Skill 引用节点 ───
// Skill 在编辑器里是不可拆分的结构化节点，但发给模型时仍序列化为原有中文提示语义。

import { mergeAttributes, Node } from '@tiptap/core';

export const SkillReference = Node.create({
  name: 'skillReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      name: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-skill-name') ?? '',
        renderHTML: (attributes) => ({ 'data-skill-name': attributes.name }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="skill-reference"]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'skill-reference',
        class: 'composer-skill-reference',
      }),
      ['span', { class: 'composer-skill-slash', 'aria-hidden': 'true' }, '/'],
      ['span', { class: 'composer-skill-name' }, node.attrs.name],
    ];
  },

  renderText({ node }) {
    return `用 ${node.attrs.name} 技能：`;
  },
});
