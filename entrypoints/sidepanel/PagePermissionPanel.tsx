// ─── 页面权限底部暂停面板 ───
// 职责：把网站读取/操作权限请求固定在消息流底部的输入区上方，
// 与 Ask User 面板同一位置，避免权限卡片埋在上方历史消息里被忽略。
// 提交前不修改对话历史，也不触发新的任务。

import { Loader2, LockKeyhole, X } from 'lucide-react';
import { useState } from 'react';
import type { ToolActivity } from '@/lib/domain/types';

interface PagePermissionPanelProps {
  activity: ToolActivity;
  onResolve: (requestId: string, permissionPattern: string, allow: boolean) => Promise<boolean>;
  onCancel: () => void;
}

export function PagePermissionPanel({ activity, onResolve, onCancel }: PagePermissionPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const interactionPermission = activity.permissionKind === 'interact';
  const canResolve = Boolean(activity.requestId && activity.permissionPattern);

  const resolvePermission = async (allow: boolean) => {
    if (!canResolve || !activity.requestId || !activity.permissionPattern) return;
    setBusy(true);
    setError('');
    const sent = await onResolve(activity.requestId, activity.permissionPattern, allow);
    if (!sent) {
      setBusy(false);
      setError('侧边栏连接不可用，请稍后重试。');
    }
  };

  return (
    <section className="ask-user-panel" aria-label="页面权限确认">
      <div className="ask-user-head">
        <span className="ask-user-icon" aria-hidden>
          <LockKeyhole size={13} />
        </span>
        <span className="ask-user-kicker">需要你确认一件事</span>
        <span className="ask-user-paused">Agent 已暂停</span>
      </div>

      <div className="chat-permission-origin" title={activity.sourceOrigin}>
        <LockKeyhole size={11} aria-hidden />
        <span>{activity.sourceOrigin ?? '当前网站'}</span>
      </div>
      <p>
        {interactionPermission
          ? '允许后可观察并操作这个网站当前页的可见控件；提交、发送、投递、删除或支付等动作仍会单独确认，密码和文件始终不能代操作。可随时在设置中撤销。'
          : '允许后可读取这个网站的可见纯文本，并把回答所需内容发送给你当前选择的模型供应商；不会点击、输入或操作页面。可随时在设置中撤销。'}
      </p>
      <p className="ask-user-note">回答后会保留当前进度，从暂停位置继续执行。</p>

      <div className="chat-permission-actions">
        <button
          type="button"
          className="ask-user-cancel chat-permission-deny"
          disabled={busy}
          onClick={onCancel}
        >
          <X size={11} aria-hidden />
          取消任务
        </button>
        <button
          type="button"
          className="chat-permission-deny"
          disabled={!canResolve || busy}
          onClick={() => void resolvePermission(false)}
        >
          不允许
        </button>
        <button
          type="button"
          className="chat-permission-allow"
          disabled={!canResolve || busy}
          onClick={() => void resolvePermission(true)}
        >
          {busy ? <Loader2 size={11} className="animate-spin" aria-hidden /> : null}
          {interactionPermission ? '允许操作' : '允许读取'}
        </button>
      </div>
      {error ? (
        <p className="chat-permission-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
