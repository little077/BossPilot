// ─── Background Service Worker 入口 ───
// 职责：① 点击图标打开侧边栏；② Port 服务端（接收侧边栏指令、广播任务快照）；
// ③ 接收 content script 的验证码上报。业务逻辑全部在 orchestrator。

import { AGENT_PORT_NAME, type ClientMessage, type ServerMessage } from '@/lib/ipc/protocol';
import { orchestrator } from '@/lib/pipeline/orchestrator';

export default defineBackground(() => {
  // 点击工具栏图标 → 打开侧边栏
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => void 0);

  // ─── Port 服务端 ───
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== AGENT_PORT_NAME) return;

    const send = (msg: ServerMessage) => {
      try {
        port.postMessage(msg);
      } catch {
        // 端口已断开，忽略
      }
    };

    const offSnapshot = orchestrator.onSnapshot((snapshot) => send({ type: 'snapshot', snapshot }));
    const offLog = orchestrator.onLog((level, text) => send({ type: 'log', level, text }));

    port.onMessage.addListener((raw: ClientMessage) => {
      void handleMessage(raw, send);
    });

    port.onDisconnect.addListener(() => {
      offSnapshot();
      offLog();
    });

    send({ type: 'connected' });
  });

  async function handleMessage(msg: ClientMessage, send: (m: ServerMessage) => void) {
    try {
      switch (msg.type) {
        case 'subscribe':
          send({ type: 'snapshot', snapshot: orchestrator.getSnapshot() });
          break;
        case 'run_nl':
          await orchestrator.runNaturalLanguage(msg.text);
          break;
        case 'run_params':
          await orchestrator.runWithParams(msg.params);
          break;
        case 'parse_only': {
          const params = await orchestrator.parseOnly(msg.text);
          send({ type: 'parsed', params });
          break;
        }
        case 'cancel':
          orchestrator.cancel();
          break;
        case 'resume_captcha':
          orchestrator.resumeCaptcha();
          break;
        case 'download_report':
          await orchestrator.downloadReport();
          break;
      }
    } catch (e) {
      send({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }

  // ─── content script 验证码上报 ───
  chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg?.type === 'zhipin_captcha_detected') {
      orchestrator.notifyCaptchaFromContent();
    }
  });
});
