import { captureCurrentPageStructure } from '@/lib/diagnostics/page-structure';
import { recorder } from '@/lib/diagnostics/recorder';
import { redact } from '@/lib/diagnostics/redaction';
import { buildDiagnosticsReport, diagnosticsFileName } from '@/lib/diagnostics/report';
import type { ChatMessage } from '@/lib/domain/chat';
import type { PageTurnSnapshot } from '@/lib/domain/types';
import { generateConversationTitle } from '@/lib/generation/conversation-title';
import { GenerationError, sanitizeGenerationError } from '@/lib/generation/errors';
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
import { hasExactPageOriginAccess } from '@/lib/page/access';
import {
  claimPendingPageTurn,
  clearPendingPageTurn,
  createPendingPageTurn,
  historyMatchesPending,
  loadPendingPageTurn,
  savePendingPageTurn,
} from '@/lib/page/pending';
import { capturePageTurnSnapshot, pageContextHistory } from '@/lib/page/snapshot';
import { orchestrator } from '@/lib/pipeline/orchestrator';
import { ProviderService } from '@/lib/providers/service';
import { createTrustedStorageGate } from '@/lib/storage/access';
import { BROWSER_ACTION_TOOL, executeBrowserAction } from '@/lib/tools/browser-action';
import { READ_CURRENT_PAGE_TOOL, readCurrentPage } from '@/lib/tools/read-current-page';

interface ActiveDiagnostic {
  requestId: string;
  messageCount: number;
  promptChars: number;
  /** 本轮发送的完整消息（含 system prompt），供诊断日志记录原文。 */
  messages: Array<{ role: string; content: string }>;
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
    const pageSnapshots = new Map<string, PageTurnSnapshot | null>();
    const chatHistories = new Map<string, ChatMessage[]>();
    const cancelledPendingRequests = new Set<string>();
    const latestUserText = (requestId: string) => diagnosticInputs.get(requestId) ?? '';
    let activeDiagnostic: ActiveDiagnostic | null = null;

    const generationAdapter = createPiGenerationAdapter();
    const titleControllers = new Map<string, { controller: AbortController; requestId: string }>();

    const generationManager = new ChatGenerationManager({
      adapter: generationAdapter,
      systemPrompt: CHAT_SYSTEM,
      maxOutputTokens: 8_192,
      tools: [READ_CURRENT_PAGE_TOOL, BROWSER_ACTION_TOOL],
      executeTool: async (call, signal, requestId, reportProgress) => {
        recorder.step('chat', 'tool', `模型调用 ${call.name}`);
        const result =
          call.name === 'browser_action'
            ? await executeBrowserAction(
                call,
                pageSnapshots.get(requestId) ?? null,
                latestUserText(requestId),
                signal,
                reportProgress,
              )
            : await readCurrentPage(pageSnapshots.get(requestId) ?? null, signal);
        if ('deferred' in result) return result;
        recorder.step('chat', result.isError ? 'error' : 'tool', result.statusText, result.detail);
        return result;
      },
      onToolDeferred: async (generation) => {
        const snapshot = pageSnapshots.get(generation.requestId);
        const history = chatHistories.get(generation.requestId);
        if (!snapshot || !history) {
          throw new GenerationError(
            'INVALID_RESPONSE',
            '当前页面恢复点不完整，请重新发送问题。',
            false,
          );
        }
        await savePendingPageTurn(createPendingPageTurn(generation, snapshot, history));
      },
      resolveTarget: async () => {
        await requireTrustedStorage();
        const target = await resolveActiveGenerationTarget();
        if (activeDiagnostic && !activeDiagnostic.targetResolved) {
          activeDiagnostic.targetResolved = true;
          recorder.beginRun('chat', latestUserText(activeDiagnostic.requestId), {
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
            const pending = await loadPendingPageTurn();
            if (!generationManager.isRunning && pending?.status === 'resuming') {
              generationManager.failDeferred(
                pending.generation,
                new GenerationError(
                  'NETWORK_ERROR',
                  '授权后的恢复过程被浏览器中断。为避免重复请求模型或读错页面，请重新发送问题。',
                  true,
                ),
              );
              await clearPendingPageTurn(pending.requestId);
            } else if (!generationManager.isRunning && pending?.status === 'awaiting_permission') {
              send({
                type: 'stream_update',
                requestId: pending.requestId,
                message: pending.generation.message,
              });
            }
            const awaitingRequestId =
              !generationManager.isRunning && pending?.status === 'awaiting_permission'
                ? pending.requestId
                : undefined;
            send({
              type: 'chat_state',
              running: generationManager.isRunning || Boolean(awaitingRequestId),
              ...(generationManager.currentRequestId || awaitingRequestId
                ? { requestId: generationManager.currentRequestId ?? awaitingRequestId }
                : {}),
            });
            break;
          }
          case 'chat':
            await startChat(message.requestId, message.messages);
            break;
          case 'summarize_conversation':
            await summarizeConversation(
              message.requestId,
              message.conversationId,
              message.messages,
            );
            break;
          case 'page_permission_result':
            await resumePagePermission(message.requestId, message.granted, message.messages);
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
              if (requestId && !generationManager.stop(requestId)) {
                const pending = await claimPendingPageTurn(requestId);
                if (pending) {
                  await clearPendingPageTurn(requestId);
                  generationManager.cancelDeferred(pending.generation);
                } else {
                  const resuming = await loadPendingPageTurn();
                  if (resuming?.requestId === requestId && resuming.status === 'resuming') {
                    cancelledPendingRequests.add(requestId);
                  }
                }
              }
            }
            if (message.scope !== 'chat') orchestrator.cancel();
            break;
          }
          case 'clear_chat':
            generationManager.clearReplay();
            await clearPendingPageTurn();
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

    async function summarizeConversation(
      requestId: string,
      conversationId: string,
      messages: ChatMessage[],
    ): Promise<void> {
      const previous = titleControllers.get(conversationId);
      if (previous) {
        previous.controller.abort();
        broadcast(chatPorts, {
          type: 'conversation_title_error',
          requestId: previous.requestId,
          conversationId,
        });
      }
      const controller = new AbortController();
      titleControllers.set(conversationId, { controller, requestId });
      const timeout = setTimeout(() => controller.abort(), 30_000);

      try {
        await requireTrustedStorage();
        const target = await resolveActiveGenerationTarget();
        const title = await generateConversationTitle(
          generationAdapter,
          target,
          messages,
          controller.signal,
        );
        if (titleControllers.get(conversationId)?.controller !== controller) return;
        broadcast(chatPorts, { type: 'conversation_title', requestId, conversationId, title });
      } catch {
        if (titleControllers.get(conversationId)?.controller !== controller) return;
        // 标题是非关键增强；失败时保留本地的「历史记录 N」，不污染主对话。
        broadcast(chatPorts, { type: 'conversation_title_error', requestId, conversationId });
      } finally {
        clearTimeout(timeout);
        if (titleControllers.get(conversationId)?.controller === controller) {
          titleControllers.delete(conversationId);
        }
      }
    }

    async function startChat(requestId: string, history: ChatMessage[]): Promise<void> {
      if (generationManager.isRunning || (await loadPendingPageTurn())) {
        broadcast(chatPorts, {
          type: 'error',
          requestId,
          text: '当前已有回复正在生成，请先停止后再重试。',
        });
        return;
      }

      const snapshot = await capturePageTurnSnapshot().catch(() => null);
      pageSnapshots.set(requestId, snapshot);
      chatHistories.set(requestId, history);

      const lastUser = [...history].reverse().find((message) => message.role === 'user');
      diagnosticInputs.set(requestId, lastUser?.content ?? '');
      activeDiagnostic = {
        requestId,
        messageCount: history.length + 1,
        promptChars:
          CHAT_SYSTEM.length +
          history.reduce((total, message) => total + message.content.length, 0),
        messages: [
          { role: 'system', content: CHAT_SYSTEM },
          ...history.map((message) => ({ role: message.role, content: message.content })),
        ],
        startedAt: Date.now(),
        targetResolved: false,
      };

      try {
        await generationManager.start(requestId, pageContextHistory(history, snapshot));
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
        pageSnapshots.delete(requestId);
        chatHistories.delete(requestId);
      }
    }

    async function resumePagePermission(
      requestId: string,
      granted: boolean,
      messages: ChatMessage[],
    ): Promise<void> {
      const pending = await claimPendingPageTurn(requestId);
      if (!pending) {
        const current = await loadPendingPageTurn();
        const replay = generationManager.getSnapshot();
        if (
          (current?.requestId === requestId && current.status === 'resuming') ||
          generationManager.currentRequestId === requestId ||
          (replay?.requestId === requestId && replay.message.status !== 'streaming')
        ) {
          return;
        }
        broadcast(chatPorts, {
          type: 'error',
          requestId,
          text: '这次页面授权已经处理、过期或不存在，请重新发送问题。',
        });
        return;
      }

      const history = messages.filter((message) => message.id !== pending.generation.message.id);
      if (cancelledPendingRequests.delete(requestId)) {
        generationManager.cancelDeferred(pending.generation);
        await clearPendingPageTurn(requestId);
        return;
      }
      if (!historyMatchesPending(pending, history)) {
        generationManager.failDeferred(
          pending.generation,
          new GenerationError(
            'INVALID_RESPONSE',
            '等待授权期间会话历史已经变化。为避免把页面内容接到错误的问题上，请重新发送问题。',
            false,
          ),
        );
        await clearPendingPageTurn(requestId);
        return;
      }

      pageSnapshots.set(requestId, pending.snapshot);
      chatHistories.set(requestId, history);
      const lastUser = [...history].reverse().find((message) => message.role === 'user');
      diagnosticInputs.set(requestId, lastUser?.content ?? '');
      try {
        const pattern = pending.generation.message.toolActivity?.permissionPattern;
        const permissionAvailable =
          granted && Boolean(pattern) && (await hasExactPageOriginAccess(pattern ?? ''));
        if (cancelledPendingRequests.delete(requestId)) {
          generationManager.cancelDeferred(pending.generation);
          return;
        }
        const permissionKind = pending.generation.message.toolActivity?.permissionKind ?? 'read';
        const override = permissionAvailable
          ? undefined
          : {
              isError: true,
              errorCode: 'permission_denied' as const,
              statusText:
                permissionKind === 'interact' ? '未授权操作目标网站' : '未授权读取当前网站',
              detail:
                permissionKind === 'interact'
                  ? '用户或 Chrome 没有授予目标网站的页面操作权限。'
                  : '用户或 Chrome 没有授予当前网站的页面读取权限。',
              content:
                permissionKind === 'interact'
                  ? '浏览器工具失败（permission_denied）：用户或 Chrome 没有授予目标网站的页面操作权限。'
                  : '工具读取失败（permission_denied）：用户或 Chrome 没有授予当前网站的页面读取权限。',
              sourceOrigin:
                pending.generation.message.toolActivity?.sourceOrigin ?? pending.snapshot.origin,
              sourceTitle:
                pending.generation.message.toolActivity?.sourceTitle ?? pending.snapshot.title,
              sourceUrl:
                pending.generation.message.toolActivity?.sourceUrl ?? pending.snapshot.safeUrl,
            };
        await generationManager.resumeDeferred(
          pending.generation,
          pageContextHistory(history, pending.snapshot),
          override,
        );
      } finally {
        await clearPendingPageTurn(requestId);
        diagnosticInputs.delete(requestId);
        pageSnapshots.delete(requestId);
        chatHistories.delete(requestId);
        cancelledPendingRequests.delete(requestId);
      }
    }

    function finishDiagnostics(event: ChatGenerationEvent): void {
      if (event.type !== 'end' && event.type !== 'error') return;
      const diagnostic = activeDiagnostic;
      if (!diagnostic || diagnostic.requestId !== event.requestId) return;

      const usage = event.message.usage;
      recorder.logLlm('chat', {
        model: event.message.modelIdentity?.modelId ?? 'unknown',
        purpose: '对话',
        messageCount: diagnostic.messageCount,
        promptChars: diagnostic.promptChars,
        outputChars: event.message.content.length,
        messages: diagnostic.messages,
        outputText: event.message.content,
        promptTokens: usage?.inputTokens,
        completionTokens: usage?.outputTokens,
        latencyMs: Date.now() - diagnostic.startedAt,
      });

      if (event.type === 'error') {
        recorder.logError('chat', event.message.errorMessage ?? '模型请求失败。');
        recorder.finishRun('chat', 'error');
      } else if (event.message.status === 'cancelled') {
        recorder.step('chat', 'note', '用户停止了本轮生成。');
        recorder.finishRun('chat', 'cancelled');
      } else {
        recorder.finishRun('chat', 'completed');
      }
      activeDiagnostic = null;
    }

    async function downloadDiagnostics(): Promise<void> {
      const pageStructure = await captureCurrentPageStructure();
      const markdown = buildDiagnosticsReport(recorder.snapshotRuns(), pageStructure);
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
