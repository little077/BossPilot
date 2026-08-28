// ─── 会话运行偏好 ───
// 职责：把模型与思考等级绑定到当前会话；运行中修改只影响下一轮。
// 使用 shadcn/ui Select（Radix 封装），下拉经 Portal + Popper 定位，
// 展开不挤压输入框工具行；触发器以紧凑内联姿态嵌入工具行右侧。

import { useEffect, useMemo, useState } from 'react';
import type { ConversationRuntimeSettings, ThinkingLevel } from '@/lib/domain/chat';
import type { ProviderStateView } from '@/lib/domain/types';
import type { ProviderCommandResponse } from '@/lib/ipc/protocol';
import { loadConversationRuntimeSettings, saveConversationRuntimeSettings } from '@/lib/storage/db';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select';

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
const IDENTITY_SEP = '::';

/**
 * 工具行内联触发器样式：无边框、24px 高、透明背景，hover 柔和品牌色高亮，
 * 与附件按钮同一姿态，不破坏输入框底部的简洁感。
 */
const TOOL_TRIGGER_CLASS =
  'h-6 w-auto min-w-0 max-w-full justify-start gap-1 overflow-hidden rounded-[7px] border-transparent bg-transparent ' +
  'px-[7px] py-0 text-[10px] text-ink-faint ' +
  'hover:border-transparent hover:bg-brand-soft hover:text-brand ' +
  'focus-visible:border-brand focus-visible:bg-surface focus-visible:ring-0 ' +
  '[&_svg]:size-3 [&_svg]:text-current';

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
  const selectedModelLabel =
    modelOptions.find((option) => option.value === modelValue)?.label ?? '选择模型';
  const selectedThinkingLabel =
    THINKING_OPTIONS.find((option) => option.value === (settings?.thinkingLevel ?? 'off'))?.label ??
    '思考等级';

  const persist = async (next: ConversationRuntimeSettings) => {
    setSettings(next);
    await saveConversationRuntimeSettings(next);
  };

  if (!conversationId || !providers) return null;

  return (
    <fieldset
      className="conversation-runtime-controls m-0 flex min-w-0 max-w-[218px] flex-[1_1_176px] items-center justify-end gap-1 border-0 p-0 [min-inline-size:0]"
      aria-label="当前会话运行设置"
    >
      <Select
        value={modelValue}
        onValueChange={(value) => {
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
      >
        <SelectTrigger
          aria-label="当前会话模型"
          className={`${TOOL_TRIGGER_CLASS} flex-[1_1_132px]`}
          title={selectedModelLabel}
        >
          <span className="block min-w-0 flex-1 truncate">
            <SelectValue placeholder="选择模型" />
          </span>
        </SelectTrigger>
        <SelectContent
          align="end"
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="max-w-[min(280px,calc(100vw-16px))]"
        >
          {modelOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className="block min-w-0 truncate" title={option.label}>
                {option.label}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={settings?.thinkingLevel ?? 'off'}
        onValueChange={(thinkingLevel) => {
          void persist({
            conversationId,
            ...(identity ? { modelIdentity: identity } : {}),
            thinkingLevel: thinkingLevel as ThinkingLevel,
            contextWindowTokens: settings?.contextWindowTokens ?? 128_000,
            maxOutputTokens: settings?.maxOutputTokens ?? 8_192,
            updatedAt: Date.now(),
          });
        }}
      >
        <SelectTrigger
          aria-label="思考等级"
          className={`${TOOL_TRIGGER_CLASS} flex-[0_1_82px]`}
          title={selectedThinkingLabel}
        >
          <span className="block min-w-0 flex-1 truncate">
            <SelectValue placeholder="思考等级" />
          </span>
        </SelectTrigger>
        <SelectContent
          align="end"
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="max-w-[min(280px,calc(100vw-16px))]"
        >
          {THINKING_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </fieldset>
  );
}
