// ─── 会话运行偏好 ───
// 职责：把模型与思考等级绑定到当前会话；运行中修改只影响下一轮。
// 使用通用 Select 组件，视觉与交互与项目其他选择控件保持一致。

import { useEffect, useMemo, useState } from 'react';
import type { ConversationRuntimeSettings, ThinkingLevel } from '@/lib/domain/chat';
import type { ProviderStateView } from '@/lib/domain/types';
import type { ProviderCommandResponse } from '@/lib/ipc/protocol';
import { loadConversationRuntimeSettings, saveConversationRuntimeSettings } from '@/lib/storage/db';
import { Select } from './ui/Select';

interface ConversationRuntimeControlsProps {
  conversationId: string | null;
}

const THINKING_OPTIONS: Array<{ value: ThinkingLevel; label: string; hint?: string }> = [
  { value: 'off', label: '标准', hint: '速度优先，不做额外推理' },
  { value: 'low', label: '轻度思考', hint: '复杂问题适度推理' },
  { value: 'medium', label: '中度思考', hint: '平衡速度与推理深度' },
  { value: 'high', label: '深度思考', hint: '强模型推理模式' },
];

/** 模型 identity 分隔符：providerId 与 modelId 之间。 */
const IDENTITY_SEP = '\u0000';

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

  const modelOptions = useMemo(
    () =>
      providers?.connections.flatMap((connection) =>
        connection.models.map((model) => ({
          value: `${connection.providerId}${IDENTITY_SEP}${model.id}`,
          label: `${connection.providerId} / ${model.name}`,
        })),
      ) ?? [],
    [providers],
  );
  const identity = settings?.modelIdentity ?? providers?.activeModel;
  const modelValue = identity ? `${identity.providerId}${IDENTITY_SEP}${identity.modelId}` : '';

  const persist = async (next: ConversationRuntimeSettings) => {
    setSettings(next);
    await saveConversationRuntimeSettings(next);
  };

  if (!conversationId || !providers) return null;

  return (
    <fieldset className="conversation-runtime-controls" aria-label="当前会话运行设置">
      <Select
        value={modelValue}
        options={modelOptions}
        onChange={(value) => {
          const [providerId, modelId] = value.split(IDENTITY_SEP);
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
        ariaLabel="当前会话模型"
        placeholder="选择模型"
        allowEmpty={false}
      />
      <Select
        value={settings?.thinkingLevel ?? 'off'}
        options={THINKING_OPTIONS}
        onChange={(thinkingLevel) => {
          void persist({
            conversationId,
            ...(identity ? { modelIdentity: identity } : {}),
            thinkingLevel,
            contextWindowTokens: settings?.contextWindowTokens ?? 128_000,
            maxOutputTokens: settings?.maxOutputTokens ?? 8_192,
            updatedAt: Date.now(),
          });
        }}
        ariaLabel="思考等级"
        placeholder="思考等级"
        allowEmpty={false}
      />
    </fieldset>
  );
}
