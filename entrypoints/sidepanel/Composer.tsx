// ─── Composer：基于 tiptap 的对话输入框 ───
// 交互沿用主分支的 AgentComposer 卡片：圆角卡容器 + 聚焦光晕 + Enter 发送。
// 用 tiptap 而非 textarea：占位符体验更好、自动增高。Demo 阶段只要纯文本 + 换行，
// 因此关闭 StarterKit 全部富文本能力，也不接附件/技能/语音等扩展。

import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { ArrowUp, Square } from 'lucide-react';
import { useRef, useState } from 'react';

interface ComposerProps {
  onSend: (text: string) => boolean;
  running?: boolean;
  disabled?: boolean;
  onCancel?: () => void;
}

export function Composer({ onSend, running = false, disabled = false, onCancel }: ComposerProps) {
  const [empty, setEmpty] = useState(true);
  // 运行中或断连时禁止编辑：把最新状态放进 ref，editor 只创建一次也能读到。
  const submitRef = useRef<() => void>(() => {});

  const placeholder = disabled
    ? '正在连接后台…'
    : running
      ? '正在生成，可点击右侧停止…'
      : '输入消息，Enter 发送，Shift+Enter 换行';

  const editor = useEditor({
    extensions: [
      // 聊天输入只要纯文本 + 换行，关闭所有富文本能力。
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        bold: false,
        italic: false,
        strike: false,
        code: false,
        link: false,
        underline: false,
      }),
      Placeholder.configure({ placeholder }),
    ],
    editorProps: {
      attributes: {
        'aria-label': '输入消息',
        'aria-multiline': 'true',
      },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          // 中文输入法候选确认的回车不触发发送。
          if (event.isComposing || event.keyCode === 229) return false;
          submitRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => setEmpty(e.isEmpty),
    onCreate: ({ editor: e }) => setEmpty(e.isEmpty),
    autofocus: true,
  });

  submitRef.current = () => {
    if (!editor || running || disabled) return;
    const text = editor.getText({ blockSeparator: '\n' }).trim();
    if (!text) return;
    if (onSend(text)) {
      editor.commands.clearContent(true);
      setEmpty(true);
    }
  };

  const canSend = !empty && !disabled && !running;

  return (
    <section
      className={`composer-card relative rounded-2xl border border-line bg-surface transition-all duration-200 focus-within:border-brand/60 focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-brand)_10%,transparent)] ${
        running ? 'border-brand/40' : ''
      }`}
      aria-label="消息输入"
    >
      <EditorContent editor={editor} className="composer-editor" />
      <footer className="flex items-center justify-end gap-1.5 px-2.5 pb-2">
        {running ? (
          <button
            type="button"
            onClick={onCancel}
            aria-label="停止生成"
            title="停止生成"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-danger/10 text-danger transition-all duration-200 hover:bg-danger/20 hover:shadow-sm active:scale-95"
          >
            <Square size={12} className="fill-current" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => submitRef.current()}
            disabled={!canSend}
            aria-label="发送"
            title="发送"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand text-white transition-all duration-200 hover:bg-brand-strong hover:shadow-[0_4px_12px_color-mix(in_srgb,var(--color-brand)_35%,transparent)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:shadow-none"
          >
            <ArrowUp size={14} aria-hidden />
          </button>
        )}
      </footer>
    </section>
  );
}
