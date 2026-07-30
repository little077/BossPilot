// ─── 模型卡包设置 ───
// 职责：实现原型中的「领卡 → 开通 → 拉目录 → 选模型 → 配置完成」交互。
// API Key 仅单向发送给 Background；组件只持有用户本次输入和脱敏快照。

import { Check, ExternalLink, KeyRound, Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderConnectionView, ProviderStateView } from '@/lib/domain/types';
import { sendProviderCommand } from '@/lib/providers/client';
import {
  normalizeProviderBaseUrl,
  requestProviderHostPermission,
} from '@/lib/providers/permissions';
import {
  getProviderDefinition,
  PROVIDERS,
  type ProviderDefinition,
} from '@/lib/providers/registry';

interface ProviderDraft {
  apiKey: string;
  baseUrl: string;
  manualModel: string;
}

const EMPTY_DRAFT: ProviderDraft = { apiKey: '', baseUrl: '', manualModel: '' };

export function ProviderSettings() {
  const [state, setState] = useState<ProviderStateView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [busyProviderIds, setBusyProviderIds] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string>();
  const [showAllProviders, setShowAllProviders] = useState(false);
  const keyInputs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    let active = true;
    void sendProviderCommand({ type: 'providers:get' }).then(
      (next) => {
        if (active) setState(next);
      },
      (error: unknown) => {
        if (active) setNotice(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const connectionById = useMemo(
    () => new Map(state?.connections.map((connection) => [connection.providerId, connection])),
    [state],
  );
  const availableProviders = PROVIDERS.filter((provider) => !connectionById.has(provider.id));
  const hasAdditionalProviders = availableProviders.some((provider) => !provider.featured);
  const additionalProviderCount = availableProviders.filter(
    (provider) => !provider.featured,
  ).length;
  const visibleProviders = showAllProviders
    ? availableProviders
    : availableProviders.filter((provider) => provider.featured);

  const getDraft = (providerId: string): ProviderDraft =>
    drafts[providerId] ?? {
      ...EMPTY_DRAFT,
      baseUrl:
        connectionById.get(providerId)?.baseUrl ?? getProviderDefinition(providerId)?.baseUrl ?? '',
    };
  const updateDraft = (providerId: string, patch: Partial<ProviderDraft>) => {
    setDrafts((current) => ({
      ...current,
      [providerId]: { ...(current[providerId] ?? EMPTY_DRAFT), ...patch },
    }));
  };
  const setProviderBusy = (providerId: string, busy: boolean) => {
    setBusyProviderIds((current) => {
      const next = new Set(current);
      if (busy) next.add(providerId);
      else next.delete(providerId);
      return next;
    });
  };

  const issueProvider = async (provider: ProviderDefinition) => {
    setProviderBusy(provider.id, true);
    try {
      const next = await sendProviderCommand({
        type: 'providers:issue',
        providerId: provider.id,
      });
      setState(next);
      setNotice(`已领取 ${provider.label} 卡，请填写密钥后开通。`);
      requestAnimationFrame(() => keyInputs.current[provider.id]?.focus());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setProviderBusy(provider.id, false);
    }
  };

  const connectProvider = async (
    provider: ProviderDefinition,
    connection: ProviderConnectionView,
  ) => {
    const draft = getDraft(provider.id);
    const rawBaseUrl = provider.custom ? draft.baseUrl : provider.baseUrl;

    setErrors((current) => ({ ...current, [provider.id]: '' }));
    setProviderBusy(provider.id, true);
    try {
      if (!provider.keyOptional && !connection.hasApiKey && !draft.apiKey.trim()) {
        throw new Error('请先填写 API Key。');
      }
      const baseUrl = normalizeProviderBaseUrl(rawBaseUrl);
      const granted = await requestProviderHostPermission(baseUrl);
      if (!granted) throw new Error('未获得该模型端点的访问权限，无法读取模型目录。');

      const next = await sendProviderCommand({
        type: 'providers:connect',
        providerId: provider.id,
        apiKey: draft.apiKey,
        ...(provider.custom ? { baseUrl } : {}),
      });
      setState(next);
      updateDraft(provider.id, { apiKey: '', baseUrl });
      const modelCount =
        next.connections.find((item) => item.providerId === provider.id)?.models.length ?? 0;
      setNotice(`${provider.label} 模型目录已加载，共 ${modelCount} 个模型。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrors((current) => ({ ...current, [provider.id]: message }));
      setNotice(`${provider.label} 开通失败：${message}`);
    } finally {
      setProviderBusy(provider.id, false);
    }
  };

  const selectModel = async (provider: ProviderDefinition, modelId: string) => {
    setProviderBusy(provider.id, true);
    try {
      const next = await sendProviderCommand({
        type: 'providers:select',
        providerId: provider.id,
        modelId,
      });
      setState(next);
      setNotice(`${provider.label} 已配置为 ${modelId}。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setProviderBusy(provider.id, false);
    }
  };

  const addManualModel = async (
    provider: ProviderDefinition,
    connection: ProviderConnectionView,
  ) => {
    const draft = getDraft(provider.id);
    const modelId = draft.manualModel.trim();
    if (!modelId) {
      setErrors((current) => ({ ...current, [provider.id]: '请先填写模型 ID。' }));
      return;
    }

    const rawBaseUrl = provider.custom ? draft.baseUrl : provider.baseUrl;
    setProviderBusy(provider.id, true);
    try {
      if (!provider.keyOptional && !connection.hasApiKey && !draft.apiKey.trim()) {
        throw new Error('请先填写 API Key。');
      }
      const baseUrl = normalizeProviderBaseUrl(rawBaseUrl);
      const granted = await requestProviderHostPermission(baseUrl);
      if (!granted) throw new Error('未获得该模型端点的访问权限。');

      const next = await sendProviderCommand({
        type: 'providers:add-manual-model',
        providerId: provider.id,
        modelId,
        apiKey: draft.apiKey,
        ...(provider.custom ? { baseUrl } : {}),
      });
      setState(next);
      updateDraft(provider.id, { apiKey: '', baseUrl, manualModel: '' });
      setErrors((current) => ({ ...current, [provider.id]: '' }));
      setNotice(`${provider.label} 已手动配置模型 ${modelId}。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrors((current) => ({ ...current, [provider.id]: message }));
    } finally {
      setProviderBusy(provider.id, false);
    }
  };

  const removeProvider = async (provider: ProviderDefinition) => {
    setProviderBusy(provider.id, true);
    try {
      const next = await sendProviderCommand({
        type: 'providers:remove',
        providerId: provider.id,
      });
      setState(next);
      setDrafts((current) => {
        const nextDrafts = { ...current };
        delete nextDrafts[provider.id];
        return nextDrafts;
      });
      setNotice(`${provider.label} 卡已销毁，保存的密钥已删除。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setProviderBusy(provider.id, false);
    }
  };

  if (!state) {
    return (
      <section className="provider-settings" aria-label="模型卡包">
        <div className="flex items-center gap-2 text-[11px] text-ink-faint">
          <Loader2 size={12} className="animate-spin" />
          正在加载模型卡包…
        </div>
      </section>
    );
  }

  return (
    <section className="provider-settings" aria-labelledby="provider-wallet-title">
      <div className="provider-section-title">
        <h2 id="provider-wallet-title">我的模型卡包</h2>
        <span>密钥仅存本机</span>
      </div>

      {notice && (
        <div className="provider-notice" role="status" aria-live="polite">
          <ShieldCheck size={12} />
          {notice}
        </div>
      )}

      <div className="provider-wallet">
        {state.connections.length === 0 ? (
          <div className="provider-wallet-empty">
            卡包还是空的
            <br />
            从下方 <strong>发卡台</strong> 领取一个模型厂商
          </div>
        ) : (
          state.connections.map((connection) => {
            const provider = getProviderDefinition(connection.providerId);
            if (!provider) return null;
            return (
              <ProviderCard
                key={provider.id}
                provider={provider}
                connection={connection}
                draft={getDraft(provider.id)}
                active={state.activeModel?.providerId === provider.id}
                busy={busyProviderIds.has(provider.id)}
                error={errors[provider.id]}
                inputRef={(element) => {
                  keyInputs.current[provider.id] = element;
                }}
                onDraft={(patch) => updateDraft(provider.id, patch)}
                onConnect={() => void connectProvider(provider, connection)}
                onSelect={(modelId) => void selectModel(provider, modelId)}
                onAddManual={() => void addManualModel(provider, connection)}
                onRemove={() => void removeProvider(provider)}
              />
            );
          })
        )}
      </div>

      <div className="provider-deck">
        <div className="provider-section-title">
          <h3>发卡台</h3>
          <span>点击标签领取</span>
        </div>
        <div className="provider-capsules">
          {availableProviders.length > 0 ? (
            <>
              {visibleProviders.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className="provider-capsule"
                  disabled={busyProviderIds.has(provider.id)}
                  onClick={() => void issueProvider(provider)}
                >
                  <span className="provider-logo" data-tone={provider.tone}>
                    {provider.shortLabel}
                  </span>
                  {provider.label}
                  <Plus size={11} aria-hidden />
                </button>
              ))}
              {hasAdditionalProviders && (
                <button
                  type="button"
                  className="provider-capsule provider-capsule-more"
                  aria-expanded={showAllProviders}
                  onClick={() => setShowAllProviders((current) => !current)}
                >
                  {showAllProviders ? '收起更多' : `显示更多（${additionalProviderCount}）`}
                </button>
              )}
            </>
          ) : (
            <p className="text-[10px] text-ink-faint">全部厂商都已领取。</p>
          )}
        </div>
      </div>
    </section>
  );
}

interface ProviderCardProps {
  provider: ProviderDefinition;
  connection: ProviderConnectionView;
  draft: ProviderDraft;
  active: boolean;
  busy: boolean;
  error?: string;
  inputRef: (element: HTMLInputElement | null) => void;
  onDraft: (patch: Partial<ProviderDraft>) => void;
  onConnect: () => void;
  onSelect: (modelId: string) => void;
  onAddManual: () => void;
  onRemove: () => void;
}

function ProviderCard({
  provider,
  connection,
  draft,
  active,
  busy,
  error,
  inputRef,
  onDraft,
  onConnect,
  onSelect,
  onAddManual,
  onRemove,
}: ProviderCardProps) {
  const configured = Boolean(connection.selectedModelId);
  const status = getStatusText(connection, busy, error);
  const showManual = provider.custom || Boolean(error);

  return (
    <article
      className={`provider-card ${active ? 'provider-card-active' : ''}`}
      aria-label={`${provider.label} 模型配置`}
    >
      <div className="provider-card-band" data-tone={provider.tone}>
        <div className="provider-card-heading">
          <strong>{provider.label}</strong>
          {active && <span className="provider-active-flag">使用中 ✦</span>}
          <span className="provider-pass">BOSSPILOT PASS</span>
        </div>
        {configured && (
          <div className="provider-stamp" role="status" aria-label="配置完成">
            配置完成
            <small>READY</small>
          </div>
        )}
        <div className="provider-key-row">
          <span className="provider-key-chip">
            <KeyRound size={15} />
          </span>
          <span className="provider-key-mask">
            {connection.hasApiKey
              ? `•••• ${connection.apiKeyLastFour}`
              : provider.keyOptional
                ? '无需密钥'
                : '•••• ····'}
          </span>
        </div>
        <span className="provider-model-line">
          {configured
            ? active
              ? `当前模型：${connection.selectedModelId}`
              : `已配置：${connection.selectedModelId}`
            : connection.models.length > 0
              ? '目录已加载 · 请在下方选择模型'
              : '待开通 · 在下方填写密钥'}
        </span>
      </div>

      <form
        className="provider-card-config"
        onSubmit={(event) => {
          event.preventDefault();
          onConnect();
        }}
      >
        {provider.custom && (
          <label className="provider-field">
            <span>Base URL（OpenAI 兼容端点）</span>
            <input
              type="url"
              required
              placeholder="https://api.example.com/v1"
              value={draft.baseUrl}
              onChange={(event) => onDraft({ baseUrl: event.target.value })}
            />
          </label>
        )}

        <div className="provider-field">
          <div className="provider-field-label">
            <label htmlFor={`provider-key-${provider.id}`}>API Key（仅存本机）</label>
            <a href={provider.keyUrl} target="_blank" rel="noreferrer">
              获取密钥
              <ExternalLink size={9} />
            </a>
          </div>
          <div className="provider-key-form">
            <input
              ref={inputRef}
              id={`provider-key-${provider.id}`}
              type="password"
              autoComplete="off"
              placeholder={
                connection.hasApiKey
                  ? `已保存 •••• ${connection.apiKeyLastFour}，留空则继续使用`
                  : provider.keyOptional
                    ? '本地服务可留空'
                    : '输入 API Key'
              }
              value={draft.apiKey}
              onChange={(event) => onDraft({ apiKey: event.target.value })}
            />
            <button type="submit" disabled={busy}>
              {busy ? <Loader2 size={11} className="animate-spin" /> : null}
              {busy ? '获取中' : connection.models.length > 0 ? '更新' : '开通'}
            </button>
          </div>
        </div>

        <p
          className={`provider-status ${error ? 'provider-status-error' : configured ? 'provider-status-ok' : ''}`}
          aria-live="polite"
        >
          {status}
        </p>

        {connection.models.length > 0 && (
          <div className="provider-models">
            <div className="provider-models-title">
              <strong>可用模型</strong>
              <span>{configured ? '点击可切换默认模型' : '点选一个完成配置'}</span>
            </div>
            <div className="provider-model-list">
              {connection.models.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  className={
                    connection.selectedModelId === model.id ? 'provider-model-selected' : undefined
                  }
                  aria-pressed={connection.selectedModelId === model.id}
                  disabled={busy}
                  title={model.name}
                  onClick={() => onSelect(model.id)}
                >
                  {connection.selectedModelId === model.id && <Check size={10} />}
                  {model.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {showManual && (
          <div className="provider-manual-model">
            <label htmlFor={`provider-manual-${provider.id}`}>手动模型 ID</label>
            <div>
              <input
                id={`provider-manual-${provider.id}`}
                value={draft.manualModel}
                placeholder="如 my-model"
                onChange={(event) => onDraft({ manualModel: event.target.value })}
              />
              <button type="button" disabled={busy} onClick={onAddManual}>
                添加
              </button>
            </div>
          </div>
        )}

        <div className="provider-card-footer">
          <span>不上传 · 不同步 · 可随时销毁</span>
          <button type="button" disabled={busy} onClick={onRemove}>
            <Trash2 size={10} />
            销毁此卡
          </button>
        </div>
      </form>
    </article>
  );
}

function getStatusText(connection: ProviderConnectionView, busy: boolean, error?: string): string {
  if (busy) return '正在请求模型厂商并读取可用模型列表…';
  if (error) return `✗ ${error}`;
  if (connection.selectedModelId) {
    return `✓ 配置完成 · 默认模型 ${connection.selectedModelId}`;
  }
  if (connection.models.length > 0) {
    return `✓ 检测到 ${connection.models.length} 个模型，请选择一个作为默认模型`;
  }
  return '待开通：填写密钥后将自动读取厂商模型列表';
}
