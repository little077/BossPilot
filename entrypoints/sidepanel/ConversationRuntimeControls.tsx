// ─── 会话运行偏好 ───
// 职责：把模型与思考等级绑定到当前会话；运行中修改只影响下一轮。

import { useEffect, useMemo, useState } from 'react';
import type { ConversationRuntimeSettings, ThinkingLevel } from '@/lib/domain/chat';
import type { ProviderStateView } from '@/lib/domain/types';
import type { ProviderCommandResponse } from '@/lib/ipc/protocol';
import { loadConversationRuntimeSettings, saveConversationRuntimeSettings } from '@/lib/storage/db';

interface ConversationRuntimeControlsProps {
  conversationId: string | null;
}

const THINKING_OPTIONS: Array<{ value: ThinkingLevel; label: string }> = [
  { value: 'off', label: '标准' },
  { value: 'low', label: '轻度思考' },
  { value: 'medium', label: '中度思考' },
  { value: 'high', label: '深度思考' },
];

export function ConversationRuntimeControls({ conversationId }: ConversationRuntimeControlsProps) {
  const [providers, setProviders] = useState<ProviderStateView | null>(null);
  const [settings, setSettings] = useState<ConversationRuntimeSettings | null>(null);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    let disposed = false;
    void Promise.all([
      chrome.runtime.sendMessage({ type: 'providers:get' }).catch(() => null),
      conversationId ? loadConversationRuntimeSettings(conversationId) : Promise.resolve(null),
    ]).then(([response, stored]) => {
      if (disposed) return;
      const result = response as ProviderCommandResponse | null;
      if (result?.ok) setProviders(result.state);
      setSettings(stored);
    });
    return () => {
      disposed = true;
    };
  }, [conversationId]);

  const models = useMemo(
    () =>
      providers?.connections.flatMap((connection) =>
        connection.models.map((model) => ({
          value: `${connection.providerId}\u0000${model.id}`,
          label: `${connection.providerId} / ${model.name}`,
        })),
      ) ?? [],
    [providers],
  );
  const identity = settings?.modelIdentity ?? providers?.activeModel;
  const modelValue = identity ? `${identity.providerId}\u0000${identity.modelId}` : '';

  const persist = async (next: ConversationRuntimeSettings) => {
    setSettings(next);
    await saveConversationRuntimeSettings(next);
  };

  if (!conversationId || !providers) return null;

  return (
    <fieldset className="flex items-center gap-1.5">
      <legend className="sr-only">当前会话运行设置</legend>
      <label className="sr-only" htmlFor="conversation-model">
        当前会话模型
      </label>
      <select
        id="conversation-model"
        className="max-w-36 rounded-lg border border-line bg-surface px-1.5 py-1 text-[10px] text-ink-soft"
        value={modelValue}
        onChange={(event) => {
          const [providerId, modelId] = event.target.value.split('\u0000');
          if (!providerId || !modelId) return;
          void persist({
            conversationId,
            modelIdentity: { providerId, modelId },
            thinkingLevel: settings?.thinkingLevel ?? 'off',
            contextWindowTokens: settings?.contextWindowTokens ?? 128_000,
            maxOutputTokens: settings?.maxOutputTokens ?? 8_192,
            updatedAt: Date.now(),
          });
        }}
      >
        {models.map((model) => (
          <option key={model.value} value={model.value}>
            {model.label}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="conversation-thinking">
        思考等级
      </label>
      <select
        id="conversation-thinking"
        className="rounded-lg border border-line bg-surface px-1.5 py-1 text-[10px] text-ink-soft"
        value={settings?.thinkingLevel ?? 'off'}
        onChange={(event) => {
          const thinkingLevel = event.target.value as ThinkingLevel;
          void persist({
            conversationId,
            ...(identity ? { modelIdentity: identity } : {}),
            thinkingLevel,
            contextWindowTokens: settings?.contextWindowTokens ?? 128_000,
            maxOutputTokens: settings?.maxOutputTokens ?? 8_192,
            updatedAt: Date.now(),
          });
        }}
      >
        {THINKING_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </fieldset>
  );
}
