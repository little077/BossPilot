// ─── 会话标题生成 ───
// 职责：用当前 BYOK 模型把有限长度的对话压缩成历史列表标题；不参与主对话流程决策。

import type { ChatMessage } from '@/lib/domain/chat';
import { GenerationError } from '@/lib/generation/errors';
import type {
  GenerationAdapter,
  GenerationInputMessage,
  ResolvedGenerationTarget,
} from '@/lib/generation/types';

const TITLE_SYSTEM = `你是会话标题生成器。根据用户提供的对话内容生成一个准确、具体的中文标题。
只输出标题，不要解释，不要加引号、书名号、句号或“标题：”前缀。标题控制在 6 到 20 个汉字左右，不得补充对话中不存在的信息。`;
const MAX_SOURCE_CHARS = 6_000;
const MAX_SOURCE_MESSAGES = 10;
const MAX_TITLE_CHARS = 30;

export async function generateConversationTitle(
  adapter: GenerationAdapter,
  target: ResolvedGenerationTarget,
  messages: ChatMessage[],
  signal: AbortSignal,
  now = Date.now(),
): Promise<string> {
  const transcript = conversationExcerpt(messages);
  if (!transcript) {
    throw new GenerationError('INVALID_RESPONSE', '当前会话没有可用于生成标题的内容。', false);
  }

  const input: GenerationInputMessage = {
    role: 'user',
    content: `请为下面的对话生成标题：\n\n${transcript}`,
    createdAt: now,
  };
  let output = '';

  for await (const event of adapter.stream(target, {
    systemPrompt: TITLE_SYSTEM,
    messages: [input],
    signal,
    maxOutputTokens: 48,
    temperature: 0.2,
  })) {
    if (event.type === 'text-delta') {
      output += event.delta;
      if (output.length > 200) {
        throw new GenerationError('OUTPUT_LIMIT_EXCEEDED', '模型返回的会话标题过长。', false);
      }
    }
    if (event.type === 'tool-call') {
      throw new GenerationError('INVALID_RESPONSE', '会话标题生成不允许调用工具。', false);
    }
    if (event.type === 'finish' && event.reason === 'cancelled') {
      throw new GenerationError('NETWORK_ERROR', '会话标题生成已中断。', true);
    }
  }

  const title = normalizeGeneratedTitle(output);
  if (!title) {
    throw new GenerationError('INVALID_RESPONSE', '模型没有返回有效的会话标题。', true);
  }
  return title;
}

export function conversationExcerpt(messages: ChatMessage[]): string {
  const relevant = messages
    .filter(
      (message) =>
        message.content.trim().length > 0 &&
        message.status !== 'streaming' &&
        message.status !== 'error' &&
        !message.error,
    )
    .slice(-MAX_SOURCE_MESSAGES);

  const lines: string[] = [];
  let remaining = MAX_SOURCE_CHARS;
  for (const message of relevant) {
    const prefix = message.role === 'user' ? '用户：' : '助手：';
    const content = message.content.replace(/\s+/g, ' ').trim();
    const line = `${prefix}${content}`;
    if (remaining <= prefix.length) break;
    const clipped = line.slice(0, remaining);
    lines.push(clipped);
    remaining -= clipped.length + 1;
  }
  return lines.join('\n');
}

export function normalizeGeneratedTitle(value: string): string {
  return value
    .replace(/^\s*(?:标题\s*[:：]\s*)?/u, '')
    .replace(/[“”"'《》]/gu, '')
    .replace(/[。！？!?；;：:]$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS);
}
