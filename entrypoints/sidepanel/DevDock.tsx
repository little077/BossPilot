// ─── DEV 悬浮球：一键应用 .env 调试配置 ───
// 只在开发构建出现（App.tsx 以 import.meta.env.DEV 守卫，生产整块被摇树移除）。
// 重新安装扩展导致本地配置被清空后，点一下即把 .env（WXT_DEV_*）里的密钥与模型
// 经既有 config:set 通道加密落库，免去「手填密钥 → 拉目录 → 选模型」三步。
// 反馈用短暂气泡给出：成功、.env 缺密钥、后台未连接三种结果如实提示。

import { Zap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DevAccess } from '@/lib/dev/access';

/** 反馈气泡停留时长。 */
const FEEDBACK_MS = 2600;

interface DevDockProps {
  access: DevAccess | null;
  /** 保存配置（沿用 config:set 通道）；返回 false 表示后台连接已断。 */
  onApply: (input: { baseUrl: string; model: string; apiKey: string }) => boolean;
  /** 应用成功后回调（App 用它切到对话页）。 */
  onApplied?: () => void;
}

interface Feedback {
  tone: 'ok' | 'error';
  text: string;
}

export function DevDock({ access, onApply, onApplied }: DevDockProps) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 卸载时清掉未到期的隐藏计时器，避免在已卸载组件上 setState。
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const apply = useCallback(() => {
    let next: Feedback;
    if (!access?.apiKey) {
      next = { tone: 'error', text: '请在 .env 补上 WXT_DEV_API_KEY' };
    } else if (onApply({ baseUrl: access.baseUrl, model: access.model, apiKey: access.apiKey })) {
      next = { tone: 'ok', text: `已应用 ${access.model}` };
      onApplied?.();
    } else {
      next = { tone: 'error', text: '后台连接中，请稍后重试' };
    }
    setFeedback(next);
    // 连点会刷新气泡并重新计时，而不是留下多个计时器互相打架。
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setFeedback(null), FEEDBACK_MS);
  }, [access, onApply, onApplied]);

  return (
    <div className="pointer-events-none fixed bottom-3 left-3 z-50 flex items-center gap-2">
      <button
        type="button"
        onClick={apply}
        aria-label="应用 .env 调试配置"
        title="应用 .env 中的调试密钥与模型（仅开发环境）"
        data-testid="dev-dock"
        className="pointer-events-auto grid h-9 w-9 place-items-center rounded-full bg-brand text-white opacity-80 shadow-[0_6px_16px_color-mix(in_srgb,var(--color-brand)_35%,transparent)] transition-all duration-200 hover:scale-105 hover:opacity-100 active:scale-95"
      >
        <Zap size={15} aria-hidden />
      </button>
      {feedback ? (
        <span
          role="status"
          className={`pointer-events-auto rounded-full border bg-surface px-2.5 py-1 text-[10px] leading-none shadow-md ${
            feedback.tone === 'error'
              ? 'border-danger/30 text-danger'
              : 'border-brand/25 text-brand'
          }`}
        >
          {feedback.text}
        </span>
      ) : null}
    </div>
  );
}
