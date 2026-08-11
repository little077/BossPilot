// ─── 通用搜索框交互脚本 ───
// 职责：用可见性与无障碍语义发现搜索控件，输入用户查询并触发表单；函数保持完全自包含以供 executeScript 序列化。

import type {
  BrowserPageFingerprint,
  BrowserSearchControlSnapshot,
  BrowserSearchScriptResult,
} from '@/lib/domain/types';

export function performSemanticSearch(query: string): BrowserSearchScriptResult {
  type Candidate = { element: HTMLElement; snapshot: BrowserSearchControlSnapshot };
  const maxCandidates = 8;

  const clip = (value: string, maxChars = 160) => {
    const normalized = value.replaceAll('\u0000', '').replace(/\s+/gu, ' ').trim();
    return normalized.length > maxChars ? normalized.slice(0, maxChars) : normalized;
  };
  const fingerprint = (): BrowserPageFingerprint => {
    const visibleText = document.body?.innerText ?? '';
    const text =
      visibleText.length <= 12_000
        ? visibleText
        : `${visibleText.slice(0, 6_000)}\n${visibleText.slice(-6_000)}`;
    let hash = 2_166_136_261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    return {
      url: window.location.href,
      title: clip(document.title, 300),
      textHash: (hash >>> 0).toString(16),
      textLength: visibleText.length,
      childCount: document.body?.childElementCount ?? 0,
    };
  };
  const isVisible = (element: HTMLElement) => {
    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number.parseFloat(style.opacity || '1') <= 0.05
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width >= 8 && rect.height >= 8;
  };
  const labelText = (element: HTMLElement) => {
    const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/u)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    const parts = [
      element.getAttribute('aria-label') ?? '',
      labelledBy,
      element.getAttribute('placeholder') ?? '',
      element.getAttribute('title') ?? '',
      element.getAttribute('name') ?? '',
    ];
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      for (const label of Array.from(element.labels ?? [])) parts.push(label.textContent ?? '');
    }
    return clip(parts.join(' '));
  };
  const isSubmitControl = (element: HTMLElement) => {
    if (!isVisible(element)) return false;
    const role = element.getAttribute('role') ?? '';
    const inputType = element instanceof HTMLInputElement ? element.type : '';
    const isButton =
      element instanceof HTMLButtonElement ||
      (element instanceof HTMLInputElement && ['submit', 'button'].includes(inputType)) ||
      role === 'button';
    if (!isButton) return false;
    const text = clip(
      `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''} ${
        element instanceof HTMLInputElement ? element.value : ''
      }`,
    );
    return (
      /^(搜索|查询|查找|搜一下|百度一下|search|find)$/iu.test(text) ||
      /搜索|查询|查找|search|find/iu.test(text)
    );
  };
  const findSubmitControl = (
    control: HTMLElement,
    includeDocumentRoot = true,
  ): HTMLElement | null => {
    let root = control.parentElement;
    for (let depth = 0; root && depth < 4; depth += 1, root = root.parentElement) {
      if (!includeDocumentRoot && (root === document.body || root === document.documentElement)) {
        break;
      }
      if (
        (root === document.body || root === document.documentElement) &&
        root.childElementCount > 25
      ) {
        break;
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      let scanned = 0;
      while (node && scanned < 500) {
        scanned += 1;
        if (node instanceof HTMLElement && node !== control && isSubmitControl(node)) return node;
        node = walker.nextNode();
      }
    }
    return null;
  };
  const scoreElement = (element: HTMLElement): BrowserSearchControlSnapshot | null => {
    if (!isVisible(element)) return null;
    const role = clip(element.getAttribute('role') ?? '').toLowerCase();
    const placeholder = clip(element.getAttribute('placeholder') ?? '');
    const label = labelText(element);
    const semanticText = `${role} ${placeholder} ${label}`.toLowerCase();
    let tag: BrowserSearchControlSnapshot['tag'];
    let type = '';
    let disabled = false;
    let readOnly = false;

    if (element instanceof HTMLInputElement) {
      type = element.type.toLowerCase();
      if (type !== 'text' && type !== 'search') return null;
      tag = 'input';
      disabled = element.disabled;
      readOnly = element.readOnly;
    } else if (element instanceof HTMLTextAreaElement) {
      tag = 'textarea';
      disabled = element.disabled;
      readOnly = element.readOnly;
    } else if (
      element.isContentEditable ||
      ['true', 'plaintext-only'].includes(element.getAttribute('contenteditable') ?? '')
    ) {
      tag = 'contenteditable';
    } else {
      return null;
    }
    if (disabled || readOnly) return null;

    let score = 0;
    if (role === 'searchbox') score += 120;
    if (type === 'search') score += 110;
    if (/搜索|查找|查询|search|find|keyword|关键词|职位|岗位/iu.test(semanticText)) score += 75;
    if (element.closest('form')?.getAttribute('role') === 'search') score += 45;
    if (element.getAttribute('enterkeyhint') === 'search') score += 35;
    if (findSubmitControl(element, false)) score += 80;
    if (element instanceof HTMLInputElement) score += 8;
    if (score < 50) return null;

    return { tag, role, label, placeholder, type, score };
  };
  const collectCandidates = (): Candidate[] => {
    const candidates: Candidate[] = [];
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    let scanned = 0;
    let node = walker.nextNode();
    while (node && scanned < 5_000) {
      scanned += 1;
      if (node instanceof HTMLElement) {
        const snapshot = scoreElement(node);
        if (snapshot) candidates.push({ element: node, snapshot });
      }
      node = walker.nextNode();
    }
    return candidates.sort((left, right) => right.snapshot.score - left.snapshot.score);
  };
  const setControlValue = (element: HTMLElement, value: string) => {
    element.focus();
    if (element instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setter) return false;
      setter.call(element, value);
    } else if (element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) return false;
      setter.call(element, value);
    } else if (
      element.isContentEditable ||
      ['true', 'plaintext-only'].includes(element.getAttribute('contenteditable') ?? '')
    ) {
      element.textContent = value;
    } else {
      return false;
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.value === value
      : element.textContent === value;
  };
  const initialFingerprint = fingerprint();
  const candidates = collectCandidates();
  const snapshots = candidates.slice(0, maxCandidates).map(({ snapshot }) => snapshot);
  const first = candidates[0];
  if (!first) {
    return {
      version: 1,
      ok: false,
      executionUrl: window.location.href,
      candidates: [],
      ambiguous: false,
      typed: false,
      submitted: false,
      fingerprint: initialFingerprint,
      error: 'NO_SEARCH_CONTROL',
    };
  }
  const second = candidates[1];
  const ambiguous = Boolean(second && second.snapshot.score >= first.snapshot.score - 8);
  if (ambiguous) {
    return {
      version: 1,
      ok: false,
      executionUrl: window.location.href,
      candidates: snapshots,
      ambiguous: true,
      typed: false,
      submitted: false,
      fingerprint: initialFingerprint,
      error: 'AMBIGUOUS_SEARCH_CONTROL',
    };
  }

  const typed = setControlValue(first.element, query);
  if (!typed) {
    return {
      version: 1,
      ok: false,
      executionUrl: window.location.href,
      control: first.snapshot,
      candidates: snapshots,
      ambiguous: false,
      typed: false,
      submitted: false,
      fingerprint: initialFingerprint,
      error: 'INTERACTION_FAILED',
    };
  }

  const form =
    first.element instanceof HTMLInputElement || first.element instanceof HTMLTextAreaElement
      ? first.element.form
      : first.element.closest('form');
  const submitControl = form ? null : findSubmitControl(first.element);
  const submissionMethod: BrowserSearchScriptResult['submissionMethod'] = form
    ? 'form'
    : submitControl
      ? 'button'
      : 'keypress';
  window.setTimeout(() => {
    if (form) {
      form.requestSubmit();
      return;
    }
    if (submitControl) {
      submitControl.click();
      return;
    }
    first.element.focus();
    first.element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
    first.element.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }),
    );
  }, 30);

  return {
    version: 1,
    ok: true,
    executionUrl: window.location.href,
    control: first.snapshot,
    candidates: snapshots,
    ambiguous: false,
    typed: true,
    submitted: true,
    submissionMethod,
    fingerprint: initialFingerprint,
  };
}

export function captureBrowserPageFingerprint(): BrowserPageFingerprint {
  const clip = (value: string, maxChars = 300) => {
    const normalized = value.replaceAll('\u0000', '').replace(/\s+/gu, ' ').trim();
    return normalized.length > maxChars ? normalized.slice(0, maxChars) : normalized;
  };
  const visibleText = document.body?.innerText ?? '';
  const text =
    visibleText.length <= 12_000
      ? visibleText
      : `${visibleText.slice(0, 6_000)}\n${visibleText.slice(-6_000)}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return {
    url: window.location.href,
    title: clip(document.title),
    textHash: (hash >>> 0).toString(16),
    textLength: visibleText.length,
    childCount: document.body?.childElementCount ?? 0,
  };
}
