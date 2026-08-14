import { Copy, Download, File, Folder, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { WorkspaceStore } from '@/lib/workspace/storage';
import type { WorkspaceEntry, WorkspaceFileView } from '@/lib/workspace/types';

const store = new WorkspaceStore();

interface WorkspaceViewProps {
  conversationId: string | null;
}

export function WorkspaceView({ conversationId }: WorkspaceViewProps) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [selected, setSelected] = useState<WorkspaceFileView | null>(null);
  const [versionCount, setVersionCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setEntries([]);
      setSelected(null);
      return;
    }
    setLoading(true);
    try {
      const view = await store.list(conversationId);
      setEntries(view.entries);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取会话产物失败。');
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = async (entry: WorkspaceEntry) => {
    if (!conversationId || entry.kind !== 'file') return;
    setLoading(true);
    try {
      const [file, versions] = await Promise.all([
        store.read(conversationId, entry.path),
        store.versions(conversationId, entry.path),
      ]);
      setSelected(file);
      setVersionCount(versions.length);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '预览文件失败。');
    } finally {
      setLoading(false);
    }
  };

  const download = async (entry: WorkspaceEntry) => {
    if (!conversationId || entry.kind !== 'file') return;
    try {
      const file = await store.readBlob(conversationId, entry.path);
      const url = URL.createObjectURL(file.data);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = entry.name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '下载文件失败。');
    }
  };

  const remove = async (entry: WorkspaceEntry) => {
    if (!conversationId || !window.confirm(`确定删除 ${entry.path} 吗？此操作不会影响聊天记录。`))
      return;
    try {
      await store.delete(conversationId, entry.path);
      if (selected?.path === entry.path) setSelected(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除文件失败。');
    }
  };

  const copyPreview = async () => {
    if (selected?.content === undefined) return;
    try {
      await navigator.clipboard.writeText(selected.content);
      setError('');
    } catch {
      setError('复制失败，请手动选择预览内容。');
    }
  };

  if (!conversationId) {
    return (
      <div className="p-4 text-xs text-ink-faint">先创建或打开一个会话，再查看该会话的产物。</div>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="会话产物">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <div>
          <h2 className="text-xs font-semibold text-ink">会话产物</h2>
          <p className="mt-0.5 text-[10px] text-ink-faint">仅保存在当前会话的本机工作区</p>
        </div>
        <button
          type="button"
          className="rounded-md p-1.5 text-ink-muted hover:bg-muted"
          onClick={() => void refresh()}
          aria-label="刷新产物"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>
      {error ? (
        <div className="m-3 rounded-lg border border-danger/20 bg-danger/5 p-2 text-[11px] text-danger">
          {error}
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(140px,0.8fr)_minmax(0,1.2fr)]">
        <div className="overflow-y-auto border-r border-line p-2">
          {loading && entries.length === 0 ? (
            <Loader2 size={14} className="m-2 animate-spin text-brand" />
          ) : null}
          {!loading && entries.length === 0 ? (
            <p className="p-2 text-[11px] leading-5 text-ink-faint">
              暂无产物。可以告诉 Agent：“把当前页面保存为 /reports/summary.md”。
            </p>
          ) : null}
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="group mb-1 flex items-center gap-1 rounded-lg border border-transparent px-1.5 py-1 hover:border-line hover:bg-muted/40"
            >
              <button
                type="button"
                onClick={() => void open(entry)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                disabled={entry.kind !== 'file'}
              >
                {entry.kind === 'directory' ? (
                  <Folder size={12} className="shrink-0 text-brand" />
                ) : (
                  <File size={12} className="shrink-0 text-ink-muted" />
                )}
                <span className="min-w-0 truncate text-[11px] text-ink" title={entry.path}>
                  {entry.path}
                </span>
              </button>
              {entry.kind === 'file' ? (
                <button
                  type="button"
                  onClick={() => void download(entry)}
                  className="p-1 text-ink-faint hover:text-brand"
                  aria-label={`下载 ${entry.name}`}
                >
                  <Download size={11} />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void remove(entry)}
                className="p-1 text-ink-faint hover:text-danger"
                aria-label={`删除 ${entry.name}`}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
        <div className="min-w-0 overflow-auto p-3">
          {!selected ? (
            <p className="text-[11px] text-ink-faint">
              选择文件查看预览。Markdown、JSON、文本和图片支持本地预览。
            </p>
          ) : (
            <article>
              <div className="mb-2 border-b border-line pb-2">
                <div className="flex items-start justify-between gap-2">
                  <strong className="block break-all text-xs text-ink">{selected.path}</strong>
                  {selected.content !== undefined ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-md p-1 text-ink-faint hover:bg-muted hover:text-brand"
                      onClick={() => void copyPreview()}
                      aria-label="复制文件内容"
                    >
                      <Copy size={11} />
                    </button>
                  ) : null}
                </div>
                <span className="text-[10px] text-ink-faint">
                  {selected.mimeType} · {formatBytes(selected.size)} · v{selected.version}
                  {versionCount > 0 ? ` · ${versionCount} 个历史版本` : ''}
                </span>
              </div>
              {selected.dataUrl ? (
                <img
                  src={selected.dataUrl}
                  alt={selected.name}
                  className="max-w-full rounded-lg border border-line"
                />
              ) : null}
              {selected.content !== undefined ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-ink">
                  {selected.content}
                </pre>
              ) : null}
              {!selected.dataUrl && selected.content === undefined ? (
                <p className="text-[11px] text-ink-faint">此文件不支持内嵌预览，请下载后查看。</p>
              ) : null}
            </article>
          )}
        </div>
      </div>
    </section>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
