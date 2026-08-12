// ─── 对话生成会话管理器 ───
// 职责：固定单轮模型、串行执行有界 Agent 循环、保存可恢复快照，并统一收口取消与错误终态。

import type { ChatMessage, GenerationUsage } from '@/lib/domain/chat';
import type { ModelIdentity } from '@/lib/domain/types';
import { GenerationError, isAbortError, sanitizeGenerationError } from '@/lib/generation/errors';
import type {
  GenerationAdapter,
  GenerationEvent,
  GenerationInputMessage,
  GenerationToolCall,
  GenerationToolDeferredResult,
  GenerationToolDefinition,
  GenerationToolExecutionOutcome,
  GenerationToolExecutionResult,
  GenerationToolExecutor,
  ResolvedGenerationTarget,
} from '@/lib/generation/types';

export type ChatGenerationEventType = 'start' | 'update' | 'end' | 'error';

/** Background 只需把这个不含凭据的快照映射到 IPC。 */
export interface ChatGenerationEvent {
  type: ChatGenerationEventType;
  requestId: string;
  message: ChatMessage;
}

export type ChatGenerationListener = (event: ChatGenerationEvent) => void;

/** 等待真实用户手势时可安全持久化的最小生成状态，不包含 API Key 或页面正文。 */
export interface DeferredGenerationTurn {
  version: 1 | 2;
  requestId: string;
  message: ChatMessage;
  rawContent: string;
  toolCall: GenerationToolCall;
  targetIdentity: ModelIdentity;
  usage?: GenerationUsage;
  deferredAt: number;
  /** v2：恢复多步循环所需的协议消息；只写入扩展私有的 chrome.storage.session。 */
  loopMessages?: GenerationInputMessage[];
  modelTurns?: number;
  /** @deprecated v0.5 早期快照只记录工具名和参数，恢复时不再用于无进展判断。 */
  toolCallSignatures?: string[];
  /** 相同调用且相同可观察结果的紧凑签名，用于跨 Ask User/权限暂停恢复无进展检测。 */
  toolAttemptSignatures?: string[];
}

export type GenerationTargetResolver = () =>
  | ResolvedGenerationTarget
  | Promise<ResolvedGenerationTarget>;

export interface ChatGenerationManagerOptions {
  resolveTarget: GenerationTargetResolver;
  adapter: GenerationAdapter;
  createMessageId?: () => string;
  now?: () => number;
  systemPrompt?: string;
  maxOutputTokens?: number;
  /** 即使上游忽略 token 参数，也不得突破的 UTF-16 字符硬上限。 */
  maxOutputChars?: number;
  /** 全量流快照的最小广播间隔；终态不受该间隔影响。 */
  streamUpdateIntervalMs?: number;
  temperature?: number;
  /** 当前里程碑开放的高层有界工具；同一个模型回合仍只接受一次工具调用。 */
  tools?: GenerationToolDefinition[];
  executeTool?: GenerationToolExecutor;
  /** 包含最终回答在内的模型回合硬上限；默认 200，只作为失控保险丝。 */
  maxAgentTurns?: number;
  /** 相同工具、参数和可观察结果最多连续出现几次；默认 3，防止无进展空转。 */
  maxConsecutiveIdenticalToolCalls?: number;
  onToolDeferred?: (
    turn: DeferredGenerationTurn,
    result: GenerationToolDeferredResult,
  ) => void | Promise<void>;
}

interface ActiveTurn {
  requestId: string;
  controller: AbortController;
  message?: ChatMessage;
  rawContent: string;
  secret: string;
  terminalEmitted: boolean;
  updatePending: boolean;
  updateTimer?: ReturnType<typeof setTimeout>;
  pendingToolCall?: GenerationToolCall;
  usage?: GenerationUsage;
  modelTurns: number;
  toolAttemptSignatures: string[];
}

const ABORTED = Symbol('generation-aborted');
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_STREAM_UPDATE_INTERVAL_MS = 50;
export const DEFAULT_MAX_AGENT_TURNS = 200;
export const DEFAULT_MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS = 3;

type StreamOutcome =
  | { kind: 'tool'; toolCall: GenerationToolCall }
  | { kind: 'terminal'; message: ChatMessage };

export class ChatGenerationManager {
  private readonly listeners = new Set<ChatGenerationListener>();
  private readonly createMessageId: () => string;
  private readonly now: () => number;
  private readonly maxOutputChars: number;
  private readonly streamUpdateIntervalMs: number;
  private readonly maxAgentTurns: number;
  private readonly maxConsecutiveIdenticalToolCalls: number;
  private active?: ActiveTurn;
  private replay?: ChatGenerationEvent;

  constructor(private readonly options: ChatGenerationManagerOptions) {
    this.createMessageId = options.createMessageId ?? (() => crypto.randomUUID());
    this.now = options.now ?? Date.now;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.streamUpdateIntervalMs =
      options.streamUpdateIntervalMs ?? DEFAULT_STREAM_UPDATE_INTERVAL_MS;
    this.maxAgentTurns = positiveInteger(options.maxAgentTurns, DEFAULT_MAX_AGENT_TURNS);
    this.maxConsecutiveIdenticalToolCalls = positiveInteger(
      options.maxConsecutiveIdenticalToolCalls,
      DEFAULT_MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS,
    );
  }

  get isRunning(): boolean {
    return this.active !== undefined;
  }

  get currentRequestId(): string | undefined {
    return this.active?.requestId;
  }

  /**
   * 启动一轮生成。解析阶段也占用互斥锁，但解析成功前不创建 assistant，
   * 避免配置错误在历史中留下空消息。
   */
  async start(requestId: string, history: ChatMessage[]): Promise<ChatMessage> {
    if (this.active) {
      throw new GenerationError('BUSY', '当前已有回复正在生成，请先停止后再重试。');
    }

    this.replay = undefined;
    const turn: ActiveTurn = {
      requestId,
      controller: new AbortController(),
      rawContent: '',
      secret: '',
      terminalEmitted: false,
      updatePending: false,
      modelTurns: 0,
      toolAttemptSignatures: [],
    };
    this.active = turn;

    let target: ResolvedGenerationTarget;
    try {
      const resolution = this.options.resolveTarget();
      target = cloneTarget(isPromiseLike(resolution) ? await resolution : resolution);
      turn.secret = target.apiKey;
    } catch (error) {
      this.releaseWithoutEvent(turn);
      throw sanitizeGenerationError(error);
    }

    turn.message = {
      id: this.createMessageId(),
      role: 'assistant',
      content: '',
      createdAt: this.now(),
      status: 'streaming',
      modelIdentity: { ...target.identity },
      reasoningActivity: {
        status: 'running',
        summary: '正在判断是否需要使用浏览器工具',
        startedAt: this.now(),
      },
    };
    this.publish(turn, 'start');

    if (turn.controller.signal.aborted) {
      return this.finishCancelled(turn);
    }

    try {
      return await this.runAgentLoop(turn, target, toGenerationInputMessages(history));
    } catch (error) {
      if (turn.controller.signal.aborted || isAbortError(error)) {
        return this.finishCancelled(turn);
      }
      return this.finishError(turn, error);
    }
  }

  /** 从持久化权限卡恢复同一个 tool call；第一阶段模型不会被重复调用。 */
  async resumeDeferred(
    state: DeferredGenerationTurn,
    history: ChatMessage[],
    executionOverride?: GenerationToolExecutionResult,
  ): Promise<ChatMessage> {
    if (this.active) {
      throw new GenerationError('BUSY', '当前已有回复正在生成，请先停止后再重试。');
    }

    const turn = activeTurnFromDeferred(state);
    this.active = turn;
    this.replay = undefined;

    try {
      const resolution = this.options.resolveTarget();
      const target = cloneTarget(isPromiseLike(resolution) ? await resolution : resolution);
      if (!sameModelIdentity(target.identity, state.targetIdentity)) {
        return this.finishError(
          turn,
          new GenerationError(
            'INVALID_RESPONSE',
            '等待授权期间活动模型已变化。为避免把网页发送到错误的模型，请重新发送问题。',
            false,
          ),
        );
      }
      turn.secret = target.apiKey;
      const message = requireMessage(turn);
      const activity = currentToolActivity(message);
      if (!activity || activity.callId !== state.toolCall.id) {
        return this.finishError(
          turn,
          new GenerationError('INVALID_RESPONSE', '等待授权的工具状态不完整，请重新发送问题。'),
        );
      }

      activity.status = 'running';
      activity.statusText = `正在${activity.label}`;
      activity.finishedAt = undefined;
      message.pendingUserQuestion = undefined;
      syncLegacyToolActivity(message, activity);
      this.publish(turn, 'update');

      return await this.executeAndContinueTool(
        turn,
        target,
        state.loopMessages
          ? cloneGenerationInputMessages(state.loopMessages)
          : toGenerationInputMessages(history),
        state.toolCall,
        false,
        executionOverride,
      );
    } catch (error) {
      if (turn.controller.signal.aborted || isAbortError(error)) {
        return this.finishCancelled(turn);
      }
      return this.finishError(turn, error);
    }
  }

  /** 权限卡等待期间没有活动网络请求，取消时直接发布同一消息的确定终态。 */
  cancelDeferred(state: DeferredGenerationTurn): ChatMessage | null {
    if (this.active) return null;
    const turn = activeTurnFromDeferred(state);
    this.active = turn;
    return this.finishCancelled(turn, state.usage);
  }

  /** Service Worker 恢复中断或恢复点失配时，为原消息发布一个明确且唯一的错误终态。 */
  failDeferred(state: DeferredGenerationTurn, error: unknown): ChatMessage | null {
    if (this.active) return null;
    const turn = activeTurnFromDeferred(state);
    this.active = turn;
    return this.finishError(turn, error);
  }

  /**
   * 每个模型回合最多接受一个工具调用，但工具结果会继续交还模型，直到自然回答、暂停或触发保险丝。
   * 浏览器工具保持串行，避免多个页面动作互相争用活动标签页。
   */
  private async runAgentLoop(
    turn: ActiveTurn,
    target: ResolvedGenerationTarget,
    inputMessages: GenerationInputMessage[],
  ): Promise<ChatMessage> {
    if (turn.modelTurns >= this.maxAgentTurns) {
      return this.finishError(
        turn,
        new GenerationError(
          'AGENT_LIMIT_REACHED',
          `Agent 已达到 ${this.maxAgentTurns} 个模型回合的安全上限，任务已停止。你可以缩小目标后继续。`,
          false,
        ),
      );
    }

    turn.modelTurns += 1;
    const outcome = await this.runGeneration(turn, target, inputMessages, this.options.tools);
    if (outcome.kind === 'terminal') return outcome.message;

    const toolDefinition = this.options.tools?.find(
      (candidate) => candidate.name === outcome.toolCall.name,
    );
    if (!toolDefinition || !this.options.executeTool) {
      return this.finishError(
        turn,
        new GenerationError(
          'INVALID_RESPONSE',
          `模型请求了未开放的工具：${outcome.toolCall.name}`,
          false,
        ),
      );
    }

    this.beginToolActivity(turn, outcome.toolCall, toolDefinition);
    return await this.executeAndContinueTool(turn, target, inputMessages, outcome.toolCall, true);
  }

  private async executeAndContinueTool(
    turn: ActiveTurn,
    target: ResolvedGenerationTarget,
    inputMessages: GenerationInputMessage[],
    toolCall: GenerationToolCall,
    allowDeferred: boolean,
    executionOverride?: GenerationToolExecutionResult,
  ): Promise<ChatMessage> {
    if (!this.options.executeTool) {
      return this.finishError(
        turn,
        new GenerationError('INVALID_RESPONSE', '当前没有可执行的浏览器工具。', false),
      );
    }

    const outcome =
      executionOverride ??
      (await promiseOrAbort(
        this.options.executeTool(
          toolCall,
          turn.controller.signal,
          turn.requestId,
          (statusText, detail) => this.updateToolActivity(turn, statusText, detail),
          {
            model: {
              providerLabel: target.providerLabel,
              modelName: target.modelName,
              supportsImageInput: target.supportsImageInput === true,
            },
          },
        ),
        turn.controller.signal,
      ));
    if (outcome === ABORTED) return this.finishCancelled(turn);

    const execution = isDeferredToolExecution(outcome)
      ? allowDeferred
        ? await this.deferTool(turn, target, inputMessages, toolCall, outcome)
        : deferredStillMissing(outcome)
      : outcome;
    if (execution === null) return cloneMessage(requireMessage(turn));
    if (execution.errorCode === 'CANCELLED' || execution.errorCode === 'cancelled') {
      return this.finishCancelled(turn);
    }

    this.finishToolActivity(turn, execution);
    const attemptSignature = toolAttemptSignature(toolCall, execution);
    turn.toolAttemptSignatures.push(attemptSignature);
    if (
      trailingIdenticalCount(turn.toolAttemptSignatures, attemptSignature) >=
      this.maxConsecutiveIdenticalToolCalls
    ) {
      return this.finishError(
        turn,
        new GenerationError(
          'REPEATED_TOOL_CALL',
          `Agent 连续 ${this.maxConsecutiveIdenticalToolCalls} 次执行了相同操作且页面没有取得进展，已停止空转。请检查页面是否仍在加载、需要验证或操作目标已经失效。`,
          false,
        ),
      );
    }
    const toolMessages: GenerationInputMessage[] = [
      ...inputMessages,
      {
        role: 'assistant',
        content: turn.rawContent,
        createdAt: requireMessage(turn).createdAt,
        finishReason: 'tool',
        toolCalls: [toolCall],
      },
      {
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: execution.content,
        ...(execution.images ? { images: execution.images.map((image) => ({ ...image })) } : {}),
        isError: execution.isError,
        createdAt: this.now(),
      },
    ];

    return await this.runAgentLoop(turn, target, toolMessages);
  }

  private async deferTool(
    turn: ActiveTurn,
    target: ResolvedGenerationTarget,
    loopMessages: GenerationInputMessage[],
    toolCall: GenerationToolCall,
    result: GenerationToolDeferredResult,
  ): Promise<null> {
    if (!this.options.onToolDeferred) {
      throw new GenerationError(
        'PERMISSION_REQUIRED',
        result.kind === 'page_permission' ? result.detail : result.question,
        false,
      );
    }

    const message = requireMessage(turn);
    const activity = currentToolActivity(message);
    if (!activity) {
      throw new GenerationError('INVALID_RESPONSE', 'Agent 工具没有可恢复的活动状态。');
    }
    activity.status = result.kind === 'user_input' ? 'waiting_user' : 'waiting_permission';
    activity.statusText = result.statusText;
    if (result.kind === 'page_permission') {
      activity.detail = result.detail;
      activity.sourceOrigin = result.sourceOrigin;
      activity.sourceTitle = result.sourceTitle;
      activity.permissionPattern = result.permissionPattern;
      activity.permissionKind = result.permissionKind ?? 'read';
    } else {
      message.pendingUserQuestion = {
        requestId: turn.requestId,
        callId: toolCall.id,
        question: result.question,
        options: result.options.map((option) => ({ ...option })),
        allowCustom: result.allowCustom,
        ...(result.customPlaceholder ? { customPlaceholder: result.customPlaceholder } : {}),
      };
    }
    syncLegacyToolActivity(message, activity);

    const deferred: DeferredGenerationTurn = {
      version: 2,
      requestId: turn.requestId,
      message: cloneMessage(message),
      rawContent: turn.rawContent,
      toolCall: cloneToolCall(toolCall),
      targetIdentity: { ...target.identity },
      ...(turn.usage ? { usage: { ...turn.usage } } : {}),
      deferredAt: this.now(),
      // 截图属于短时模型上下文，不能写入 chrome.storage.session。
      loopMessages: cloneGenerationInputMessages(loopMessages, false),
      modelTurns: turn.modelTurns,
      toolAttemptSignatures: [...turn.toolAttemptSignatures],
    };
    await this.options.onToolDeferred(deferred, result);
    this.publish(turn, 'update');
    this.releaseWithoutEvent(turn);
    return null;
  }

  private async runGeneration(
    turn: ActiveTurn,
    target: ResolvedGenerationTarget,
    messages: GenerationInputMessage[],
    tools?: GenerationToolDefinition[],
  ): Promise<StreamOutcome> {
    turn.pendingToolCall = undefined;
    const iterator = this.options.adapter
      .stream(target, {
        systemPrompt: this.options.systemPrompt ?? '',
        messages,
        signal: turn.controller.signal,
        ...(tools?.length ? { tools } : {}),
        ...(this.options.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: this.options.maxOutputTokens }),
        ...(this.options.temperature === undefined
          ? {}
          : { temperature: this.options.temperature }),
      })
      [Symbol.asyncIterator]();

    while (!turn.terminalEmitted) {
      const result = await nextOrAbort(iterator, turn.controller.signal);
      if (result === ABORTED) {
        closeIterator(iterator);
        return { kind: 'terminal', message: this.finishCancelled(turn) };
      }
      if (result.done) {
        return {
          kind: 'terminal',
          message: this.finishError(
            turn,
            new GenerationError('INVALID_RESPONSE', '模型响应提前结束，请重试。', true),
          ),
        };
      }

      const outcome = this.consume(turn, result.value);
      if (outcome) {
        closeIterator(iterator);
        return outcome;
      }
    }

    return { kind: 'terminal', message: cloneMessage(requireMessage(turn)) };
  }

  /** requestId 必须精确匹配；重复取消同一活动轮次不会产生额外终态。 */
  stop(requestId: string): boolean {
    if (!this.active || this.active.requestId !== requestId) return false;
    if (!this.active.controller.signal.aborted) {
      this.active.controller.abort();
    }
    return true;
  }

  cancel(requestId: string): boolean {
    return this.stop(requestId);
  }

  subscribe(listener: ChatGenerationListener): () => void {
    this.listeners.add(listener);
    if (this.replay) this.notify(listener, this.replay);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 返回防御性拷贝，Background 可据此主动同步当前或最近终态。 */
  getSnapshot(): ChatGenerationEvent | null {
    return this.replay ? cloneEvent(this.replay) : null;
  }

  /**
   * 只清除已经结束的回放。活动轮次始终保留最新快照，
   * 否则 Port 重连会丢失正在生成的正文。
   */
  clearReplay(): void {
    if (!this.active) this.replay = undefined;
  }

  private consume(turn: ActiveTurn, event: GenerationEvent): StreamOutcome | undefined {
    switch (event.type) {
      case 'start':
        return undefined;
      case 'text-delta':
        if (event.delta) {
          this.completeReasoning(turn, '已完成问题分析');
          const remaining = this.maxOutputChars - turn.rawContent.length;
          if (event.delta.length > remaining) {
            if (remaining > 0) turn.rawContent += event.delta.slice(0, remaining);
            requireMessage(turn).content = publicContent(turn.rawContent, turn.secret, true);
            turn.controller.abort();
            return {
              kind: 'terminal',
              message: this.finishError(
                turn,
                new GenerationError(
                  'OUTPUT_LIMIT_EXCEEDED',
                  `模型输出超过 ${this.maxOutputChars} 字符安全上限，已停止生成。`,
                ),
              ),
            };
          }

          turn.rawContent += event.delta;
          requireMessage(turn).content = publicContent(turn.rawContent, turn.secret, false);
          this.queueUpdate(turn);
        }
        return undefined;
      case 'tool-call':
        if (turn.pendingToolCall) {
          return {
            kind: 'terminal',
            message: this.finishError(
              turn,
              new GenerationError(
                'INVALID_RESPONSE',
                '模型在同一轮请求了多个工具，已停止执行。',
                false,
              ),
            ),
          };
        }
        turn.pendingToolCall = { ...event.toolCall, arguments: { ...event.toolCall.arguments } };
        this.completeReasoning(turn, '已判断需要使用浏览器工具');
        return undefined;
      case 'finish':
        turn.usage = addUsage(turn.usage, event.usage);
        if (event.reason === 'cancelled') {
          return { kind: 'terminal', message: this.finishCancelled(turn, turn.usage) };
        }
        if (event.reason === 'tool') {
          if (!turn.pendingToolCall) {
            return {
              kind: 'terminal',
              message: this.finishError(
                turn,
                new GenerationError(
                  'INVALID_RESPONSE',
                  '模型结束于工具调用状态，但没有返回有效工具请求。',
                  true,
                ),
              ),
            };
          }
          return { kind: 'tool', toolCall: turn.pendingToolCall };
        }
        if (turn.pendingToolCall) {
          return {
            kind: 'terminal',
            message: this.finishError(
              turn,
              new GenerationError('INVALID_RESPONSE', '模型工具调用没有正确结束。', true),
            ),
          };
        }
        this.completeReasoning(turn, '已完成问题分析');
        return {
          kind: 'terminal',
          message: this.finishCompleted(turn, event.reason, turn.usage),
        };
    }
  }

  private completeReasoning(turn: ActiveTurn, summary: string): void {
    const activity = requireMessage(turn).reasoningActivity;
    if (activity?.status !== 'running') return;
    activity.status = 'completed';
    activity.finishedAt = this.now();
    activity.summary = summary;
  }

  private beginToolActivity(
    turn: ActiveTurn,
    call: GenerationToolCall,
    definition: GenerationToolDefinition,
  ): void {
    const message = requireMessage(turn);
    const activity = {
      requestId: turn.requestId,
      callId: call.id,
      name: definition.name,
      label: definition.label,
      status: 'running',
      statusText: `正在${definition.label}`,
      startedAt: this.now(),
    } satisfies NonNullable<ChatMessage['toolActivity']>;
    message.toolActivities = [...(message.toolActivities ?? []), activity];
    syncLegacyToolActivity(message, activity);
    this.publish(turn, 'update');
  }

  private finishToolActivity(turn: ActiveTurn, execution: GenerationToolExecutionResult): void {
    const message = requireMessage(turn);
    const activity = currentToolActivity(message);
    if (!activity) return;
    activity.status = execution.isError ? 'failed' : 'succeeded';
    activity.statusText = execution.statusText;
    activity.finishedAt = this.now();
    if (execution.detail) activity.detail = execution.detail;
    if (execution.errorCode) activity.errorCode = execution.errorCode;
    if (execution.sourceOrigin) activity.sourceOrigin = execution.sourceOrigin;
    if (execution.sourceTitle) activity.sourceTitle = execution.sourceTitle;
    if (execution.sourceUrl) activity.sourceUrl = execution.sourceUrl;
    if (execution.extractionMode) activity.extractionMode = execution.extractionMode;
    if (execution.returnedChars !== undefined) activity.returnedChars = execution.returnedChars;
    if (execution.truncated !== undefined) activity.truncated = execution.truncated;
    if (execution.enrichmentStatus) activity.enrichmentStatus = execution.enrichmentStatus;
    syncLegacyToolActivity(message, activity);
    this.publish(turn, 'update');
  }

  private updateToolActivity(turn: ActiveTurn, statusText: string, detail?: string): void {
    const message = requireMessage(turn);
    const activity = currentToolActivity(message);
    if (activity?.status !== 'running' || turn.controller.signal.aborted) return;
    activity.statusText = statusText;
    if (detail) activity.detail = detail;
    syncLegacyToolActivity(message, activity);
    this.publish(turn, 'update');
  }

  private finishCompleted(
    turn: ActiveTurn,
    reason: Exclude<ChatMessage['finishReason'], 'cancelled' | undefined>,
    usage: GenerationUsage,
  ): ChatMessage {
    const message = requireMessage(turn);
    message.content = publicContent(turn.rawContent, turn.secret, true);
    message.status = 'completed';
    message.finishReason = reason;
    message.usage = { ...usage };
    message.pendingUserQuestion = undefined;
    return this.publishTerminal(turn, 'end');
  }

  private finishCancelled(turn: ActiveTurn, usage?: GenerationUsage): ChatMessage {
    const message = requireMessage(turn);
    if (message.reasoningActivity?.status === 'running') {
      message.reasoningActivity.status = 'cancelled';
      message.reasoningActivity.summary = '已停止问题分析';
      message.reasoningActivity.finishedAt = this.now();
    }
    const toolActivity = currentToolActivity(message);
    if (
      toolActivity?.status === 'running' ||
      toolActivity?.status === 'waiting_permission' ||
      toolActivity?.status === 'waiting_user'
    ) {
      toolActivity.status = 'cancelled';
      toolActivity.statusText = `已停止${toolActivity.label}`;
      toolActivity.errorCode = 'CANCELLED';
      toolActivity.finishedAt = this.now();
      syncLegacyToolActivity(message, toolActivity);
    }
    message.pendingUserQuestion = undefined;
    message.content = publicContent(turn.rawContent, turn.secret, true);
    message.status = 'cancelled';
    message.finishReason = 'cancelled';
    if (usage) message.usage = { ...usage };
    return this.publishTerminal(turn, 'end');
  }

  private finishError(turn: ActiveTurn, error: unknown): ChatMessage {
    const message = requireMessage(turn);
    const safeError = sanitizeGenerationError(error, turn.secret);
    if (message.reasoningActivity?.status === 'running') {
      message.reasoningActivity.status = 'error';
      message.reasoningActivity.summary = '问题分析未完成';
      message.reasoningActivity.finishedAt = this.now();
    }
    const toolActivity = currentToolActivity(message);
    if (
      toolActivity?.status === 'running' ||
      toolActivity?.status === 'waiting_permission' ||
      toolActivity?.status === 'waiting_user'
    ) {
      toolActivity.status = 'failed';
      toolActivity.statusText = `${toolActivity.label}时发生错误`;
      toolActivity.finishedAt = this.now();
      syncLegacyToolActivity(message, toolActivity);
    }
    message.pendingUserQuestion = undefined;
    message.content = publicContent(turn.rawContent, turn.secret, true);
    message.status = 'error';
    message.error = true;
    message.errorMessage = safeError.message;
    message.errorCode = safeError.code;
    message.retryable = safeError.retryable;
    return this.publishTerminal(turn, 'error');
  }

  private publish(turn: ActiveTurn, type: 'start' | 'update'): void {
    if (turn.terminalEmitted) return;
    this.dispatch({
      type,
      requestId: turn.requestId,
      message: cloneMessage(requireMessage(turn)),
    });
  }

  private publishTerminal(turn: ActiveTurn, type: 'end' | 'error'): ChatMessage {
    if (turn.terminalEmitted) return cloneMessage(requireMessage(turn));
    turn.terminalEmitted = true;
    this.clearUpdateTimer(turn);
    if (this.active === turn) this.active = undefined;
    const event: ChatGenerationEvent = {
      type,
      requestId: turn.requestId,
      message: cloneMessage(requireMessage(turn)),
    };
    this.dispatch(event);
    return cloneMessage(event.message);
  }

  private dispatch(event: ChatGenerationEvent): void {
    this.replay = cloneEvent(event);
    for (const listener of this.listeners) this.notify(listener, event);
  }

  private notify(listener: ChatGenerationListener, event: ChatGenerationEvent): void {
    try {
      listener(cloneEvent(event));
    } catch {
      // UI/Port 订阅方的异常不能破坏后台唯一终态保证。
    }
  }

  private releaseWithoutEvent(turn: ActiveTurn): void {
    this.clearUpdateTimer(turn);
    if (this.active === turn) this.active = undefined;
  }

  /**
   * 正文快照是全量消息；限制为固定帧率，避免大量微小 delta 形成 O(n²)
   * 的结构化克隆、Port 传输和 React 更新。首段立即可见，终态始终立即发送。
   */
  private queueUpdate(turn: ActiveTurn): void {
    if (this.streamUpdateIntervalMs <= 0) {
      this.publish(turn, 'update');
      return;
    }

    if (turn.updateTimer === undefined) {
      this.publish(turn, 'update');
      turn.updateTimer = setTimeout(
        () => this.flushQueuedUpdate(turn),
        this.streamUpdateIntervalMs,
      );
      return;
    }

    turn.updatePending = true;
  }

  private flushQueuedUpdate(turn: ActiveTurn): void {
    turn.updateTimer = undefined;
    if (turn.terminalEmitted || this.active !== turn || !turn.updatePending) return;

    turn.updatePending = false;
    this.publish(turn, 'update');
    turn.updateTimer = setTimeout(() => this.flushQueuedUpdate(turn), this.streamUpdateIntervalMs);
  }

  private clearUpdateTimer(turn: ActiveTurn): void {
    if (turn.updateTimer !== undefined) clearTimeout(turn.updateTimer);
    turn.updateTimer = undefined;
    turn.updatePending = false;
  }
}

function requireMessage(turn: ActiveTurn): ChatMessage {
  if (!turn.message) {
    throw new GenerationError('INVALID_RESPONSE', '生成会话尚未初始化。');
  }
  return turn.message;
}

function cloneTarget(target: ResolvedGenerationTarget): ResolvedGenerationTarget {
  return {
    ...target,
    identity: { ...target.identity },
  };
}

function isPromiseLike(
  value: ResolvedGenerationTarget | Promise<ResolvedGenerationTarget>,
): value is Promise<ResolvedGenerationTarget> {
  return typeof Reflect.get(value, 'then') === 'function';
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    ...(message.modelIdentity ? { modelIdentity: { ...message.modelIdentity } } : {}),
    ...(message.usage ? { usage: { ...message.usage } } : {}),
    ...(message.reasoningActivity ? { reasoningActivity: { ...message.reasoningActivity } } : {}),
    ...(message.toolActivity ? { toolActivity: { ...message.toolActivity } } : {}),
    ...(message.toolActivities
      ? { toolActivities: message.toolActivities.map((activity) => ({ ...activity })) }
      : {}),
    ...(message.pendingUserQuestion
      ? {
          pendingUserQuestion: {
            ...message.pendingUserQuestion,
            options: message.pendingUserQuestion.options.map((option) => ({ ...option })),
          },
        }
      : {}),
  };
}

function activeTurnFromDeferred(state: DeferredGenerationTurn): ActiveTurn {
  return {
    requestId: state.requestId,
    controller: new AbortController(),
    message: cloneMessage(state.message),
    rawContent: state.rawContent,
    secret: '',
    terminalEmitted: false,
    updatePending: false,
    pendingToolCall: cloneToolCall(state.toolCall),
    modelTurns: state.modelTurns ?? 1,
    toolAttemptSignatures: [...(state.toolAttemptSignatures ?? [])],
    ...(state.usage ? { usage: { ...state.usage } } : {}),
  };
}

function cloneToolCall(call: GenerationToolCall): GenerationToolCall {
  return { ...call, arguments: { ...call.arguments } };
}

function sameModelIdentity(current: ModelIdentity, expected: ModelIdentity): boolean {
  return current.providerId === expected.providerId && current.modelId === expected.modelId;
}

function isDeferredToolExecution(
  outcome: GenerationToolExecutionOutcome,
): outcome is GenerationToolDeferredResult {
  return 'deferred' in outcome && outcome.deferred === true;
}

function deferredStillMissing(result: GenerationToolDeferredResult): GenerationToolExecutionResult {
  if (result.kind === 'user_input') {
    return {
      isError: true,
      statusText: '没有收到有效回答',
      detail: 'Ask User 恢复时没有收到有效的用户答案。',
      content: 'ask_user 失败：没有收到有效的用户答案。',
    };
  }
  return {
    isError: true,
    errorCode: 'permission_denied',
    statusText: '仍未获得页面权限',
    detail: result.detail,
    content: '工具读取失败（permission_denied）：用户或 Chrome 没有授予当前网站的页面读取权限。',
    sourceOrigin: result.sourceOrigin,
    sourceTitle: result.sourceTitle,
  };
}

function currentToolActivity(
  message: ChatMessage,
): NonNullable<ChatMessage['toolActivity']> | null {
  return message.toolActivities?.at(-1) ?? message.toolActivity ?? null;
}

function syncLegacyToolActivity(
  message: ChatMessage,
  activity: NonNullable<ChatMessage['toolActivity']>,
): void {
  message.toolActivity = { ...activity };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function toolCallSignature(call: GenerationToolCall): string {
  return `${call.name}:${stableJson(call.arguments)}`;
}

function toolAttemptSignature(
  call: GenerationToolCall,
  result: GenerationToolExecutionResult,
): string {
  return `${toolCallSignature(call)}:${result.isError ? 'error' : 'success'}:${
    result.errorCode ?? ''
  }:${compactHash(result.content)}`;
}

/** FNV-1a：只用于紧凑比较工具结果，不用于安全或数据完整性。 */
function compactHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'undefined';
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function trailingIdenticalCount(signatures: string[], target: string): number {
  let count = 0;
  for (let index = signatures.length - 1; index >= 0; index -= 1) {
    if (signatures[index] !== target) break;
    count += 1;
  }
  return count;
}

function cloneGenerationInputMessages(
  messages: GenerationInputMessage[],
  includeImages = true,
): GenerationInputMessage[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      return {
        ...message,
        ...(message.toolCalls
          ? { toolCalls: message.toolCalls.map((call) => cloneToolCall(call)) }
          : {}),
      };
    }
    if (message.role === 'toolResult') {
      if (!includeImages && message.images) {
        const { images: _images, ...withoutImages } = message;
        return {
          ...withoutImages,
          content: `${message.content}\n[视觉截图未持久化；如仍需要视觉信息，请重新观察页面。]`,
        };
      }
      return {
        ...message,
        ...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}),
      };
    }
    return { ...message };
  });
}

function cloneEvent(event: ChatGenerationEvent): ChatGenerationEvent {
  return {
    ...event,
    message: cloneMessage(event.message),
  };
}

/**
 * 仅保留可能构成密钥前缀的末尾片段，下一批 delta 到来后再决定释放或擦除，
 * 防止一个密钥被厂商拆成多段返回时短暂出现在 Port 消息中。
 */
function publicContent(content: string, secret: string, terminal: boolean): string {
  if (!secret) return content;
  const redacted = content.split(secret).join('[REDACTED]');
  if (terminal) return redacted;

  const maxPrefixLength = Math.min(secret.length - 1, redacted.length);
  for (let length = maxPrefixLength; length > 0; length -= 1) {
    if (redacted.endsWith(secret.slice(0, length))) {
      return redacted.slice(0, -length);
    }
  }
  return redacted;
}

async function nextOrAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T> | typeof ABORTED> {
  if (signal.aborted) return ABORTED;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function promiseOrAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORTED> {
  if (signal.aborted) return ABORTED;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function toGenerationInputMessages(history: ChatMessage[]): GenerationInputMessage[] {
  return history.flatMap<GenerationInputMessage>((message) => {
    const content = message.content.trim();
    if (!content) return [];

    if (message.role === 'user') {
      return [{ role: 'user', content, createdAt: message.createdAt }];
    }
    if (message.error || message.status === 'error' || message.status === 'streaming') return [];

    return [
      {
        role: 'assistant',
        content,
        createdAt: message.createdAt,
        ...(message.finishReason ? { finishReason: message.finishReason } : {}),
      },
    ];
  });
}

function addUsage(current: GenerationUsage | undefined, next: GenerationUsage): GenerationUsage {
  if (!current) return { ...next };
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    cacheReadTokens: current.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + next.cacheWriteTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    cost: current.cost + next.cost,
  };
}

function closeIterator<T>(iterator: AsyncIterator<T>): void {
  if (!iterator.return) return;
  try {
    void Promise.resolve(iterator.return()).catch(() => {
      // 终态已经由 manager 决定，适配器清理失败不能再产生第二个终态。
    });
  } catch {
    // 同步清理异常同样不能覆盖已经发布的终态。
  }
}
