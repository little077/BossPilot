import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并 Tailwind 类名：clsx 处理条件类，tailwind-merge 去重冲突类。
 * shadcn/ui 组件约定的 className 组合工具。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
