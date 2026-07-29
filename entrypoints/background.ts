// ─── Background Service Worker 入口 ───
// 职责：① 点击图标打开侧边栏；② Port 服务端（接收侧边栏指令、广播任务快照/流式对话）；
// ③ 接收 content script 的验证码上报。搜索采集业务逻辑在 orchestrator；
// 流式对话在本文件内直接编排（无状态：会话历史由侧边栏持有并随消息带上）。

import { recorder } from '@/lib/diagnostics/recorder';
import { buildDiagnosticsReport, diagnosticsFileName } from '@/lib/diagnostics/report';
import type { ChatMessage } from '@/lib/domain/chat';
import { AGENT_PORT_NAME, type ClientMessage, type ServerMessage } from '@/lib/ipc/protocol';
import { chatStream, LlmError } from '@/lib/llm/client';
import { CHAT_SYSTEM } from '@/lib/llm/prompts';
import { orchestrator } from '@/lib/pipeline/orchestrator';
import { getLlmConfig } from '@/lib/storage/config';

export default defineBackground(() => {
  // 点击工具栏图标 → 打开侧边栏
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => void 0);

  // 当前流式对话的中止控制器（单例：同一时刻只跑一轮对话）。
  let chatAbort: AbortController | null = null;

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
        case 'chat':
          await runChat(msg.messages, send);
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
          chatAbort?.abort();
          orchestrator.cancel();
          break;
        case 'resume_captcha':
          orchestrator.resumeCaptcha();
          break;
        case 'download_diagnostics':
          await downloadDiagnostics();
          break;
      }
    } catch (e) {
      send({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }

  // ─── 流式对话 ───
  async function runChat(history: ChatMessage[], send: (m: ServerMessage) => void) {
    const messageId = `asst-${Date.now().toString(36)}`;
    const config = await getLlmConfig();
    const lastUser = [...history].reverse().find((m) => m.role === 'user');

    recorder.beginRun(lastUser?.content ?? '', config);
    send({ type: 'stream_start', messageId });

    // 组装发给模型的消息：系统提示 + 历史（仅取 role/content）。
    const payload = [
      { role: 'system' as const, content: CHAT_SYSTEM },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];
    const promptChars = payload.reduce((n, m) => n + m.content.length, 0);

    chatAbort = new AbortController();
    const startedAt = Date.now();
    let content = '';
    try {
      const result = await chatStream(config, payload, {
        signal: chatAbort.signal,
        onDelta: (delta) => {
          content += delta;
          send({ type: 'stream_delta', messageId, delta });
        },
      });
      recorder.logLlm({
        model: config.model,
        messageCount: payload.length,
        promptChars,
        outputChars: result.content.length,
        promptTokens: result.usage?.promptTokens,
        completionTokens: result.usage?.completionTokens,
        latencyMs: Date.now() - startedAt,
      });
      recorder.finishRun('completed');
      send({ type: 'stream_end', messageId, content: result.content });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        recorder.step('note', '用户取消了对话');
        recorder.finishRun('cancelled');
        // 保留已产出的部分内容作为定稿
        send({ type: 'stream_end', messageId, content });
      } else {
        const text = e instanceof LlmError || e instanceof Error ? e.message : String(e);
        recorder.logError(text);
        recorder.finishRun('error');
        send({ type: 'stream_error', messageId, text });
      }
    } finally {
      chatAbort = null;
    }
  }

  // ─── 执行日志下载 ───
  async function downloadDiagnostics() {
    const md = buildDiagnosticsReport(recorder.snapshotRuns());
    const dataUrl = `data:text/markdown;charset=utf-8;base64,${base64EncodeUtf8(md)}`;
    await chrome.downloads.download({
      url: dataUrl,
      filename: diagnosticsFileName(),
      saveAs: true,
    });
  }

  // ─── content script 验证码上报 ───
  chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg?.type === 'zhipin_captcha_detected') {
      orchestrator.notifyCaptchaFromContent();
    }
  });
});

/** UTF-8 安全的 base64 编码（btoa 只支持 Latin-1）。 */
function base64EncodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
