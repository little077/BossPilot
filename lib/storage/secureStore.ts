// ─── 安全配置存储 ───
// 模型配置（含 API Key）加密后落 IndexedDB；对称密钥存 chrome.storage.local。
// 明文密钥只在内存与「sidepanel → background」这一路扩展内传输中出现，绝不回传 UI。

import type { ModelConfig, ModelConfigView } from '@/lib/domain/types';
import { decryptString, encryptString, generateKeyBase64, lastFour } from '@/lib/storage/crypto';
import { db } from '@/lib/storage/db';

const ENC_KEY = 'bosspilot:enc-key';

/** 取得（或首次生成）本机对称加密密钥的 base64。 */
async function getEncryptionKey(): Promise<string> {
  const stored = await chrome.storage.local.get(ENC_KEY);
  const existing = stored[ENC_KEY];
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const fresh = await generateKeyBase64();
  await chrome.storage.local.set({ [ENC_KEY]: fresh });
  return fresh;
}

/** 读取并解密配置；未配置时返回 null。 */
export async function getModelConfig(): Promise<ModelConfig | null> {
  const row = await db.secure.get('config');
  if (!row) return null;
  const key = await getEncryptionKey();
  const apiKey = await decryptString(row.encApiKey, key);
  return { baseUrl: row.baseUrl, model: row.model, apiKey };
}

/** 加密并保存配置；apiKey 为空串时保留原有密钥（UX：留空表示不修改）。 */
export async function setModelConfig(input: {
  baseUrl: string;
  model: string;
  apiKey: string;
}): Promise<ModelConfigView> {
  const key = await getEncryptionKey();
  const existing = await db.secure.get('config');
  const apiKey =
    input.apiKey.length > 0
      ? input.apiKey
      : existing
        ? await decryptString(existing.encApiKey, key)
        : '';
  const encApiKey = await encryptString(apiKey, key);
  await db.secure.put({ id: 'config', baseUrl: input.baseUrl, model: input.model, encApiKey });
  return toView({ baseUrl: input.baseUrl, model: input.model, apiKey });
}

/** 读取脱敏快照，供设置页展示。 */
export async function getModelConfigView(): Promise<ModelConfigView | null> {
  const config = await getModelConfig();
  return config ? toView(config) : null;
}

function toView(config: ModelConfig): ModelConfigView {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    hasApiKey: config.apiKey.length > 0,
    apiKeyLastFour: lastFour(config.apiKey),
  };
}
