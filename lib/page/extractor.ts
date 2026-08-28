// ─── 通用页面纯文本提取器 ───
// 职责：在隔离世界中克隆并清洗当前 DOM，优先提取选择区/文章/主区域，最后有界读取可见正文。

import { Readability } from '@mozilla/readability';
import type {
  PageExtractionMode,
  PageScriptExtraction,
  PageSemanticStructure,
} from '@/lib/domain/types';

const MAX_SELECTED_CHARS = 2_000;
const MAX_TEXT_CHARS = 20_000;
const MAX_SCANNED_ELEMENTS = 50_000;
const MAX_READABILITY_ELEMENTS = 10_000;
const MIN_USEFUL_CHARS = 20;
const MIN_ARTICLE_CHARS = 120;
const MAX_STRUCTURE_ELEMENTS = 10_000;
const MAX_HEADINGS = 40;
const MAX_LANDMARKS = 24;

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
  const structure = extractSemanticStructure(doc, view, elements);

  if (selection) {
    return result(doc, 'selection', selection, selection.length, scannedElements, structure);
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
    return result(doc, 'article', articleText, articleText.length, scannedElements, structure);
  }
  if (mainText.length >= MIN_USEFUL_CHARS) {
    return result(doc, 'main', mainText, mainText.length, scannedElements, structure);
  }

  const fallback = visibleBodyText(doc, view);
  return result(
    doc,
    'body-fallback',
    fallback.text,
    fallback.originalChars,
    scannedElements,
    structure,
    elements.length > MAX_SCANNED_ELEMENTS || fallback.truncated,
  );
}

function extractSemanticStructure(
  doc: Document,
  view: Window | null,
  elements: Element[],
): PageSemanticStructure {
  const headings: PageSemanticStructure['headings'] = [];
  const landmarks: PageSemanticStructure['landmarks'] = [];
  const controlCounts = new Map<string, number>();
  const structureVisibility = new WeakMap<Element, boolean>();
  const textVisibility = new WeakMap<Element, boolean>();
  const boundary = doc.body ?? doc.documentElement;
  let interactiveTotal = 0;
  let matchedHeadings = 0;
  let matchedLandmarks = 0;

  const scanned = Math.min(elements.length, MAX_STRUCTURE_ELEMENTS);
  for (let index = 0; index < scanned; index += 1) {
    const element = elements[index];
    if (!element || !view || !isVisibleForStructure(element, boundary, view, structureVisibility)) {
      continue;
    }

    const headingLevel = /^H([1-6])$/u.exec(element.tagName)?.[1];
    if (headingLevel) {
      const text = visibleElementText(element, boundary, view, textVisibility, 200);
      if (text) {
        matchedHeadings += 1;
        if (headings.length < MAX_HEADINGS) {
          headings.push({ level: Number(headingLevel), text });
        }
      }
    }

    const landmarkRole = semanticLandmarkRole(element);
    if (landmarkRole) {
      matchedLandmarks += 1;
      if (landmarks.length < MAX_LANDMARKS) {
        landmarks.push({ role: landmarkRole, name: accessibleStructureName(element, doc) });
      }
    }

    const controlRole = semanticControlRole(element);
    if (controlRole && isInteractiveControl(element, controlRole)) {
      interactiveTotal += 1;
      controlCounts.set(controlRole, (controlCounts.get(controlRole) ?? 0) + 1);
    }
  }

  return {
    version: 1,
    headings,
    landmarks,
    controls: {
      total: interactiveTotal,
      byRole: Array.from(controlCounts, ([role, count]) => ({ role, count })).sort(
        (left, right) => right.count - left.count || left.role.localeCompare(right.role),
      ),
    },
    truncated:
      elements.length > MAX_STRUCTURE_ELEMENTS ||
      matchedHeadings > headings.length ||
      matchedLandmarks > landmarks.length,
  };
}

function semanticLandmarkRole(element: Element): string {
  const explicit = normalizeInline(element.getAttribute('role') ?? '').toLowerCase();
  if (
    [
      'banner',
      'complementary',
      'contentinfo',
      'form',
      'main',
      'navigation',
      'region',
      'search',
    ].includes(explicit)
  ) {
    return explicit;
  }
  switch (element.tagName) {
    case 'ASIDE':
      return 'complementary';
    case 'FOOTER':
      return 'contentinfo';
    case 'FORM':
      return 'form';
    case 'HEADER':
      return 'banner';
    case 'MAIN':
      return 'main';
    case 'NAV':
      return 'navigation';
    default:
      return '';
  }
}

function semanticControlRole(element: Element): string {
  const explicit = normalizeInline(element.getAttribute('role') ?? '').toLowerCase();
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === 'a' && element.hasAttribute('href')) return 'link';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag !== 'input') {
    if (
      (element as HTMLElement).isContentEditable ||
      ['', 'true', 'plaintext-only'].includes(element.getAttribute('contenteditable') ?? 'missing')
    ) {
      return 'textbox';
    }
    return '';
  }
  const type = (element as HTMLInputElement).type.toLowerCase();
  if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (type === 'range') return 'slider';
  if (type === 'search') return 'searchbox';
  if (type === 'hidden') return '';
  return 'textbox';
}

function isVisibleForStructure(
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
    const excluded = [
      'SCRIPT',
      'STYLE',
      'NOSCRIPT',
      'TEMPLATE',
      'IFRAME',
      'OBJECT',
      'EMBED',
    ].includes(current.tagName);
    let hidden =
      excluded || current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true';
    if (!hidden) {
      try {
        const style = view.getComputedStyle(current);
        hidden =
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          style.contentVisibility === 'hidden' ||
          style.opacity === '0';
      } catch {
        hidden = false;
      }
    }
    inherited = inherited && !hidden;
    cache.set(current, inherited);
  }
  return cache.get(start) ?? inherited;
}

function isInteractiveControl(element: Element, role: string): boolean {
  if (role === 'presentation' || role === 'none') return false;
  if (
    ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(element.tagName) ||
    (element as HTMLElement).isContentEditable ||
    ['', 'true', 'plaintext-only'].includes(element.getAttribute('contenteditable') ?? 'missing')
  ) {
    return true;
  }
  return (element as HTMLElement).tabIndex >= 0 || element.hasAttribute('onclick');
}

function accessibleStructureName(element: Element, doc: Document): string {
  const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/u)
    .filter(Boolean)
    .map((id) => doc.getElementById(id)?.textContent ?? '')
    .join(' ');
  return clip(
    normalizeInline(
      labelledBy || element.getAttribute('aria-label') || element.getAttribute('title') || '',
    ),
    120,
  );
}

function visibleElementText(
  root: Element,
  boundary: Element,
  view: Window,
  visibility: WeakMap<Element, boolean>,
  maxChars: number,
): string {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const fragments: string[] = [];
  let chars = 0;
  for (let node = walker.nextNode(); node && chars < maxChars; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !isVisibleForReading(parent, boundary, view, visibility)) continue;
    const text = normalizeInline(node.nodeValue ?? '');
    if (!text) continue;
    const separator = fragments.length > 0 ? 1 : 0;
    const available = maxChars - chars - separator;
    if (available <= 0) break;
    const fragment = clip(text, available);
    fragments.push(fragment);
    chars += fragment.length + separator;
  }
  return normalizeInline(fragments.join(' '));
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
  structure: PageSemanticStructure,
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
    structure,
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
