// ─── DEV 悬浮球：可拖动的调试便捷动作（仅开发构建） ───
// 只在开发构建出现（App.tsx 以 import.meta.env.DEV 守卫，生产整块被摇树移除）。
// 整颗球可拖动：默认停在左下角，但位置不固定——握住拖拽手柄可拖到顶部或任意角落，
// 也支持方向键微调、Home 归位（键盘路径，满足可访问性）。容器 pointer-events-none，
// 只有手柄/按钮吃事件，悬浮时不会挡住底下的对话区。
// 两颗动作按钮：
// 1) 应用 .env 调试配置：重新安装扩展清空本地配置后，点一下把 .env（WXT_DEV_*）里的密钥
//    与模型经既有 config:set 通道加密落库，免去「手填密钥 → 拉目录 → 选模型」三步。
// 2) 下载最近一轮轨迹（阶段 3 最薄观测）：经 trace:latest 只读拿到后台记录的 TurnTrace，
//    用纯函数 buildTraceExport 打包成 Markdown 文件触发下载——把整个文件甩给大模型即可复盘
//    「这一轮到底发生了什么」，不再直接写剪贴板。
// 反馈都用同一段短暂气泡给出；trace 数据只读不回写（写入永远只在后台）。

import { Download, GripVertical, Zap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DevAccess } from '@/lib/dev/access';
import type { TurnTrace } from '@/lib/diagnostics/trace';
import { buildTraceExport } from '@/lib/diagnostics/trace';

/** 反馈气泡停留时长。 */
const FEEDBACK_MS = 2600;
/** 键盘拖动步长（普通 / Shift 加速）与距边界的留白。 */
const KEY_STEP = 12;
const KEY_STEP_FAST = 40;
const EDGE_GAP = 4;

/** 默认落点：左下角（与旧版固定位置一致），窗口尺寸未知时给个合理兜底。 */
function defaultPosition(): { x: number; y: number } {
  const h = typeof window === 'undefined' ? 768 : window.innerHeight;
  return { x: 12, y: Math.max(EDGE_GAP, h - 64) };
}

interface DevDockProps {
  access: DevAccess | null;
  /** 保存配置（沿用 config:set 通道）；返回 false 表示后台连接已断。 */
  onApply: (input: { baseUrl: string; model: string; apiKey: string }) => boolean;
  /** 应用成功后回调（App 用它切到对话页）。 */
  onApplied?: () => void;
  /** 只读获取最近一轮轨迹；无轨迹或后台断开时返回 null。 */
  getTrace?: () => Promise<TurnTrace | null>;
}

interface Feedback {
  tone: 'ok' | 'error';
  text: string;
}

export function DevDock({ access, onApply, onApplied, getTrace }: DevDockProps) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pos, setPos] = useState(defaultPosition);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);
  // 拖拽时记录「指针相对盒子左上角」的偏移，保证拖动跟手且不跳动。
  const dragOffset = useRef<{ dx: number; dy: number } | null>(null);

  // 卸载时清掉未到期的隐藏计时器，避免在已卸载组件上 setState。
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const showFeedback = useCallback((next: Feedback) => {
    setFeedback(next);
    // 连点会刷新气泡并重新计时，而不是留下多个计时器互相打架。
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setFeedback(null), FEEDBACK_MS);
  }, []);

  // 把坐标收进视口，四边各留 EDGE_GAP，避免拖出屏幕外再也拖不回来。
  const clamp = useCallback((x: number, y: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 120;
    const h = rect?.height ?? 40;
    const maxX = Math.max(EDGE_GAP, window.innerWidth - w - EDGE_GAP);
    const maxY = Math.max(EDGE_GAP, window.innerHeight - h - EDGE_GAP);
    return { x: Math.min(Math.max(EDGE_GAP, x), maxX), y: Math.min(Math.max(EDGE_GAP, y), maxY) };
  }, []);

  const onGripPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffset.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onGripPointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!dragOffset.current) return;
      setPos(clamp(e.clientX - dragOffset.current.dx, e.clientY - dragOffset.current.dy));
    },
    [clamp],
  );

  const onGripPointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    dragOffset.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  // 键盘移动：方向键微调（Shift 加速），Home 归位，保证无鼠标也能挪球。
  const onGripKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const step = e.shiftKey ? KEY_STEP_FAST : KEY_STEP;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      if (e.key === 'Home') {
        e.preventDefault();
        setPos(defaultPosition());
        return;
      }
      const move = moves[e.key];
      if (!move) return;
      e.preventDefault();
      setPos((p) => clamp(p.x + move[0], p.y + move[1]));
    },
    [clamp],
  );

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
    showFeedback(next);
  }, [access, onApply, onApplied, showFeedback]);

  // 下载轨迹：取只读轨迹 → 打包成 Markdown → 经临时 <a download> 触发落盘 → 立即释放 object URL。
  const downloadTrace = useCallback(async () => {
    if (!getTrace) {
      showFeedback({ tone: 'error', text: '后台未连接，无法取轨迹' });
      return;
    }
    const trace = await getTrace();
    if (!trace) {
      showFeedback({ tone: 'error', text: '暂无可下载轨迹' });
      return;
    }
    try {
      const { filename, mime, body } = buildTraceExport(trace);
      const url = URL.createObjectURL(new Blob([body], { type: mime }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showFeedback({ tone: 'ok', text: `已下载 ${trace.turns} 轮轨迹` });
    } catch {
      showFeedback({ tone: 'error', text: '下载不可用' });
    }
  }, [getTrace, showFeedback]);

  return (
    <div
      ref={boxRef}
      style={{ left: pos.x, top: pos.y }}
      className="pointer-events-none fixed z-50 flex items-center gap-1.5"
      data-testid="dev-dock"
    >
      <button
        type="button"
        aria-label="拖动调试悬浮球（方向键移动，Home 归位）"
        title="按住拖动，或用方向键移动、Home 归位（仅开发环境）"
        data-testid="dev-dock-grip"
        onPointerDown={onGripPointerDown}
        onPointerMove={onGripPointerMove}
        onPointerUp={onGripPointerUp}
        onKeyDown={onGripKeyDown}
        className="pointer-events-auto grid h-7 w-5 cursor-grab touch-none place-items-center rounded-full bg-surface text-ink-faint opacity-70 shadow-md transition-opacity hover:opacity-100 active:cursor-grabbing"
      >
        <GripVertical size={13} aria-hidden />
      </button>
      <button
        type="button"
        onClick={apply}
        aria-label="应用 .env 调试配置"
        title="应用 .env 中的调试密钥与模型（仅开发环境）"
        data-testid="dev-dock-apply"
        className="pointer-events-auto grid h-9 w-9 place-items-center rounded-full bg-brand text-white opacity-80 shadow-[0_6px_16px_color-mix(in_srgb,var(--color-brand)_35%,transparent)] transition-all duration-200 hover:scale-105 hover:opacity-100 active:scale-95"
      >
        <Zap size={15} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => void downloadTrace()}
        aria-label="下载最近一轮轨迹"
        title="下载最近一轮 Agent 轨迹为 Markdown 文件（仅开发环境）"
        data-testid="dev-dock-trace"
        className="pointer-events-auto grid h-9 w-9 place-items-center rounded-full bg-surface text-ink-soft opacity-80 shadow-md transition-all duration-200 hover:scale-105 hover:opacity-100 active:scale-95"
      >
        <Download size={15} aria-hidden />
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
