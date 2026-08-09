// ─── Ask User 人机协同工具 ───
// 职责：把模型给出的一个关键澄清问题收敛成安全、可持久化的 UI 数据；不调用网页能力。

import type { AskUserOption } from '@/lib/domain/types';
import type {
  GenerationToolCall,
  GenerationToolDefinition,
  GenerationToolExecutionOutcome,
  GenerationToolExecutionResult,
} from '@/lib/generation/types';

export const ASK_USER_TOOL: GenerationToolDefinition = {
  name: 'ask_user',
  label: '询问用户',
  description:
    '仅当缺少一个会显著改变后续操作结果的关键信息时调用。一次只问一个简短问题，提供 2 到 4 个互斥选项，并允许用户自定义回答。不要询问可以通过已有工具自行确认的信息，也不要用于普通确认或汇报进度。',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: '一个简短、具体、可以直接回答的问题。',
      },
      options: {
        type: 'array',
        description: '2 到 4 个互斥的推荐答案，按推荐顺序排列。',
        minItems: 2,
        maxItems: 4,
        items: { type: 'string' },
      },
      customPlaceholder: {
        type: 'string',
        description: '自定义回答输入框的示例提示，可省略。',
      },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  },
};

const MAX_QUESTION_CHARS = 300;
const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTION_CHARS = 100;
const MAX_PLACEHOLDER_CHARS = 120;

export function askUser(call: GenerationToolCall): GenerationToolExecutionOutcome {
  const question = normalizeText(call.arguments.question, MAX_QUESTION_CHARS);
  const rawOptions = Array.isArray(call.arguments.options) ? call.arguments.options : [];
  const labels = unique(
    rawOptions
      .map((value) => normalizeText(value, MAX_OPTION_CHARS))
      .filter((value): value is string => Boolean(value)),
  ).slice(0, MAX_OPTIONS);

  if (!question || labels.length < MIN_OPTIONS) {
    return invalidQuestion(
      '问题必须是非空文本，并提供 2 到 4 个不重复选项。请修正参数后重新调用 ask_user。',
    );
  }

  const options: AskUserOption[] = labels.map((label, index) => ({
    id: `option-${index + 1}`,
    label,
  }));
  const customPlaceholder = normalizeText(call.arguments.customPlaceholder, MAX_PLACEHOLDER_CHARS);

  return {
    deferred: true,
    kind: 'user_input',
    statusText: '等待用户补充信息',
    question,
    options,
    allowCustom: true,
    ...(customPlaceholder ? { customPlaceholder } : {}),
  };
}

function invalidQuestion(detail: string): GenerationToolExecutionResult {
  return {
    isError: true,
    statusText: '澄清问题参数无效',
    detail,
    content: `ask_user 调用失败：${detail}`,
  };
}

function normalizeText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return value.replaceAll('\u0000', '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
