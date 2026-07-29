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

  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
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

/** 一次流式对话的用量与最终文本。 */
export interface ChatStreamResult {
  content: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

function readUsage(data: unknown): ChatStreamResult['usage'] {
  const u = (data as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u) return undefined;
  return {
    promptTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
    completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
  };
}

/**
 * 流式对话：逐 token 通过 onDelta 回调返回。
 * 优先走 SSE（stream:true + accept text/event-stream）；若端点不支持流式（返回
 * 普通 JSON 而非 event-stream），自动降级为一次性解析并整段回调，保证兼容。
 */
export async function chatStream(
  config: LlmConfig,
  messages: ChatMessage[],
  opts: { onDelta?: (delta: string) => void; signal?: AbortSignal; temperature?: number } = {},
): Promise<ChatStreamResult> {
  if (!config.apiKey) throw new LlmError('未配置 API Key，请先在设置页填写模型信息。');
  if (!config.baseUrl) throw new LlmError('未配置 base URL。');
  if (!config.model) throw new LlmError('未配置模型名。');

  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: config.model,
    messages,
    temperature: opts.temperature ?? 0.6,
    stream: true,
  };

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new LlmError(`网络请求失败：${(e as Error).message}`);
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new LlmError(`模型返回 ${resp.status}：${errText.slice(0, 300)}`);
  }

  // 非 SSE 降级：部分兼容端点忽略 stream:true，直接返回整段 JSON。
  const contentType = resp.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream') || !resp.body) {
    const data = (await resp.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    const content = data?.choices?.[0]?.message?.content ?? '';
    if (!content) throw new LlmError('模型返回内容为空。');
    opts.onDelta?.(content);
    return { content, usage: readUsage(data) };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: ChatStreamResult['usage'];
  let finished = false;

  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          finished = true;
          break;
        }
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: Record<string, unknown>;
          };
          const delta = json.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            content += delta;
            opts.onDelta?.(delta);
          }
          if (json.usage) usage = readUsage(json);
        } catch {
          // 非法 SSE 数据行不应中断后续增量。
        }
      }
      nl = buffer.indexOf('\n');
    }
  }

  if (!content) throw new LlmError('模型返回内容为空。');
  return { content, usage };
}

/**
 * 从模型输出里稳健地解析出 JSON（容忍 ```json 代码块包裹 / 前后多余文本）。
 */
export function extractJson<T>(raw: string): T {
  let s = raw.trim();
  // 去掉 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const fencedBody = fence?.[1];
  if (fencedBody) s = fencedBody.trim();
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
