// ─── Composer：基于 tiptap 的对话输入框 ───
// 交互参考 RedScope 的 AgentComposer：卡片容器 + 聚焦光晕 + Enter 发送。
// 使用 tiptap 而非 textarea：占位符体验更好、自动增高、后续可扩展 @提及/斜杠命令。

import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { ArrowUp, FileText, Image, Paperclip, ScanText, Square, X } from 'lucide-react';
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  attachmentFromFile,
  MAX_ATTACHMENTS,
  selectionAttachment,
  validateAttachmentSet,
} from '@/lib/attachments/input';
import type { ChatAttachment } from '@/lib/domain/chat';

export interface ComposerHandle {
  /** 外部填入文本（示例 chips 用），并聚焦到末尾 */
  setText: (text: string) => void;
  focus: () => void;
}

interface ComposerProps {
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  running?: boolean;
  /** 运行中允许发送纯文本约束；附件仍需等下一轮。 */
  allowSteering?: boolean;
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
  allowSteering = false,
  disabled = false,
  onCancel,
  autoFocus = false,
  clearOnSend = true,
  className = '',
  waitingForAnswer = false,
  ref,
}: ComposerProps) {
  const [empty, setEmpty] = useState(true);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [readingAttachment, setReadingAttachment] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 回调与状态放进 ref，让 editor 只创建一次也能拿到最新值
  const submitRef = useRef<() => void>(() => {});
  const placeholderRef = useRef('');
  placeholderRef.current = waitingForAnswer
    ? 'Agent 正在等待上方问题的回答…'
    : running
      ? allowSteering
        ? '可追加约束，Agent 会在安全步骤后调整…'
        : '正在生成，可点击右侧停止…'
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
    if (!editor || (running && !allowSteering) || disabled) return;
    const text = editor.getText({ blockSeparator: '\n' }).trim();
    if (!text && attachments.length === 0) return;
    onSend(text || '请分析我附加的内容。', attachments);
    if (clearOnSend) {
      editor.commands.clearContent(true);
      setAttachments([]);
    }
  };

  // 允许 steering 时运行中仍可编辑，但附件操作保持锁定。
  useEffect(() => {
    editor?.setEditable((!running || allowSteering) && !disabled && !waitingForAnswer);
  }, [allowSteering, disabled, editor, running, waitingForAnswer]);

  useImperativeHandle(ref, () => ({
    setText: (text: string) => {
      if (!editor) return;
      editor.chain().clearContent().insertContent({ type: 'text', text }).focus('end').run();
    },
    focus: () => editor?.commands.focus('end'),
  }));

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setReadingAttachment(true);
    setAttachmentError('');
    try {
      const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
      if (files.length > room) throw new Error('每条消息最多添加 3 个附件。');
      const added = await Promise.all([...files].map(attachmentFromFile));
      const next = [...attachments, ...added];
      validateAttachmentSet(next);
      setAttachments(next);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : '附件读取失败。');
    } finally {
      setReadingAttachment(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const addSelection = async () => {
    setAttachmentError('');
    try {
      if (attachments.length >= MAX_ATTACHMENTS) throw new Error('每条消息最多添加 3 个附件。');
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id === undefined) throw new Error('没有可读取的当前页面。');
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: captureSelectionInPage,
      });
      if (!result?.result) throw new Error('无法读取当前页面选区。');
      const next = [...attachments, selectionAttachment(result.result)];
      validateAttachmentSet(next);
      setAttachments(next);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : '无法读取当前页面选区。');
    }
  };

  return (
    <section
      className={`composer-card rounded-2xl border border-line bg-surface transition-all duration-200 focus-within:border-brand/60 focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-brand)_10%,transparent)] ${
        running ? 'border-brand/40' : ''
      } ${className}`}
    >
      <EditorContent editor={editor} className="composer-editor" />
      {attachments.length ? (
        <fieldset className="composer-attachments" aria-label="待发送附件">
          {attachments.map((attachment) => (
            <span key={attachment.id} className="composer-attachment">
              {attachment.kind === 'image' ? <Image size={10} /> : <FileText size={10} />}
              <span>{attachment.name}</span>
              <button
                type="button"
                aria-label={`移除附件 ${attachment.name}`}
                onClick={() =>
                  setAttachments((current) => current.filter(({ id }) => id !== attachment.id))
                }
              >
                <X size={9} />
              </button>
            </span>
          ))}
        </fieldset>
      ) : null}
      {attachmentError ? (
        <div className="composer-attachment-error" role="status">
          {attachmentError}
        </div>
      ) : null}
      <footer className="flex items-center justify-between gap-2 px-2.5 pb-2">
        <div className="composer-tools">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="sr-only"
            aria-label="选择附件文件"
            accept="image/jpeg,image/png,image/webp,.txt,.md,.markdown,.json,.csv"
            onChange={(event) => void addFiles(event.target.files)}
          />
          <button
            type="button"
            aria-label="添加图片或文本文件"
            title="添加图片或文本文件"
            disabled={running || disabled || waitingForAnswer || readingAttachment}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={11} />
          </button>
          <button
            type="button"
            aria-label="附加当前页选中文本"
            title="附加当前页选中文本"
            disabled={running || disabled || waitingForAnswer || readingAttachment}
            onClick={() => void addSelection()}
          >
            <ScanText size={11} />
          </button>
          <span className={`text-[10px] ${waitingForAnswer ? 'text-warning' : 'text-ink-faint'}`}>
            {waitingForAnswer ? '回答后会从当前步骤继续' : 'Enter 发送'}
          </span>
        </div>
        {running ? (
          <div className="flex items-center gap-1">
            {allowSteering ? (
              <button
                type="button"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand text-white transition-all duration-200 active:scale-95 disabled:opacity-40"
                disabled={empty || disabled}
                title="追加指令"
                aria-label="追加指令"
                onClick={() => submitRef.current()}
              >
                <ArrowUp size={14} />
              </button>
            ) : null}
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
          </div>
        ) : (
          <button
            type="button"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand text-white transition-all duration-200 hover:bg-brand-strong hover:shadow-[0_4px_12px_color-mix(in_srgb,var(--color-brand)_35%,transparent)] active:scale-95 disabled:opacity-40 disabled:hover:shadow-none"
            disabled={(empty && attachments.length === 0) || disabled}
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

function captureSelectionInPage(): { text: string; origin: string; title: string } {
  return {
    text: window.getSelection()?.toString() ?? '',
    origin: window.location.origin,
    title: document.title,
  };
}
