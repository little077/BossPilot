// ─── Composer：基于 tiptap 的对话输入框 ───
// 交互参考 RedScope 的 AgentComposer：卡片容器 + 聚焦光晕 + Enter 发送。
// 使用 tiptap 而非 textarea：占位符体验更好、自动增高、后续可扩展 @提及/斜杠命令。

import type { JSONContent } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { ArrowUp, FileText, Image, Paperclip, Square, X } from 'lucide-react';
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  attachmentFromFile,
  MAX_ATTACHMENTS,
  validateAttachmentSet,
} from '@/lib/attachments/input';
import type { ChatAttachment } from '@/lib/domain/chat';
import { sendSkillCommand } from '@/lib/skills/client';
import type { SkillCatalogEntry } from '@/lib/skills/types';
import { SkillPicker } from './SkillPicker';
import { SkillReference } from './SkillReference';

export interface ComposerHandle {
  /** 外部填入文本（示例 chips 用），并聚焦到末尾 */
  setText: (text: string) => void;
  focus: () => void;
}

export interface ComposerDraft {
  /** 保存完整 Tiptap 文档，避免 Skill atom 在切屏后退化为纯文本。 */
  content: JSONContent;
  attachments: ChatAttachment[];
}

interface ComposerProps {
  onSend: (text: string, attachments: ChatAttachment[]) => boolean | Promise<boolean>;
  draft?: ComposerDraft;
  onDraftChange?: (draft: ComposerDraft) => void;
  running?: boolean;
  /** 运行中允许发送纯文本约束；附件仍需等下一轮。 */
  allowSteering?: boolean;
  disabled?: boolean;
  onCancel?: () => void;
  autoFocus?: boolean;
  /** 发送成功后是否清空内容（首页沉底动画期间由会话切换接管草稿） */
  clearOnSend?: boolean;
  className?: string;
  /** Ask User 等待态：普通输入保持可见但不可编辑，答案只能从上方暂停面板提交。 */
  waitingForAnswer?: boolean;
  /** 输入框工具行右侧的内联控件（模型选择器等），渲染在「Enter 发送」提示之后。 */
  tools?: ReactNode;
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
  tools,
  draft,
  onDraftChange,
  ref,
}: ComposerProps) {
  const [empty, setEmpty] = useState(true);
  const [attachments, setAttachments] = useState<ChatAttachment[]>(() => draft?.attachments ?? []);
  const [attachmentError, setAttachmentError] = useState('');
  const [readingAttachment, setReadingAttachment] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);
  const submittingRef = useRef(false);
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;

  // ─── 技能选择器 ───
  // 触发器点击与输入 `/` 共用同一个 SkillPicker（open + initialQuery 受控）。
  // 状态经 ref 同步给 editor 只创建一次的闭包（与 submitRef 同一模式）。
  const [slashSkills, setSlashSkills] = useState<SkillCatalogEntry[]>([]);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashOpen, setSlashOpen] = useState(false);
  const slashOpenRef = useRef(false);
  const slashSkillsRef = useRef<SkillCatalogEntry[]>([]);

  useEffect(() => {
    void sendSkillCommand({ type: 'skills:get' })
      .then((view) => {
        const enabled = view.skills.filter((skill) => skill.enabled);
        slashSkillsRef.current = enabled;
        setSlashSkills(enabled);
      })
      .catch(() => {
        slashSkillsRef.current = [];
        setSlashSkills([]);
      });
  }, []);

  // 选择技能：技能节点插入当前光标处，保留已有输入内容；
  // 仅斜杠（/）触发时把斜杠词本身替换为结构化 Skill 节点。
  // 节点的 renderText 会保留「用 {name} 技能：」这一原有模型提示语义。
  const selectSkillRef = useRef<(skill: SkillCatalogEntry) => void>(() => {});

  // 回调与状态放进 ref，让 editor 只创建一次也能拿到最新值
  const submitRef = useRef<() => Promise<void>>(async () => {});
  const placeholderRef = useRef('');
  placeholderRef.current = waitingForAnswer
    ? 'Agent 正在等待上方问题的回答…'
    : running
      ? allowSteering
        ? '可追加约束，Agent 会在安全步骤后调整…'
        : '正在生成，可点击右侧停止…'
      : disabled
        ? '正在连接 BossPilot…'
        : '输入消息，Enter 发送；输入 / 使用技能';

  const editor = useEditor({
    content: draft?.content,
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
      SkillReference,
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
    ],
    editorProps: {
      handleKeyDown: (_view, event) => {
        // 技能菜单打开时焦点在菜单搜索框，键盘导航由 SkillPicker 处理。
        if (event.key === 'Enter' && !event.shiftKey) {
          // 中文输入法候选确认的回车不触发发送
          if (event.isComposing || event.keyCode === 229) return false;
          void submitRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      setEmpty(e.isEmpty);
      onDraftChangeRef.current?.({
        content: e.getJSON(),
        attachments: attachmentsRef.current,
      });
      // 输入 `/` 开头且不含空格的文本时打开技能选择器（带入过滤词）。
      const text = e.getText({ blockSeparator: '\n' });
      const match = /^\/[^\s/]*$/.exec(text);
      const shouldOpen = Boolean(match) && slashSkillsRef.current.length > 0;
      slashOpenRef.current = shouldOpen;
      setSlashOpen(shouldOpen);
      setSlashQuery(match ? text.slice(1) : '');
    },
    onCreate: ({ editor: e }) => setEmpty(e.isEmpty),
    autofocus: autoFocus ? 'end' : false,
  });

  // editor 创建后填充选择技能的实现。
  selectSkillRef.current = (skill: SkillCatalogEntry) => {
    if (!editor) return;
    const { from } = editor.state.selection;
    // 光标前若是 /技能词（斜杠触发），只删除该词本身，避免残留；
    // 其余情况原样插入，已有输入内容不受影响。
    const before = editor.state.doc.textBetween(0, from, '\n');
    const slash = /\/[^\s/]*$/.exec(before);
    const chain = editor.chain();
    if (slash) {
      chain.deleteRange({ from: from - slash[0].length, to: from });
    }
    chain
      .insertContent([
        { type: 'skillReference', attrs: { name: skill.name, description: skill.description } },
        { type: 'text', text: ' ' },
      ])
      .focus()
      .run();
    slashOpenRef.current = false;
    setSlashOpen(false);
  };

  // 菜单开合回调：Esc / 点击外部关闭后焦点回到编辑器。
  const handlePickerOpenChange = useCallback(
    (open: boolean) => {
      slashOpenRef.current = open;
      setSlashOpen(open);
      if (!open) {
        setSlashQuery('');
        editor?.commands.focus('end');
      }
    },
    [editor],
  );

  // 失焦（例如点击编辑器外）关闭菜单；菜单打开时失焦（焦点在搜索框）由菜单自身管理。
  useEffect(() => {
    if (!editor) return;
    const close = () => {
      if (slashOpenRef.current) return;
      slashOpenRef.current = false;
      setSlashOpen(false);
    };
    editor.on('blur', close);
    return () => {
      editor.off('blur', close);
    };
  }, [editor]);

  submitRef.current = async () => {
    if (!editor || submittingRef.current || (running && !allowSteering) || disabled) return;
    const text = editor.getText({ blockSeparator: '\n' }).trim();
    if (!text && attachments.length === 0) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const accepted = await onSend(text || '请分析我附加的内容。', attachments);
      if (accepted && clearOnSend) {
        attachmentsRef.current = [];
        setAttachments([]);
        editor.commands.clearContent(true);
        onDraftChangeRef.current?.({ content: editor.getJSON(), attachments: [] });
      }
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : '消息发送失败，请稍后重试。');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
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

  const replaceAttachments = (next: ChatAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
    if (editor) {
      onDraftChangeRef.current?.({ content: editor.getJSON(), attachments: next });
    }
  };

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
      replaceAttachments(next);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : '附件读取失败。');
    } finally {
      setReadingAttachment(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <section
      className={`composer-card relative rounded-2xl border border-line bg-surface transition-all duration-200 focus-within:border-brand/60 focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-brand)_10%,transparent)] ${
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
                  replaceAttachments(attachments.filter(({ id }) => id !== attachment.id))
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
        <div className="composer-tools flex min-w-0 flex-1 items-center gap-[5px]">
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
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-ink-faint hover:bg-brand-soft hover:text-brand disabled:cursor-not-allowed disabled:opacity-45"
            aria-label="添加图片或文本文件"
            title="添加图片或文本文件"
            disabled={running || disabled || waitingForAnswer || readingAttachment || submitting}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={11} />
          </button>
          <SkillPicker
            skills={slashSkills}
            open={slashOpen}
            initialQuery={slashQuery || undefined}
            disabled={running || disabled || waitingForAnswer}
            onOpenChange={handlePickerOpenChange}
            onSelect={(skill) => selectSkillRef.current(skill)}
            className="shrink-0"
          />
          {tools}
        </div>
        {running ? (
          <div className="flex items-center gap-1">
            {allowSteering ? (
              <button
                type="button"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand text-white transition-all duration-200 active:scale-95 disabled:opacity-40"
                disabled={empty || disabled || submitting}
                title="追加指令"
                aria-label="追加指令"
                onClick={() => void submitRef.current()}
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
            disabled={(empty && attachments.length === 0) || disabled || submitting}
            title="发送"
            onClick={() => void submitRef.current()}
          >
            <ArrowUp size={14} />
          </button>
        )}
      </footer>
    </section>
  );
}
