// ─── 对话视图 ───
// 消息列表 + 输入框 + 流式光标 + 停止生成按钮 + 工具卡片 + 错误提示。
// 纯展示，状态来自 useAgentPort。

import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, ToolCallView } from '@/lib/domain/chat';
import { Composer } from './Composer';

const MARKDOWN_PLUGINS = [remarkGfm];

/** 工具名 → 中文展示名（未收录的工具名原样展示）。 */
const TOOL_LABELS: Record<string, string> = {
  read_current_page: '读取当前页面',
  read_artifact: '取回工件全文',
};

/** 工具卡片：同一容器三态渲染——执行中（转圈）/ 成功（勾选 + 摘要）/ 失败（警示 + 摘要 + 错误码）。 */
function ToolCallCard({ toolCall }: { toolCall: ToolCallView }) {
  const label = TOOL_LABELS[toolCall.name] ?? toolCall.name;
  return (
    <div
      role="status"
      className="mb-1.5 flex items-center gap-1.5 rounded-lg border border-line-strong bg-app px-2 py-1.5 text-[10px] leading-4"
    >
      {toolCall.status === 'running' ? (
        <>
          <Loader2 size={12} className="shrink-0 animate-spin text-brand" aria-hidden />
          <span className="text-ink-soft">正在{label}…</span>
        </>
      ) : toolCall.status === 'success' ? (
        <>
          <Check size={12} className="shrink-0 text-success" aria-hidden />
          <span className="text-ink-soft">{toolCall.summary ?? `${label}完成`}</span>
          {/* 工件短编号：告知用户全文去了哪，无浏览/下载 UI（阶段 2 边界）。 */}
          {toolCall.artifactId ? (
            <span
              className="shrink-0 rounded border border-line-strong px-1 py-px font-mono text-ink-faint"
              title={`工件编号 ${toolCall.artifactId}`}
            >
              #{toolCall.artifactId.slice(0, 8)}
            </span>
          ) : null}
        </>
      ) : (
        <>
          <AlertTriangle size={12} className="shrink-0 text-danger" aria-hidden />
          <span className="min-w-0 flex-1 text-danger">
            {toolCall.summary ?? `${label}失败，请重试。`}
          </span>
          {toolCall.errorCode ? (
            <span className="shrink-0 rounded border border-danger/30 px-1 py-px font-mono text-danger">
              {toolCall.errorCode}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

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
            // 兼容历史：旧数据只有单卡 toolCall，新数据为多卡 toolCalls。统一成数组渲染。
            const cards: ToolCallView[] =
              message.toolCalls ?? (message.toolCall ? [message.toolCall] : []);
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
                {cards.map((card) => (
                  <ToolCallCard key={card.id ?? card.name} toolCall={card} />
                ))}
                {/* 压缩可见性提示：本轮送模型前把早先 N 条折进了摘要（可关，见设置）。 */}
                {message.compacted && message.compacted.rounds > 0 ? (
                  <div className="mb-1.5 text-[10px] text-ink-faint">
                    已将早先 {message.compacted.rounds} 条对话压缩为摘要
                  </div>
                ) : null}
                {streaming && !message.content && cards.length === 0 ? (
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
