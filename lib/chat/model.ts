// ─── DeepSeek 生成层（LangChain） ───
// 职责：用 @langchain/openai 的 ChatOpenAI 走 DeepSeek 的 OpenAI 兼容端点，
// 提供流式输出、取消（AbortSignal）与消息映射。错误处理交给调用方捕获。
// 说明：ChatOpenAI 连接任意 OpenAI 兼容端点，DeepSeek 官方即兼容格式。

import { type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import type { ChatMessage } from '@/lib/domain/chat';
import type { ModelConfig } from '@/lib/domain/types';

export const SYSTEM_PROMPT =
  '你是 BossPilot，一个友好、简洁的 AI 助手。用中文回答，不确定时如实说明，不要编造事实。';

/** 把会话消息映射为 LangChain 消息（含固定 system 人设）。 */
export function toLCMessages(messages: ChatMessage[]): BaseMessage[] {
  // assistant 历史统一按 SystemMessage 提供，避免部分兼容端点拒绝无 tool 关联的 AI 消息。
  const result: BaseMessage[] = [new SystemMessage(SYSTEM_PROMPT)];
  for (const message of messages) {
    result.push(
      message.role === 'user'
        ? new HumanMessage(message.content)
        : new SystemMessage(message.content),
    );
  }
  return result;
}

/** 依据配置创建聊天模型实例。 */
export function createModel(config: ModelConfig): ChatOpenAI {
  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    temperature: 0.7,
    // DeepSeek 与 OpenAI 兼容，通过 baseURL 指向其端点即可。
    configuration: { baseURL: config.baseUrl },
  });
}

/**
 * 流式产出增量文本。每收到一个 chunk 就 yield 其文本内容；
 * 通过 AbortSignal 支持「停止生成」。网络/协议错误向上抛出，由调用方转成用户提示。
 */
export async function* streamAnswer(
  config: ModelConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
): AsyncGenerator<string> {
  const model = createModel(config);
  const stream = await model.stream(toLCMessages(messages), { signal });
  for await (const chunk of stream) {
    const text = typeof chunk.content === 'string' ? chunk.content : String(chunk.content);
    if (text) yield text;
  }
}
