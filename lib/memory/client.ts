import type { AgentContextCommand, AgentContextCommandResponse } from '@/lib/ipc/protocol';
import type { AgentContextView } from './types';

export async function sendAgentContextCommand(
  command: AgentContextCommand,
): Promise<AgentContextView> {
  const response: unknown = await chrome.runtime.sendMessage(command);
  if (!isResponse(response)) throw new Error('用户上下文服务返回了无效响应。');
  if (!response.ok) throw new Error(response.error);
  return response.state;
}

function isResponse(value: unknown): value is AgentContextCommandResponse {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false;
  const response = value as { ok?: unknown; state?: unknown; error?: unknown };
  if (response.ok === false) return typeof response.error === 'string';
  return response.ok === true && typeof response.state === 'object' && response.state !== null;
}
