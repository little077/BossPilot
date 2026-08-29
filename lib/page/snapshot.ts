// ─── 单轮标签页快照 ───
// 职责：用户发送时固定页面身份，并在读取前后校验，禁止静默改读另一个活动页。

import type { ChatMessage } from '@/lib/domain/chat';
import type { PageReadErrorCode, PageTurnSnapshot } from '@/lib/domain/types';
import { withPageContext } from './context';

export type PageSnapshotValidation =
  | { ok: true; tab: chrome.tabs.Tab }
  | { ok: false; errorCode: PageReadErrorCode; message: string };

export async function capturePageTurnSnapshot(): Promise<PageTurnSnapshot | null> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab?.id || tab.windowId === undefined || !tab.url) return null;
  return snapshotFromTab(tab);
}

export function snapshotFromTab(tab: chrome.tabs.Tab, capturedAt = Date.now()): PageTurnSnapshot {
  if (tab.id === undefined || tab.windowId === undefined || !tab.url) {
    throw new TypeError('标签页缺少 id、windowId 或 URL。');
  }
  const parsed = parseUrl(tab.url);
  const origin = parsed?.origin === 'null' ? '' : (parsed?.origin ?? '');
  const scheme = parsed?.protocol.replace(':', '') ?? '';
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    safeUrl: safePageUrl(tab.url),
    origin,
    title: safePageTitle(tab.title ?? '', tab.url),
    scheme,
    isHttp: scheme === 'http' || scheme === 'https',
    isBoss: origin === 'https://www.zhipin.com',
    capturedAt,
  };
}

export async function validatePageTurnSnapshot(
  snapshot: PageTurnSnapshot,
): Promise<PageSnapshotValidation> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(snapshot.tabId);
  } catch {
    return changed('原页面已经关闭，未读取其他标签页。');
  }
  if (tab.windowId !== snapshot.windowId || !tab.url) {
    return changed('原页面已经被替换，未读取其他标签页。');
  }
  // 页面级校验只看 origin+pathname：SPA（如小红书）滚动加载时 query 参数
  // （xsec_token 等）会高频变化，不应误判为“页面已经变化”；跨站或跨页面仍严格失败。
  if (!samePageKey(tab.url, snapshot.url)) {
    return changed('发送问题后页面已经发生变化，请在目标页面重新发送。');
  }
  return { ok: true, tab };
}

/**
 * 宽松的“同一页面”判定：origin 与 pathname 相同即视为未跳转，
 * 忽略 query/hash 变化。非 HTTP(S) 或解析失败时回退到完整字符串比较（严格）。
 */
export function samePageKey(urlA: string, urlB: string): boolean {
  const a = parseUrl(urlA);
  const b = parseUrl(urlB);
  if (!a || !b || (a.protocol !== 'http:' && a.protocol !== 'https:')) {
    return urlA === urlB;
  }
  return a.origin === b.origin && a.pathname === b.pathname;
}

export function pageContextHistory(
  history: ChatMessage[],
  snapshot: PageTurnSnapshot | null,
): ChatMessage[] {
  // 兼容入口：恢复暂停点时注入活动页上下文（不含标签页列表）。
  return withPageContext(history, snapshot);
}

export function safePageUrl(value: string): string {
  const parsed = parseUrl(value);
  return parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    ? `${parsed.origin}${parsed.pathname}`
    : '';
}

/**
 * Chrome 会在无 title 的页面把 URL 当作标签标题；这类伪标题同样必须去掉查询参数，
 * 避免它经工具状态或诊断日志绕过 safePageUrl 的隐私边界。
 */
export function safePageTitle(value: string, pageUrl: string): string {
  const title = clip(normalizeInline(value), 300);
  const page = parseUrl(pageUrl);
  if (!title || !page) return title;

  const normalizedTitle = title.replace(/^https?:\/\//i, '');
  const host = page.host.toLowerCase();
  const bareHost = host.replace(/^www\./, '');
  const lowerTitle = normalizedTitle.toLowerCase();
  const looksLikePageUrl = [host, bareHost].some(
    (candidate) => lowerTitle === candidate || lowerTitle.startsWith(`${candidate}/`),
  );
  if (!looksLikePageUrl) return title;

  const queryIndex = normalizedTitle.search(/[?#]/u);
  return queryIndex < 0 ? normalizedTitle : normalizedTitle.slice(0, queryIndex);
}

export function navigationKey(value: string): string {
  const parsed = parseUrl(value);
  if (!parsed) return value;
  parsed.hash = '';
  return parsed.href;
}

function changed(message: string): PageSnapshotValidation {
  return { ok: false, errorCode: 'page_changed', message };
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** JSON 序列化时转义 `<`，避免网页标题/正文中的标记被模型当作结构化指令。 */
export function safeJson(value: object): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function normalizeInline(value: string): string {
  return value.replaceAll('\u0000', '').replace(/\s+/g, ' ').trim();
}

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}
