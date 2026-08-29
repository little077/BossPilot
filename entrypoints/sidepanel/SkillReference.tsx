// ─── Composer Skill 引用节点 ───
// Skill 在编辑器里是不可拆分的结构化节点，但发给模型时仍序列化为原有中文提示语义。
// NodeView 渲染 chip：悬停显示 × 删除按钮（点击直接移除节点）与技能描述 tooltip。
// Tooltip 直接使用 shadcn 标准组合 API。description 属性随 JSON/HTML 持久化，
// 空值不输出 data-skill-description，保证既有 getHTML 断言（name 与 data-type 相邻）。

import { mergeAttributes, Node } from '@tiptap/core';
import { type NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/Tooltip';

/** chip 视图：× 删除按钮 + / + 名称，整体可 hover 出技能描述 tooltip。 */
export function SkillReferenceView({ node, editor, getPos }: NodeViewProps) {
  const name = String(node.attrs.name ?? '');
  const description = String(node.attrs.description ?? '');

  const remove = () => {
    if (typeof getPos !== 'function') return;
    const from = getPos();
    if (from == null) return;
    editor
      .chain()
      .focus()
      .deleteRange({ from, to: from + node.nodeSize })
      .run();
  };

  const chip = (
    <NodeViewWrapper as="span" data-type="skill-reference" className="composer-skill-reference">
      <button
        type="button"
        className="composer-skill-remove"
        aria-label={`移除技能 ${name}`}
        // mousedown preventDefault：避免 ProseMirror 把点击当成选区操作
        onMouseDown={(event) => event.preventDefault()}
        onClick={remove}
      >
        <X size={10} strokeWidth={2.2} aria-hidden="true" />
      </button>
      <span className="composer-skill-slash" aria-hidden="true">
        /
      </span>
      <span className="composer-skill-name">{name}</span>
    </NodeViewWrapper>
  );

  if (!description) return chip;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent className="max-w-60 whitespace-normal text-left">
        /{name}：{description}
      </TooltipContent>
    </Tooltip>
  );
}

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
      description: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-skill-description') ?? '',
        // 空值输出空对象：HTML 里不冗余 data-skill-description=""
        renderHTML: (attributes) =>
          attributes.description ? { 'data-skill-description': attributes.description } : {},
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

  addNodeView() {
    return ReactNodeViewRenderer(SkillReferenceView);
  },
});
