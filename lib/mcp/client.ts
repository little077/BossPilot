import type { McpCommand, McpCommandResponse } from '@/lib/ipc/protocol';
import type { McpSettingsView } from './types';

export async function sendMcpCommand(command: McpCommand): Promise<McpSettingsView> {
  const response: unknown = await chrome.runtime.sendMessage(command);
  if (!isResponse(response)) throw new Error('MCP 服务返回了无效响应。');
  if (!response.ok) throw new Error(response.error);
  return response.state;
}

function isResponse(value: unknown): value is McpCommandResponse {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false;
  const response = value as { ok?: unknown; state?: unknown; error?: unknown };
  if (response.ok === false) return typeof response.error === 'string';
  return response.ok === true && typeof response.state === 'object' && response.state !== null;
}
