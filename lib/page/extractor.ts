// ─── 通用页面纯文本提取器 ───
// 职责：在隔离世界中克隆并清洗当前 DOM，优先提取选择区/文章/主区域，最后有界读取可见正文。

import { Readability } from '@mozilla/readability';
import type { PageExtractionMode, PageScriptExtraction } from '@/lib/domain/types';

const MAX_SELECTED_CHARS = 2_000;
const MAX_TEXT_CHARS = 20_000;
const MAX_SCANNED_ELEMENTS = 50_000;
const MAX_READABILITY_ELEMENTS = 10_000;
const MIN_USEFUL_CHARS = 20;
const MIN_ARTICLE_CHARS = 120;

const EXCLUDED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'CANVAS',
  'SVG',
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'OPTION',
]);

/** 该函数只返回纯文本；Readability 的 HTML content 永远不会越过扩展边界。 */
export function extractCurrentDocument(doc: Document = document): PageScriptExtraction {
  const view = doc.defaultView;
  const elements = Array.from(doc.getElementsByTagName('*'));
  const scannedElements = Math.min(elements.length, MAX_SCANNED_ELEMENTS);
  const selection = safeSelectedText(doc, view);

  if (selection) {
    return result(doc, 'selection', selection, selection.length, scannedElements);
  }

  let articleText = '';
  let mainText = '';
  if (elements.length <= MAX_READABILITY_ELEMENTS) {
    const clone = doc.cloneNode(true) as Document;
    sanitizeClone(elements, Array.from(clone.getElementsByTagName('*')), view);
    mainText = bestSemanticMainText(clone);

    try {
      const article = new Readability(clone, {
        charThreshold: MIN_ARTICLE_CHARS,
        maxElemsToParse: MAX_READABILITY_ELEMENTS,
      }).parse();
      articleText = normalizeText(article?.textContent ?? '');
    } catch {
      // 文章算法失败时继续使用确定性的语义/可见文本兜底。
    }
  }

  if (articleText.length >= MIN_ARTICLE_CHARS) {
    return result(doc, 'article', articleText, articleText.length, scannedElements);
  }
  if (mainText.length >= MIN_USEFUL_CHARS) {
    return result(doc, 'main', mainText, mainText.length, scannedElements);
  }

  const fallback = visibleBodyText(doc, view);
  return result(
    doc,
    'body-fallback',
    fallback.text,
    fallback.originalChars,
    scannedElements,
    elements.length > MAX_SCANNED_ELEMENTS || fallback.truncated,
  );
}

function safeSelectedText(doc: Document, view: Window | null): string {
  const selection = view?.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return '';
  if (nodeIsSensitive(selection.anchorNode) || nodeIsSensitive(selection.focusNode)) return '';
  if (selection.anchorNode?.ownerDocument !== doc || selection.focusNode?.ownerDocument !== doc) {
    return '';
  }
  return clip(normalizeText(selection.toString()), MAX_SELECTED_CHARS);
}

function nodeIsSensitive(node: Node | null): boolean {
  let element = node instanceof Element ? node : node?.parentElement;
  while (element) {
    if (isExcludedElement(element)) return true;
    element = element.parentElement;
  }
  return false;
}

function sanitizeClone(
  sourceElements: Element[],
  cloneElements: Element[],
  view: Window | null,
): void {
  const length = Math.min(sourceElements.length, cloneElements.length);
  for (let index = 0; index < length; index += 1) {
    const source = sourceElements[index];
    const clone = cloneElements[index];
    if (source && clone && shouldRemoveFromReading(source, view)) clone.remove();
  }
}

function shouldRemoveFromReading(element: Element, view: Window | null): boolean {
  if (isExcludedElement(element)) return true;
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return true;
  if (!view) return false;
  try {
    const style = view.getComputedStyle(element);
    return (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.contentVisibility === 'hidden' ||
      style.opacity === '0'
    );
  } catch {
    return false;
  }
}

function isExcludedElement(element: Element): boolean {
  if (EXCLUDED_TAGS.has(element.tagName)) return true;
  const editable = element.getAttribute('contenteditable');
  return editable !== null && editable.toLowerCase() !== 'false';
}

function bestSemanticMainText(doc: Document): string {
  let best = '';
  for (const element of doc.querySelectorAll('main, [role="main"], article')) {
    const text = normalizeText(element.textContent ?? '');
    if (text.length > best.length) best = text;
  }
  return best;
}

function visibleBodyText(
  doc: Document,
  view: Window | null,
): { text: string; originalChars: number; truncated: boolean } {
  const body = doc.body;
  if (!body || !view) return { text: '', originalChars: 0, truncated: false };

  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const visibility = new WeakMap<Element, boolean>();
  const kept: string[] = [];
  let keptChars = 0;
  let originalChars = 0;
  let visited = 0;

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    visited += 1;
    if (visited > MAX_SCANNED_ELEMENTS) break;
    const parent = node.parentElement;
    if (!parent || !isVisibleForReading(parent, body, view, visibility)) continue;
    const fragment = normalizeInline(node.nodeValue ?? '');
    if (!fragment) continue;
    originalChars += fragment.length + (originalChars > 0 ? 1 : 0);
    if (keptChars >= MAX_TEXT_CHARS) continue;
    const available = MAX_TEXT_CHARS - keptChars - (kept.length > 0 ? 1 : 0);
    if (available <= 0) continue;
    const clipped = clip(fragment, available);
    kept.push(clipped);
    keptChars += clipped.length + (kept.length > 1 ? 1 : 0);
  }

  const text = normalizeText(kept.join('\n'));
  return {
    text,
    originalChars: Math.max(originalChars, text.length),
    truncated: visited > MAX_SCANNED_ELEMENTS || originalChars > text.length,
  };
}

function isVisibleForReading(
  start: Element,
  boundary: Element,
  view: Window,
  cache: WeakMap<Element, boolean>,
): boolean {
  const chain: Element[] = [];
  let element: Element | null = start;
  let inherited = true;

  while (element) {
    const cached = cache.get(element);
    if (cached !== undefined) {
      inherited = cached;
      break;
    }
    chain.push(element);
    if (element === boundary) break;
    element = element.parentElement;
  }

  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const current = chain[index];
    if (!current) continue;
    inherited = inherited && !shouldRemoveFromReading(current, view);
    cache.set(current, inherited);
  }
  return cache.get(start) ?? inherited;
}

function result(
  doc: Document,
  mode: PageExtractionMode,
  value: string,
  originalChars: number,
  scannedElements: number,
  forcedTruncated = false,
): PageScriptExtraction {
  const normalized = normalizeText(value);
  const text = clip(normalized, MAX_TEXT_CHARS);
  return {
    version: 1,
    executionUrl: doc.location.href,
    title: clip(normalizeInline(doc.title), 300),
    language: clip(normalizeInline(doc.documentElement.lang), 32),
    mode,
    text,
    originalChars: Math.max(originalChars, normalized.length),
    returnedChars: text.length,
    truncated: forcedTruncated || text.length < Math.max(originalChars, normalized.length),
    scannedElements,
    untrusted: true,
  };
}

function normalizeText(value: string): string {
  return value
    .replaceAll('\u0000', '')
    .replaceAll('\u00a0', ' ')
    .split(/\r?\n/)
    .map((line) => normalizeInline(line))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}
