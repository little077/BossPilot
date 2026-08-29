// 麦克风授权跳板页（独立标签页）。
//
// 目的：sidepanel 等扩展页面无法弹出运行时授权弹窗（典型如麦克风
// `getUserMedia` —— 在 sidepanel 里会直接被判 `Permission dismissed`）。
// 而普通扩展标签页可以正常弹授权框，所以这里作为「授权跳板」：在标签页里
// 触发一次浏览器授权，用户允许后授权绑定到扩展 origin、全扩展通用，
// 之后 sidepanel 即可直接使用语音识别。
//
// 由 `lib/speech/mic-permission.ts` 的 `openMicPermissionPage()` 打开，
// 带 `?type=microphone` 参数。授权成功后略作停留自动关闭标签页。

import { Mic } from 'lucide-react';
import { useCallback, useState } from 'react';

type PanelState = 'idle' | 'requesting' | 'granted' | 'denied' | 'error';

const MIC_SETTINGS_URL = 'chrome://settings/content/microphone';

/** 关闭当前标签页。优先用 tabs API（本页由 chrome.tabs.create 打开，
 *  普通 `window.close()` 对这类标签页通常无效）。 */
async function closeSelfTab(): Promise<void> {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {
    /* 退回 window.close */
  }
  window.close();
}

const STYLES: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    minHeight: '100vh',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 24px',
    background: '#faf9f8',
    color: '#1c2328',
    fontFamily:
      'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  card: {
    width: '100%',
    maxWidth: 360,
    textAlign: 'center',
  },
  icon: {
    display: 'grid',
    width: 56,
    height: 56,
    margin: '0 auto 16px',
    placeItems: 'center',
    borderRadius: 16,
    background: '#eef3f5',
    color: '#315f7c',
  },
  title: { margin: 0, fontSize: 17, fontWeight: 600 },
  copy: { margin: '8px 0 20px', fontSize: 13.5, lineHeight: 1.6, color: '#5a6670' },
  button: {
    width: '100%',
    padding: '10px 0',
    border: 0,
    borderRadius: 10,
    background: '#315f7c',
    color: '#fff',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
  },
  buttonDisabled: { opacity: 0.5, cursor: 'default' },
  hint: { marginTop: 14, fontSize: 12.5, lineHeight: 1.55, color: '#5a6670' },
  success: { color: '#4a7666' },
  danger: { color: '#b3463a' },
};

export default function App() {
  const [state, setState] = useState<PanelState>('idle');

  const request = useCallback(async () => {
    setState('requesting');
    try {
      // 普通标签页可正常弹出麦克风授权框；允许后授权绑定扩展 origin。
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      setState('granted');
      // 略作停留让用户看到成功提示，再自动关闭标签页。
      setTimeout(() => void closeSelfTab(), 1_200);
    } catch {
      // 被阻止后已无法再弹框，直接打开 Chrome 设置引导手动放开。
      setState('denied');
      void chrome.tabs.create({ url: MIC_SETTINGS_URL });
    }
  }, []);

  const type = new URLSearchParams(window.location.search).get('type');

  if (type !== 'microphone') {
    return (
      <div style={STYLES.page}>
        <div style={STYLES.card}>
          <div style={{ ...STYLES.icon, color: '#b3463a' }}>
            <Mic size={24} />
          </div>
          <h1 style={STYLES.title}>未知的授权请求</h1>
          <p style={STYLES.copy}>这个页面只能用于 BossPilot 的麦克风授权，请关闭它。</p>
        </div>
      </div>
    );
  }

  return (
    <div style={STYLES.page}>
      <div style={STYLES.card}>
        <div style={STYLES.icon}>
          <Mic size={24} />
        </div>
        <h1 style={STYLES.title}>允许 BossPilot 使用麦克风</h1>
        <p style={STYLES.copy}>
          语音输入在侧边栏内使用，需要一次麦克风授权。点击下方按钮后在浏览器弹窗中选择「允许」，
          授权完成后本页会自动关闭，回到侧边栏再次点击麦克风即可开始语音输入。
        </p>
        {state === 'idle' || state === 'requesting' ? (
          <button
            type="button"
            style={{ ...STYLES.button, ...(state === 'requesting' ? STYLES.buttonDisabled : {}) }}
            disabled={state === 'requesting'}
            onClick={() => void request()}
          >
            {state === 'requesting' ? '等待授权…' : '授权麦克风'}
          </button>
        ) : state === 'granted' ? (
          <p style={{ ...STYLES.hint, ...STYLES.success }}>已授权，即将自动关闭本页。</p>
        ) : (
          <p style={{ ...STYLES.hint, ...STYLES.danger }}>
            未获得授权。已在 Chrome 设置中打开麦克风页面，请允许 BossPilot 后重试。
          </p>
        )}
      </div>
    </div>
  );
}
