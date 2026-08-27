// ─── 通用选择框（SmartSelect） ───
// 企业级交互：悬停高亮、选中反馈、键盘导航（↑↓/Home/End/Enter/Escape）、
// 点击外部关闭。视觉遵循项目设计令牌（surface/line/ink/brand），
// 替代原生 <select>，保证多处在视觉与交互上的一致性。

import { Check, ChevronDown } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** 辅助说明（列表项副标题，可省略）。 */
  hint?: string;
}

interface SelectProps<T extends string> {
  value: T | '';
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** 无障碍标签（aria-label）。 */
  ariaLabel: string;
  /** 未选中时的占位文案。 */
  placeholder?: string;
  /** 是否显示「未选择」空选项（默认 true）。 */
  allowEmpty?: boolean;
  className?: string;
  disabled?: boolean;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = '未选择',
  allowEmpty = true,
  className = '',
  disabled = false,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const selected = options.find((option) => option.value === value) ?? null;

  // 点击组件外部关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // 列表滚动到活动项
  useEffect(() => {
    if (!open || activeIndex < 0 || !listRef.current) return;
    const item = listRef.current.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  // 打开后把焦点移入列表，键盘导航随即接管
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  const selectIndex = (index: number) => {
    const option = options[index];
    if (option) {
      onChange(option.value);
      setOpen(false);
    }
  };

  const moveActive = (delta: number) => {
    const total = options.length;
    if (total === 0) return;
    setActiveIndex((current) => {
      if (current < 0) return delta > 0 ? 0 : total - 1;
      return (current + delta + total) % total;
    });
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(0);
      setOpen(true);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(options.length - 1);
      setOpen(true);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen((current) => !current);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (activeIndex >= 0) selectIndex(activeIndex);
        break;
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  return (
    <div ref={rootRef} className={`smart-select relative ${className}`}>
      <button
        type="button"
        className="smart-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="smart-select-value">{selected ? selected.label : placeholder}</span>
        <ChevronDown size={12} className={`smart-select-chevron ${open ? 'is-open' : ''}`} />
      </button>

      {open ? (
        <div
          id={listboxId}
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          className="smart-select-list"
          onKeyDown={handleListKeyDown}
        >
          {allowEmpty ? (
            <div
              role="option"
              aria-selected={value === ''}
              tabIndex={-1}
              className={`smart-select-item ${value === '' ? 'is-selected' : ''}`}
              onClick={() => {
                onChange('' as T);
                setOpen(false);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  onChange('' as T);
                  setOpen(false);
                }
              }}
              onMouseEnter={() => setActiveIndex(-1)}
            >
              <span className="smart-select-label">{placeholder}</span>
              {value === '' ? <Check size={11} className="smart-select-check" /> : null}
            </div>
          ) : null}
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;
            return (
              <div
                key={option.value}
                role="option"
                aria-selected={isSelected}
                aria-label={option.hint ? `${option.label}，${option.hint}` : option.label}
                tabIndex={-1}
                className={`smart-select-item ${isSelected ? 'is-selected' : ''} ${isActive ? 'is-active' : ''}`}
                onClick={() => selectIndex(index)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    selectIndex(index);
                  }
                }}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="smart-select-label">{option.label}</span>
                {option.hint ? <span className="smart-select-hint">{option.hint}</span> : null}
                {isSelected ? <Check size={11} className="smart-select-check" /> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
