// ─── 当前页面结构诊断采集 ───
// 职责：在下载诊断日志时读取当前活动的 Boss 页面，并返回限量、只读、脱敏结构快照。
// 非 Boss 页面或采集失败不会阻断执行日志下载，只在报告中写明原因。

import { captureZhipinPageStructure, isZhipinUrl } from '@/lib/adapter/zhipin';
import type { DiagnosticPageStructureSnapshot } from '@/lib/domain/types';

export async function captureCurrentPageStructure(): Promise<DiagnosticPageStructureSnapshot> {
  const capturedAt = Date.now();
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    return {
      status: 'failed',
      capturedAt,
      reason: '扩展无法访问当前活动标签页，请检查 tabs 权限。',
    };
  }

  const tab = tabs[0];
  if (!tab?.id) {
    return {
      status: 'skipped',
      capturedAt,
      reason: '没有找到可采集的活动标签页。',
    };
  }
  if (!isZhipinUrl(tab.url)) {
    return {
      status: 'skipped',
      capturedAt,
      reason: '当前活动标签页不是 Boss 直聘官方页面，未采集 DOM 结构。',
    };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: captureZhipinPageStructure,
    });
    const snapshot = results[0]?.result;
    if (snapshot) return snapshot;
    return {
      status: 'failed',
      capturedAt,
      pageUrl: safePageUrl(tab.url),
      reason: '页面脚本已经执行，但没有返回结构快照；页面可能正在导航或重新加载。',
    };
  } catch {
    return {
      status: 'failed',
      capturedAt,
      pageUrl: safePageUrl(tab.url),
      reason: '无法读取当前 Boss 页面结构，请刷新页面并确认扩展拥有站点访问权限。',
    };
  }
}

function safePageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}
