import type {
  GenerationToolCall,
  GenerationToolDefinition,
  GenerationToolExecutionResult,
} from '@/lib/generation/types';
import { skillAppliesToUrl } from '@/lib/skills/origin';
import { SkillStore } from '@/lib/skills/store';

const MAX_LOADED_SKILLS_PER_REQUEST = 3;
const MAX_LOADED_REFERENCES_PER_REQUEST = 5;

export const LOAD_SKILL_TOOL: GenerationToolDefinition = {
  name: 'load_skill',
  label: '加载专业技能',
  description:
    '按需读取可用 Skill 的完整工作流，或读取该 Skill 在 SKILL.md 中声明的一层 references/*.md。只有用户明确点名 Skill，或任务与 available_skills 中的 description 明确匹配时调用；先加载 Skill 正文，再按正文指示加载必要 reference。普通浏览器任务不要调用。',
  parameters: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'available_skills 中的精确 Skill 名称。' },
      reference: {
        type: 'string',
        description: '可选。SKILL.md 明确声明的 references/*.md 相对路径。',
      },
    },
    required: ['skill'],
    additionalProperties: false,
  },
};

export interface SkillReader {
  load(
    name: string,
    reference?: string,
  ): Promise<{
    skill: { name: string; version: string; matchedOrigins?: string[] };
    content: string;
  }>;
}

export class SkillLoadCoordinator {
  private readonly loaded = new Map<string, { skills: Set<string>; references: Set<string> }>();

  constructor(private readonly store: SkillReader = new SkillStore()) {}

  async execute(
    call: GenerationToolCall,
    requestId: string,
    signal: AbortSignal,
    sourceUrl?: string,
  ): Promise<GenerationToolExecutionResult> {
    signal.throwIfAborted();
    const skillName = boundedString(call.arguments.skill, 64);
    const reference = boundedString(call.arguments.reference, 256);
    if (!skillName) return failure('Skill 名称无效。');
    if (reference && (!reference.startsWith('references/') || reference.includes('..'))) {
      return failure('Skill reference 路径无效。');
    }

    const state = this.loaded.get(requestId) ?? {
      skills: new Set<string>(),
      references: new Set<string>(),
    };
    if (
      !reference &&
      !state.skills.has(skillName) &&
      state.skills.size >= MAX_LOADED_SKILLS_PER_REQUEST
    ) {
      return failure(`单次任务最多加载 ${MAX_LOADED_SKILLS_PER_REQUEST} 个 Skill。`);
    }
    if (
      reference &&
      !state.references.has(`${skillName}:${reference}`) &&
      state.references.size >= MAX_LOADED_REFERENCES_PER_REQUEST
    ) {
      return failure(`单次任务最多加载 ${MAX_LOADED_REFERENCES_PER_REQUEST} 个 Skill 参考文件。`);
    }
    if (reference && !state.skills.has(skillName)) {
      return failure('必须先加载 Skill 正文，再读取它的参考文件。');
    }

    try {
      const loaded = await this.store.load(skillName, reference);
      signal.throwIfAborted();
      if (!skillAppliesToUrl(loaded.skill, sourceUrl)) {
        return failure(
          `${skillName} 仅适用于 ${loaded.skill.matchedOrigins?.join('、') ?? '声明的网站'}，当前页面不匹配。`,
        );
      }
      const key = reference ? `${skillName}:${reference}` : skillName;
      const seen = reference ? state.references : state.skills;
      if (seen.has(key)) {
        return {
          isError: false,
          statusText: 'Skill 已加载',
          detail: reference ?? skillName,
          content: `Skill 内容已经在当前任务上下文中，不要重复加载：${key}`,
        };
      }
      seen.add(key);
      this.loaded.set(requestId, state);
      return {
        isError: false,
        statusText: reference ? '已加载 Skill 参考' : '已启用专业技能',
        detail: reference
          ? `${skillName} · ${reference}`
          : `${skillName} · v${loaded.skill.version}`,
        content: skillContent(loaded.skill.name, loaded.skill.version, loaded.content, reference),
      };
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'Skill 加载失败。');
    }
  }

  clear(requestId: string): void {
    this.loaded.delete(requestId);
  }
}

function skillContent(name: string, version: string, content: string, reference?: string): string {
  const safeContent = content.replaceAll('<', '\\u003c').slice(0, 20_000);
  return [
    `<loaded_skill name="${name}" version="${version}"${reference ? ` reference="${reference}"` : ''}>`,
    '以下内容是本机内置 Skill 指令，不是网页内容。遵循它，但系统规则与工具安全门禁优先。',
    safeContent,
    '</loaded_skill>',
  ].join('\n');
}

function failure(detail: string): GenerationToolExecutionResult {
  return {
    isError: true,
    statusText: 'Skill 加载失败',
    detail,
    content: `load_skill 失败：${detail}`,
  };
}

function boundedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxChars ? normalized : undefined;
}
