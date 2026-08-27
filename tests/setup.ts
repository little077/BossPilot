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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});
