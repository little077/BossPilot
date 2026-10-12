// ─── 后台 Service Worker：Port 服务端 + LangChain 流式调度 + 一来一回工具调用 ───
// 职责：承接侧边栏的流式对话请求，用模型（经 LangChain，默认 DeepSeek 端点）逐 token 回复；
// 支持「停止生成」（AbortController）与断线重连回放；所有跨域模型调用收口在此
// （扩展上下文 + host_permissions 才能绕过浏览器 CORS）。密钥只在本进程内存解密，绝不回传 UI。
// 工具调用采用「一来一回」：生成①带工具 → 确定性执行 → 生成②带工具结果总结。

import { type ParsedToolCall, streamFollowUp, streamToolTurn } from '@/lib/chat/model';
import { listModels } from '@/lib/chat/models';
import {
  AGENT_PORT_NAME,
  type ClientMessage,
  isClientMessage,
  type ServerMessage,
} from '@/lib/chat/protocol';
import type { ChatMessage } from '@/lib/domain/chat';
import { makeMessage } from '@/lib/domain/chat';
import type { ModelConfig, ModelConfigView } from '@/lib/domain/types';
import {
  registerKeepAliveHandler,
  startStreamKeepAlive,
  stopStreamKeepAlive,
} from '@/lib/keepalive';
import { getModelConfig, getModelConfigView, setModelConfig } from '@/lib/storage/secureStore';
import { executeTool, hasTool, toBindableToolDefinitions } from '@/lib/tools/registry';
import { type ToolResult, toolError } from '@/lib/tools/types';

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
      const message: ChatMessage = { ...makeMessage('assistant', ''), status: 'streaming' };
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

      try {
        // 生成①：带工具流式生成；模型决定调用工具时在流末尾产出 tool_call（只取第一个）。
        let call: ParsedToolCall | null = null;
        let invalidCallName: string | null = null;
        for await (const event of streamToolTurn(
          config,
          messages,
          toBindableToolDefinitions(),
          controller.signal,
        )) {
          if (!active) break;
          if (event.type === 'text') {
            active.message.content += event.text;
            update.notify();
          } else if (event.type === 'tool_call') {
            call = event.call;
          } else {
            invalidCallName = event.name || '未知工具';
          }
        }

        // 模型产出了无法执行的工具调用：如实报错，不猜参数、不继续生成。
        if (active && invalidCallName !== null) {
          active.message.toolCall = {
            name: invalidCallName,
            status: 'error',
            summary: '模型生成的工具调用无法解析，请重试。',
            errorCode: 'invalid_arguments',
          };
          active.message.status = 'error';
          active.message.error = true;
          active.message.errorMessage = '模型生成的工具调用无法解析，请重试。';
          broadcast({ type: 'stream_error', requestId, message: cloneMessage(active.message) });
          return;
        }

        if (active && call) {
          await executeToolRound(config, messages, call, controller, publish, update);
        }

        if (active) {
          active.message.status = 'completed';
          broadcast({ type: 'stream_end', requestId, message: cloneMessage(active.message) });
        }
      } catch (error) {
        if (!active) return;
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

    /** 工具执行 + 生成②：卡片置「执行中」→ 门禁 → 确定性执行 → 卡片置终态 → 不带工具总结。 */
    async function executeToolRound(
      config: ModelConfig,
      messages: ChatMessage[],
      call: ParsedToolCall,
      controller: AbortController,
      publish: () => void,
      update: { notify: () => void },
    ): Promise<void> {
      if (!active) return;
      active.message.toolCall = { name: call.name, status: 'running' };
      publish();

      const startedAt = Date.now();
      let result: ToolResult;
      if (beforeToolCall(call)) {
        result = await executeTool(call.name, call.args, { signal: controller.signal });
      } else {
        result = toolError(
          'unknown_tool',
          `不支持的工具：${call.name}`,
          `[工具调用被拦截] 错误码：unknown_tool，工具名：${call.name}。请如实告知用户当前版本不支持该操作。`,
        );
      }
      console.debug(
        `[tools] ${call.name} ${result.isError ? `失败(${result.errorCode})` : '成功'} ${Date.now() - startedAt}ms`,
      );

      if (!active) return;
      active.message.toolCall = result.isError
        ? {
            name: call.name,
            status: 'error',
            summary: result.summary,
            errorCode: result.errorCode,
          }
        : {
            name: call.name,
            status: 'success',
            summary: result.summary,
            artifactId: result.artifactId,
          };
      publish();

      // 工具阶段被取消：交给外层 catch 走「已停止」终态。
      controller.signal.throwIfAborted();

      // 生成②：把「工具调用 + 工具结果」作为往返消息追加，不再绑定工具。
      for await (const text of streamFollowUp(
        config,
        messages,
        call,
        result.llmText,
        controller.signal,
      )) {
        if (!active) break;
        active.message.content += text;
        update.notify();
      }
    }
  },
});

/**
 * 工具执行门禁：v1 注册表内全部是只读工具，直接放行；点位必须保留——
 * 未来任何写类工具（点击/填表/发送）必须先在此接入用户确认，不得绕过。
 */
function beforeToolCall(call: ParsedToolCall): boolean {
  return hasTool(call.name);
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return { ...message };
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

/** 生成面向用户的错误文本，压缩空白并移除可能出现的密钥明文。 */
function safeErrorMessage(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutKey = apiKey ? raw.split(apiKey).join('[REDACTED]') : raw;
  return withoutKey.replace(/\s+/g, ' ').trim().slice(0, 300) || '模型请求失败，请稍后重试。';
}

function isTrustedExtensionPage(sender: chrome.runtime.MessageSender | undefined): boolean {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (sender.url) return sender.url.startsWith(chrome.runtime.getURL(''));
  // 原生侧边栏可能不带 url；此时仅接受无 web tab 的发送方。
  return !sender.tab;
}
