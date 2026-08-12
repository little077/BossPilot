import { Brain, Loader2, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { sendAgentContextCommand } from '@/lib/memory/client';
import type { AgentContextView, MemoryEntry } from '@/lib/memory/types';

export function AgentContextSettings() {
  const [view, setView] = useState<AgentContextView | null>(null);
  const [instructions, setInstructions] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<MemoryEntry>();
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void sendAgentContextCommand({ type: 'context:get' }).then(
      (next) => {
        if (!active) return;
        setView(next);
        setInstructions(next.settings.instructions);
      },
      () => {
        if (active) setNotice('用户指令与记忆读取失败，请重新打开设置。');
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const run = async (key: string, operation: () => Promise<AgentContextView>, success: string) => {
    setBusy(key);
    setNotice('');
    try {
      const next = await operation();
      setView(next);
      setInstructions(next.settings.instructions);
      setNotice(success);
      return true;
    } catch {
      setNotice('保存失败，请稍后重试。');
      return false;
    } finally {
      setBusy('');
    }
  };

  const saveSettings = (memoryEnabled = view?.settings.memoryEnabled ?? false) =>
    run(
      'settings',
      () =>
        sendAgentContextCommand({
          type: 'context:save-settings',
          instructions,
          memoryEnabled,
        }),
      memoryEnabled ? '用户指令已保存，长期记忆已开启。' : '用户指令已保存。',
    );

  const addMemory = async () => {
    if (!draft.trim()) return;
    const saved = await run(
      'add',
      () => sendAgentContextCommand({ type: 'context:add-memory', content: draft }),
      '已添加一条本地记忆。',
    );
    if (saved) setDraft('');
  };

  return (
    <section className="agent-context-settings" aria-labelledby="agent-context-title">
      <div className="provider-section-title">
        <h2 id="agent-context-title">用户上下文</h2>
        <span>本机可见、可编辑</span>
      </div>
      <label className="agent-instructions-label" htmlFor="agent-instructions">
        长期用户指令
      </label>
      <textarea
        id="agent-instructions"
        value={instructions}
        maxLength={4_000}
        disabled={!view || busy === 'settings'}
        placeholder="例如：优先用中文回答；比较岗位时先看技术成长，再看薪资。"
        onChange={(event) => setInstructions(event.target.value)}
      />
      <div className="agent-context-actions">
        <small>{instructions.length}/4000 · 每轮都随系统指令发送给当前模型</small>
        <button
          type="button"
          className="agent-context-save"
          disabled={!view || Boolean(busy)}
          onClick={() => void saveSettings()}
        >
          {busy === 'settings' ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Save size={11} />
          )}
          保存指令
        </button>
      </div>

      <label className="chat-history-toggle agent-memory-toggle">
        <span className="chat-history-toggle-icon" aria-hidden>
          <Brain size={12} />
        </span>
        <span className="chat-history-toggle-copy">
          <strong>本地长期记忆</strong>
          <span>默认关闭。只保存你明确要求记住的非敏感偏好；不会自动收集网页内容。</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label="本地长期记忆"
          aria-checked={view?.settings.memoryEnabled ?? false}
          checked={view?.settings.memoryEnabled ?? false}
          disabled={!view || Boolean(busy)}
          onChange={(event) => void saveSettings(event.target.checked)}
        />
        <span className="chat-history-switch" aria-hidden />
      </label>

      {view?.settings.memoryEnabled ? (
        <>
          <div className="agent-memory-add">
            <input
              type="text"
              value={draft}
              maxLength={500}
              aria-label="添加本地记忆"
              placeholder="手动添加一条长期偏好"
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="button"
              aria-label="保存本地记忆"
              disabled={!draft.trim() || Boolean(busy)}
              onClick={() => void addMemory()}
            >
              {busy === 'add' ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            </button>
          </div>
          <ul className="agent-memory-list" aria-label="本地记忆列表">
            {view.memories.length ? (
              view.memories.map((memory) => (
                <li key={memory.id} className="agent-memory-card">
                  {editing?.id === memory.id ? (
                    <input
                      type="text"
                      maxLength={500}
                      aria-label={`编辑记忆 ${memory.content}`}
                      value={editing.content}
                      onChange={(event) => setEditing({ ...editing, content: event.target.value })}
                    />
                  ) : (
                    <span>{memory.content}</span>
                  )}
                  <div>
                    {editing?.id === memory.id ? (
                      <>
                        <button
                          type="button"
                          aria-label="保存编辑后的记忆"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void run(
                              memory.id,
                              () =>
                                sendAgentContextCommand({
                                  type: 'context:update-memory',
                                  id: memory.id,
                                  content: editing.content,
                                }),
                              '记忆已更新。',
                            ).then((saved) => saved && setEditing(undefined))
                          }
                        >
                          <Save size={10} />
                        </button>
                        <button
                          type="button"
                          aria-label="取消编辑记忆"
                          onClick={() => setEditing(undefined)}
                        >
                          <X size={10} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-label={`编辑记忆 ${memory.content}`}
                          onClick={() => setEditing(memory)}
                        >
                          <Pencil size={10} />
                        </button>
                        <button
                          type="button"
                          aria-label={`删除记忆 ${memory.content}`}
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void run(
                              memory.id,
                              () =>
                                sendAgentContextCommand({
                                  type: 'context:remove-memory',
                                  id: memory.id,
                                }),
                              '记忆已删除。',
                            )
                          }
                        >
                          <Trash2 size={10} />
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))
            ) : (
              <div className="page-origin-empty">尚未保存长期记忆</div>
            )}
          </ul>
          {view.memories.length ? (
            <button
              type="button"
              className="agent-memory-clear"
              disabled={Boolean(busy)}
              onClick={() =>
                void run(
                  'clear',
                  () => sendAgentContextCommand({ type: 'context:clear-memories' }),
                  '全部本地记忆已清除。',
                )
              }
            >
              <Trash2 size={10} /> 清空全部记忆
            </button>
          ) : null}
        </>
      ) : null}
      {notice ? (
        <div className="page-origin-notice" role="status">
          {notice}
        </div>
      ) : null}
    </section>
  );
}
