// run_skill 只负责技能选择、授权收敛和沙箱调度；脚本能力由 SkillSandboxRunner 二次校验。
import type {
  GenerationToolCall,
  GenerationToolDefinition,
  GenerationToolExecutionOutcome,
  GenerationToolExecutionResult,
} from '@/lib/generation/types';
import type { SkillSandboxRunner } from '@/lib/skills/sandbox';
import type { SkillStore } from '@/lib/skills/store';
import type { SkillCapability } from '@/lib/skills/types';

export const RUN_SKILL_TOOL: GenerationToolDefinition = {
  name: 'run_skill',
  label: '运行 Skill 脚本',
  description:
    '运行已启用 Skill 的脚本。必须先 load_skill 阅读工作流，并且只运行工作流明确指定的脚本。script 参数必须传完整相对路径（以 scripts/ 开头，例如 scripts/read-profile.js）。Python、Shell、PowerShell 等脚本在浏览器扩展中不支持。脚本声明的工作区、网页、Chrome API 或网络能力会先询问用户。',
  parameters: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description:
          '已加载 Skill 的精确名称（available_skills 里的 name 属性，例如 xhs-note-scout）。',
      },
      script: {
        type: 'string',
        description: '脚本的完整相对路径，必须以 scripts/ 开头（例如 scripts/read-profile.js）。',
      },
      input: { type: 'object', description: '传给脚本的可序列化输入。' },
    },
    required: ['skill', 'script', 'input'],
    additionalProperties: false,
  },
};

export type SkillRunApproval = 'once' | 'always' | null;

export class SkillRunCoordinator {
  constructor(
    private readonly store: SkillStore,
    private readonly runner: SkillSandboxRunner,
  ) {}

  async execute(
    call: GenerationToolCall,
    conversationId: string,
    approval: SkillRunApproval,
    signal: AbortSignal,
  ): Promise<GenerationToolExecutionOutcome> {
    signal.throwIfAborted();
    const skillName = boundedString(call.arguments.skill, 64);
    const scriptPath = boundedString(call.arguments.script, 512);
    if (!skillName || !scriptPath || !safeScriptPath(scriptPath))
      return failure(
        `Skill 或脚本路径无效（skill="${call.arguments.skill}" script="${call.arguments.script}"）。script 必须是以 scripts/ 开头的相对路径，例如 scripts/read-profile.js。`,
      );
    if (!isRecord(call.arguments.input)) return failure('Skill input 必须是对象。');

    try {
      const skill = await this.store.getPackage(skillName);
      if (!(await this.store.listEnabled()).some(({ name }) => name === skillName)) {
        return failure('Skill 已停用。');
      }
      if (!skill.definition.allowedTools.includes('run_skill')) {
        return failure('SKILL.md 没有声明 run_skill。');
      }
      const file = skill.files.find(({ path }) => path === scriptPath);
      if (!file) return failure('Skill 脚本不存在。');
      if (!['.js', '.mjs'].some((extension) => scriptPath.endsWith(extension))) {
        return failure('浏览器版只支持 JavaScript；Python、Shell 和 PowerShell 脚本不受支持。');
      }
      if (file.kind !== 'text') return failure('Skill 脚本不是文本文件。');
      const capabilities = skill.definition.capabilities;
      const decisions = await Promise.all(
        capabilities.map(async (capability) => ({
          capability,
          decision: await this.store.persistentGrant(skillName, capability),
        })),
      );
      const denied = decisions.find(({ decision }) => decision === 'deny');
      if (denied) return failure(`用户已拒绝 ${denied.capability}，可在设置中撤销后重试。`);
      const missing = decisions.flatMap(({ capability, decision }) =>
        decision === 'allow' ? [] : [capability],
      );
      if (missing.length > 0 && !approval) return permissionQuestion(skillName, missing);
      if (missing.length > 0 && approval === 'always') {
        await Promise.all(
          missing.map((capability) => this.store.resolveGrant(skillName, capability, 'allow')),
        );
      }
      const result = await this.runner.run(
        conversationId,
        file.content,
        call.arguments.input,
        capabilities,
        signal,
      );
      const content = JSON.stringify(result ?? null).replaceAll('<', '\\u003c');
      return {
        isError: false,
        statusText: 'Skill 脚本已完成',
        detail: `${skillName} · ${scriptPath}`,
        content: `<skill_script_result name="${skillName}" script="${scriptPath}">\n${content}\n</skill_script_result>`,
        riskLevel: capabilities.some((capability) => capability.endsWith('.write'))
          ? 'write'
          : 'read',
        authorizationStatus: missing.length > 0 ? 'granted' : 'not_required',
        recoverability: 'safe_retry',
      };
    } catch (error) {
      if (signal.aborted) return cancelled();
      return failure(error instanceof Error ? error.message : 'Skill 脚本执行失败。');
    }
  }
}

function cancelled(): GenerationToolExecutionResult {
  return {
    isError: true,
    errorCode: 'cancelled',
    statusText: '已停止运行 Skill 脚本',
    detail: '用户取消了本次 Skill 运行。',
    content: 'run_skill 已取消：用户停止了本次 Skill 运行。',
    riskLevel: 'read',
    authorizationStatus: 'not_required',
    recoverability: 'safe_retry',
  };
}

function permissionQuestion(
  skillName: string,
  capabilities: SkillCapability[],
): GenerationToolExecutionOutcome {
  return {
    deferred: true,
    kind: 'user_input',
    statusText: '等待 Skill 能力授权',
    question: `${skillName} 请求以下能力：${capabilities.join('、')}。是否允许？`,
    options: [
      { id: 'once', label: '仅本次允许' },
      { id: 'always', label: '持续允许' },
      { id: 'deny', label: '拒绝' },
    ],
    allowCustom: false,
  };
}

function safeScriptPath(path: string): boolean {
  return (
    path.startsWith('scripts/') &&
    !path.includes('..') &&
    !path.includes('\\') &&
    /^[a-zA-Z0-9._/-]+$/u.test(path)
  );
}

function failure(detail: string): GenerationToolExecutionResult {
  return {
    isError: true,
    statusText: 'Skill 脚本失败',
    detail,
    content: `run_skill 失败：${detail}`,
    riskLevel: 'read',
    authorizationStatus: 'denied',
    recoverability: 'user_retry',
  };
}

function boundedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxChars ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
