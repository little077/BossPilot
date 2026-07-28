// ─── OpenAI 兼容 LLM 客户端 ───
// 只依赖标准 Chat Completions 协议，因此同一套代码可对接 OpenAI / DeepSeek /
// Kimi / 智谱 / 本地 Ollama 等任意 OpenAI 兼容端点（BYOK）。
// 运行在 background service worker，使用扩展的 host 权限，无 CORS 问题。

import type { LlmConfig } from '@/lib/domain/types';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class LlmError extends Error {}

/**
 * 调用一次 Chat Completions，返回 assistant 文本。
 * responseFormatJson=true 时请求 JSON 模式（多数兼容端点支持，不支持则忽略）。
 */
export async function chat(
  config: LlmConfig,
  messages: ChatMessage[],
  opts: { responseFormatJson?: boolean; signal?: AbortSignal; temperature?: number } = {},
): Promise<string> {
  if (!config.apiKey) throw new LlmError('未配置 API Key，请先在设置页填写模型信息。');
  if (!config.baseUrl) throw new LlmError('未配置 base URL。');
  if (!config.model) throw new LlmError('未配置模型名。');

  const url = config.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    stream: false,
  };
  if (opts.responseFormatJson) {
    body.response_format = { type: 'json_object' };
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    throw new LlmError(`网络请求失败：${(e as Error).message}`);
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new LlmError(`模型返回 ${resp.status}：${errText.slice(0, 300)}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new LlmError('模型返回内容为空。');
  return content;
}

/**
 * 从模型输出里稳健地解析出 JSON（容忍 ```json 代码块包裹 / 前后多余文本）。
 */
export function extractJson<T>(raw: string): T {
  let s = raw.trim();
  // 去掉 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 截取首个 { 到末个 }（或首 [ 到末 ]）
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1;
  let end = -1;
  if (firstArr >= 0 && (firstObj < 0 || firstArr < firstObj)) {
    start = firstArr;
    end = s.lastIndexOf(']');
  } else {
    start = firstObj;
    end = s.lastIndexOf('}');
  }
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    return JSON.parse(s) as T;
  } catch (e) {
    throw new LlmError(`无法解析模型返回的 JSON：${(e as Error).message}`);
  }
}
