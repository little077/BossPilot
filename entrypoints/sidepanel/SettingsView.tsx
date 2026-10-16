// ─── 设置页：DeepSeek 模型卡（拉目录 + 选模型） ───
// 交互对齐主分支「领卡 → 开通 → 拉模型目录 → 选模型 → 配置完成」的最小闭环：
// Base URL 写死在卡面（Demo 固定单一厂商，不做自定义端点）；用户填密钥后点「开通并获取模型」，
// 后台用密钥请求 {baseUrl}/models 拿回可用模型列表，用户点选一个后才算配置完成。
// 未选模型时，对话页会引导用户回到本页完成选择（见 App.tsx 的引导逻辑）。

import { Check, ExternalLink, KeyRound, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { ModelCatalogEntry, ModelConfigView } from '@/lib/domain/types';

// DeepSeek 官方端点即 OpenAI 兼容格式；Demo 固定这一厂商，端点与取密钥地址写死。
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_KEY_URL = 'https://platform.deepseek.com/api_keys';

interface SettingsViewProps {
  config: ModelConfigView | null;
  models: ModelCatalogEntry[];
  modelsLoading: boolean;
  modelsError: string;
  onSave: (input: { baseUrl: string; model: string; apiKey: string }) => boolean;
  onFetchModels: (input: { baseUrl: string; apiKey: string }) => boolean;
  onSelectModel: (baseUrl: string, model: string) => boolean;
  /** 切换长会话自动压缩开关（阶段 3 源①）；返回 false 表示后台连接已断。 */
  onToggleCompact: (enabled: boolean) => boolean;
}

export function SettingsView({
  config,
  models,
  modelsLoading,
  modelsError,
  onSave,
  onFetchModels,
  onSelectModel,
  onToggleCompact,
}: SettingsViewProps) {
  const [apiKey, setApiKey] = useState('');
  const [savedNotice, setSavedNotice] = useState('');

  const hasKey = Boolean(config?.hasApiKey);
  const selectedModel = config?.model ?? '';
  const configured = hasKey && selectedModel.length > 0;
  // 压缩开关当前态：缺省视为开启（与新用户默认一致）。
  const compactEnabled = config?.compactEnabled ?? true;

  // 「开通并获取模型」：先落库密钥（保留当前已选模型），再触发一次目录拉取。
  const connect = (event: React.FormEvent) => {
    event.preventDefault();
    setSavedNotice('');
    const trimmed = apiKey.trim();
    // 首次使用必须有密钥；已配置过则允许留空（后台沿用已存密钥，仅刷新列表）。
    if (!trimmed && !hasKey) {
      setSavedNotice('首次使用请先填写 API Key。');
      return;
    }
    onSave({ baseUrl: DEEPSEEK_BASE_URL, model: selectedModel, apiKey: trimmed });
    onFetchModels({ baseUrl: DEEPSEEK_BASE_URL, apiKey: trimmed });
    setApiKey('');
  };

  const pickModel = (modelId: string) => {
    setSavedNotice('');
    if (onSelectModel(DEEPSEEK_BASE_URL, modelId)) {
      setSavedNotice(`已选择 ${modelId}，回到「对话」即可开始。`);
    } else {
      setSavedNotice('选择失败：后台连接已断开，请稍候重试。');
    }
  };

  const modelLine = configured
    ? `当前模型：${selectedModel}`
    : hasKey
      ? selectedModel
        ? `已配置：${selectedModel}`
        : '密钥已存 · 请在下方获取并选择模型'
      : '待开通 · 填写密钥后获取模型';

  return (
    <section className="provider-settings" aria-label="模型配置">
      <div className="provider-section-title">
        <h2>我的模型卡包</h2>
        <span>密钥仅存本机</span>
      </div>

      <div className="provider-wallet">
        <article
          className={`provider-card ${configured ? 'provider-card-active' : ''}`}
          aria-label="DeepSeek 模型配置"
        >
          <div className="provider-card-band" data-tone="blue">
            <div className="provider-card-heading">
              <strong>DeepSeek</strong>
              {configured ? <span className="provider-active-flag">使用中 ✓</span> : null}
              <span className="provider-pass">BOSSPILOT PASS</span>
            </div>
            {configured ? (
              <div className="provider-stamp" role="status" aria-label="配置完成">
                配置完成
                <small>READY</small>
              </div>
            ) : null}
            <div className="provider-key-row">
              <span className="provider-key-chip">
                <KeyRound size={15} aria-hidden />
              </span>
              <span className="provider-key-mask">
                {hasKey ? `•••• ${config?.apiKeyLastFour ?? ''}` : '•••• ••••'}
              </span>
            </div>
            <span className="provider-model-line">{modelLine}</span>
          </div>

          <form className="provider-card-config" onSubmit={connect}>
            <div className="provider-field">
              <div className="provider-field-label">
                <label htmlFor="deepseek-api-key">API Key（仅存本机）</label>
                <a href={DEEPSEEK_KEY_URL} target="_blank" rel="noreferrer">
                  获取密钥
                  <ExternalLink size={9} aria-hidden />
                </a>
              </div>
              <div className="provider-key-form">
                <input
                  id="deepseek-api-key"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    hasKey ? `已保存 •••• ${config?.apiKeyLastFour ?? ''}，留空则沿用` : 'sk-...'
                  }
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <button type="submit" disabled={modelsLoading}>
                  {modelsLoading ? (
                    <Loader2 size={11} className="animate-spin" aria-hidden />
                  ) : null}
                  {modelsLoading ? '获取中' : hasKey ? '更新并获取模型' : '开通并获取模型'}
                </button>
              </div>
            </div>

            {/* 拉取状态 / 错误提示（error 走 models_state，不与对话错误通道混用）。 */}
            {modelsError ? (
              <p className="provider-status provider-status-error" aria-live="polite">
                ✗ {modelsError}
              </p>
            ) : modelsLoading ? (
              <p className="provider-status" aria-live="polite">
                正在请求 DeepSeek 并读取可用模型列表…
              </p>
            ) : savedNotice ? (
              <p className="provider-status provider-status-ok" aria-live="polite">
                {savedNotice}
              </p>
            ) : null}

            {/* 模型目录：拉取回来后在此点选默认模型（沿用主分支 provider-models 列表样式）。 */}
            {models.length > 0 ? (
              <div className="provider-models">
                <div className="provider-models-title">
                  <strong>可用模型</strong>
                  <span>{selectedModel ? '点击可切换默认模型' : '点选一个完成配置'}</span>
                </div>
                <div className="provider-model-list">
                  {models.map((model) => {
                    const active = selectedModel === model.id;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        className={active ? 'provider-model-selected' : undefined}
                        aria-pressed={active}
                        disabled={modelsLoading}
                        title={model.name}
                        onClick={() => pickModel(model.id)}
                      >
                        {active ? <Check size={10} aria-hidden /> : null}
                        {model.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* 长会话自动压缩开关：可见、可关（阶段 3 源①）。仅在已配置后可调。 */}
            <div className="provider-field">
              <div className="provider-key-row">
                <input
                  id="compact-toggle"
                  type="checkbox"
                  checked={compactEnabled}
                  disabled={!configured}
                  onChange={(event) => {
                    setSavedNotice('');
                    onToggleCompact(event.target.checked);
                  }}
                />
                <label htmlFor="compact-toggle">
                  长会话自动压缩（将早先轮次摘要以控制上下文规模，可关）
                </label>
              </div>
            </div>

            <div className="provider-card-footer">
              <span>不上云 · 不同步 · 仅本地</span>
            </div>
          </form>
        </article>
      </div>
    </section>
  );
}
