// ─── 页面访问边界（chrome API 薄封装） ───
// 把「定位活动标签页」与「注入自包含抽取函数」收敛在这里：上层工具只面对结构化结果
// 与稳定错误码；jsdom 单测可以在这两个函数上直接 mock，不触碰真实浏览器 API。

import type { ToolErrorCode } from './types';

export interface ActiveTabInfo {
  tabId: number;
  url: string;
}

export type ActiveTabResult =
  | { ok: true; tab: ActiveTabInfo }
  | { ok: false; errorCode: ToolErrorCode };

export type InjectionOutput<T> =
  | { ok: true; value: Awaited<T> }
  | { ok: false; errorCode: ToolErrorCode };

/** 解析当前窗口的活动标签页；无授权时 tab.url 不可见，统一归类为稳定错误码。 */
export async function resolveActiveTab(): Promise<ActiveTabResult> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    return { ok: false, errorCode: 'no_active_tab' };
  }
  const tab = tabs[0];
  if (!tab || tab.id === undefined) return { ok: false, errorCode: 'no_active_tab' };

  const url = tab.url ?? tab.pendingUrl ?? '';
  // activeTab 授权未覆盖该标签页时 url 不可见：对应「让用户点一下扩展图标」的提示路径。
  if (!url) return { ok: false, errorCode: 'page_access_denied' };
  // 拿到 URL 但协议不可注入（chrome://、扩展页、file://、应用商店页等）。
  if (!/^https?:/i.test(url)) return { ok: false, errorCode: 'unsupported_page' };

  return { ok: true, tab: { tabId: tab.id, url } };
}

/** 注入自包含函数并取回结果；异常按注入失败的常见原因归类。 */
export async function injectExtraction<T>(
  tabId: number,
  func: () => T,
): Promise<InjectionOutput<T>> {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func });
    const value: unknown = results[0]?.result;
    if (value === undefined || value === null) return { ok: false, errorCode: 'injection_failed' };
    // 收窄后的泛型条件类型无法直接赋回 Awaited<T>，经 unknown 中转断言一次。
    return { ok: true, value: value as Awaited<T> };
  } catch (error) {
    return { ok: false, errorCode: classifyInjectionError(error) };
  }
}

/** 注入失败的常见原因：缺少标签页访问权 → page_access_denied；其余归 injection_failed。 */
function classifyInjectionError(error: unknown): ToolErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/cannot access|cannot be scripted|extensions gallery|host permission/i.test(message)) {
    return 'page_access_denied';
  }
  return 'injection_failed';
}
