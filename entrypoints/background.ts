import { AgentManager } from '@/lib/agent/agent-manager';
import { ConversationAgent } from '@/lib/agent/conversation-agent';
import { toolContextManager } from '@/lib/agent/tool-context';
import { captureCurrentPageStructure } from '@/lib/diagnostics/page-structure';
import { recorder } from '@/lib/diagnostics/recorder';
import { redact } from '@/lib/diagnostics/redaction';
import { buildDiagnosticsReport, diagnosticsFileName } from '@/lib/diagnostics/report';
import type { ChatMessage } from '@/lib/domain/chat';
import { compactGenerationContext } from '@/lib/generation/compaction';
import { generateConversationTitle } from '@/lib/generation/conversation-title';
import { GenerationError, sanitizeGenerationError } from '@/lib/generation/errors';
import { type ChatGenerationEvent, ChatGenerationManager } from '@/lib/generation/manager';
import { createPiGenerationAdapter } from '@/lib/generation/pi-adapter';
import { AgentRunRegistry, createChromeRunRegistryStore } from '@/lib/generation/registry';
import { resolveActiveGenerationTarget, resolveGenerationTarget } from '@/lib/generation/resolve';
import type {
  GenerationToolExecutionOutcome,
  GenerationToolExecutionResult,
} from '@/lib/generation/types';
import {
  AGENT_PORT_NAME,
  type AgentContextCommandResponse,
  type ClientMessage,
  isAgentContextCommand,
  isClientMessage,
  isMcpCommand,
  isProviderCommand,
  isSkillCommand,
  type McpCommandResponse,
  type ProviderCommandResponse,
  type ServerMessage,
  type SkillCommandResponse,
} from '@/lib/ipc/protocol';
import { CHAT_SYSTEM } from '@/lib/llm/prompts';
import { isMcpToolName, McpService } from '@/lib/mcp/service';
import { buildAgentContextPrompt } from '@/lib/memory/prompt';
import { MemoryStore } from '@/lib/memory/store';
import { hasExactPageOriginAccess } from '@/lib/page/access';
import {
  claimPendingPageTurn,
  clearPendingPageTurn,
  createPendingAgentTurn,
  historyMatchesPending,
  listPendingPageTurns,
  loadPendingPageTurn,
  savePendingPageTurn,
} from '@/lib/page/pending';
import { capturePageTurnSnapshot, pageContextHistory } from '@/lib/page/snapshot';
import { orchestrator } from '@/lib/pipeline/orchestrator';
import { ProviderService } from '@/lib/providers/service';
import { skillAppliesToUrl } from '@/lib/skills/origin';
import {
  exportAllSkillArchives,
  exportSkillArchive,
  importSkillArchive,
} from '@/lib/skills/package';
import { buildSkillCatalogPrompt } from '@/lib/skills/prompt';
import { SkillSandboxRunner } from '@/lib/skills/sandbox';
import { SkillStore } from '@/lib/skills/store';
import type { SkillPackage } from '@/lib/skills/types';
import { createTrustedStorageGate } from '@/lib/storage/access';
import {
  loadConversationRuntimeSettings,
  saveConversationRuntimeSettings,
  saveRunCheckpoint,
} from '@/lib/storage/db';
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
import { RUN_SKILL_TOOL, SkillRunCoordinator } from '@/lib/tools/run-skill';
import { WORKSPACE_TOOLS, WorkspaceToolCoordinator } from '@/lib/tools/workspace';

function base64ToBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export default defineBackground({
  type: 'module',
  main() {
    const requireTrustedStorage = createTrustedStorageGate();
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => void 0);

    const providerService = new ProviderService();
    const skillStore = new SkillStore();
    const skillLoader = new SkillLoadCoordinator(skillStore);
    const skillSandbox = new SkillSandboxRunner();
    const skillRunner = new SkillRunCoordinator(skillStore, skillSandbox);
    const memoryStore = new MemoryStore();
    const memoryTools = new MemoryToolCoordinator(memoryStore);
    const workspaceTools = new WorkspaceToolCoordinator();
    const mcpService = new McpService();
    void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const chatPorts = new Set<chrome.runtime.Port>();

    const generationAdapter = createPiGenerationAdapter();
    const pageInteraction = new PageInteractionCoordinator();
    const titleControllers = new Map<string, { controller: AbortController; requestId: string }>();

    const runRegistry = new AgentRunRegistry(
      (conversationId, publish) => {
        // 每个会话独立的工具上下文
        const toolContext = toolContextManager.getOrCreate(conversationId);

        const generationManager = new ChatGenerationManager({
          adapter: generationAdapter,
          systemPrompt: async () =>
            composeChatSystemPrompt(skillStore, memoryStore, toolContext.getPageSnapshot()?.url),
          maxOutputTokens: 8_192,
          generationSettings: async () => {
            const settings = await loadConversationRuntimeSettings(conversationId);
            return settings
              ? {
                  maxOutputTokens: settings.maxOutputTokens,
                  thinkingLevel: settings.thinkingLevel,
                }
              : {};
          },
          maxAgentTurns: 200,
          maxConsecutiveIdenticalToolCalls: 3,
          contextWindowTokens: 128_000,
          compactionThreshold: 0.8,
          compactMessages: (target, messages, signal) =>
            compactGenerationContext(generationAdapter, target, messages, signal),
          tools: async () => [
            READ_CURRENT_PAGE_TOOL,
            BROWSER_ACTION_TOOL,
            OBSERVE_PAGE_TOOL,
            OBSERVE_VISUAL_PAGE_TOOL,
            INTERACT_PAGE_TOOL,
            LOAD_SKILL_TOOL,
            RUN_SKILL_TOOL,
            SEARCH_MEMORY_TOOL,
            SAVE_MEMORY_TOOL,
            ...WORKSPACE_TOOLS,
            ...(await mcpService.generationTools()),
            ASK_USER_TOOL,
          ],
          executeTool: async (call, signal, requestId, reportProgress, context) => {
            recorder.step('chat', 'tool', call.name);
            let result: GenerationToolExecutionOutcome;
            switch (call.name) {
              case 'browser_action':
                result = await executeBrowserAction(
                  call,
                  toolContext.getPageSnapshot(),
                  toolContext.getLatestUserText(),
                  signal,
                  reportProgress,
                );
                if (!('deferred' in result) && !result.isError) {
                  const nextSnapshot =
                    result.nextPageSnapshot ?? (await capturePageTurnSnapshot().catch(() => null));
                  toolContext.setPageSnapshot(nextSnapshot);
                }
                break;
              case 'read_current_page':
                result = await readCurrentPage(toolContext.getPageSnapshot(), signal);
                break;
              case 'observe_page':
                result = await pageInteraction.observe(
                  call,
                  toolContext.getPageSnapshot(),
                  signal,
                  requestId,
                );
                break;
              case 'observe_visual_page':
                result = await pageInteraction.observeVisual(
                  call,
                  toolContext.getPageSnapshot(),
                  signal,
                  requestId,
                  toolContext.revokeToolCallApproval(call.id),
                  reportProgress,
                  context,
                );
                break;
              case 'interact_page':
                result = await pageInteraction.interact(
                  call,
                  toolContext.getPageSnapshot(),
                  signal,
                  requestId,
                  toolContext.revokeToolCallApproval(call.id),
                  reportProgress,
                );
                break;
              case 'load_skill':
                result = await skillLoader.execute(
                  call,
                  requestId,
                  signal,
                  toolContext.getPageSnapshot()?.url,
                );
                break;
              case 'run_skill':
                result = await skillRunner.execute(
                  call,
                  conversationId,
                  toolContext.getSkillApproval(call.id) ?? null,
                  signal,
                );
                toolContext.deleteSkillApproval(call.id);
                break;
              case 'search_memory':
              case 'save_memory':
                result = await memoryTools.execute(call, toolContext.getLatestUserText(), signal);
                break;
              case 'workspace_create':
              case 'workspace_mkdir':
              case 'workspace_read':
              case 'workspace_edit':
              case 'workspace_rename':
              case 'workspace_delete':
              case 'workspace_list':
              case 'workspace_search':
              case 'workspace_save_url':
                result = await workspaceTools.execute(
                  call,
                  conversationId,
                  toolContext.revokeToolCallApproval(call.id),
                  signal,
                );
                break;
              case 'ask_user':
                result = askUser(call);
                break;
              default:
                result = isMcpToolName(call.name)
                  ? await mcpService.execute(
                      call,
                      toolContext.revokeToolCallApproval(call.id),
                      signal,
                    )
                  : {
                      isError: true,
                      statusText: '工具禁用',
                      content: `未开放${call.name}`,
                    };
            }
            if ('deferred' in result) return result;
            if (result.nextPageSnapshot) {
              toolContext.setPageSnapshot(result.nextPageSnapshot);
            }
            recorder.step(
              'chat',
              result.isError ? 'error' : 'tool',
              result.statusText,
              result.detail,
            );
            return result;
          },
          onToolDeferred: async (generation, deferred) => {
            const snapshot = toolContext.getPageSnapshot();
            const history = toolContext.getChatHistory();
            if (!history.length || (deferred.kind === 'page_permission' && !snapshot)) {
              throw new GenerationError('INVALID_RESPONSE', '恢复失败，请重试', false);
            }
            await savePendingPageTurn(
              createPendingAgentTurn(
                generation,
                snapshot ?? null,
                history,
                deferred.kind,
                Date.now(),
                conversationId,
              ),
            );
          },
          onModelRound: (round) => {
            const diagnostic = toolContext.getDiagnostic(round.requestId);
            if (!diagnostic) return;
            diagnostic.modelRounds += 1;
            const messages = [
              { role: 'system', content: round.systemPrompt },
              ...round.messages.map((message) => ({
                role: message.role,
                content: message.content,
              })),
            ];
            recorder.logLlm('chat', {
              model: round.modelId,
              purpose: `对话 · 回合 ${diagnostic.modelRounds}`,
              messageCount: messages.length,
              promptChars: messages.reduce((total, message) => total + message.content.length, 0),
              outputChars: round.outputText.length,
              messages,
              outputText: round.outputText,
              promptTokens: round.usage.inputTokens,
              completionTokens: round.usage.outputTokens,
              latencyMs: round.latencyMs,
              finishReason: round.finishReason,
              ...(round.toolName ? { toolName: round.toolName } : {}),
            });
          },
          resolveTarget: async () => {
            await requireTrustedStorage();
            const target = await resolveActiveGenerationTarget();
            const activeDiagnostic = toolContext.findDiagnosticByConversation(conversationId);
            if (activeDiagnostic) {
              activeDiagnostic.targetResolved = true;
              recorder.beginRun('chat', toolContext.getLatestUserText(), {
                model: target.identity.modelId,
                baseUrl: target.baseUrl,
              });
            }
            return target;
          },
        });
        generationManager.subscribe((event) => {
          publish(event);
          broadcast(chatPorts, generationEventToServerMessage(event, conversationId));
          finishDiagnostics(event, conversationId);
          if (event.type === 'end' || event.type === 'error') {
            const historyMessageIds = toolContext.getChatHistory().map(({ id }) => id);
            void saveRunCheckpoint({
              id: `checkpoint-${crypto.randomUUID()}`,
              runId: event.requestId,
              conversationId,
              historyMessageIds,
              phase:
                event.message.status === 'cancelled'
                  ? 'interrupted'
                  : event.type === 'error'
                    ? 'interrupted'
                    : 'stable',
              createdAt: Date.now(),
            }).catch(() => void 0);
          }
          if (event.type === 'start' && event.message.modelIdentity) {
            void loadConversationRuntimeSettings(conversationId)
              .then(async (settings) => {
                if (!settings) {
                  await saveConversationRuntimeSettings({
                    conversationId,
                    modelIdentity: event.message.modelIdentity,
                    thinkingLevel: 'off',
                    contextWindowTokens: 128_000,
                    maxOutputTokens: 8_192,
                    updatedAt: Date.now(),
                  });
                }
              })
              .catch(() => void 0);
          }
        });

        // 注册会话级 Agent 实例
        const agent = new ConversationAgent({
          conversationId,
          toolContext,
          createManager: () => generationManager,
          broadcast: (event, convId) =>
            broadcast(chatPorts, generationEventToServerMessage(event, convId)),
          finishDiagnostics: (event, convId) => finishDiagnostics(event, convId),
          saveCheckpoint: (event, convId, historyIds) => {
            void saveRunCheckpoint({
              id: `checkpoint-${crypto.randomUUID()}`,
              runId: event.requestId,
              conversationId: convId,
              historyMessageIds: historyIds,
              phase:
                event.message.status === 'cancelled'
                  ? 'interrupted'
                  : event.type === 'error'
                    ? 'interrupted'
                    : 'stable',
              createdAt: Date.now(),
            }).catch(() => void 0);
          },
          saveRuntimeSettings: (convId, modelIdentity) => {
            void loadConversationRuntimeSettings(convId)
              .then(async (settings) => {
                if (!settings) {
                  await saveConversationRuntimeSettings({
                    conversationId: convId,
                    modelIdentity: modelIdentity as never,
                    thinkingLevel: 'off',
                    contextWindowTokens: 128_000,
                    maxOutputTokens: 8_192,
                    updatedAt: Date.now(),
                  });
                }
              })
              .catch(() => void 0);
          },
        });
        return generationManager;
      },
      createChromeRunRegistryStore(),
      2,
    );

    // 多会话 Agent 管理器：统一管理 ConversationAgent 实例生命周期
    const agentManager = new AgentManager({
      registry: runRegistry,
      toolContextManager,
      createAgent: (conversationId) => {
        const toolContext = toolContextManager.getOrCreate(conversationId);
        return new ConversationAgent({
          conversationId,
          toolContext,
          createManager: (convId, publish) => {
            // 从 runRegistry 获取已创建的 manager
            const manager = runRegistry.managerForConversation(convId);
            // 重新订阅事件（ConversationAgent 需要自己的事件处理）
            manager.subscribe((event) => publish(event));
            return manager;
          },
          broadcast: (event, convId) =>
            broadcast(chatPorts, generationEventToServerMessage(event, convId)),
          finishDiagnostics: (event, convId) => finishDiagnostics(event, convId),
          saveCheckpoint: (event, convId, historyIds) => {
            void saveRunCheckpoint({
              id: `checkpoint-${crypto.randomUUID()}`,
              runId: event.requestId,
              conversationId: convId,
              historyMessageIds: historyIds,
              phase:
                event.message.status === 'cancelled'
                  ? 'interrupted'
                  : event.type === 'error'
                    ? 'interrupted'
                    : 'stable',
              createdAt: Date.now(),
            }).catch(() => void 0);
          },
          saveRuntimeSettings: (convId, modelIdentity) => {
            void loadConversationRuntimeSettings(convId)
              .then(async (settings) => {
                if (!settings) {
                  await saveConversationRuntimeSettings({
                    conversationId: convId,
                    modelIdentity: modelIdentity as never,
                    thinkingLevel: 'off',
                    contextWindowTokens: 128_000,
                    maxOutputTokens: 8_192,
                    updatedAt: Date.now(),
                  });
                }
              })
              .catch(() => void 0);
          },
        });
      },
    });

    void runRegistry.restore();
    runRegistry.subscribe((runs) => broadcast(chatPorts, { type: 'run_state', runs }));

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
        .then(async () => {
          let skill: SkillPackage | undefined;
          let archiveBase64: string | undefined;
          switch (raw.type) {
            case 'skills:get':
              break;
            case 'skills:set-enabled':
              await skillStore.setEnabled(raw.name, raw.enabled);
              break;
            case 'skills:create':
              skill = await skillStore.create(raw.name);
              break;
            case 'skills:get-package':
              skill = await skillStore.getPackage(raw.name);
              break;
            case 'skills:save-package':
              skill = await skillStore.savePackage(raw.name, raw.files);
              break;
            case 'skills:import':
              skill = await skillStore.importPackage(
                await importSkillArchive(base64ToBuffer(raw.archiveBase64)),
              );
              break;
            case 'skills:export':
              archiveBase64 = bytesToBase64(
                await exportSkillArchive(await skillStore.getPackage(raw.name)),
              );
              break;
            case 'skills:export-all':
              archiveBase64 = bytesToBase64(
                await exportAllSkillArchives(await skillStore.listAllPackages()),
              );
              break;
            case 'skills:duplicate':
              skill = await skillStore.duplicate(raw.name, raw.nextName);
              break;
            case 'skills:delete':
              await skillStore.delete(raw.name);
              break;
            case 'skills:revoke-grant':
              await skillStore.revokeGrant(raw.id);
              break;
          }
          return { state: await skillStore.list(), skill, archiveBase64 };
        })
        .then(
          ({ state, skill, archiveBase64 }) =>
            sendResponse({ ok: true, state, skill, archiveBase64 } satisfies SkillCommandResponse),
          (error: unknown) =>
            sendResponse({
              ok: false,
              error: publicOperationError(error, ''),
            } satisfies SkillCommandResponse),
        );
      return true;
    });

    chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
      if (
        !isTrustedExtensionPage(sender) ||
        !isRecord(raw) ||
        raw.type !== 'skill-capability:request'
      )
        return;
      void skillSandbox.handleCapabilityRequest(raw).then(sendResponse);
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

    chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
      if (!isMcpCommand(raw) || !isTrustedExtensionPage(sender)) return;
      void requireTrustedStorage()
        .then(async () => {
          switch (raw.type) {
            case 'mcp:get':
              return mcpService.view();
            case 'mcp:save':
              return mcpService.addOrRefresh(raw);
            case 'mcp:set-enabled':
              return mcpService.setEnabled(raw.id, raw.enabled);
            case 'mcp:remove':
              return mcpService.remove(raw.id);
          }
        })
        .then(
          (state) => sendResponse({ ok: true, state } satisfies McpCommandResponse),
          (error: unknown) =>
            sendResponse({
              ok: false,
              error: publicOperationError(error, raw.type === 'mcp:save' ? raw.token : ''),
            } satisfies McpCommandResponse),
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
            send({ type: 'run_state', runs: agentManager.getSnapshots() });
            for (const replay of agentManager.getReplayEvents()) {
              send(generationEventToServerMessage(replay.event, replay.conversationId));
            }
            const pendingTurns = await listPendingPageTurns();
            for (const pending of pendingTurns) {
              if (pending.status === 'resuming') {
                runRegistry
                  .managerForConversation(pending.conversationId ?? '')
                  .failDeferred(
                    pending.generation,
                    new GenerationError(
                      'NETWORK_ERROR',
                      '授权后的恢复过程被浏览器中断。为避免重复请求模型或读错页面，请重试本轮。',
                      true,
                    ),
                  );
                await clearPendingPageTurn(pending.requestId);
                continue;
              }
              send({
                type: 'stream_update',
                requestId: pending.requestId,
                ...(pending.conversationId ? { conversationId: pending.conversationId } : {}),
                message: pending.generation.message,
              });
            }
            const activeRun = agentManager
              .getSnapshots()
              .find((run) => run.status === 'running' || run.status === 'waiting_user');
            send({
              type: 'chat_state',
              running: Boolean(activeRun),
              ...(activeRun ? { requestId: activeRun.requestId } : {}),
            });
            break;
          }
          case 'chat':
            await startChat(message.conversationId, message.requestId, message.messages);
            break;
          case 'run:start':
            await startChat(message.conversationId, message.runId, message.messages);
            break;
          case 'run:steer':
            if (!agentManager.steerTask(message.runId, message.content)) {
              send({
                type: 'error',
                requestId: message.runId,
                text: '该任务已经结束，无法追加指令。',
              });
            }
            break;
          case 'run:retry':
          case 'run:resume':
            await startChat(message.conversationId, message.runId, message.messages);
            break;
          case 'run:cancel':
            agentManager.stopTask(message.runId);
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
              const requestId = message.requestId;
              if (requestId && !agentManager.stopTask(requestId)) {
                const pending = await claimPendingPageTurn(requestId);
                if (pending) {
                  await clearPendingPageTurn(requestId);
                  runRegistry
                    .managerForConversation(pending.conversationId ?? '')
                    .cancelDeferred(pending.generation);
                } else {
                  const resuming = await loadPendingPageTurn(requestId);
                  if (resuming?.requestId === requestId && resuming.status === 'resuming') {
                    const resumingContext = toolContextManager.getOrCreate(
                      resuming.conversationId ?? '',
                    );
                    resumingContext.cancelPendingRequest(requestId);
                  }
                }
              }
            }
            if (message.scope !== 'chat') orchestrator.cancel();
            break;
          }
          case 'clear_chat':
            agentManager.clearReplay();
            if (!agentManager.getSnapshots().some((run) => run.status === 'running'))
              recorder.clear();
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
        const runtimeSettings = await loadConversationRuntimeSettings(conversationId).catch(
          () => null,
        );
        const target = await resolveGenerationTarget(runtimeSettings?.modelIdentity);
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

    async function startChat(
      conversationId: string,
      requestId: string,
      history: ChatMessage[],
    ): Promise<void> {
      const pendingForConversation = (await listPendingPageTurns()).find(
        (turn) => turn.conversationId === conversationId,
      );
      if (agentManager.getRunState(conversationId) || pendingForConversation) {
        broadcast(chatPorts, {
          type: 'error',
          requestId,
          text: '该会话已有回复正在生成；你可以追加指令，或先停止后再重试。',
        });
        return;
      }

      const snapshot = await capturePageTurnSnapshot().catch(() => null);
      const agent = agentManager.getAgent(conversationId);
      const toolContext = toolContextManager.getOrCreate(conversationId);

      if (agent) {
        const lastUser = [...history].reverse().find((message) => message.role === 'user');
        agent.prepareForNewTask(snapshot, history, lastUser?.content ?? '', requestId);
      } else {
        // Agent 尚未创建（首次调用），直接操作 toolContext
        toolContext.setPageSnapshot(snapshot);
        toolContext.setChatHistory(history);
        const lastUser = [...history].reverse().find((message) => message.role === 'user');
        toolContext.setLatestUserText(lastUser?.content ?? '');
        toolContext.setDiagnostic(requestId, {
          conversationId,
          requestId,
          targetResolved: false,
          modelRounds: 0,
        });
      }
      await saveRunCheckpoint({
        id: `checkpoint-${crypto.randomUUID()}`,
        runId: requestId,
        conversationId,
        historyMessageIds: history.map(({ id }) => id),
        phase: 'queued',
        createdAt: Date.now(),
      });

      try {
        await agentManager.startTask(conversationId, requestId, history, snapshot);
      } catch (error) {
        toolContext.deleteDiagnostic(requestId);
        // 解析阶段还没有 stream_start；重连窗口可能已通过 chat_state 绑定本 requestId，
        // 因此必须广播失败，不能只通知最初发起请求的 Port。
        broadcast(chatPorts, {
          type: 'error',
          requestId,
          text: sanitizeGenerationError(error).message,
        });
      } finally {
        const pending = await loadPendingPageTurn(requestId).catch(() => null);
        if (pending?.requestId !== requestId)
          await pageInteraction.clear(requestId).catch(() => void 0);
        if (pending?.requestId !== requestId) skillLoader.clear(requestId);
        if (agent) {
          agent.cleanupAfterTask(requestId);
        } else {
          toolContext.deleteDiagnostic(requestId);
          toolContext.setLatestUserText('');
          toolContext.setPageSnapshot(null);
          toolContext.setChatHistory([]);
        }
      }
    }

    async function resumePagePermission(
      requestId: string,
      granted: boolean,
      messages: ChatMessage[],
    ): Promise<void> {
      const pending = await claimPendingPageTurn(requestId);
      if (!pending) {
        const current = await loadPendingPageTurn(requestId);
        const replay = runRegistry
          .replayEvents()
          .find((item) => item.event.requestId === requestId)?.event;
        if (
          (current?.requestId === requestId && current.status === 'resuming') ||
          runRegistry.managerForRequest(requestId)?.currentRequestId === requestId ||
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
      const conversationId = pending.conversationId ?? '';
      const deferredManager = runRegistry.managerForConversation(conversationId);
      if (pending.kind !== 'page_permission' || !pending.snapshot) {
        deferredManager.failDeferred(
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
      const agent = agentManager.getAgent(conversationId);
      const toolContext = toolContextManager.getOrCreate(conversationId);
      if (toolContext.deleteCancelledPendingRequest(requestId)) {
        deferredManager.cancelDeferred(pending.generation);
        await clearPendingPageTurn(requestId);
        return;
      }
      if (!historyMatchesPending(pending, history)) {
        deferredManager.failDeferred(
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

      const lastUser = [...history].reverse().find((message) => message.role === 'user');
      if (agent) {
        agent.prepareForResume(pending.snapshot, history, lastUser?.content ?? '');
      } else {
        toolContext.setPageSnapshot(pending.snapshot);
        toolContext.setChatHistory(history);
        toolContext.setLatestUserText(lastUser?.content ?? '');
      }
      // 先移除已经领取的旧暂停点；恢复过程中若再次暂停，会写入一个新的有效暂停点。
      await clearPendingPageTurn(requestId);
      try {
        const pendingActivity =
          pending.generation.message.toolActivities?.at(-1) ??
          pending.generation.message.toolActivity;
        const pattern = pendingActivity?.permissionPattern;
        const permissionAvailable =
          granted && Boolean(pattern) && (await hasExactPageOriginAccess(pattern ?? ''));
        if (toolContext.deleteCancelledPendingRequest(requestId)) {
          deferredManager.cancelDeferred(pending.generation);
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
          toolContext.approveToolCall(pending.generation.toolCall.id);
        }
        await runRegistry.enqueue(conversationId, requestId, async (generationManager) => {
          await generationManager.resumeDeferred(
            pending.generation,
            pageContextHistory(history, pending.snapshot),
            override,
          );
        });
      } finally {
        toolContext.revokeToolCallApproval(pending.generation.toolCall.id);
        const nextPending = await loadPendingPageTurn(requestId).catch(() => null);
        if (nextPending?.requestId !== requestId) {
          await pageInteraction.clear(requestId).catch(() => void 0);
          skillLoader.clear(requestId);
        }
        if (agent) {
          agent.cleanupAfterResume(requestId);
        } else {
          toolContext.setLatestUserText('');
          toolContext.setPageSnapshot(null);
          toolContext.setChatHistory([]);
          toolContext.deleteCancelledPendingRequest(requestId);
        }
      }
    }

    async function resumeAskUser(
      requestId: string,
      answer: string,
      messages: ChatMessage[],
    ): Promise<void> {
      const pending = await claimPendingPageTurn(requestId);
      if (!pending) {
        const current = await loadPendingPageTurn(requestId);
        const replay = runRegistry
          .replayEvents()
          .find((item) => item.event.requestId === requestId)?.event;
        if (
          (current?.requestId === requestId && current.status === 'resuming') ||
          runRegistry.managerForRequest(requestId)?.currentRequestId === requestId ||
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
      const conversationId = pending.conversationId ?? '';
      const deferredManager = runRegistry.managerForConversation(conversationId);
      if (pending.kind !== 'user_input') {
        deferredManager.failDeferred(
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
      const agent = agentManager.getAgent(conversationId);
      const toolContext = toolContextManager.getOrCreate(conversationId);
      if (toolContext.deleteCancelledPendingRequest(requestId)) {
        deferredManager.cancelDeferred(pending.generation);
        await clearPendingPageTurn(requestId);
        return;
      }
      if (!historyMatchesPending(pending, history)) {
        deferredManager.failDeferred(
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

      const lastUser = [...history].reverse().find((message) => message.role === 'user');
      if (agent) {
        agent.prepareForResume(pending.snapshot, history, lastUser?.content ?? '');
      } else {
        toolContext.setPageSnapshot(pending.snapshot);
        toolContext.setChatHistory(history);
        toolContext.setLatestUserText(lastUser?.content ?? '');
      }
      await clearPendingPageTurn(requestId);
      try {
        const resumeDeferred = async (override?: GenerationToolExecutionResult) => {
          await runRegistry.enqueue(conversationId, requestId, async (generationManager) => {
            await generationManager.resumeDeferred(pending.generation, history, override);
          });
        };
        if (toolContext.deleteCancelledPendingRequest(requestId)) {
          deferredManager.cancelDeferred(pending.generation);
          return;
        }
        if (pending.generation.toolCall.name === 'interact_page') {
          if (normalizedAnswer === '确认执行') {
            toolContext.approveToolCall(pending.generation.toolCall.id);
            await resumeDeferred();
          } else {
            await resumeDeferred({
              isError: true,
              statusText: '用户未确认页面操作',
              detail: '用户选择不执行这次可能产生外部影响的页面操作。',
              content:
                '页面操作未执行：用户没有确认本次高风险动作。不要重试相同动作，除非用户重新明确要求。',
            });
          }
        } else if (pending.generation.toolCall.name === 'observe_visual_page') {
          if (normalizedAnswer === '仅本次允许') {
            toolContext.approveToolCall(pending.generation.toolCall.id);
            await resumeDeferred();
          } else {
            await resumeDeferred({
              isError: true,
              statusText: '用户取消视觉观察',
              detail: '没有截取或发送当前页面截图。',
              content:
                '视觉观察未执行：用户没有允许发送当前页面截图。请改用 DOM/文本工具；除非用户重新明确要求，否则不要再次请求截图。',
            });
          }
        } else if (pending.generation.toolCall.name === 'run_skill') {
          const toolCall = pending.generation.toolCall;
          if (normalizedAnswer === '仅本次允许' || normalizedAnswer === '持续允许') {
            toolContext.setSkillApproval(
              toolCall.id,
              normalizedAnswer === '持续允许' ? 'always' : 'once',
            );
            await resumeDeferred();
          } else {
            const skillName =
              typeof toolCall.arguments.skill === 'string' ? toolCall.arguments.skill : '';
            if (skillName) {
              const skill = await skillStore.getPackage(skillName).catch(() => null);
              if (skill) {
                const decisions = await Promise.all(
                  skill.definition.capabilities.map(async (capability) => ({
                    capability,
                    decision: await skillStore.persistentGrant(skillName, capability),
                  })),
                );
                await Promise.all(
                  decisions.flatMap(({ capability, decision }) =>
                    decision === 'allow'
                      ? []
                      : [skillStore.resolveGrant(skillName, capability, 'deny')],
                  ),
                );
              }
            }
            await resumeDeferred({
              isError: true,
              statusText: '用户拒绝 Skill 能力',
              detail: 'Skill 脚本没有执行，可在设置中撤销拒绝记录。',
              content: 'Skill 脚本未执行：用户拒绝了所需能力。不要静默绕过或改用未授权能力。',
              riskLevel: 'write',
              authorizationStatus: 'denied',
              recoverability: 'user_retry',
            });
          }
        } else if (pending.generation.toolCall.name.startsWith('workspace_')) {
          if (normalizedAnswer === '确认执行') {
            toolContext.approveToolCall(pending.generation.toolCall.id);
            await resumeDeferred();
          } else {
            await resumeDeferred({
              isError: true,
              statusText: '用户取消工作区写入',
              detail: '本地文件没有发生变化。',
              content:
                '工作区写入未执行：用户选择取消。除非用户重新明确要求，否则不要重试相同写入。',
              riskLevel: 'write',
              authorizationStatus: 'denied',
              recoverability: 'user_retry',
            });
          }
        } else if (isMcpToolName(pending.generation.toolCall.name)) {
          if (normalizedAnswer === '确认执行') {
            toolContext.approveToolCall(pending.generation.toolCall.id);
            await resumeDeferred();
          } else {
            await resumeDeferred({
              isError: true,
              statusText: '用户取消 MCP 外部操作',
              detail: '用户没有确认这次 MCP 操作。',
              content: 'MCP 操作未执行：用户选择取消。除非用户重新明确要求，否则不要重试。',
            });
          }
        } else {
          await resumeDeferred({
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
        toolContext.revokeToolCallApproval(pending.generation.toolCall.id);
        toolContext.deleteSkillApproval(pending.generation.toolCall.id);
        const nextPending = await loadPendingPageTurn(requestId).catch(() => null);
        if (nextPending?.requestId !== requestId) {
          await pageInteraction.clear(requestId).catch(() => void 0);
          skillLoader.clear(requestId);
        }
        if (agent) {
          agent.cleanupAfterResume(requestId);
        } else {
          toolContext.setLatestUserText('');
          toolContext.setPageSnapshot(null);
          toolContext.setChatHistory([]);
          toolContext.deleteCancelledPendingRequest(requestId);
        }
      }
    }

    function finishDiagnostics(event: ChatGenerationEvent, conversationId: string): void {
      if (event.type !== 'end' && event.type !== 'error') return;
      const toolContext = toolContextManager.get(conversationId);
      const diagnostic = toolContext?.getDiagnostic(event.requestId);
      if (!diagnostic || diagnostic.requestId !== event.requestId) return;

      if (event.type === 'error') {
        recorder.logError('chat', event.message.errorMessage ?? '模型请求失败。');
        recorder.finishRun('chat', 'error');
      } else if (event.message.status === 'cancelled') {
        recorder.step('chat', 'note', '用户停止。');
        recorder.finishRun('chat', 'cancelled');
      } else {
        recorder.finishRun('chat', 'completed');
      }
      toolContext?.deleteDiagnostic(event.requestId);
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

function generationEventToServerMessage(
  event: ChatGenerationEvent,
  conversationId?: string,
): ServerMessage {
  const scope = conversationId ? { conversationId } : {};
  switch (event.type) {
    case 'start':
      return { type: 'stream_start', requestId: event.requestId, ...scope, message: event.message };
    case 'update':
      return {
        type: 'stream_update',
        requestId: event.requestId,
        ...scope,
        message: event.message,
      };
    case 'end':
      return { type: 'stream_end', requestId: event.requestId, ...scope, message: event.message };
    case 'error':
      return { type: 'stream_error', requestId: event.requestId, ...scope, message: event.message };
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

async function composeChatSystemPrompt(
  skillStore: SkillStore,
  memoryStore?: MemoryStore,
  sourceUrl?: string,
) {
  const [skills, context] = await Promise.all([
    skillStore.listEnabled(),
    memoryStore?.settings() ?? Promise.resolve(undefined),
  ]);
  return [
    CHAT_SYSTEM,
    buildSkillCatalogPrompt(skills.filter((skill) => skillAppliesToUrl(skill, sourceUrl))),
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
