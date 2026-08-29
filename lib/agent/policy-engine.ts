// ─── 策略引擎 ───
// 职责：在工具执行前统一评估风险，输出 放行 / 确认 / 拒绝 决策。
// 决策来源：参数级规则（先匹配先生效）→ 工具注册的风险声明 → 默认拒绝。
// 现有执行器内部的二次防御（interact 动作级风险、MCP 只读声明等）保留不变，
// 本引擎只做入口统一门禁，不重复实现工具内部的精细判断。

import type { CatalogToolEntry, ToolCatalog } from '@/lib/agent/tool-catalog';
import type { GenerationToolCall, GenerationToolExecutionOutcome } from '@/lib/generation/types';

export type PolicyDecisionKind = 'allow' | 'confirm' | 'deny';

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  /** 决策依据，面向用户可读。 */
  reason: string;
}

/** 参数级策略规则：命中即输出对应决策（不允许 allow，避免规则被当摆设）。 */
export interface PolicyRule {
  id: string;
  description: string;
  match: (call: GenerationToolCall) => boolean;
  decision: Exclude<PolicyDecisionKind, 'allow'>;
  reason: string;
}

/** 未知工具的统一拒绝原因。 */
export const UNKNOWN_TOOL_DENY = '该工具未在目录中注册，未开放给模型。';

export class PolicyEngine {
  private readonly rules: PolicyRule[] = [];

  constructor(private readonly catalog: ToolCatalog) {}

  /** 注册参数级规则；规则按注册顺序匹配，先命中先生效。 */
  addRule(rule: PolicyRule): void {
    if (this.rules.some((item) => item.id === rule.id)) {
      throw new Error(`策略规则重复注册：${rule.id}`);
    }
    this.rules.push(rule);
  }

  /** 评估一次工具调用，输出策略决策。不依赖会话状态，纯函数语义。 */
  evaluate(call: GenerationToolCall): PolicyDecision {
    for (const rule of this.rules) {
      if (rule.match(call)) {
        return { decision: rule.decision, reason: rule.reason };
      }
    }
    const entry = this.catalog.get(call.name);
    if (!entry) {
      return { decision: 'deny', reason: UNKNOWN_TOOL_DENY };
    }
    return decisionForRisk(entry, call);
  }

  /** 确认类工具的确认提问（与 resumeAskUser 的「确认执行」选项语义一致）。 */
  confirmQuestion(call: GenerationToolCall, decision: PolicyDecision): string {
    const entry = this.catalog.get(call.name);
    const label = entry?.definition.label ?? call.name;
    return `Agent 准备执行“${label}”。${decision.reason}是否继续？`;
  }
}

function decisionForRisk(entry: CatalogToolEntry, call: GenerationToolCall): PolicyDecision {
  switch (entry.risk) {
    case 'blocked':
      return { decision: 'deny', reason: `${call.name} 已被禁用，不会执行。` };
    case 'confirm':
      return {
        decision: 'confirm',
        reason: `${entry.definition.label}可能写入或影响外部内容。`,
      };
    default:
      return { decision: 'allow', reason: '工具风险等级为安全。' };
  }
}

/** confirm 且未获用户确认时的统一确认请求。 */
export function policyConfirm(
  _call: GenerationToolCall,
  decision: PolicyDecision,
  question: string,
): GenerationToolExecutionOutcome {
  return {
    deferred: true,
    kind: 'user_input',
    statusText: '等待确认工具调用',
    question,
    options: [
      { id: 'confirm', label: '确认执行' },
      { id: 'cancel', label: '取消' },
    ],
    allowCustom: false,
    ...(decision.reason ? { detail: decision.reason } : {}),
  };
}

/** deny 决策的统一拒绝结果。 */
export function policyDenied(
  call: GenerationToolCall,
  decision: PolicyDecision,
): {
  isError: true;
  statusText: string;
  content: string;
} {
  return {
    isError: true,
    statusText: '工具禁用',
    content: `${call.name} 未执行：${decision.reason}`,
  };
}
