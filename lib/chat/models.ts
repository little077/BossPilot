// ─── 模型目录发现（OpenAI 兼容） ───
// 职责：给定 base URL 与密钥，拉取厂商可用模型列表，供设置页「选模型」而非写死单模型。
// 与主分支 provider 发现逻辑同构：GET {baseUrl}/models + Bearer 认证，解析 data[] → {id,name}。
// 只在后台 Service Worker 内调用（扩展上下文 + host_permissions 才能绕过浏览器 CORS）。

import type { ModelCatalogEntry } from '@/lib/domain/types';

/** 单次拉取保留的最大模型数，避免异常端点返回超长列表压垮 UI。 */
const MAX_MODELS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 归一化去重：按 id 保留首个条目，稳定顺序。 */
function normalize(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const seen = new Set<string>();
  const result: ModelCatalogEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
    if (result.length >= MAX_MODELS) break;
  }
  return result;
}

/**
 * 拉取 OpenAI 兼容端点的模型列表。
 * 失败抛错（HTTP 非 2xx、响应结构不符、空列表），由调用方（后台）转成用户可读提示。
 */
export async function listModels(baseUrl: string, apiKey: string): Promise<ModelCatalogEntry[]> {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const response = await fetch(`${trimmed}/models`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`模型目录获取失败（HTTP ${response.status}），请检查密钥与端点。`);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('模型目录返回结构异常，端点可能不兼容 OpenAI 格式。');
  }

  const entries = payload.data.flatMap((item): ModelCatalogEntry[] => {
    if (!isRecord(item)) return [];
    const id = readString(item.id);
    if (!id) return [];
    return [{ id, name: readString(item.name) ?? readString(item.display_name) ?? id }];
  });

  if (entries.length === 0) {
    throw new Error('该端点未返回任何可用模型。');
  }
  return normalize(entries);
}
