// ─── 后台 Service Worker：Port 服务端 + LangChain 流式调度 + 有界工具循环 ───
// 职责：承接侧边栏的流式对话请求，用模型（经 LangChain，默认 DeepSeek 端点）逐 token 回复；
// 支持「停止生成」（AbortController）与断线重连回放；所有跨域模型调用收口在此
// （扩展上下文 + host_permissions 才能绕过浏览器 CORS）。密钥只在本进程内存解密，绝不回传 UI。
// 阶段 3：编排从「一来一回」升级为「有界 model–tool 循环」——循环流程收口在 lib/agent/loop.ts，
// 后台只做「组装依赖 + 逐事件映射到 UI 广播/trace + 前后挂压缩与异常终态」的胶水。

import { SystemMessage } from '@langchain/core/messages';
import { compactHistory, needsCompaction, withReactiveRetry } from '@/lib/agent/compaction';
import type { LoopDeps, LoopEvent } from '@/lib/agent/loop';
import { runBoundedAgentLoop } from '@/lib/agent/loop';
import { streamBoundMessages, streamPlainMessages, toLCMessages } from '@/lib/chat/model';
import { listModels } from '@/lib/chat/models';
import {
  AGENT_PORT_NAME,
  type ClientMessage,
  isClientMessage,
  type ServerMessage,
} from '@/lib/chat/protocol';
import {
  DEFAULT_MAX_LOG_CHARS,
  sanitizeForLog,
  TRACE_PREVIEW_CHARS,
} from '@/lib/diagnostics/redaction';
import type { EndReason, TokenUsage, TraceStep, TurnTrace } from '@/lib/diagnostics/trace';
import { latestTrace, putTrace } from '@/lib/diagnostics/trace';
import type { ChatMessage, ToolCallView } from '@/lib/domain/chat';
import { makeMessage } from '@/lib/domain/chat';
import type { ModelConfigView } from '@/lib/domain/types';
import {
  registerKeepAliveHandler,
  startStreamKeepAlive,
  stopStreamKeepAlive,
} from '@/lib/keepalive';
import { getModelConfig, getModelConfigView, setModelConfig } from '@/lib/storage/secureStore';
import { executeTool, hasTool, toBindableToolDefinitions } from '@/lib/tools/registry';

interface ActiveGeneration {
  requestId: string;
  controller: AbortController;
  message: ChatMessage;
}

const EMPTY_CONFIG_VIEW: ModelConfigView = {
  baseUrl: '',
  model: '',
  hasApiKey: false,
  apiKeyLastFour: '',
};

export default defineBackground({
  type: 'module',
  main() {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => void 0);
    // MV3 保活：注册闹钟处理器，流式期间由 startStreamKeepAlive 挂起闹钟。
    registerKeepAliveHandler();

    const ports = new Set<chrome.runtime.Port>();
    let active: ActiveGeneration | null = null;
    // 上一轮实测总 token（SW 存活期内有效，重启即重置——压缩本为机会性）：供下轮水位判断。
    let lastTurnTokens = 0;

    const broadcast = (message: ServerMessage): void => {
      for (const port of ports) safelyPost(port, message);
    };

    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== AGENT_PORT_NAME || !isTrustedExtensionPage(port.sender)) return;
      ports.add(port);

      port.onMessage.addListener((raw: unknown) => {
        if (!isClientMessage(raw)) {
          safelyPost(port, { type: 'error', text: '收到无法识别的扩展消息。' });
          return;
        }
        void handleClientMessage(raw, (message) => safelyPost(port, message));
      });
      port.onDisconnect.addListener(() => {
        ports.delete(port);
      });

      safelyPost(port, { type: 'connected' });
      // 断线重连回放：若后台仍在生成，先同步状态与当前全量快照。
      if (active) {
        safelyPost(port, { type: 'chat_state', running: true, requestId: active.requestId });
        safelyPost(port, {
          type: 'stream_update',
          requestId: active.requestId,
          message: cloneMessage(active.message),
        });
      } else {
        safelyPost(port, { type: 'chat_state', running: false });
      }
    });

    async function handleClientMessage(
      message: ClientMessage,
      send: (message: ServerMessage) => void,
    ): Promise<void> {
      switch (message.type) {
        case 'subscribe':
          // 连接时已回放，无需额外处理。
          break;
        case 'chat':
          await startChat(message.requestId, message.messages);
          break;
        case 'cancel':
          if (active && active.requestId === message.requestId) active.controller.abort();
          break;
        case 'clear_chat':
          active = null;
          break;
        case 'config:get': {
          const config = (await getModelConfigView()) ?? EMPTY_CONFIG_VIEW;
          send({ type: 'config_state', requestId: message.requestId, config });
          break;
        }
        case 'config:set': {
          const config = await setModelConfig({
            baseUrl: message.baseUrl,
            model: message.model,
            apiKey: message.apiKey,
            compactEnabled: message.compactEnabled,
          });
          send({ type: 'config_state', requestId: message.requestId, config });
          break;
        }
        case 'models:fetch': {
          // 密钥留空时回退到已保存密钥，支持「已配置用户点一下刷新模型列表」。
          const apiKey =
            message.apiKey.length > 0 ? message.apiKey : ((await getModelConfig())?.apiKey ?? '');
          if (!apiKey) {
            send({
              type: 'models_state',
              requestId: message.requestId,
              models: [],
              error: '请先填写 API Key 后再获取模型。',
            });
            break;
          }
          try {
            const models = await listModels(message.baseUrl, apiKey);
            send({ type: 'models_state', requestId: message.requestId, models });
          } catch (error) {
            // 失败文本可能夹带密钥（如某些 SDK 把 header 回显进错误），走脱敏后处理。
            send({
              type: 'models_state',
              requestId: message.requestId,
              models: [],
              error: safeErrorMessage(error, apiKey),
            });
          }
          break;
        }
        case 'trace:latest': {
          // 最薄观测：界面只读，这里取最近一轮轨迹回传；无记录回 null。
          const trace = await latestTrace();
          send({ type: 'trace_state', requestId: message.requestId, trace });
          break;
        }
      }
    }

    async function startChat(requestId: string, messages: ChatMessage[]): Promise<void> {
      if (active) {
        broadcast({ type: 'error', requestId, text: '当前已有回复正在生成，请先停止后再重试。' });
        return;
      }

      const config = await getModelConfig();
      if (!config?.apiKey) {
        broadcast({
          type: 'error',
          requestId,
          text: '尚未配置 DeepSeek 模型密钥，请先到「设置」页填写并保存。',
        });
        return;
      }
      // 密钥之外还必须选定模型：未选则引导回卡包完成「获取模型 → 选择」。
      if (!config.model) {
        broadcast({
          type: 'error',
          requestId,
          text: '尚未选择模型，请到「设置」页获取并选择一个模型后再开始对话。',
        });
        return;
      }

      const controller = new AbortController();
      const message: ChatMessage = {
        ...makeMessage('assistant', ''),
        status: 'streaming',
        toolCalls: [],
      };
      active = { requestId, controller, message };

      broadcast({ type: 'stream_start', requestId, message: cloneMessage(message) });
      startStreamKeepAlive();

      // 逐 token 累积，按时间节流广播全量快照（终态由 stream_end 保证最新）。
      const update = makeThrottle(() => {
        if (active) {
          broadcast({ type: 'stream_update', requestId, message: cloneMessage(active.message) });
        }
      }, 60);
      // 工具卡片状态切换等关键节点不走节流，立即广播。
      const publish = (): void => {
        if (active) {
          broadcast({ type: 'stream_update', requestId, message: cloneMessage(active.message) });
        }
      };

      // trace 累加器与卡片游标：循环每步映射成结构化步骤 + 一张工具卡片。
      const startedAt = Date.now();
      const steps: TraceStep[] = [];
      const cards: ToolCallView[] = [];
      let pendingCard: ToolCallView | null = null;
      let genBuffer = '';
      let endReason: EndReason | null = null;
      let turns = 0;
      let tokens: TokenUsage = 'unreported';

      const deps: LoopDeps = {
        streamBound: (lc, signal) =>
          streamBoundMessages(config, lc, toBindableToolDefinitions(), signal),
        streamPlain: (lc, signal) => streamPlainMessages(config, lc, signal),
        executeTool: (name, args, ctx) => executeTool(name, args, ctx),
        // 门禁每圈必经：v1 全只读恒放行，写类工具接入前此位点必须存在（阶段 5 用户确认）。
        beforeToolCall: (name) => hasTool(name),
      };

      const onEvent = (event: LoopEvent): void => {
        if (!active) return;
        if (event.type === 'text') {
          active.message.content += event.text;
          genBuffer += event.text;
          update.notify();
          return;
        }
        if (event.type === 'step_start') {
          if (event.kind === 'generation') genBuffer = '';
          else {
            pendingCard = {
              id: crypto.randomUUID(),
              name: event.tool ?? '工具',
              status: 'running',
            };
            cards.push(pendingCard);
            active.message.toolCalls = cards.slice();
            publish();
          }
          return;
        }
        if (event.type === 'step_end') {
          steps.push({
            index: event.index,
            kind: event.kind,
            tool: event.tool,
            ms: event.ms,
            status: event.status,
            errorCode: event.errorCode,
            // 预览脱敏：生成步用本轮文本，工具步用结果摘要（均为不可信外部内容，过 sanitizer）。
            preview:
              event.kind === 'tool'
                ? sanitizeForLog(event.summary ?? '', [config.apiKey], TRACE_PREVIEW_CHARS)
                : sanitizeForLog(genBuffer, [config.apiKey], TRACE_PREVIEW_CHARS),
          });
          if (event.kind === 'tool' && pendingCard) {
            pendingCard.status = event.status === 'error' ? 'error' : 'success';
            pendingCard.summary = event.summary;
            pendingCard.errorCode = event.errorCode;
            pendingCard.artifactId = event.artifactId;
            pendingCard = null;
            active.message.toolCalls = cards.slice();
            publish();
          }
          return;
        }
        // loop_end：记下终局供收尾与 trace 使用（终态在下方统一落）。
        endReason = event.endReason;
        turns = event.turns;
        tokens = event.tokens;
      };

      try {
        // reactive 兜底：整轮（压缩 + 循环）若因上下文超限失败，硬裁到最近 2 条只重试一次。
        await withReactiveRetry(async (windowMessages) => {
          let history: ChatMessage[] = windowMessages;
          // 源①：循环前按高水位对早先历史做批量摘要（可关；低频触发）。
          if (needsCompaction(lastTurnTokens, config.compactEnabled ?? true)) {
            const outcome = await compactHistory(
              {
                summarize: async (prompt) => {
                  let out = '';
                  for await (const piece of streamPlainMessages(
                    config,
                    [new SystemMessage(prompt)],
                    controller.signal,
                  )) {
                    out += piece;
                  }
                  return out;
                },
              },
              windowMessages,
            );
            history = outcome.messages;
            if (outcome.compacted && active) {
              active.message.compacted = { rounds: outcome.rounds };
              publish();
            }
          }
          await runBoundedAgentLoop(deps, toLCMessages(history), controller.signal, { onEvent });
        }, messages);

        if (active) {
          // 记入 trace（正常/取消/触顶/超预算都经此路）。
          await recordTrace(requestId, startedAt, steps, endReason ?? 'completed', turns, tokens);
          // 上一轮实测 token 留作下轮压缩水位判据。
          lastTurnTokens = tokenTotal(tokens);
          if (endReason === 'error') {
            active.message.status = 'error';
            active.message.error = true;
            active.message.errorMessage = '模型生成的工具调用无法解析，请重试。';
            broadcast({ type: 'stream_error', requestId, message: cloneMessage(active.message) });
          } else {
            active.message.status = endReason === 'cancelled' ? 'cancelled' : 'completed';
            broadcast({ type: 'stream_end', requestId, message: cloneMessage(active.message) });
          }
        }
      } catch (error) {
        if (!active) return;
        // 异常/取消路径也补记 trace，绝不留「无轨迹的一轮」。
        await recordTrace(
          requestId,
          startedAt,
          steps,
          controller.signal.aborted ? 'cancelled' : 'error',
          turns,
          tokens,
        );
        if (controller.signal.aborted) {
          active.message.status = 'cancelled';
          broadcast({ type: 'stream_end', requestId, message: cloneMessage(active.message) });
        } else {
          active.message.status = 'error';
          active.message.error = true;
          active.message.errorMessage = safeErrorMessage(error, config.apiKey);
          broadcast({ type: 'stream_error', requestId, message: cloneMessage(active.message) });
        }
      } finally {
        update.cancel();
        stopStreamKeepAlive();
        active = null;
      }
    }

    /** 落一轮结构化轨迹（写入只在后台，界面只读）；失败步数与 token 未上报都如实记录。 */
    async function recordTrace(
      requestId: string,
      startedAt: number,
      steps: TraceStep[],
      endReason: EndReason,
      turns: number,
      tokens: TokenUsage,
    ): Promise<void> {
      const trace: TurnTrace = {
        id: requestId,
        createdAt: Date.now(),
        endReason,
        turns,
        totalMs: Date.now() - startedAt,
        tokens,
        failedSteps: steps.filter((step) => step.status === 'error').length,
        steps,
      };
      await putTrace(trace);
    }
  },
});

function cloneMessage(message: ChatMessage): ChatMessage {
  return { ...message };
}

/** token 合计：未上报记 0；抽成函数避免闭包内重赋值导致的类型收窄把 tokens 判成 never。 */
function tokenTotal(tokens: TokenUsage): number {
  return tokens === 'unreported' ? 0 : tokens.input + tokens.output;
}

function safelyPost(port: chrome.runtime.Port, message: ServerMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // 端口已断开时由 onDisconnect 移除，忽略单次投递失败。
  }
}

/** 节流器：leading + trailing，两次广播间隔至少 `ms`，避免 token 洪泛压垮 Port。 */
function makeThrottle(fn: () => void, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invoke = () => {
    last = Date.now();
    fn();
  };
  return {
    notify(): void {
      const elapsed = Date.now() - last;
      if (elapsed >= ms) {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        invoke();
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = undefined;
          invoke();
        }, ms - elapsed);
      }
    },
    cancel(): void {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** 生成面向用户的错误文本：统一走脱敏器（密钥剥离→空白折叠→截断），空则给兜底文案。 */
function safeErrorMessage(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeForLog(raw, [apiKey], DEFAULT_MAX_LOG_CHARS) || '模型请求失败，请稍后重试。';
}

function isTrustedExtensionPage(sender: chrome.runtime.MessageSender | undefined): boolean {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (sender.url) return sender.url.startsWith(chrome.runtime.getURL(''));
  // 原生侧边栏可能不带 url；此时仅接受无 web tab 的发送方。
  return !sender.tab;
}
