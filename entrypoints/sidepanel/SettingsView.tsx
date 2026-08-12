// ─── 设置页：模型卡包与页面来源权限 ───

import { Globe2, Loader2, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  type GrantedPageOrigin,
  listGrantedPageOrigins,
  removePageOriginAccess,
} from '@/lib/page/access';
import { getChatHistorySettings, setChatHistorySettings } from '@/lib/storage/config';
import { AgentContextSettings } from './AgentContextSettings';
import { AgentHealthCheckPanel } from './AgentHealthCheck';
import { DataPortability } from './DataPortability';
import { McpSettings } from './McpSettings';
import { ProviderSettings } from './ProviderSettings';
import { SkillSettings } from './SkillSettings';

export function SettingsView() {
  return (
    <div className="redscope-settings flex flex-col">
      <ProviderSettings />
      <SkillSettings />
      <AgentContextSettings />
      <McpSettings />
      <AgentHealthCheckPanel />
      <DataPortability />
      <ChatHistorySettings />
      <PageOriginSettings />
    </div>
  );
}

function ChatHistorySettings() {
  const [autoTitle, setAutoTitle] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void getChatHistorySettings()
      .then((settings) => {
        if (active) setAutoTitle(settings.autoTitle);
      })
      .catch(() => {
        if (active) setNotice('自动标题设置读取失败，请重新打开设置。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const changeAutoTitle = async (enabled: boolean) => {
    const previous = autoTitle;
    setAutoTitle(enabled);
    setSaving(true);
    setNotice('');
    try {
      await setChatHistorySettings({ autoTitle: enabled });
      setNotice(enabled ? '已开启自动会话标题。' : '已关闭自动会话标题。');
    } catch {
      setAutoTitle(previous);
      setNotice('自动标题设置保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="chat-history-settings" aria-labelledby="chat-history-settings-title">
      <div className="provider-section-title">
        <h2 id="chat-history-settings-title">对话历史</h2>
        <span>仅保存在本机</span>
      </div>
      <label className="chat-history-toggle">
        <span className="chat-history-toggle-icon" aria-hidden>
          <Sparkles size={12} />
        </span>
        <span className="chat-history-toggle-copy">
          <strong>自动生成会话标题</strong>
          <span>
            每轮成功回复后，会额外调用一次当前模型生成短标题，并消耗少量
            Token；关闭或生成失败时使用“历史记录 N”。
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-checked={autoTitle}
          checked={autoTitle}
          disabled={loading || saving}
          aria-label="自动生成会话标题"
          onChange={(event) => void changeAutoTitle(event.target.checked)}
        />
        <span className="chat-history-switch" aria-hidden>
          {saving ? <Loader2 size={9} className="animate-spin" /> : null}
        </span>
      </label>
      {notice ? (
        <div className="page-origin-notice" role="status">
          {notice}
        </div>
      ) : null}
    </section>
  );
}

function PageOriginSettings() {
  const [origins, setOrigins] = useState<GrantedPageOrigin[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void listGrantedPageOrigins()
      .then((items) => {
        if (active) setOrigins(items);
      })
      .catch(() => {
        if (active) {
          setOrigins([]);
          setNotice('网站权限列表读取失败，请重新打开设置。');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const remove = async (item: GrantedPageOrigin) => {
    setRemoving(item.pattern);
    setNotice('');
    try {
      await removePageOriginAccess(item.pattern);
      setOrigins((current) => current?.filter(({ pattern }) => pattern !== item.pattern) ?? []);
      setNotice(`已撤销 ${item.origin} 的页面读取权限。`);
    } catch {
      setNotice(`未能撤销 ${item.origin} 的权限，请稍后重试。`);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <section className="page-origin-settings" aria-labelledby="page-origin-settings-title">
      <div className="provider-section-title">
        <h2 id="page-origin-settings-title">页面读取权限</h2>
        <span>按网站单独授权</span>
      </div>
      <p className="page-origin-copy">
        BossPilot
        默认只读取回答所需的可见文本；视觉任务会先说明原因并逐次询问，截图中的已填写字段会被遮挡。这里可以撤销之前允许的网站。
      </p>
      {notice ? (
        <div className="page-origin-notice" role="status">
          {notice}
        </div>
      ) : null}
      {origins === null ? (
        <div className="page-origin-empty">
          <Loader2 size={11} className="animate-spin" /> 正在读取网站权限…
        </div>
      ) : origins.length === 0 ? (
        <div className="page-origin-empty">
          <Globe2 size={12} /> 尚未长期允许其他网站
        </div>
      ) : (
        <ul className="page-origin-list">
          {origins.map((item) => (
            <li key={item.pattern}>
              <span title={item.origin}>{item.origin}</span>
              <button
                type="button"
                aria-label={`撤销 ${item.origin} 的页面读取权限`}
                disabled={removing === item.pattern}
                onClick={() => void remove(item)}
              >
                {removing === item.pattern ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Trash2 size={11} />
                )}
                撤销
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
