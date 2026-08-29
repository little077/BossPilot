// ─── Composer：基于 tiptap 的对话输入框 ───
// 交互参考 RedScope 的 AgentComposer：卡片容器 + 聚焦光晕 + Enter 发送。
// 使用 tiptap 而非 textarea：占位符体验更好、自动增高、后续可扩展 @提及/斜杠命令。

import type { JSONContent } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { ArrowUp, FileText, Image, Mic, Paperclip, Pause, Square, X } from 'lucide-react';
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
import {
  openMicPermissionPage,
  openSystemMicSettings,
  queryMicPermission,
} from '@/lib/speech/mic-permission';
import type { SpeechErrorKind } from '@/lib/speech/recognition';
import { appendTranscript } from '@/lib/speech/transcript';
import { SkillPicker } from './SkillPicker';
import { SkillReference } from './SkillReference';
import { useSpeechRecognition } from './useSpeechRecognition';

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

/** 语音计时显示：00:00 格式（等宽数字由 CSS tabular-nums 负责）。 */
export function formatVoiceTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 归一化识别错误 → 用户可读文案（组件外常量，避免每次渲染重建）。 */
const SPEECH_ERROR_LABELS: Record<SpeechErrorKind, string> = {
  'not-allowed': '麦克风授权未通过，请允许后重试',
  'no-speech': '没有听到语音，请重试',
  'audio-capture': '无法访问麦克风设备',
  network: '语音识别服务网络不可用',
  'language-unavailable': '当前语言不支持语音识别',
  aborted: '语音输入已取消',
  unknown: '语音识别失败，请重试',
};

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
  // 语音消息监听器只注册一次，编辑器实例经 ref 取最新值
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);

  // ─── 语音输入 ───
  // SpeechRecognition 直接在 sidepanel 使用（见 lib/speech/recognition.ts），
  // 识别期间输入框显示「正在输入语音…」提示条（对照设计稿 voice-hint），
  // 中间结果作为编辑器末尾的「未定稿后缀」实时上屏。
  type VoiceUiState =
    | 'idle'
    | 'preparing'
    | 'listening'
    | 'auth-required'
    | 'error'
    | 'unavailable';
  const [voiceState, setVoiceState] = useState<VoiceUiState>('idle');
  const [voiceError, setVoiceError] = useState('');
  const [voiceSeconds, setVoiceSeconds] = useState(0);
  const voiceStateRef = useRef<VoiceUiState>('idle');
  voiceStateRef.current = voiceState;
  // 识别中的未定稿后缀：interim 帧的增量文本，final 定稿后清空。
  const interimSuffixRef = useRef('');
  // startVoice 授权探测期间的防重入闸（异步间隙里连点会开两个授权页）。
  const voiceStartingRef = useRef(false);

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
  // 语音识别 / 提示条期间占位符置空：voice-hint 是覆盖在输入框上的浮层，
  // 若 placeholder 文案仍在会与其重叠（用户反馈的「文字叠加」问题）。
  placeholderRef.current =
    voiceState !== 'idle'
      ? ''
      : waitingForAnswer
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
      // 语音识别实时上屏也会触发 onUpdate，但语音文本不应误开斜杠菜单。
      const text = e.getText({ blockSeparator: '\n' });
      const match = /^\/[^\s/]*$/.exec(text);
      const shouldOpen =
        Boolean(match) && slashSkillsRef.current.length > 0 && voiceStateRef.current === 'idle';
      slashOpenRef.current = shouldOpen;
      setSlashOpen(shouldOpen);
      setSlashQuery(match ? text.slice(1) : '');
    },
    onCreate: ({ editor: e }) => setEmpty(e.isEmpty),
    autofocus: autoFocus ? 'end' : false,
  });
  editorRef.current = editor;

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

  // ─── 语音输入：sidepanel 直连识别 ───
  // 授权闸门：sidepanel 弹不出 getUserMedia 授权框，先探测授权态，未授权时
  // 打开授权跳板页引导（lib/speech/mic-permission.ts，方案 b：授权后回
  // sidepanel 再点一次按钮，此时 query 已是 granted，直接进入识别）。

  // 语音文本实时上屏：编辑器内容 = 已定稿内容 + 未定稿后缀。
  // 每帧先精确剥除上一帧的后缀（含拼接补的空格），再按 appendTranscript 规则
  // 追加新文本——保留用户已有输入与 SkillReference 节点，中英文边界的空格
  // 处理与落定一致。final 定稿后后缀清空，后续帧从定稿文本继续。
  const replaceVoiceSuffix = useCallback((next: string, isFinal: boolean) => {
    const editor = editorRef.current;
    if (!editor) return;
    const suffix = interimSuffixRef.current;
    const doc = editor.state.doc;
    const current = doc.textBetween(0, doc.content.size, '\n');
    const base = suffix && current.endsWith(suffix) ? current.slice(0, -suffix.length) : current;
    const merged = appendTranscript(base, next);
    const chain = editor.chain();
    if (suffix && current.endsWith(suffix)) {
      // 剥除上一帧的未定稿后缀：定位末尾文本节点（后缀一定落在其中），按字符
      // 偏移换算文档位置。不能用 doc.content.size 直接减——它含块级节点的
      // 结构标记偏移（如 <p> 开/关标记各占 1 个位置）。
      let lastTextEnd = -1;
      doc.descendants((node, pos) => {
        if (node.isText) lastTextEnd = pos + node.nodeSize;
        return true;
      });
      if (lastTextEnd !== -1) {
        chain.deleteRange({ from: lastTextEnd - suffix.length, to: lastTextEnd });
      }
    }
    const insert = merged.slice(base.length);
    if (insert) chain.insertContent({ type: 'text', text: insert });
    chain.focus('end').run();
    interimSuffixRef.current = isFinal ? '' : insert;
  }, []);

  // 识别会话生命周期由 hook 管理；错误按类型给出可读文案与降级引导。
  const handleSpeechError = useCallback((kind: SpeechErrorKind) => {
    if (kind === 'not-allowed') {
      // 授权在识别途中失效（被系统收回 / 首次拒绝）：引导重新授权。
      setVoiceError(SPEECH_ERROR_LABELS['not-allowed']);
      setVoiceState('auth-required');
      openMicPermissionPage();
      return;
    }
    setVoiceError(SPEECH_ERROR_LABELS[kind]);
    setVoiceState('error');
  }, []);

  const speech = useSpeechRecognition({
    onInterim: (text) => replaceVoiceSuffix(text, false),
    onFinal: (text) => replaceVoiceSuffix(text, true),
    onError: handleSpeechError,
  });

  // hook 状态 → UI 状态：preparing/listening 直接透传；回到 idle 时只把进行中
  // 态复位（error / auth-required 的提示文案保留到用户点掉）。会话结束（stop /
  // onEnd / 出错）时未定稿后缀作废——否则下一轮识别会把上一轮残留的 interim
  // 文本误当后缀剥除，导致输入框里已有的文案被覆盖。
  useEffect(() => {
    if (speech.state === 'preparing') {
      setVoiceState('preparing');
    } else if (speech.state === 'listening') {
      setVoiceState('listening');
    } else if (speech.state === 'idle') {
      interimSuffixRef.current = '';
      setVoiceState((prev) => (prev === 'preparing' || prev === 'listening' ? 'idle' : prev));
    }
  }, [speech.state]);

  // 语音态切换时强制占位符装饰重算：tiptap 占位符是 ProseMirror 装饰（class +
  // data-placeholder），只在 docChanged / selectionSet 事务时重算，识别开始的
  // 瞬间没有内容变化，旧占位符文案仍挂在装饰层上。手动置 selectionSet meta
  // 触发重算后，placeholder() 会按当前 ref（识别期间为空串）返回新值——
  // data-placeholder="" 使伪元素不再渲染文字，与覆盖其上的 voice-hint 浮层
  // 不再重叠（CSS .composer-card.is-voicing 的 display:none 兜底）。退出语音
  // 态时同样重算，让占位符按恢复后的文案显示。
  // biome-ignore lint/correctness/useExhaustiveDependencies: voiceState 仅作触发器（进入/退出语音态各重算一次），effect 体无需读取它
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta('selectionSet', true));
  }, [editor, voiceState]);

  // 聆听计时：listening 期间每秒 +1，其余状态归零。
  useEffect(() => {
    if (voiceState !== 'listening') {
      setVoiceSeconds(0);
      return;
    }
    const timer = window.setInterval(() => setVoiceSeconds((seconds) => seconds + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [voiceState]);

  const resetVoice = useCallback(() => {
    setVoiceSeconds(0);
    setVoiceError('');
    setVoiceState('idle');
  }, []);

  const startVoice = async () => {
    if (voiceStartingRef.current) return;
    voiceStartingRef.current = true;
    try {
      const permission = await queryMicPermission();
      if (permission === 'denied') {
        setVoiceError('麦克风权限被拒绝，请在设置中允许 BossPilot');
        setVoiceState('auth-required');
        openSystemMicSettings();
        return;
      }
      if (permission === 'prompt' || permission === 'unknown') {
        // 未授权（含探测不到权限状态）：打开授权跳板页，授权后回 sidepanel 再点一次。
        setVoiceError('需要麦克风授权，请在弹出的页面中允许');
        setVoiceState('auth-required');
        openMicPermissionPage();
        return;
      }
      // 新一轮识别前作废上一轮的未定稿后缀（stop/onEnd 已清，这里兜底
      // error 态直接重试等路径），避免已有文本被误当后缀剥除。
      interimSuffixRef.current = '';
      await speech.start();
    } finally {
      voiceStartingRef.current = false;
    }
  };

  const handleVoiceClick = () => {
    if (voiceState === 'idle') {
      void startVoice();
      return;
    }
    if (voiceState === 'listening' || voiceState === 'preparing') {
      speech.stop();
      return;
    }
    resetVoice(); // auth-required / error / unavailable：点击关闭提示
  };

  const voiceLabel =
    voiceState === 'listening'
      ? '正在输入语音…'
      : voiceState === 'preparing'
        ? '正在准备语音识别…'
        : voiceState === 'auth-required'
          ? voiceError || '需要麦克风授权，请在弹出的页面中允许'
          : voiceError || '语音输入不可用';

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
      } ${voiceState !== 'idle' ? 'is-voicing' : ''} ${className}`}
    >
      <EditorContent editor={editor} className="composer-editor" />
      {/* 语音输入提示条：识别期间替代占位符展示（对照设计稿 voice-hint） */}
      {voiceState !== 'idle' ? (
        <div
          className={`composer-voice-hint ${voiceState === 'listening' ? '' : 'is-paused'}`}
          role="status"
        >
          <span className="rec-dot" aria-hidden />
          <span className="voice-label">{voiceLabel}</span>
          <span className="voice-timer" aria-hidden>
            {formatVoiceTime(voiceSeconds)}
          </span>
          <span className="wave-inline" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        </div>
      ) : null}
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
          <div className="flex items-center gap-1.5">
            {/* 语音输入：紧挨发送按钮左侧（不占工具行，避免与模型选择器等混排） */}
            {speech.supported ? (
              <button
                type="button"
                className={`tool-btn grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-xl border-0 bg-transparent text-ink-faint transition-all duration-[140ms] hover:bg-surface-mint hover:text-brand active:scale-[0.92] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-45 ${
                  voiceState === 'listening' ? 'is-voicing bg-surface-mint text-brand' : ''
                }`}
                aria-label={
                  voiceState === 'listening'
                    ? '结束语音输入'
                    : voiceState === 'preparing'
                      ? '取消语音输入'
                      : '语音输入'
                }
                title={
                  voiceState === 'listening'
                    ? '结束语音输入'
                    : voiceState === 'preparing'
                      ? '取消语音输入'
                      : '语音输入'
                }
                disabled={disabled || waitingForAnswer || submitting}
                onClick={handleVoiceClick}
              >
                <Mic size={14} strokeWidth={1.8} className="ic-mic" />
                <Pause size={14} strokeWidth={1.8} className="ic-swap" />
              </button>
            ) : null}
            <button
              type="button"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand text-white transition-all duration-200 hover:bg-brand-strong hover:shadow-[0_4px_12px_color-mix(in_srgb,var(--color-brand)_35%,transparent)] active:scale-95 disabled:opacity-40 disabled:hover:shadow-none"
              disabled={(empty && attachments.length === 0) || disabled || submitting}
              title="发送"
              onClick={() => void submitRef.current()}
            >
              <ArrowUp size={14} />
            </button>
          </div>
        )}
      </footer>
    </section>
  );
}
