// ─── 工具目录 ───
// 职责：集中注册工具定义、风险声明与执行器，让「模型能看到什么」和
// 「后台能执行什么」永远一致；为 Policy Engine 提供统一的分发入口。
// 每个工具必须声明风险等级，不允许无风险声明地注册。

import type { ToolContext } from '@/lib/agent/tool-context';
import type {
  GenerationToolCall,
  GenerationToolDefinition,
  GenerationToolExecutionContext,
  GenerationToolExecutionOutcome,
} from '@/lib/generation/types';

/** 工具风险等级：safe 直接执行；confirm 需用户确认；blocked 一律拒绝。 */
export type ToolRisk = 'safe' | 'confirm' | 'blocked';

/** 一次工具调用的统一执行上下文。 */
export interface CatalogToolContext {
  call: GenerationToolCall;
  signal: AbortSignal;
  requestId: string;
  conversationId: string;
  /** 用户是否已确认本次调用（消费式授权，来自暂停点恢复）。 */
  approved: boolean;
  reportProgress?: (statusText: string, detail?: string) => void;
  modelContext: GenerationToolExecutionContext;
  /** 会话级工具上下文（页面快照、历史等）。 */
  toolContext: ToolContext;
}

export type CatalogToolExecutor = (
  ctx: CatalogToolContext,
) => Promise<GenerationToolExecutionOutcome>;

export interface CatalogToolEntry {
  definition: GenerationToolDefinition;
  risk: ToolRisk;
  execute: CatalogToolExecutor;
}

/**
 * 工具目录：精确注册 + 前缀模式注册（MCP 动态工具）。
 * 同名重复注册直接抛错，把「定义与执行器割裂」变成构建期错误。
 */
export class ToolCatalog {
  private readonly exact = new Map<string, CatalogToolEntry>();
  private readonly patterns: Array<{ prefix: string; entry: CatalogToolEntry }> = [];

  register(entry: CatalogToolEntry): void {
    const name = entry.definition.name;
    if (this.exact.has(name)) {
      throw new Error(`工具重复注册：${name}`);
    }
    this.exact.set(name, entry);
  }

  registerPattern(prefix: string, entry: CatalogToolEntry): void {
    if (this.patterns.some((item) => item.prefix === prefix)) {
      throw new Error(`工具模式重复注册：${prefix}`);
    }
    this.patterns.push({ prefix, entry });
  }

  get(name: string): CatalogToolEntry | undefined {
    const entry = this.exact.get(name);
    if (entry) return entry;
    for (const pattern of this.patterns) {
      if (name.startsWith(pattern.prefix)) return pattern.entry;
    }
    return undefined;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  names(): string[] {
    return [...this.exact.keys(), ...this.patterns.map((pattern) => `${pattern.prefix}*`)];
  }

  /**
   * 按风险等级过滤后的工具定义列表（模型可见集合）。
   * 返回克隆定义，防止外部修改污染注册表。
   */
  definitions(options: { risks?: ToolRisk[] } = {}): GenerationToolDefinition[] {
    const allowed = new Set(options.risks ?? ['safe', 'confirm', 'blocked']);
    const result: GenerationToolDefinition[] = [];
    for (const entry of this.exact.values()) {
      if (!allowed.has(entry.risk)) continue;
      result.push(cloneDefinition(entry.definition));
    }
    return result;
  }

  /** 分发执行；未知工具返回统一的「未开放」错误，不抛异常。 */
  async execute(
    call: GenerationToolCall,
    ctx: Omit<CatalogToolContext, 'call'>,
  ): Promise<GenerationToolExecutionOutcome> {
    const entry = this.get(call.name);
    if (!entry) {
      return {
        isError: true,
        statusText: '工具禁用',
        content: `未开放${call.name}`,
      };
    }
    return entry.execute({ ...ctx, call });
  }
}

function cloneDefinition(definition: GenerationToolDefinition): GenerationToolDefinition {
  return {
    ...definition,
    parameters: {
      ...definition.parameters,
      properties: structuredClone(definition.parameters.properties),
      ...(definition.parameters.required ? { required: [...definition.parameters.required] } : {}),
    },
  };
}
