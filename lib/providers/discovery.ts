// ─── 厂商模型目录发现 ───
// 职责：在 Background 中按公开协议请求模型目录，并把不可信响应收敛为统一模型列表。

import type { ProviderModel } from '@/lib/domain/types';
import { normalizeProviderBaseUrl } from '@/lib/providers/permissions';
import type { ProviderDefinition } from '@/lib/providers/registry';

const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_MODELS = 1_000;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_PAGES = 10;

export class ProviderDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderDiscoveryError';
  }
}

export interface DiscoverModelsOptions {
  provider: ProviderDefinition;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function discoverProviderModels({
  provider,
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 10_000,
}: DiscoverModelsOptions): Promise<ProviderModel[]> {
  const safeBaseUrl = normalizeProviderBaseUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let nextUrl: string | undefined = buildModelsUrl(provider, safeBaseUrl);
    let responseChars = 0;
    let pageCount = 0;
    let models: ProviderModel[] = [];
    const seenCursors = new Set<string>();

    while (nextUrl) {
      if (pageCount >= MAX_PAGES) {
        throw new ProviderDiscoveryError('模型目录分页过多，已停止读取。');
      }
      pageCount += 1;

      const response = await fetchImpl(nextUrl, {
        method: 'GET',
        headers: buildHeaders(provider, apiKey),
        signal: controller.signal,
      });

      const contentLength = Number(response.headers.get('content-length') ?? 0);
      const remainingChars = MAX_RESPONSE_CHARS - responseChars;
      if (Number.isFinite(contentLength) && contentLength > remainingChars) {
        throw new ProviderDiscoveryError('厂商返回的模型目录过大，已停止读取。');
      }

      const body = await response.text();
      responseChars += body.length;
      if (responseChars > MAX_RESPONSE_CHARS) {
        throw new ProviderDiscoveryError('厂商返回的模型目录过大，已停止读取。');
      }
      if (!response.ok) {
        throw new ProviderDiscoveryError(
          redactSecret(
            `模型目录请求失败（HTTP ${response.status}）：${readProviderError(body)}`,
            apiKey,
          ),
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new ProviderDiscoveryError('厂商返回了无法解析的模型目录。');
      }

      models = normalizeModels([...models, ...parseModels(provider.discovery, payload)]);
      if (models.length >= MAX_MODELS) break;

      const cursor = readNextCursor(provider.discovery, payload);
      if (!cursor) break;
      if (seenCursors.has(cursor)) {
        throw new ProviderDiscoveryError('厂商返回了重复的模型目录分页游标。');
      }
      seenCursors.add(cursor);
      nextUrl = buildModelsUrl(provider, safeBaseUrl, cursor);
    }

    if (models.length === 0) {
      throw new ProviderDiscoveryError('厂商没有返回可选择的模型，可尝试手动填写模型 ID。');
    }
    return models;
  } catch (error) {
    if (error instanceof ProviderDiscoveryError) throw error;
    if (controller.signal.aborted) {
      throw new ProviderDiscoveryError(`请求模型目录超时（${Math.round(timeoutMs / 1000)} 秒）。`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderDiscoveryError(redactSecret(`无法获取模型目录：${message}`, apiKey));
  } finally {
    clearTimeout(timer);
  }
}

function buildModelsUrl(provider: ProviderDefinition, baseUrl: string, cursor?: string): string {
  const path = provider.discovery === 'ollama' ? 'api/tags' : 'models';
  const url = new URL(path, `${baseUrl}/`);
  if (provider.discovery === 'anthropic') {
    url.searchParams.set('limit', String(MAX_MODELS));
    if (cursor) url.searchParams.set('after_id', cursor);
  } else if (provider.discovery === 'gemini') {
    url.searchParams.set('pageSize', String(MAX_MODELS));
    if (cursor) url.searchParams.set('pageToken', cursor);
  }
  return url.toString();
}

function buildHeaders(provider: ProviderDefinition, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (!apiKey || provider.publicCatalog || provider.discovery === 'ollama') return headers;

  if (provider.discovery === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider.discovery === 'gemini') {
    headers['x-goog-api-key'] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function parseModels(kind: ProviderDefinition['discovery'], payload: unknown): ProviderModel[] {
  if (!isRecord(payload)) return [];

  if (kind === 'gemini') {
    const rawModels = Array.isArray(payload.models) ? payload.models : [];
    return normalizeModels(
      rawModels.flatMap((item) => {
        if (!isRecord(item)) return [];
        const supported = Array.isArray(item.supportedGenerationMethods)
          ? item.supportedGenerationMethods
          : Array.isArray(item.supportedActions)
            ? item.supportedActions
            : [];
        if (
          supported.length > 0 &&
          !supported.some(
            (method) => method === 'generateContent' || method === 'streamGenerateContent',
          )
        ) {
          return [];
        }
        const rawId = readString(item.name)?.replace(/^models\//, '');
        return rawId ? [{ id: rawId, name: readString(item.displayName) ?? rawId }] : [];
      }),
    );
  }

  if (kind === 'ollama') {
    const rawModels = Array.isArray(payload.models) ? payload.models : [];
    return normalizeModels(
      rawModels.flatMap((item) => {
        if (!isRecord(item)) return [];
        const id = readString(item.name) ?? readString(item.model);
        return id ? [{ id, name: id }] : [];
      }),
    );
  }

  const rawModels = Array.isArray(payload.data) ? payload.data : [];
  return normalizeModels(
    rawModels.flatMap((item) => {
      if (!isRecord(item)) return [];
      const id = readString(item.id);
      if (!id) return [];
      return [{ id, name: readString(item.name) ?? readString(item.display_name) ?? id }];
    }),
  );
}

function readNextCursor(
  kind: ProviderDefinition['discovery'],
  payload: unknown,
): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (kind === 'gemini') return normalizeCursor(payload.nextPageToken);
  if (kind !== 'anthropic' || payload.has_more !== true) return undefined;

  const cursor = normalizeCursor(payload.last_id);
  if (!cursor) {
    throw new ProviderDiscoveryError('厂商模型目录缺少下一页游标。');
  }
  return cursor;
}

function normalizeCursor(value: unknown): string | undefined {
  const cursor = readString(value)?.trim();
  if (!cursor) return undefined;
  if (cursor.length > 2_048) {
    throw new ProviderDiscoveryError('厂商模型目录分页游标过长。');
  }
  return cursor;
}

function normalizeModels(models: ProviderModel[]): ProviderModel[] {
  const seen = new Set<string>();
  const result: ProviderModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    const name = model.name.trim().slice(0, MAX_MODEL_ID_LENGTH) || id;
    result.push({ id, name });
    if (result.length >= MAX_MODELS) break;
  }
  return result;
}

function readProviderError(body: string): string {
  try {
    const payload: unknown = JSON.parse(body);
    if (isRecord(payload)) {
      if (typeof payload.message === 'string') return payload.message.slice(0, 180);
      if (isRecord(payload.error) && typeof payload.error.message === 'string') {
        return payload.error.message.slice(0, 180);
      }
      if (typeof payload.error === 'string') return payload.error.slice(0, 180);
    }
  } catch {
    // 非 JSON 错误正文走下面的纯文本兜底。
  }
  const text = body.replace(/\s+/g, ' ').trim();
  return text.slice(0, 180) || '请检查 API Key、网络和厂商服务状态。';
}

function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join('[REDACTED]') : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
