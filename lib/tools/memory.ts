import type {
  GenerationToolCall,
  GenerationToolDefinition,
  GenerationToolExecutionResult,
} from '@/lib/generation/types';
import { MemoryStore } from '@/lib/memory/store';
import type { AgentContextView, MemoryEntry } from '@/lib/memory/types';

export const SEARCH_MEMORY_TOOL: GenerationToolDefinition = {
  name: 'search_memory',
  label: '查找本地记忆',
  description:
    '仅当 local_memory enabled=true 且当前任务需要用户长期偏好或背景时，搜索用户主动保存的本地记忆。不要为普通问题试探性调用。',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: '与当前任务直接相关的简短检索词。' } },
    required: ['query'],
    additionalProperties: false,
  },
};

export const SAVE_MEMORY_TOOL: GenerationToolDefinition = {
  name: 'save_memory',
  label: '保存本地记忆',
  description:
    '只有用户在当前消息明确要求“记住/以后都这样/保存偏好”时，保存一条简短、非敏感、由用户直接提供的长期事实或偏好。绝不能保存网页推断、密码、API Key、身份号码或联系方式。',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '一条独立、可编辑的长期偏好，最多 500 字。' },
    },
    required: ['content'],
    additionalProperties: false,
  },
};

const EXPLICIT_MEMORY_INTENT =
  /(?:记住|记一下|保存(?:这个|这条)?(?:偏好|习惯|信息)?|以后(?:都|请)|长期使用)/u;
const SENSITIVE = /(?:api\s*key|密码|口令|身份证|银行卡|信用卡|手机号|电话号码|住址)/iu;

export interface MemoryRepository {
  settings(): Promise<{ version: 1; instructions: string; memoryEnabled: boolean }>;
  search(query: string): Promise<MemoryEntry[]>;
  add(content: string): Promise<AgentContextView>;
}

export class MemoryToolCoordinator {
  constructor(private readonly store: MemoryRepository = new MemoryStore()) {}

  async execute(
    call: GenerationToolCall,
    latestUserText: string,
    signal: AbortSignal,
  ): Promise<GenerationToolExecutionResult> {
    signal.throwIfAborted();
    const settings = await this.store.settings();
    if (!settings.memoryEnabled) return failure('本地长期记忆已关闭。');
    if (call.name === 'search_memory') {
      const query = bounded(call.arguments.query, 300);
      if (!query) return failure('记忆检索词无效。');
      const matches = await this.store.search(query);
      signal.throwIfAborted();
      return {
        isError: false,
        statusText: matches.length ? '已查找本地记忆' : '没有相关本地记忆',
        detail: `找到 ${matches.length} 条`,
        content: `<local_memory_results>${JSON.stringify(
          matches.map(({ id, content, updatedAt }) => ({ id, content, updatedAt })),
        ).replaceAll('<', '\\u003c')}</local_memory_results>`,
      };
    }
    if (call.name !== 'save_memory') return failure('未知记忆工具。');
    if (!EXPLICIT_MEMORY_INTENT.test(latestUserText)) {
      return failure('用户当前消息没有明确要求持久保存；请先使用 ask_user 获得明确同意。');
    }
    const content = bounded(call.arguments.content, 500);
    if (!content || SENSITIVE.test(content)) return failure('记忆内容为空、过长或包含敏感信息。');
    await this.store.add(content);
    signal.throwIfAborted();
    return {
      isError: false,
      statusText: '已保存本地记忆',
      detail: content,
      content: `已在本机保存用户明确要求的长期偏好：${content}`,
    };
  }
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replaceAll('\u0000', '').replace(/\s+/gu, ' ').trim();
  return text && text.length <= max ? text : undefined;
}

function failure(detail: string): GenerationToolExecutionResult {
  return {
    isError: true,
    statusText: '本地记忆未执行',
    detail,
    content: `记忆工具失败：${detail}`,
  };
}
