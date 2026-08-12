import { Download, Loader2, ShieldCheck, Upload } from 'lucide-react';
import { type ChangeEvent, useRef, useState } from 'react';
import {
  backupFileName,
  createBossPilotBackup,
  importBossPilotBackup,
  serializeBossPilotBackup,
} from '@/lib/portability/backup';

const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function DataPortability() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const exportData = async () => {
    setBusy('export');
    setNotice('');
    setError('');
    try {
      const text = serializeBossPilotBackup(await createBossPilotBackup());
      downloadText(text, backupFileName());
      setNotice('备份已生成。文件不包含 API Key、MCP Token 或网站权限。');
    } catch {
      setError('备份生成失败，请稍后重试。');
    } finally {
      setBusy(null);
    }
  };

  const importData = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setNotice('');
    setError('');
    if (file.size > MAX_FILE_BYTES) {
      setError('备份文件不能超过 25 MB。');
      return;
    }
    setBusy('import');
    try {
      const result = await importBossPilotBackup(await file.text());
      setNotice(
        `已合并 ${result.conversations} 个会话、${result.messages} 条消息和 ${result.memories} 条记忆。现有数据没有被覆盖。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '备份恢复失败。');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="data-portability" aria-label="数据备份与恢复">
      <div className="settings-section-kicker">LOCAL DATA</div>
      <h2>数据备份与恢复</h2>
      <p>
        导出会话流、附件、长期指令、记忆和本地开关。恢复只合并新数据，不覆盖现有会话；密钥、MCP
        Token 和网站授权必须重新配置。
      </p>
      <div className="data-portability-note">
        <ShieldCheck size={12} /> JSON 文件可能含有你的聊天和附件，请妥善保管。
      </div>
      <div className="data-portability-actions">
        <button type="button" disabled={busy !== null} onClick={() => void exportData()}>
          {busy === 'export' ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Download size={12} />
          )}
          导出备份
        </button>
        <button type="button" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
          {busy === 'import' ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Upload size={12} />
          )}
          恢复备份
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          aria-label="选择 BossPilot 备份文件"
          onChange={(event) => void importData(event)}
        />
      </div>
      {notice ? <div className="data-portability-success">{notice}</div> : null}
      {error ? <div className="data-portability-error">{error}</div> : null}
    </section>
  );
}

function downloadText(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
