// ─── BossPilot 侧边栏主界面 ───
// 极简 LangChain + DeepSeek 流式对话 Demo：两个页签「对话 / 设置」。
// 状态集中在 useAgentPort，Chat 与 SettingsView 只负责展示与交互。

import { Bot, Loader2, MessageSquare, Settings } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getDevAccess } from '@/lib/dev/access';
import { Chat } from './Chat';
import { DevDock } from './DevDock';
import { SettingsView } from './SettingsView';
import { useAgentPort } from './usePort';

type Tab = 'chat' | 'settings';

const NAV_ITEMS: Array<[Tab, typeof MessageSquare, string]> = [
  ['chat', MessageSquare, '对话'],
  ['settings', Settings, '设置'],
];

export default function App() {
  const {
    messages,
    chatRunning,
    connected,
    config,
    models,
    modelsLoading,
    modelsError,
    sendChat,
    cancelChat,
    saveConfig,
    fetchModels,
    selectModel,
  } = useAgentPort();
  const [tab, setTab] = useState<Tab>('chat');
  // 引导只发生一次：待配置快照从后台回来后，若「有密钥但没选模型」或完全未配置，
  // 自动跳到设置页（卡包），承担引导用户配置模型的作用；用户此后手动切换不再打扰。
  const didGuideRef = useRef(false);

  const configured = Boolean(config?.hasApiKey && config?.model);

  useEffect(() => {
    if (!connected || config === null || didGuideRef.current) return;
    if (!configured) {
      didGuideRef.current = true;
      setTab('settings');
    }
  }, [connected, config, configured]);

  return (
    <div className="flex h-full flex-col bg-app text-ink" data-testid="app-shell">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-[10px] bg-brand text-white">
          <Bot size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] leading-tight font-semibold">BossPilot</div>
          <div className="flex items-center gap-1 truncate text-[10px] text-ink-faint">
            {chatRunning ? (
              <>
                <Loader2 size={9} className="animate-spin text-brand" />
                回复生成中…
              </>
            ) : connected ? (
              'LangChain × DeepSeek · 本地隐私'
            ) : (
              '连接后台中…'
            )}
          </div>
        </div>
        <nav className="flex shrink-0 items-center gap-0.5" aria-label="主导航">
          {NAV_ITEMS.map(([key, Icon, label]) => (
            <button
              key={key}
              type="button"
              title={label}
              aria-label={label}
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => setTab(key)}
              className={`grid h-7 w-7 place-items-center rounded-lg transition-colors ${
                tab === key
                  ? 'bg-surface-mint text-brand'
                  : 'text-ink-faint hover:bg-surface-soft hover:text-ink-soft'
              }`}
            >
              <Icon size={15} />
            </button>
          ))}
        </nav>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'chat' ? (
          <Chat
            messages={messages}
            running={chatRunning}
            connected={connected}
            onSend={sendChat}
            onCancel={cancelChat}
          />
        ) : (
          <SettingsView
            config={config}
            models={models}
            modelsLoading={modelsLoading}
            modelsError={modelsError}
            onSave={saveConfig}
            onFetchModels={fetchModels}
            onSelectModel={selectModel}
          />
        )}
      </main>

      {/* DEV 专用悬浮球：一键应用 .env 调试配置；生产构建此块被摇树移除。 */}
      {import.meta.env.DEV ? (
        <DevDock access={getDevAccess()} onApply={saveConfig} onApplied={() => setTab('chat')} />
      ) : null}
    </div>
  );
}
