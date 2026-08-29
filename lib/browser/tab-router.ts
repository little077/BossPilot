// ─── 通用标签页路由 ───
// 职责：只处理受约束的 HTTP(S) 目标，优先复用已有页面，并把焦点与加载等待收口到确定性代码。

import type { BrowserDestination, PageTurnSnapshot } from '@/lib/domain/types';

const LOAD_POLL_MS = 150;
const DEFAULT_LOAD_TIMEOUT_MS = 12_000;
/** tab open 的快速等待上限：SPA（如小红书）经常超时，快速返回让模型继续推进。 */
const OPEN_READY_GRACE_MS = 2_500;

export const KNOWN_BROWSER_DESTINATIONS: Readonly<
  Record<Exclude<BrowserDestination, 'current'>, string>
> = {
  baidu: 'https://www.baidu.com/',
  bing: 'https://www.bing.com/',
  google: 'https://www.google.com/',
  boss: 'https://www.zhipin.com/',
};

export interface RoutedTab {
  tab: chrome.tabs.Tab;
  reused: boolean;
}

export function resolveBrowserTarget(
  destination: BrowserDestination | undefined,
  directUrl: string | undefined,
  userText: string,
):
  | { ok: true; url: string }
  | { ok: false; error: 'INVALID_BROWSER_ACTION' | 'UNGROUNDED_URL'; detail: string } {
  if (destination && destination !== 'current') {
    return { ok: true, url: KNOWN_BROWSER_DESTINATIONS[destination] };
  }
  if (!directUrl) {
    return {
      ok: false,
      error: 'INVALID_BROWSER_ACTION',
      detail: '没有提供可以打开的目标网站。',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(directUrl);
  } catch {
    return { ok: false, error: 'INVALID_BROWSER_ACTION', detail: '目标网址格式无效。' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      error: 'INVALID_BROWSER_ACTION',
      detail: '浏览器操作只允许打开 HTTP(S) 页面。',
    };
  }
  if (!isUrlGroundedInUserText(parsed, userText)) {
    return {
      ok: false,
      error: 'UNGROUNDED_URL',
      detail: '模型给出的网址没有出现在用户请求中。为避免猜测网址，本次没有打开页面。',
    };
  }
  return { ok: true, url: parsed.href };
}

export async function openOrFocusTab(
  targetUrl: string,
  snapshot: PageTurnSnapshot | null,
  signal: AbortSignal,
): Promise<RoutedTab> {
  signal.throwIfAborted();
  const target = new URL(targetUrl);
  const tabs = await chrome.tabs.query({});
  signal.throwIfAborted();
  const matches = tabs.filter(
    (tab) => tab.id !== undefined && tab.url && isSameTarget(tab.url, target),
  );
  const existing = chooseExistingTab(matches, snapshot?.windowId);

  if (existing?.id !== undefined) {
    const tab = await chrome.tabs.update(existing.id, { active: true });
    if (!tab) throw new Error('TAB_NOT_FOUND: 已有标签页在切换前被关闭。');
    await focusWindow(tab.windowId);
    return { tab, reused: true };
  }

  const createProperties: chrome.tabs.CreateProperties = { url: target.href, active: true };
  if (snapshot?.windowId !== undefined) createProperties.windowId = snapshot.windowId;
  const tab = await chrome.tabs.create(createProperties);
  await focusWindow(tab.windowId);
  return { tab, reused: false };
}

export async function openNewTab(
  targetUrl: string,
  snapshot: PageTurnSnapshot | null,
  signal: AbortSignal,
): Promise<chrome.tabs.Tab> {
  signal.throwIfAborted();
  const target = new URL(targetUrl);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error('INVALID_BROWSER_ACTION: 只允许新建 HTTP(S) 标签页。');
  }
  const createProperties: chrome.tabs.CreateProperties = { url: target.href, active: true };
  if (snapshot?.windowId !== undefined) createProperties.windowId = snapshot.windowId;
  const tab = await chrome.tabs.create(createProperties);
  signal.throwIfAborted();
  await focusWindow(tab.windowId);
  return tab;
}

export async function waitForTabReady(
  tabId: number,
  signal: AbortSignal,
  timeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    signal.throwIfAborted();
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error('TAB_NOT_FOUND: 目标标签页已经关闭。');
    }
    if (tab.status === 'complete' && tab.url) return tab;
    await abortableDelay(LOAD_POLL_MS, signal);
  }
  throw new Error('TAB_LOAD_TIMEOUT: 页面在限定时间内没有加载完成。');
}

/**
 * tab open 专用：有界快速等待。页面在宽限期内加载完成则 ready=true；
 * 超时返回当前标签页与 ready=false（不抛错）——加载未完成不等于失败，
 * 验证责任交给后续 read_current_page。消灭 SPA 页面反复吃满 12s 超时的问题。
 */
export async function waitForTabReadyBounded(
  tabId: number,
  signal: AbortSignal,
  graceMs = OPEN_READY_GRACE_MS,
): Promise<{ tab: chrome.tabs.Tab; ready: boolean }> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    signal.throwIfAborted();
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error('TAB_NOT_FOUND: 目标标签页已经关闭。');
    }
    if (tab.status === 'complete' && tab.url) return { tab, ready: true };
    if (Date.now() > deadline) return { tab, ready: false };
    await abortableDelay(LOAD_POLL_MS, signal);
  }
}

export function isSameTarget(value: string, target: URL): boolean {
  try {
    const candidate = new URL(value);
    if (candidate.origin !== target.origin) return false;
    const targetPath = normalizePath(target.pathname);
    return targetPath === '/' || normalizePath(candidate.pathname) === targetPath;
  } catch {
    return false;
  }
}

function isUrlGroundedInUserText(url: URL, userText: string): boolean {
  const normalized = userText.toLowerCase();
  const host = url.hostname.toLowerCase();
  const bareHost = host.replace(/^www\./, '');
  return (
    normalized.includes(url.href.toLowerCase()) ||
    containsExplicitHost(normalized, host) ||
    (bareHost.includes('.') && containsExplicitHost(normalized, bareHost))
  );
}

function containsExplicitHost(text: string, host: string): boolean {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(^|[^a-z0-9.-])${escaped}($|[^a-z0-9.-])`, 'u').test(text);
}

function chooseExistingTab(
  tabs: chrome.tabs.Tab[],
  preferredWindowId: number | undefined,
): chrome.tabs.Tab | undefined {
  return [...tabs].sort((left, right) => {
    const leftPreferred = left.windowId === preferredWindowId ? 1 : 0;
    const rightPreferred = right.windowId === preferredWindowId ? 1 : 0;
    if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
    if (left.active !== right.active) return left.active ? -1 : 1;
    return (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0);
  })[0];
}

async function focusWindow(windowId: number): Promise<void> {
  try {
    await chrome.windows.update(windowId, { focused: true });
  } catch {
    // 标签页已经激活时，窗口焦点失败不应把整个低风险导航判为失败。
  }
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/u, '');
  return trimmed || '/';
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
