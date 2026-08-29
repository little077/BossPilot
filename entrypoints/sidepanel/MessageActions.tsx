// 消息底部操作栏：流式输出完毕后出现，提供 复制 / 重新生成。
// 交互与样式严格对照 design-prototype/message-actions.html（浅色主题，无深色浮层）。

import { Check, Copy, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/lib/domain/chat';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/Tooltip';

interface MessageActionsProps {
  message: ChatMessage;
  onRegenerate?: () => boolean;
}

const ACT_BTN_CLASS =
  'act-btn grid size-[26px] place-items-center rounded-[7px] text-ink-faint transition-all ' +
  'duration-[140ms] hover:bg-ink/6 hover:text-ink active:scale-[0.92] ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand';

export function MessageActions({ message, onRegenerate }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);

  // 卸载时清理计时器，避免残留的恢复回调
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    },
    [],
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
    } catch {
      return; // 剪贴板不可用：不进入成功态
    }
    setCopied(true);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1_600);
  };

  const handleRegenerate = () => {
    if (retrying || !onRegenerate) return;
    if (!onRegenerate()) return;
    setRetrying(true);
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = window.setTimeout(() => setRetrying(false), 600);
  };

  return (
    <div className="msg-actions mt-1.5 flex items-center gap-0.5 px-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={`${ACT_BTN_CLASS} ${copied ? 'is-copied bg-success/10 text-success' : ''}`}
            aria-label="复制回答"
            onClick={() => void handleCopy()}
          >
            {copied ? <Check size={15} strokeWidth={2} /> : <Copy size={15} strokeWidth={1.8} />}
          </button>
        </TooltipTrigger>
        {copied ? null : (
          <TooltipContent className="rounded-[8px] px-[9px] py-1">复制回答</TooltipContent>
        )}
      </Tooltip>

      {onRegenerate ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={`${ACT_BTN_CLASS} ${retrying ? 'is-retrying' : ''}`}
              aria-label="重新生成"
              onClick={handleRegenerate}
            >
              <RotateCcw size={15} strokeWidth={1.8} />
            </button>
          </TooltipTrigger>
          <TooltipContent className="rounded-[8px] px-[9px] py-1">重新生成</TooltipContent>
        </Tooltip>
      ) : null}

      <span
        className={`copied-chip pointer-events-none ml-1.5 inline-flex items-center gap-1 rounded-full border border-success/22 bg-success/10 px-[9px] py-0.5 text-[11px] font-medium text-success transition-all duration-[160ms] ${
          copied ? 'translate-x-0 opacity-100' : '-translate-x-1 opacity-0'
        }`}
      >
        <Check size={10} strokeWidth={2.4} /> 已复制
      </span>
    </div>
  );
}
