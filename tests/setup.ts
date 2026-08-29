import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

Object.defineProperty(HTMLElement.prototype, 'innerText', {
  configurable: true,
  get(this: HTMLElement) {
    return this.textContent ?? '';
  },
  set(this: HTMLElement, value: string) {
    this.textContent = value;
  },
});

// jsdom 未实现的滚动 API；适配层注入函数在真实浏览器中由 Chrome 提供。
HTMLElement.prototype.scrollIntoView = vi.fn();
HTMLElement.prototype.scrollBy = vi.fn();

// jsdom 未实现 Pointer Capture API；Radix UI（Select 等）在指针交互时依赖它们。
if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}
if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => undefined;
}
if (!HTMLElement.prototype.releasePointerCapture) {
  HTMLElement.prototype.releasePointerCapture = () => undefined;
}

// jsdom 未实现 ResizeObserver；Radix Tooltip/Popper 用它追踪触发器和内容尺寸。
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(() => {
  // 先卸载组件树再清理全局 stub：afterEach 按 LIFO 执行，文件级 afterEach 若先
  // unstubAllGlobals，组件卸载（cleanup）时访问 chrome 会 ReferenceError。
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
