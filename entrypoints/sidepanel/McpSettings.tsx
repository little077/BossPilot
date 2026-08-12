import { Cable, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { sendMcpCommand } from '@/lib/mcp/client';
import { permissionPatternForMcp } from '@/lib/mcp/store';
import type { McpSettingsView } from '@/lib/mcp/types';

export function McpSettings() {
  const [view, setView] = useState<McpSettingsView | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [editId, setEditId] = useState<string>();
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void sendMcpCommand({ type: 'mcp:get' }).then(
      (next) => active && setView(next),
      () => active && setNotice('MCP 配置读取失败，请重新打开设置。'),
    );
    return () => {
      active = false;
    };
  }, []);

  const save = async () => {
    setBusy('save');
    setNotice('');
    try {
      const pattern = permissionPatternForMcp(url);
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) throw new Error('没有授予 MCP 服务地址的网络权限。');
      const next = await sendMcpCommand({
        type: 'mcp:save',
        ...(editId ? { id: editId } : {}),
        name,
        url,
        token,
      });
      setView(next);
      setName('');
      setUrl('');
      setToken('');
      setEditId(undefined);
      setExpanded(false);
      setNotice('MCP 服务已连接，工具目录已更新。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'MCP 服务连接失败。');
    } finally {
      setBusy('');
    }
  };

  const mutate = async (
    key: string,
    command: Parameters<typeof sendMcpCommand>[0],
    success: string,
  ) => {
    setBusy(key);
    setNotice('');
    try {
      setView(await sendMcpCommand(command));
      setNotice(success);
    } catch {
      setNotice('MCP 设置保存失败，请稍后重试。');
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="mcp-settings" aria-labelledby="mcp-settings-title">
      <div className="provider-section-title">
        <h2 id="mcp-settings-title">MCP 工具</h2>
        <span>Streamable HTTP · 按地址授权</span>
      </div>
      <p className="page-origin-copy">
        连接用户信任的远程 MCP
        服务。只读工具可直接执行；其他工具每次都会在输入框上方请求确认。当前不支持浏览器中启动 stdio
        本机进程。
      </p>
      <button
        type="button"
        className="mcp-add-button"
        onClick={() => setExpanded((value) => !value)}
      >
        <Plus size={11} /> 添加 MCP 服务
      </button>
      {expanded ? (
        <div className="mcp-form">
          <label htmlFor="mcp-name">名称</label>
          <input
            id="mcp-name"
            value={name}
            maxLength={80}
            placeholder="例如：我的知识库"
            onChange={(event) => setName(event.target.value)}
          />
          <label htmlFor="mcp-url">MCP 地址</label>
          <input
            id="mcp-url"
            value={url}
            placeholder="https://example.com/mcp"
            onChange={(event) => setUrl(event.target.value)}
          />
          <label htmlFor="mcp-token">Bearer Token（可选，仅存本机）</label>
          <input
            id="mcp-token"
            type="password"
            value={token}
            autoComplete="off"
            maxLength={16_384}
            onChange={(event) => setToken(event.target.value)}
          />
          <button
            type="button"
            disabled={!name.trim() || !url.trim() || Boolean(busy)}
            onClick={() => void save()}
          >
            {busy === 'save' ? <Loader2 size={11} className="animate-spin" /> : <Cable size={11} />}{' '}
            连接并读取工具
          </button>
        </div>
      ) : null}
      <div className="mcp-list">
        {view?.servers.map((server) => (
          <article key={server.id} className="mcp-card" aria-label={`${server.name} MCP 服务`}>
            <div>
              <strong>{server.name}</strong>
              <span>{server.url}</span>
              <small>
                {server.tools.length} 个工具 · {server.tokenConfigured ? '已配置令牌' : '无令牌'}
              </small>
            </div>
            <label className="skill-toggle">
              <span className="sr-only">{`${server.name} MCP 服务`}</span>
              <input
                type="checkbox"
                role="switch"
                aria-label={`${server.name} MCP 服务`}
                aria-checked={server.enabled}
                checked={server.enabled}
                disabled={Boolean(busy)}
                onChange={(event) =>
                  void mutate(
                    server.id,
                    { type: 'mcp:set-enabled', id: server.id, enabled: event.target.checked },
                    'MCP 服务状态已更新。',
                  )
                }
              />
              <span className="chat-history-switch" aria-hidden />
            </label>
            <button
              type="button"
              aria-label={`刷新 ${server.name} 工具目录`}
              disabled={Boolean(busy)}
              onClick={() => {
                setExpanded(true);
                setEditId(server.id);
                setName(server.name);
                setUrl(server.url);
                setToken('');
              }}
            >
              <RefreshCw size={10} />
            </button>
            <button
              type="button"
              aria-label={`删除 ${server.name} MCP 服务`}
              disabled={Boolean(busy)}
              onClick={() =>
                void mutate(server.id, { type: 'mcp:remove', id: server.id }, 'MCP 服务已删除。')
              }
            >
              <Trash2 size={10} />
            </button>
          </article>
        ))}
      </div>
      {notice ? (
        <div className="page-origin-notice" role="status">
          {notice}
        </div>
      ) : null}
    </section>
  );
}
