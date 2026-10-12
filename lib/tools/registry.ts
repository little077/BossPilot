// ─── 工具注册表 ───
// 全项目唯一的工具登记点与执行分发点：新工具在此加入 TOOLS 即完成注册。输出三类映射：
// 1) toBindableToolDefinitions()：给模型绑定用的 OpenAI 函数定义（零额外依赖）；
// 2) executeTool()：按名称分发到确定性实现，并作为工件落地的唯一出口——
//    非 bypass 工具的成功结果统一过 ingestToolResult，全项目物理上不存在
//    绕过入库的工具执行路径（统一性靠 choke point，不靠使用纪律）；
// 3) 未知工具与非法参数都返回结构化错误。

import { ingestToolResult } from '@/lib/artifacts/gate';
import { readArtifactTool } from './read-artifact';
import { readCurrentPageTool } from './read-current-page';
import type { AgentTool, BindableToolDefinition, ToolArgs, ToolContext, ToolResult } from './types';
import { toolError } from './types';

/** v1 全部为只读工具；写类工具将来必须同时通过 background 的 beforeToolCall 门禁。 */
const TOOLS: readonly AgentTool[] = [readCurrentPageTool, readArtifactTool];

const TOOL_BY_NAME = new Map<string, AgentTool>(
  TOOLS.map((tool): [string, AgentTool] => [tool.name, tool]),
);

/** 全部已注册工具（顺序即绑定给模型的顺序）。 */
export function listTools(): readonly AgentTool[] {
  return TOOLS;
}

/** 判断工具是否已注册（background 门禁用）。 */
export function hasTool(name: string): boolean {
  return TOOL_BY_NAME.has(name);
}

/** 生成 bindTools 用的 OpenAI 函数定义。 */
export function toBindableToolDefinitions(): BindableToolDefinition[] {
  return TOOLS.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/** 按名称执行工具；未知工具与非法参数返回结构化错误而不是抛出。 */
export async function executeTool(
  name: string,
  args: ToolArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) {
    const safeName = name.slice(0, 120);
    return toolError(
      'unknown_tool',
      `不支持的工具：${safeName}`,
      `[工具调用失败] 错误码：unknown_tool，工具名：${safeName}。请如实告知用户当前版本不支持该操作。`,
    );
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return toolError(
      'invalid_arguments',
      '工具参数格式无效。',
      '[工具调用失败] 错误码：invalid_arguments。请检查参数后重试，或如实告知用户。',
    );
  }
  const result = await tool.execute(args, ctx);
  // 工件关口收口在这里：取回类工具（artifactBypass）直通，其余结果统一入库换引用卡
  //（失败结果由关口自身直通，无需在此区分）。
  return tool.artifactBypass ? result : ingestToolResult(tool.name, result);
}
