// ─── 技能选择器（Composer 工具行） ───
// 对应设计稿 design/cmd-menu/variant-a-linear.html 的真实实现：
// 触发器与模型选择器同一姿态（无边框透明底、24px 高、hover 品牌色高亮），
// 菜单锚定在触发器正上方 6px，含搜索区 / 技能列表 / 底部常驻操作栏。
// 与斜杠（/）技能引用共用同一套状态：open + initialQuery 由外部受控，
// 选择技能后菜单立即关闭。触发器是固定的「技能」入口，不随选择变化文案。

import { Search, Settings } from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SkillCatalogEntry } from '@/lib/skills/types';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/Tooltip';

interface SkillPickerProps {
  skills: SkillCatalogEntry[];
  /** 受控开合：触发器点击与斜杠（/）触发共用。 */
  open: boolean;
  /** 打开时的初始过滤词（斜杠触发时传入，如 /bo → 'bo'）。 */
  initialQuery?: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (skill: SkillCatalogEntry) => void;
  /** 底部「设置」入口；不传则不渲染。 */
  onSettingsClick?: () => void;
  disabled?: boolean;
  className?: string;
}

/**
 * 触发器样式：浅蓝灰底常驻（与工具行模型/思考选择器同一姿态），
 * hover 与展开时品牌色柔和高亮；展开态不描边，保持工具行整体感。
 */
const TRIGGER_CLASS =
  'inline-flex h-6 max-w-[140px] cursor-pointer items-center justify-start gap-1 ' +
  'overflow-hidden rounded-[7px] border-0 bg-surface-soft ' +
  'px-[7px] py-0 text-[10px] text-ink-soft transition-colors duration-100 ' +
  'hover:bg-surface-mint hover:text-brand ' +
  'aria-expanded:bg-surface-mint aria-expanded:text-brand ' +
  'active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-3 [&_svg]:shrink-0';

const KBD_CLASS = 'rounded-[3px] border border-line bg-surface-soft px-1 font-mono text-[8px]';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 匹配高亮：只加粗不着色（项目去 AI 化规范）。以匹配位置作 key，重复片段也不会冲突。 */
function highlight(text: string, query: string): ReactNode {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return text;
  const pattern = new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'ig');
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    nodes.push(<strong key={match.index}>{match[0]}</strong>);
    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function SkillPicker({
  skills,
  open,
  initialQuery,
  onOpenChange,
  onSelect,
  onSettingsClick,
  disabled = false,
  className,
}: SkillPickerProps) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // 回调经 ref 转发：菜单打开期间外部重渲染不重建 document 监听。
  const onOpenChangeRef = useRef(onOpenChange);
  const onSelectRef = useRef(onSelect);
  onOpenChangeRef.current = onOpenChange;
  onSelectRef.current = onSelect;

  // 过滤：名称/描述包含每个空格分词（不区分大小写）。
  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return skills;
    return skills.filter((skill) =>
      words.every(
        (word) =>
          skill.name.toLowerCase().includes(word) || skill.description.toLowerCase().includes(word),
      ),
    );
  }, [skills, query]);

  // 打开：重置搜索与选中项，自动聚焦搜索框（斜杠触发时带入过滤词）。
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery ?? '');
    setIndex(0);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open, initialQuery]);

  // 过滤结果变化时收敛选中索引。
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // 键盘选中项滚入视野（按选中项 id 查询，index 变化时触发）。
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[id="skill-opt-${index}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [index, open]);

  // 点击面板外关闭（mousedown 判断，与设计稿一致）。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target)) return;
      onOpenChangeRef.current(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // 键盘导航（委托在面板容器：焦点在搜索框内也能收到）。
  // Esc 两级关闭：先清空搜索回到全列表，再按才关闭。
  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return; // 中文输入法候选确认不触发
    const total = filtered.length;
    if (total === 0) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setQuery('');
      }
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setIndex((i) => (i + 1) % total);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setIndex((i) => (i - 1 + total) % total);
        break;
      case 'Home':
        event.preventDefault();
        setIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setIndex(total - 1);
        break;
      case 'Enter':
      case 'Tab': {
        event.preventDefault();
        const skill = filtered[index];
        if (skill) onSelectRef.current(skill);
        break;
      }
      case 'Escape':
        event.preventDefault();
        if (query) {
          setQuery('');
          setIndex(0);
          searchRef.current?.focus();
        } else {
          onOpenChangeRef.current(false);
        }
        break;
    }
  }

  return (
    <div ref={anchorRef} className={cn('relative', className)}>
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="选择技能"
        title="选择技能"
        disabled={disabled}
        className={TRIGGER_CLASS}
        onClick={() => onOpenChangeRef.current(!open)}
      >
        <span className="block min-w-0 flex-1 truncate text-left">技能</span>
      </button>

      {open ? (
        <div
          ref={menuRef}
          role="listbox"
          aria-label="技能列表"
          onKeyDown={handleMenuKeyDown}
          className="absolute bottom-[calc(100%+6px)] left-0 z-30 flex w-full min-w-[260px] origin-bottom animate-[cmd-pop_180ms_cubic-bezier(0.2,0.9,0.3,1.15)] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[0_8px_28px_rgb(0_0_0/14%)]"
        >
          {/* 搜索区：放大镜内嵌，打开自动聚焦，输入即过滤 */}
          <div className="group relative border-b border-line p-2">
            <Search
              size={12}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-faint transition-colors duration-100 group-focus-within:text-brand"
            />
            <input
              ref={searchRef}
              type="text"
              value={query}
              placeholder="搜索技能…"
              aria-label="搜索技能"
              aria-activedescendant={filtered.length ? `skill-opt-${index}` : undefined}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value);
                setIndex(0);
              }}
              className="h-[30px] w-full cursor-pointer rounded-lg border border-transparent bg-surface-soft pl-[27px] pr-2.5 text-xs text-ink outline-none transition-[border-color,background,box-shadow] duration-100 placeholder:text-ink-faint hover:border-line-strong hover:bg-[color-mix(in_srgb,var(--color-surface-soft)_88%,var(--color-surface))] focus:cursor-text focus:border-brand focus:bg-surface focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-brand)_11%,transparent)]"
            />
          </div>

          {/* 技能列表：无图标，名称 + 描述两行 */}
          <div className="max-h-[288px] overflow-y-auto overscroll-contain p-1">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center text-[11px] text-ink-faint">
                <strong className="text-xs font-semibold text-ink-soft">没有匹配的技能</strong>
                <span>
                  试试其他关键词，或按 <kbd className={KBD_CLASS}>esc</kbd> 清空搜索
                </span>
              </div>
            ) : (
              filtered.map((skill, i) => (
                <Tooltip key={skill.name}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      role="option"
                      id={`skill-opt-${i}`}
                      aria-selected={i === index}
                      // mousedown preventDefault：防止失焦先于点击导致面板关闭
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onSelectRef.current(skill)}
                      // mousemove 而非 mouseenter：鼠标飘过时不同步选中态，避免闪烁
                      onMouseMove={() => {
                        if (i !== index) setIndex(i);
                      }}
                      className={cn(
                        'flex w-full cursor-pointer flex-col gap-0.5 rounded-lg border-0 bg-transparent px-2.5 py-2 text-left transition-colors duration-75',
                        i === index && 'bg-brand/10',
                      )}
                    >
                      <span className="truncate text-xs font-semibold text-ink">
                        {highlight(`/${skill.name}`, query)}
                      </span>
                      <span className="truncate text-[11px] leading-[1.4] text-ink-faint">
                        {highlight(skill.description, query)}
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-60 whitespace-normal text-left">
                    /{skill.name}：{skill.description}
                  </TooltipContent>
                </Tooltip>
              ))
            )}
          </div>

          {/* 底部常驻操作栏：不参与过滤、不参与列表键盘导航 */}
          <footer className="flex items-center justify-between gap-1.5 border-t border-line bg-[color-mix(in_srgb,var(--color-app)_70%,var(--color-surface))] px-2 py-[5px]">
            {onSettingsClick ? (
              <button
                type="button"
                onClick={onSettingsClick}
                className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-[7px] text-[10px] text-ink-soft transition-colors duration-100 hover:bg-surface-soft hover:text-brand-strong active:scale-[0.97]"
              >
                <Settings size={10} /> 设置
              </button>
            ) : null}
            <span className="ml-auto text-[9px] tracking-[0.02em] text-ink-faint">
              <kbd className={KBD_CLASS}>↑</kbd>
              <kbd className={KBD_CLASS}>↓</kbd> 选择 · <kbd className={KBD_CLASS}>↵</kbd> 执行 ·{' '}
              <kbd className={KBD_CLASS}>esc</kbd> 关闭
            </span>
          </footer>
        </div>
      ) : null}
    </div>
  );
}
