import type { ProviderStateView } from '@/lib/domain/types';
import type { McpSettingsView } from '@/lib/mcp/types';
import type { AgentContextView } from '@/lib/memory/types';
import type { SkillSettingsView } from '@/lib/skills/types';

export type AgentHealthStatus = 'pass' | 'warning' | 'info';

export interface AgentHealthCheck {
  id: 'model' | 'skills' | 'memory' | 'mcp' | 'permissions';
  label: string;
  detail: string;
  status: AgentHealthStatus;
}

export interface AgentHealthSnapshot {
  providers: ProviderStateView;
  skills: SkillSettingsView;
  context: AgentContextView;
  mcp: McpSettingsView;
  manifest: chrome.runtime.Manifest;
}

/**
 * 本地、确定性的 Agent 自检。它只检查脱敏配置快照，不调用模型，也不连接网页或 MCP。
 */
export function evaluateAgentHealth(snapshot: AgentHealthSnapshot): AgentHealthCheck[] {
  const active = snapshot.providers.activeModel;
  const connection = active
    ? snapshot.providers.connections.find(({ providerId }) => providerId === active.providerId)
    : undefined;
  const enabledSkills = snapshot.skills.skills.filter(({ enabled }) => enabled);
  const enabledMcp = snapshot.mcp.servers.filter(({ enabled }) => enabled);
  const mcpToolCount = enabledMcp.reduce((total, server) => total + server.tools.length, 0);
  const persistentHosts: string[] = Array.isArray(snapshot.manifest.host_permissions)
    ? snapshot.manifest.host_permissions.filter(
        (pattern): pattern is string => typeof pattern === 'string',
      )
    : [];
  const hasBroadPersistentHost = persistentHosts.some(
    (pattern) => pattern === '<all_urls>' || pattern === 'http://*/*' || pattern === 'https://*/*',
  );

  return [
    {
      id: 'model',
      label: '默认模型',
      status: active && connection ? 'pass' : 'warning',
      detail:
        active && connection
          ? `已选择 ${active.providerId} / ${active.modelId}`
          : '尚未选择可用模型，发送消息前需要先配置。',
    },
    {
      id: 'skills',
      label: 'Agent Skills',
      status: enabledSkills.length ? 'pass' : 'info',
      detail: enabledSkills.length
        ? `已启用 ${enabledSkills.length} 个技能，执行时按需加载。`
        : '未启用技能；通用浏览器能力仍可使用。',
    },
    {
      id: 'memory',
      label: '本地上下文',
      status: 'info',
      detail: snapshot.context.settings.memoryEnabled
        ? `记忆已开启，共 ${snapshot.context.memories.length} 条；仅在明确要求时写入。`
        : '记忆已关闭；长期指令仍按用户设置生效。',
    },
    {
      id: 'mcp',
      label: 'MCP 工具',
      status: enabledMcp.length && !mcpToolCount ? 'warning' : 'info',
      detail: enabledMcp.length
        ? `已启用 ${enabledMcp.length} 个服务，共提供 ${mcpToolCount} 个工具。`
        : '未启用 MCP 服务；这是可选扩展能力。',
    },
    {
      id: 'permissions',
      label: '权限边界',
      status: hasBroadPersistentHost ? 'warning' : 'pass',
      detail: hasBroadPersistentHost
        ? '检测到常驻的宽泛网页权限，请检查扩展清单。'
        : '未发现常驻的全站网页权限；其他站点按需授权。',
    },
  ];
}
