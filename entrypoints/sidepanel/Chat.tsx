// ─── 对话视图 ───
// 消息列表 + 输入框 + 流式光标 + 停止生成按钮 + 错误提示。纯展示，状态来自 useAgentPort。

import { Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '@/lib/domain/chat';
import { Composer } from './Composer';

const MARKDOWN_PLUGINS = [remarkGfm];

interface ChatProps {
  messages: ChatMessage[];
  running: boolean;
  connected: boolean;
  onSend: (text: string) => boolean;
  onCancel: () => void;
}

export function Chat({ messages, running, connected, onSend, onCancel }: ChatProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 依赖 messages 是刻意为之：每次消息/流式更新都要重新滚到底，effect 体本身不读取它。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 需要在 messages 变化时触发滚动
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-3" aria-live="polite">
        {messages.length === 0 ? (
          <p className="mt-8 text-center text-xs text-ink-faint">
            向 BossPilot 提个问题，回复会逐字出现。
          </p>
        ) : null}
        <div className="flex flex-col gap-2.5">
          {messages.map((message) => {
            const streaming = message.role === 'assistant' && message.status === 'streaming';
            if (message.role === 'user') {
              return (
                <div
                  key={message.id}
                  className="max-w-[92%] self-end whitespace-pre-wrap rounded-[16px_16px_5px_16px] bg-brand px-3 py-2 text-xs leading-relaxed text-white"
                >
                  {message.content}
                </div>
              );
            }
            return (
              <div
                key={message.id}
                className={`max-w-[92%] self-start rounded-[16px_16px_16px_5px] border px-3 py-2 text-xs leading-relaxed ${
                  message.error
                    ? 'border-danger/30 bg-surface text-ink'
                    : 'border-line bg-surface text-ink'
                }`}
              >
                {streaming && !message.content ? (
                  <span className="flex items-center gap-1.5 text-ink-faint">
                    <Loader2 size={12} className="animate-spin text-brand" />
                    正在思考…
                  </span>
                ) : null}
                {message.content ? (
                  <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{message.content}</ReactMarkdown>
                ) : null}
                {streaming && message.content ? (
                  <span
                    className="ml-1 inline-block h-3 w-0.5 animate-pulse rounded-full bg-brand align-middle"
                    role="status"
                    aria-label="正在生成"
                  />
                ) : null}
                {message.status === 'cancelled' ? (
                  <div className="mt-1.5 border-t border-line pt-1.5 text-[10px] text-ink-faint">
                    已停止生成
                  </div>
                ) : null}
                {message.errorMessage ? (
                  <div className="mt-1.5 border-t border-danger/20 pt-1.5 text-[10px] leading-4 text-danger">
                    {message.errorMessage}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-line bg-app p-2.5">
        <Composer onSend={onSend} running={running} disabled={!connected} onCancel={onCancel} />
      </div>
    </div>
  );
}
