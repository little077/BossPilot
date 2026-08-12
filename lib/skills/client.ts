import type { SkillCommand, SkillCommandResponse } from '@/lib/ipc/protocol';
import type { SkillSettingsView } from '@/lib/skills/types';

export async function sendSkillCommand(command: SkillCommand): Promise<SkillSettingsView> {
  const response: unknown = await chrome.runtime.sendMessage(command);
  if (!isSkillCommandResponse(response)) throw new Error('技能服务返回了无效响应。');
  if (!response.ok) throw new Error(response.error);
  return response.state;
}

function isSkillCommandResponse(value: unknown): value is SkillCommandResponse {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false;
  const response = value as { ok?: unknown; state?: unknown; error?: unknown };
  if (response.ok === false) return typeof response.error === 'string';
  return response.ok === true && typeof response.state === 'object' && response.state !== null;
}
