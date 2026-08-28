// ─── 页面视觉捕获 ───
// 职责：在精确页面文档上临时遮盖表单值、标注短期元素引用并截取当前可见区域；
// 标记层始终在 finally 中移除，截图只作为当前模型回合的短时内容块返回。

import type {
  PageInteractiveElementCandidate,
  PageTurnSnapshot,
  PageVisualOverlayResult,
} from '@/lib/domain/types';

export interface VisualMarker extends PageInteractiveElementCandidate {
  ref: string;
}

export interface MarkedPageScreenshot {
  data: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  markerCount: number;
  maskedFieldCount: number;
  approximateBytes: number;
}

export interface CaptureMarkedPageScreenshotOptions {
  snapshot: PageTurnSnapshot;
  documentId: string;
  elements: VisualMarker[];
  signal: AbortSignal;
}

const MAX_MARKERS = 40;
const MAX_BASE64_CHARS = 2_000_000;
const CAPTURE_SETTLE_MS = 80;

export async function captureMarkedPageScreenshot({
  snapshot,
  documentId,
  elements,
  signal,
}: CaptureMarkedPageScreenshotOptions): Promise<MarkedPageScreenshot> {
  signal.throwIfAborted();
  const token = crypto.randomUUID();
  const previousActive = (
    await chrome.tabs.query({
      active: true,
      windowId: snapshot.windowId,
    })
  )?.[0];
  const switchedTab = previousActive?.id !== snapshot.tabId;

  if (switchedTab) {
    await chrome.tabs.update(snapshot.tabId, { active: true });
    await abortableDelay(CAPTURE_SETTLE_MS, signal);
  }

  let overlayInstalled = false;
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: snapshot.tabId, documentIds: [documentId] },
      func: installVisualOverlay,
      args: [
        token,
        snapshot.url,
        elements.slice(0, MAX_MARKERS).map(({ ref, path, tag, risk }) => ({
          ref,
          path,
          tag,
          risk,
        })),
      ],
    });
    const overlay = parseOverlayResult(injected[0]?.result);
    if (!overlay?.ok) {
      throw new Error(overlay?.detail || '无法在当前页面建立视觉标记层。');
    }
    overlayInstalled = true;
    await abortableDelay(CAPTURE_SETTLE_MS, signal);
    const dataUrl = await chrome.tabs.captureVisibleTab(snapshot.windowId, {
      format: 'jpeg',
      quality: 72,
    });
    signal.throwIfAborted();
    const image = parseScreenshotDataUrl(dataUrl);
    return {
      ...image,
      markerCount: overlay.markerCount,
      maskedFieldCount: overlay.maskedFieldCount,
    };
  } finally {
    if (overlayInstalled) {
      await chrome.scripting
        .executeScript({
          target: { tabId: snapshot.tabId, documentIds: [documentId] },
          func: removeVisualOverlay,
          args: [token],
        })
        .catch(() => void 0);
    }
    if (switchedTab && previousActive?.id !== undefined) {
      const activeNow = (
        await chrome.tabs.query({ active: true, windowId: snapshot.windowId }).catch(() => [])
      )[0];
      if (activeNow?.id === snapshot.tabId) {
        await chrome.tabs.update(previousActive.id, { active: true }).catch(() => void 0);
      }
    }
  }
}

export function parseScreenshotDataUrl(
  dataUrl: string,
): Pick<MarkedPageScreenshot, 'data' | 'mimeType' | 'approximateBytes'> {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([a-z0-9+/=]+)$/iu.exec(dataUrl);
  if (!match?.[1] || !match[2]) throw new Error('浏览器返回了无效的截图数据。');
  if (match[2].length > MAX_BASE64_CHARS) {
    throw new Error('截图超过安全大小上限，请缩小浏览器窗口后重试。');
  }
  const mimeType = match[1].toLowerCase();
  if (mimeType !== 'image/jpeg' && mimeType !== 'image/png' && mimeType !== 'image/webp') {
    throw new Error('截图格式不受支持。');
  }
  const padding = match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0;
  return {
    data: match[2],
    mimeType,
    approximateBytes: Math.floor((match[2].length * 3) / 4) - padding,
  };
}

function parseOverlayResult(value: unknown): PageVisualOverlayResult | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== 1 ||
    typeof value.ok !== 'boolean' ||
    typeof value.executionUrl !== 'string' ||
    typeof value.token !== 'string' ||
    typeof value.markerCount !== 'number' ||
    typeof value.maskedFieldCount !== 'number' ||
    typeof value.detail !== 'string'
  ) {
    return null;
  }
  return value as unknown as PageVisualOverlayResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    setTimeout(() => signal.removeEventListener('abort', onAbort), ms);
  });
}

/** 自包含注入函数：不能引用模块变量或 import。 */
export function installVisualOverlay(
  token: string,
  expectedUrl: string,
  markers: Array<{
    ref: string;
    path: Array<number | 'shadow'>;
    tag: string;
    risk: 'safe' | 'confirm' | 'blocked';
  }>,
): PageVisualOverlayResult {
  const result = (
    ok: boolean,
    detail: string,
    markerCount = 0,
    maskedFieldCount = 0,
    error?: PageVisualOverlayResult['error'],
  ): PageVisualOverlayResult => ({
    version: 1,
    ok,
    executionUrl: window.location.href,
    token,
    markerCount,
    maskedFieldCount,
    detail,
    ...(error ? { error } : {}),
  });
  const navigationKey = (value: string) => {
    try {
      const url = new URL(value);
      url.hash = '';
      return url.href;
    } catch {
      return value;
    }
  };
  if (navigationKey(window.location.href) !== navigationKey(expectedUrl)) {
    return result(false, '视觉观察前页面地址已经变化。', 0, 0, 'STALE_VISUAL_OBSERVATION');
  }

  const rootId = `bosspilot-visual-${token}`;
  if (document.getElementById(rootId)) {
    return result(false, '页面中已经存在同名视觉标记层。', 0, 0, 'VISUAL_CAPTURE_FAILED');
  }
  const root = document.createElement('div');
  root.id = rootId;
  root.setAttribute('aria-hidden', 'true');
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '2147483647',
    overflow: 'hidden',
  });

  const visibleRect = (element: Element): DOMRect | null => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number.parseFloat(style.opacity || '1') <= 0.05 ||
      rect.width < 4 ||
      rect.height < 4 ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= window.innerHeight ||
      rect.left >= window.innerWidth
    ) {
      return null;
    }
    return rect;
  };
  const appendBox = (rect: DOMRect, style: Partial<CSSStyleDeclaration>) => {
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed',
      left: `${Math.max(0, rect.left)}px`,
      top: `${Math.max(0, rect.top)}px`,
      width: `${Math.min(rect.width, window.innerWidth - Math.max(0, rect.left))}px`,
      height: `${Math.min(rect.height, window.innerHeight - Math.max(0, rect.top))}px`,
      ...style,
    });
    root.append(box);
    return box;
  };

  let maskedFieldCount = 0;
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  let scanned = 0;
  while (node && scanned < 10_000) {
    scanned += 1;
    if (node instanceof Element) {
      const tag = node.tagName.toLowerCase();
      const input = node instanceof HTMLInputElement ? node : null;
      const editable = (node as HTMLElement).isContentEditable;
      const shouldMask =
        (input &&
          !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color'].includes(
            input.type.toLowerCase(),
          ) &&
          Boolean(input.value)) ||
        (node instanceof HTMLTextAreaElement && Boolean(node.value)) ||
        (node instanceof HTMLSelectElement && Boolean(node.value)) ||
        (editable && Boolean(node.textContent?.trim())) ||
        (tag === 'input' && ['password', 'file'].includes(input?.type.toLowerCase() ?? ''));
      const rect = shouldMask ? visibleRect(node) : null;
      if (rect) {
        appendBox(rect, {
          background: 'rgba(32, 33, 36, 0.96)',
          border: '1px solid rgba(255,255,255,0.8)',
          borderRadius: '4px',
        });
        maskedFieldCount += 1;
      }
    }
    node = walker.nextNode();
  }

  let markerCount = 0;
  for (const marker of markers) {
    // path 遍历：'shadow' 表示从 shadow host 进入其 open shadow root。
    let container: Element | ShadowRoot = document.documentElement;
    let element: Element = document.documentElement;
    let pathBroken = false;
    for (const index of marker.path) {
      if (index === 'shadow') {
        if (!(container instanceof Element) || !container.shadowRoot) {
          pathBroken = true;
          break;
        }
        container = container.shadowRoot;
        continue;
      }
      const child = container.children.item(index);
      if (!child) {
        pathBroken = true;
        break;
      }
      container = child;
      element = child;
    }
    if (
      pathBroken ||
      element === document.documentElement ||
      element.tagName.toLowerCase() !== marker.tag
    ) {
      continue;
    }
    const rect = visibleRect(element);
    if (!rect) continue;
    const color =
      marker.risk === 'blocked' ? '#6b7280' : marker.risk === 'confirm' ? '#f59e0b' : '#ef3340';
    const box = appendBox(rect, {
      border: `2px solid ${color}`,
      borderRadius: '5px',
      boxShadow: '0 0 0 1px rgba(255,255,255,0.9)',
    });
    const label = document.createElement('span');
    label.textContent = marker.ref;
    Object.assign(label.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      transform: 'translate(-1px, -100%)',
      padding: '2px 5px',
      borderRadius: '4px 4px 4px 0',
      background: color,
      color: '#fff',
      font: '700 12px/16px ui-monospace, SFMono-Regular, Consolas, monospace',
      textShadow: '0 1px 1px rgba(0,0,0,0.35)',
      whiteSpace: 'nowrap',
    });
    box.append(label);
    markerCount += 1;
  }

  document.documentElement.append(root);
  return result(
    true,
    `已标记 ${markerCount} 个控件并遮盖 ${maskedFieldCount} 个已填写字段。`,
    markerCount,
    maskedFieldCount,
  );
}

/** 自包含清理函数：截图成功、失败和取消都会调用。 */
export function removeVisualOverlay(token: string): boolean {
  const root = document.getElementById(`bosspilot-visual-${token}`);
  if (!root) return false;
  root.remove();
  return true;
}
