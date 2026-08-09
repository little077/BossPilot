// ─── Composer：基于 tiptap 的对话输入框 ───
// 交互参考 RedScope 的 AgentComposer：卡片容器 + 聚焦光晕 + Enter 发送。
// 使用 tiptap 而非 textarea：占位符体验更好、自动增高、后续可扩展 @提及/斜杠命令。

import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { ArrowUp, Square } from 'lucide-react';
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface ComposerHandle {
  /** 外部填入文本（示例 chips 用），并聚焦到末尾 */
  setText: (text: string) => void;
  focus: () => void;
}

interface ComposerProps {
  onSend: (text: string) => void;
  running?: boolean;
  disabled?: boolean;
  onCancel?: () => void;
  autoFocus?: boolean;
  /** 发送后是否清空内容（首页沉底期间保留文字，切屏时随组件卸载） */
  clearOnSend?: boolean;
  className?: string;
  /** Ask User 等待态：普通输入保持可见但不可编辑，答案只能从上方暂停面板提交。 */
  waitingForAnswer?: boolean;
  ref?: Ref<ComposerHandle>;
}

export function Composer({
  onSend,
  running = false,
  disabled = false,
  onCancel,
  autoFocus = false,
  clearOnSend = true,
  className = '',
  waitingForAnswer = false,
  ref,
}: ComposerProps) {
  const [empty, setEmpty] = useState(true);

  // 回调与状态放进 ref，让 editor 只创建一次也能拿到最新值
  const submitRef = useRef<() => void>(() => {});
  const placeholderRef = useRef('');
  placeholderRef.current = waitingForAnswer
    ? 'Agent 正在等待上方问题的回答…'
    : running
      ? '正在生成，可点击右侧停止…'
      : disabled
        ? '正在连接 BossPilot…'
        : '输入消息，Enter 发送';

  const editor = useEditor({
    extensions: [
      // 聊天输入只要纯文本 + 换行，关闭所有富文本能力
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
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
    ],
    editorProps: {
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          // 中文输入法候选确认的回车不触发发送
          if (event.isComposing || event.keyCode === 229) return false;
          submitRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => setEmpty(e.isEmpty),
    autofocus: autoFocus ? 'end' : false,
  });

  submitRef.current = () => {
    if (!editor || running || disabled) return;
    const text = editor.getText({ blockSeparator: '\n' }).trim();
    if (!text) return;
    onSend(text);
    if (clearOnSend) editor.commands.clearContent(true);
  };

  // 任务执行中锁定编辑
  useEffect(() => {
    editor?.setEditable(!running && !disabled && !waitingForAnswer);
  }, [disabled, editor, running, waitingForAnswer]);

  useImperativeHandle(ref, () => ({
    setText: (text: string) => {
      if (!editor) return;
      editor.chain().clearContent().insertContent({ type: 'text', text }).focus('end').run();
    },
    focus: () => editor?.commands.focus('end'),
  }));

  return (
    <section
      className={`composer-card rounded-2xl border border-line bg-surface transition-all duration-200 focus-within:border-brand/60 focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-brand)_10%,transparent)] ${
        running ? 'border-brand/40' : ''
      } ${className}`}
    >
      <EditorContent editor={editor} className="composer-editor" />
      <footer className="flex items-center justify-between gap-2 px-2.5 pb-2">
        <span className={`text-[10px] ${waitingForAnswer ? 'text-warning' : 'text-ink-faint'}`}>
          {waitingForAnswer ? '回答后会从当前步骤继续' : 'Enter 发送 · Shift+Enter 换行'}
        </span>
        {running ? (
          <button
            type="button"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-danger/10 text-danger transition-all duration-200 hover:bg-danger/20 hover:shadow-sm active:scale-95"
            title="停止生成"
            aria-label="停止生成"
            onClick={onCancel}
            disabled={disabled}
          >
            <Square size={12} className="fill-current" />
          </button>
        ) : (
          <button
            type="button"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand text-white transition-all duration-200 hover:bg-brand-strong hover:shadow-[0_4px_12px_color-mix(in_srgb,var(--color-brand)_35%,transparent)] active:scale-95 disabled:opacity-40 disabled:hover:shadow-none"
            disabled={empty || disabled}
            title="发送"
            onClick={() => submitRef.current()}
          >
            <ArrowUp size={14} />
          </button>
        )}
      </footer>
    </section>
  );
}
