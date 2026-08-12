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
import type { GenerationToolExecutionOutcome } from '@/lib/generation/types';
import {
  AGENT_PORT_NAME,
  type AgentContextCommandResponse,
  type ClientMessage,
  isAgentContextCommand,
  isClientMessage,
  isProviderCommand,
  isSkillCommand,
  type ProviderCommandResponse,
  type ServerMessage,
  type SkillCommandResponse,
} from '@/lib/ipc/protocol';
import { CHAT_SYSTEM } from '@/lib/llm/prompts';
import { buildAgentContextPrompt } from '@/lib/memory/prompt';
import { MemoryStore } from '@/lib/memory/store';
import { hasExactPageOriginAccess } from '@/lib/page/access';
import {
  claimPendingPageTurn,
  clearPendingPageTurn,
  createPendingAgentTurn,
  historyMatchesPending,
  loadPendingPageTurn,
  savePendingPageTurn,
} from '@/lib/page/pending';
import { capturePageTurnSnapshot, pageContextHistory } from '@/lib/page/snapshot';
import { orchestrator } from '@/lib/pipeline/orchestrator';
import { ProviderService } from '@/lib/providers/service';
import { buildSkillCatalogPrompt } from '@/lib/skills/prompt';
import { SkillStore } from '@/lib/skills/store';
import { createTrustedStorageGate } from '@/lib/storage/access';
import { ASK_USER_TOOL, askUser } from '@/lib/tools/ask-user';
import { BROWSER_ACTION_TOOL, executeBrowserAction } from '@/lib/tools/browser-action';
import { LOAD_SKILL_TOOL, SkillLoadCoordinator } from '@/lib/tools/load-skill';
import { MemoryToolCoordinator, SAVE_MEMORY_TOOL, SEARCH_MEMORY_TOOL } from '@/lib/tools/memory';
import {
  INTERACT_PAGE_TOOL,
  OBSERVE_PAGE_TOOL,
  OBSERVE_VISUAL_PAGE_TOOL,
  PageInteractionCoordinator,
} from '@/lib/tools/page-interaction';
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
    const skillStore = new SkillStore();
    const skillLoader = new SkillLoadCoordinator(skillStore);
    const memoryStore = new MemoryStore();
    const memoryTools = new MemoryToolCoordinator(memoryStore);
    void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const chatPorts = new Set<chrome.runtime.Port>();
    const diagnosticInputs = new Map<string, string>();
    const pageSnapshots = new Map<string, PageTurnSnapshot | null>();
    const chatHistories = new Map<string, ChatMessage[]>();
    const cancelledPendingRequests = new Set<string>();
    const approvedToolCalls = new Set<string>();
    const latestUserText = (requestId: string) => diagnosticInputs.get(requestId) ?? '';
    let activeDiagnostic: ActiveDiagnostic | null = null;

    const generationAdapter = createPiGenerationAdapter();
    const pageInteraction = new PageInteractionCoordinator();
    const titleControllers = new Map<string, { controller: AbortController; requestId: string }>();

    const generationManager = new ChatGenerationManager({
      adapter: generationAdapter,
      systemPrompt: async () => composeChatSystemPrompt(skillStore, memoryStore),
      maxOutputTokens: 8_192,
      maxAgentTurns: 200,
      maxConsecutiveIdenticalToolCalls: 3,
      tools: [
        READ_CURRENT_PAGE_TOOL,
        BROWSER_ACTION_TOOL,
        OBSERVE_PAGE_TOOL,
        OBSERVE_VISUAL_PAGE_TOOL,
        INTERACT_PAGE_TOOL,
        LOAD_SKILL_TOOL,
        SEARCH_MEMORY_TOOL,
        SAVE_MEMORY_TOOL,
        ASK_USER_TOOL,
      ],
      executeTool: async (call, signal, requestId, reportProgress, context) => {
        recorder.step('chat', 'tool', call.name);
        let result: GenerationToolExecutionOutcome;
        switch (call.name) {
          case 'browser_action':
            result = await executeBrowserAction(
              call,
              pageSnapshots.get(requestId) ?? null,
              latestUserText(requestId),
              signal,
              reportProgress,
            );
            if (!('deferred' in result) && !result.isError) {
              const nextSnapshot =
                result.nextPageSnapshot ?? (await capturePageTurnSnapshot().catch(() => null));
              pageSnapshots.set(requestId, nextSnapshot);
            }
            break;
          case 'read_current_page':
            result = await readCurrentPage(pageSnapshots.get(requestId) ?? null, signal);
            break;
          case 'observe_page':
            result = await pageInteraction.observe(
              call,
              pageSnapshots.get(requestId) ?? null,
              signal,
              requestId,
            );
            break;
          case 'observe_visual_page':
            result = await pageInteraction.observeVisual(
              call,
              pageSnapshots.get(requestId) ?? null,
              signal,
              requestId,
              approvedToolCalls.delete(call.id),
              reportProgress,
              context,
            );
            break;
          case 'interact_page':
            result = await pageInteraction.interact(
              call,
              pageSnapshots.get(requestId) ?? null,
              signal,
              requestId,
              approvedToolCalls.delete(call.id),
              reportProgress,
            );
            break;
          case 'load_skill':
            result = await skillLoader.execute(call, requestId, signal);
            break;
          case 'search_memory':
          case 'save_memory':
            result = await memoryTools.execute(call, latestUserText(requestId), signal);
            break;
          case 'ask_user':
            result = askUser(call);
            break;
          default:
            result = {
              isError: true,
              statusText: '工具禁用',
              content: `未开放${call.name}`,
            };
        }
        if ('deferred' in result) return result;
        if (result.nextPageSnapshot) {
          pageSnapshots.set(requestId, result.nextPageSnapshot);
        }
        recorder.step('chat', result.isError ? 'error' : 'tool', result.statusText, result.detail);
        return result;
      },
      onToolDeferred: async (generation, deferred) => {
        const snapshot = pageSnapshots.get(generation.requestId);
        const history = chatHistories.get(generation.requestId);
        if (!history || (deferred.kind === 'page_permission' && !snapshot)) {
          throw new GenerationError('INVALID_RESPONSE', '恢复失败，请重试', false);
        }
        await savePendingPageTurn(
          createPendingAgentTurn(generation, snapshot ?? null, history, deferred.kind),
        );
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

    chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
      if (!isSkillCommand(raw) || !isTrustedExtensionPage(sender)) return;
      void requireTrustedStorage()
        .then(() =>
          raw.type === 'skills:get'
            ? skillStore.list()
            : skillStore.setEnabled(raw.name, raw.enabled),
        )
        .then(
          (state) => sendResponse({ ok: true, state } satisfies SkillCommandResponse),
          (error: unknown) =>
            sendResponse({
              ok: false,
              error: publicOperationError(error, ''),
            } satisfies SkillCommandResponse),
        );
      return true;
    });

    chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
      if (!isAgentContextCommand(raw) || !isTrustedExtensionPage(sender)) return;
      void requireTrustedStorage()
        .then(async () => {
          switch (raw.type) {
            case 'context:get':
              return memoryStore.view();
            case 'context:save-settings':
              return memoryStore.saveSettings(raw);
            case 'context:add-memory':
              return memoryStore.add(raw.content);
            case 'context:update-memory':
              return memoryStore.update(raw.id, raw.content);
            case 'context:remove-memory':
              return memoryStore.remove(raw.id);
            case 'context:clear-memories':
              return memoryStore.clear();
          }
        })
        .then(
          (state) => sendResponse({ ok: true, state } satisfies AgentContextCommandResponse),
          (error: unknown) =>
            sendResponse({
              ok: false,
              error: publicOperationError(error, ''),
            } satisfies AgentContextCommandResponse),
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
            } else if (
              !generationManager.isRunning &&
              (pending?.status === 'awaiting_permission' || pending?.status === 'awaiting_user')
            ) {
              send({
                type: 'stream_update',
                requestId: pending.requestId,
                message: pending.generation.message,
              });
            }
            const awaitingRequestId =
              !generationManager.isRunning &&
              (pending?.status === 'awaiting_permission' || pending?.status === 'awaiting_user')
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
          case 'ask_user_result':
            await resumeAskUser(message.requestId, message.answer, message.messages);
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
      const chatSystemPrompt = await composeChatSystemPrompt(skillStore, memoryStore);
      activeDiagnostic = {
        requestId,
        messageCount: history.length + 1,
        promptChars:
          chatSystemPrompt.length +
          history.reduce((total, message) => total + message.content.length, 0),
        messages: [
          { role: 'system', content: chatSystemPrompt },
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
        const pending = await loadPendingPageTurn().catch(() => null);
        if (pending?.requestId !== requestId)
          await pageInteraction.clear(requestId).catch(() => void 0);
        if (pending?.requestId !== requestId) skillLoader.clear(requestId);
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
      if (pending.kind !== 'page_permission' || !pending.snapshot) {
        generationManager.failDeferred(
          pending.generation,
          new GenerationError(
            'INVALID_RESPONSE',
            '这次暂停不是页面授权请求，无法按页面权限恢复。',
            false,
          ),
        );
        await clearPendingPageTurn(requestId);
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
      // 先移除已经领取的旧暂停点；恢复过程中若再次暂停，会写入一个新的有效暂停点。
      await clearPendingPageTurn(requestId);
      try {
        const pendingActivity =
          pending.generation.message.toolActivities?.at(-1) ??
          pending.generation.message.toolActivity;
        const pattern = pendingActivity?.permissionPattern;
        const permissionAvailable =
          granted && Boolean(pattern) && (await hasExactPageOriginAccess(pattern ?? ''));
        if (cancelledPendingRequests.delete(requestId)) {
          generationManager.cancelDeferred(pending.generation);
          return;
        }
        const permissionKind = pendingActivity?.permissionKind ?? 'read';
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
              sourceOrigin: pendingActivity?.sourceOrigin ?? pending.snapshot.origin,
              sourceTitle: pendingActivity?.sourceTitle ?? pending.snapshot.title,
              sourceUrl: pendingActivity?.sourceUrl ?? pending.snapshot.safeUrl,
            };
        if (permissionAvailable && pending.generation.toolCall.name === 'observe_visual_page') {
          approvedToolCalls.add(pending.generation.toolCall.id);
        }
        await generationManager.resumeDeferred(
          pending.generation,
          pageContextHistory(history, pending.snapshot),
          override,
        );
      } finally {
        approvedToolCalls.delete(pending.generation.toolCall.id);
        const nextPending = await loadPendingPageTurn().catch(() => null);
        if (nextPending?.requestId !== requestId) {
          await pageInteraction.clear(requestId).catch(() => void 0);
          skillLoader.clear(requestId);
        }
        diagnosticInputs.delete(requestId);
        pageSnapshots.delete(requestId);
        chatHistories.delete(requestId);
        cancelledPendingRequests.delete(requestId);
      }
    }

    async function resumeAskUser(
      requestId: string,
      answer: string,
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
          text: '这次问题已经回答、过期或不存在，请重新发送问题。',
        });
        return;
      }
      if (pending.kind !== 'user_input') {
        generationManager.failDeferred(
          pending.generation,
          new GenerationError(
            'INVALID_RESPONSE',
            '这次暂停不是问题澄清请求，无法按用户回答恢复。',
            false,
          ),
        );
        await clearPendingPageTurn(requestId);
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
            '等待回答期间会话历史已经变化。为避免把答案接到错误的问题上，请重新发送问题。',
            false,
          ),
        );
        await clearPendingPageTurn(requestId);
        return;
      }

      const normalizedAnswer = answer.replaceAll('\u0000', '').replace(/\s+/g, ' ').trim();
      if (!normalizedAnswer) {
        // 无效回答不领取暂停点；claim 已写入 resuming，因此恢复为 awaiting_user 供用户重试。
        await savePendingPageTurn({ ...pending, status: 'awaiting_user' });
        broadcast(chatPorts, { type: 'error', requestId, text: '回答不能为空。' });
        return;
      }

      pageSnapshots.set(requestId, pending.snapshot);
      chatHistories.set(requestId, history);
      const lastUser = [...history].reverse().find((message) => message.role === 'user');
      diagnosticInputs.set(requestId, lastUser?.content ?? '');
      await clearPendingPageTurn(requestId);
      try {
        if (cancelledPendingRequests.delete(requestId)) {
          generationManager.cancelDeferred(pending.generation);
          return;
        }
        if (pending.generation.toolCall.name === 'interact_page') {
          if (normalizedAnswer === '确认执行') {
            approvedToolCalls.add(pending.generation.toolCall.id);
            await generationManager.resumeDeferred(pending.generation, history);
          } else {
            await generationManager.resumeDeferred(pending.generation, history, {
              isError: true,
              statusText: '用户未确认页面操作',
              detail: '用户选择不执行这次可能产生外部影响的页面操作。',
              content:
                '页面操作未执行：用户没有确认本次高风险动作。不要重试相同动作，除非用户重新明确要求。',
            });
          }
        } else if (pending.generation.toolCall.name === 'observe_visual_page') {
          if (normalizedAnswer === '仅本次允许') {
            approvedToolCalls.add(pending.generation.toolCall.id);
            await generationManager.resumeDeferred(pending.generation, history);
          } else {
            await generationManager.resumeDeferred(pending.generation, history, {
              isError: true,
              statusText: '用户取消视觉观察',
              detail: '没有截取或发送当前页面截图。',
              content:
                '视觉观察未执行：用户没有允许发送当前页面截图。请改用 DOM/文本工具；除非用户重新明确要求，否则不要再次请求截图。',
            });
          }
        } else {
          await generationManager.resumeDeferred(pending.generation, history, {
            isError: false,
            statusText: '已收到用户回答',
            detail: normalizedAnswer.slice(0, 240),
            content: [
              '以下是用户对刚才澄清问题的直接回答。把它作为任务约束继续执行。',
              '<user_clarification>',
              JSON.stringify({ answer: normalizedAnswer }).replaceAll('<', '\\u003c'),
              '</user_clarification>',
            ].join('\n'),
          });
        }
      } finally {
        approvedToolCalls.delete(pending.generation.toolCall.id);
        const nextPending = await loadPendingPageTurn().catch(() => null);
        if (nextPending?.requestId !== requestId) {
          await pageInteraction.clear(requestId).catch(() => void 0);
          skillLoader.clear(requestId);
        }
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
        recorder.step('chat', 'note', '用户停止。');
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

async function composeChatSystemPrompt(skillStore: SkillStore, memoryStore?: MemoryStore) {
  const [skills, context] = await Promise.all([
    skillStore.listEnabled(),
    memoryStore?.settings() ?? Promise.resolve(undefined),
  ]);
  return [
    CHAT_SYSTEM,
    buildSkillCatalogPrompt(skills),
    context ? buildAgentContextPrompt(context) : '',
  ]
    .filter(Boolean)
    .join('\n\n');
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
