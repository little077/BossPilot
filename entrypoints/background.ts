import { recorder } from '@/lib/diagnostics/recorder';
import { redact } from '@/lib/diagnostics/redaction';
import { buildDiagnosticsReport, diagnosticsFileName } from '@/lib/diagnostics/report';
import type { ChatMessage } from '@/lib/domain/chat';
import { sanitizeGenerationError } from '@/lib/generation/errors';
import { type ChatGenerationEvent, ChatGenerationManager } from '@/lib/generation/manager';
import { createPiGenerationAdapter } from '@/lib/generation/pi-adapter';
import { resolveActiveGenerationTarget } from '@/lib/generation/resolve';
import {
  AGENT_PORT_NAME,
  type ClientMessage,
  isClientMessage,
  isProviderCommand,
  type ProviderCommandResponse,
  type ServerMessage,
} from '@/lib/ipc/protocol';
import { CHAT_SYSTEM } from '@/lib/llm/prompts';
import { orchestrator } from '@/lib/pipeline/orchestrator';
import { ProviderService } from '@/lib/providers/service';
import { createTrustedStorageGate } from '@/lib/storage/access';

interface ActiveDiagnostic {
  requestId: string;
  messageCount: number;
  promptChars: number;
  startedAt: number;
  targetResolved: boolean;
}

export default defineBackground({
  type: 'module',
  main() {
    const requireTrustedStorage = createTrustedStorageGate();
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => void 0);

    const providerService = new ProviderService();
    const chatPorts = new Set<chrome.runtime.Port>();
    const diagnosticInputs = new Map<string, string>();
    const latestUserText = (requestId: string) => diagnosticInputs.get(requestId) ?? '';
    let activeDiagnostic: ActiveDiagnostic | null = null;

    const generationManager = new ChatGenerationManager({
      adapter: createPiGenerationAdapter(),
      systemPrompt: CHAT_SYSTEM,
      maxOutputTokens: 8_192,
      resolveTarget: async () => {
        await requireTrustedStorage();
        const target = await resolveActiveGenerationTarget();
        if (activeDiagnostic && !activeDiagnostic.targetResolved) {
          activeDiagnostic.targetResolved = true;
          recorder.beginRun(latestUserText(activeDiagnostic.requestId), {
            model: target.identity.modelId,
            baseUrl: target.baseUrl,
          });
        }
        return target;
      },
    });

    generationManager.subscribe((event) => {
      broadcast(chatPorts, generationEventToServerMessage(event));
      finishDiagnostics(event);
    });

    chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
      if (!isProviderCommand(raw) || !isTrustedExtensionPage(sender)) return;

      void requireTrustedStorage()
        .then(() => providerService.handle(raw))
        .then(
          (state) => {
            sendResponse({ ok: true, state } satisfies ProviderCommandResponse);
          },
          (error: unknown) => {
            const secret =
              raw.type === 'providers:connect' || raw.type === 'providers:add-manual-model'
                ? raw.apiKey
                : '';
            sendResponse({
              ok: false,
              error: publicOperationError(error, secret),
            } satisfies ProviderCommandResponse);
          },
        );
      return true;
    });

    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== AGENT_PORT_NAME || !isTrustedExtensionPage(port.sender)) return;
      chatPorts.add(port);

      const send = (message: ServerMessage) => safelyPost(port, message);
      const offSnapshot = orchestrator.onSnapshot((snapshot) =>
        send({ type: 'snapshot', snapshot }),
      );
      const offLog = orchestrator.onLog((level, text) => send({ type: 'log', level, text }));

      port.onMessage.addListener((raw: unknown) => {
        if (!isClientMessage(raw)) {
          send({ type: 'error', text: '收到无法识别的扩展消息。' });
          return;
        }
        void handleClientMessage(raw, send);
      });

      port.onDisconnect.addListener(() => {
        chatPorts.delete(port);
        offSnapshot();
        offLog();
      });

      send({ type: 'connected' });
    });

    chrome.runtime.onMessage.addListener((raw: unknown, sender) => {
      if (
        isRecord(raw) &&
        raw.type === 'zhipin_captcha_detected' &&
        isTrustedZhipinContentScript(sender)
      ) {
        orchestrator.notifyCaptchaFromContent();
      }
    });

    async function handleClientMessage(
      message: ClientMessage,
      send: (message: ServerMessage) => void,
    ): Promise<void> {
      try {
        switch (message.type) {
          case 'subscribe': {
            send({ type: 'snapshot', snapshot: orchestrator.getSnapshot() });
            const chatSnapshot = generationManager.getSnapshot();
            if (chatSnapshot) send(generationEventToServerMessage(chatSnapshot));
            send({
              type: 'chat_state',
              running: generationManager.isRunning,
              ...(generationManager.currentRequestId
                ? { requestId: generationManager.currentRequestId }
                : {}),
            });
            break;
          }
          case 'chat':
            await startChat(message.requestId, message.messages);
            break;
          case 'run_nl':
            await orchestrator.runNaturalLanguage(message.text);
            break;
          case 'run_params':
            await orchestrator.runWithParams(message.params);
            break;
          case 'parse_only': {
            const params = await orchestrator.parseOnly(message.text);
            send({ type: 'parsed', params });
            break;
          }
          case 'cancel': {
            if (message.scope !== 'task') {
              const requestId = message.requestId ?? generationManager.currentRequestId;
              if (requestId) generationManager.stop(requestId);
            }
            if (message.scope !== 'chat') orchestrator.cancel();
            break;
          }
          case 'clear_chat':
            generationManager.clearReplay();
            if (!generationManager.isRunning) recorder.clear();
            break;
          case 'resume_captcha':
            orchestrator.resumeCaptcha();
            break;
          case 'download_diagnostics':
            await downloadDiagnostics();
            break;
        }
      } catch (error) {
        send({
          type: 'error',
          text: publicOperationError(error),
          ...('requestId' in message ? { requestId: message.requestId } : {}),
        });
      }
    }

    async function startChat(requestId: string, history: ChatMessage[]): Promise<void> {
      if (generationManager.isRunning) {
        broadcast(chatPorts, {
          type: 'error',
          requestId,
          text: '当前已有回复正在生成，请先停止后再重试。',
        });
        return;
      }

      const lastUser = [...history].reverse().find((message) => message.role === 'user');
      diagnosticInputs.set(requestId, lastUser?.content ?? '');
      activeDiagnostic = {
        requestId,
        messageCount: history.length + 1,
        promptChars:
          CHAT_SYSTEM.length +
          history.reduce((total, message) => total + message.content.length, 0),
        startedAt: Date.now(),
        targetResolved: false,
      };

      try {
        await generationManager.start(requestId, history);
      } catch (error) {
        activeDiagnostic = null;
        // 解析阶段还没有 stream_start；重连窗口可能已通过 chat_state 绑定本 requestId，
        // 因此必须广播失败，不能只通知最初发起请求的 Port。
        broadcast(chatPorts, {
          type: 'error',
          requestId,
          text: sanitizeGenerationError(error).message,
        });
      } finally {
        diagnosticInputs.delete(requestId);
      }
    }

    function finishDiagnostics(event: ChatGenerationEvent): void {
      if (event.type !== 'end' && event.type !== 'error') return;
      const diagnostic = activeDiagnostic;
      if (!diagnostic || diagnostic.requestId !== event.requestId) return;

      const usage = event.message.usage;
      recorder.logLlm({
        model: event.message.modelIdentity?.modelId ?? 'unknown',
        messageCount: diagnostic.messageCount,
        promptChars: diagnostic.promptChars,
        outputChars: event.message.content.length,
        promptTokens: usage?.inputTokens,
        completionTokens: usage?.outputTokens,
        latencyMs: Date.now() - diagnostic.startedAt,
      });

      if (event.type === 'error') {
        recorder.logError(event.message.errorMessage ?? '模型请求失败。');
        recorder.finishRun('error');
      } else if (event.message.status === 'cancelled') {
        recorder.step('note', '用户停止了本轮生成。');
        recorder.finishRun('cancelled');
      } else {
        recorder.finishRun('completed');
      }
      activeDiagnostic = null;
    }

    async function downloadDiagnostics(): Promise<void> {
      const markdown = buildDiagnosticsReport(recorder.snapshotRuns());
      const dataUrl = `data:text/markdown;charset=utf-8;base64,${base64EncodeUtf8(markdown)}`;
      await chrome.downloads.download({
        url: dataUrl,
        filename: diagnosticsFileName(),
        saveAs: true,
      });
    }
  },
});

function generationEventToServerMessage(event: ChatGenerationEvent): ServerMessage {
  switch (event.type) {
    case 'start':
      return { type: 'stream_start', requestId: event.requestId, message: event.message };
    case 'update':
      return { type: 'stream_update', requestId: event.requestId, message: event.message };
    case 'end':
      return { type: 'stream_end', requestId: event.requestId, message: event.message };
    case 'error':
      return { type: 'stream_error', requestId: event.requestId, message: event.message };
  }
}

function broadcast(ports: ReadonlySet<chrome.runtime.Port>, message: ServerMessage): void {
  for (const port of ports) safelyPost(port, message);
}

function safelyPost(port: chrome.runtime.Port, message: ServerMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // A disconnected port is removed by onDisconnect; another subscriber may still be active.
  }
}

function isTrustedExtensionPage(sender: chrome.runtime.MessageSender | undefined): boolean {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (sender.url) return sender.url.startsWith(chrome.runtime.getURL(''));
  // Chrome may omit `url` for a native side panel. In that case only a sender
  // without a web tab is trusted; a content script always carries its tab.
  return !sender.tab;
}

function isTrustedZhipinContentScript(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.tab || !sender.url) return false;
  try {
    return new URL(sender.url).origin === 'https://www.zhipin.com';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publicOperationError(error: unknown, secret = ''): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const withoutExactSecret = secret ? rawMessage.split(secret).join('[REDACTED]') : rawMessage;
  return (
    redact(withoutExactSecret).replace(/\s+/g, ' ').trim().slice(0, 360) || '操作失败，请稍后重试。'
  );
}

function base64EncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
