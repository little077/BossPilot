// ─── Sidepanel 多模型客户端 ───
// 职责：通过一次性 Runtime Message 调用 Background；响应只有脱敏快照。

import type { ProviderStateView } from '@/lib/domain/types';
import type { ProviderCommand, ProviderCommandResponse } from '@/lib/ipc/protocol';

export async function sendProviderCommand(command: ProviderCommand): Promise<ProviderStateView> {
  const response: unknown = await chrome.runtime.sendMessage(command);
  if (!isProviderCommandResponse(response)) {
    throw new Error('模型配置服务返回了无效响应。');
  }
  if (!response.ok) throw new Error(response.error);
  return response.state;
}

function isProviderCommandResponse(value: unknown): value is ProviderCommandResponse {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false;
  const response = value as { ok?: unknown; state?: unknown; error?: unknown };
  if (response.ok === false) return typeof response.error === 'string';
  if (response.ok !== true || typeof response.state !== 'object' || response.state === null) {
    return false;
  }
  return true;
}
