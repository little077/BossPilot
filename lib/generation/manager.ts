// ─── 对话生成会话管理器 ───
// 职责：固定单轮模型、串行化生成、保存可重放的完整消息快照，并统一收口取消与错误终态。

import type { ChatMessage, GenerationUsage } from '@/lib/domain/chat';
import { GenerationError, isAbortError, sanitizeGenerationError } from '@/lib/generation/errors';
import type {
  GenerationAdapter,
  GenerationEvent,
  GenerationInputMessage,
  GenerationToolCall,
  GenerationToolDefinition,
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
  /** 当前里程碑开放只读页面工具；Manager 硬性限制一轮最多执行一次。 */
  tools?: GenerationToolDefinition[];
  executeTool?: GenerationToolExecutor;
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
}

const ABORTED = Symbol('generation-aborted');
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_STREAM_UPDATE_INTERVAL_MS = 50;

type StreamOutcome =
  | { kind: 'tool'; toolCall: GenerationToolCall }
  | { kind: 'terminal'; message: ChatMessage };

export class ChatGenerationManager {
  private readonly listeners = new Set<ChatGenerationListener>();
  private readonly createMessageId: () => string;
  private readonly now: () => number;
  private readonly maxOutputChars: number;
  private readonly streamUpdateIntervalMs: number;
  private active?: ActiveTurn;
  private replay?: ChatGenerationEvent;

  constructor(private readonly options: ChatGenerationManagerOptions) {
    this.createMessageId = options.createMessageId ?? (() => crypto.randomUUID());
    this.now = options.now ?? Date.now;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.streamUpdateIntervalMs =
      options.streamUpdateIntervalMs ?? DEFAULT_STREAM_UPDATE_INTERVAL_MS;
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
        summary: '正在判断是否需要读取当前页面',
        startedAt: this.now(),
      },
    };
    this.publish(turn, 'start');

    if (turn.controller.signal.aborted) {
      return this.finishCancelled(turn);
    }

    try {
      const inputMessages = toGenerationInputMessages(history);
      const first = await this.runGeneration(turn, target, inputMessages, this.options.tools);
      if (first.kind === 'terminal') return first.message;

      const toolDefinition = this.options.tools?.find(
        (candidate) => candidate.name === first.toolCall.name,
      );
      if (!toolDefinition || !this.options.executeTool) {
        return this.finishError(
          turn,
          new GenerationError(
            'INVALID_RESPONSE',
            `模型请求了未开放的工具：${first.toolCall.name}`,
            false,
          ),
        );
      }

      this.beginToolActivity(turn, first.toolCall, toolDefinition);
      const execution = await promiseOrAbort(
        this.options.executeTool(first.toolCall, turn.controller.signal),
        turn.controller.signal,
      );
      if (execution === ABORTED) return this.finishCancelled(turn);
      if (execution.errorCode === 'CANCELLED') return this.finishCancelled(turn);

      this.finishToolActivity(turn, execution);
      const toolMessages: GenerationInputMessage[] = [
        ...inputMessages,
        {
          role: 'assistant',
          content: turn.rawContent,
          createdAt: requireMessage(turn).createdAt,
          finishReason: 'tool',
          toolCalls: [first.toolCall],
        },
        {
          role: 'toolResult',
          toolCallId: first.toolCall.id,
          toolName: first.toolCall.name,
          content: execution.content,
          isError: execution.isError,
          createdAt: this.now(),
        },
      ];

      const second = await this.runGeneration(turn, target, toolMessages);
      if (second.kind === 'tool') {
        return this.finishError(
          turn,
          new GenerationError(
            'INVALID_RESPONSE',
            '本轮已完成一次工具调用，不能继续调用其他工具。',
            false,
          ),
        );
      }
      return second.message;
    } catch (error) {
      if (turn.controller.signal.aborted || isAbortError(error)) {
        return this.finishCancelled(turn);
      }
      return this.finishError(turn, error);
    }
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
        this.completeReasoning(turn, '已判断需要读取当前页面');
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
    requireMessage(turn).toolActivity = {
      callId: call.id,
      name: definition.name,
      label: definition.label,
      status: 'running',
      statusText: `正在${definition.label}`,
      startedAt: this.now(),
    };
    this.publish(turn, 'update');
  }

  private finishToolActivity(turn: ActiveTurn, execution: GenerationToolExecutionResult): void {
    const activity = requireMessage(turn).toolActivity;
    if (!activity) return;
    activity.status = execution.isError ? 'failed' : 'succeeded';
    activity.statusText = execution.statusText;
    activity.finishedAt = this.now();
    if (execution.detail) activity.detail = execution.detail;
    if (execution.errorCode) activity.errorCode = execution.errorCode;
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
    return this.publishTerminal(turn, 'end');
  }

  private finishCancelled(turn: ActiveTurn, usage?: GenerationUsage): ChatMessage {
    const message = requireMessage(turn);
    if (message.reasoningActivity?.status === 'running') {
      message.reasoningActivity.status = 'cancelled';
      message.reasoningActivity.summary = '已停止问题分析';
      message.reasoningActivity.finishedAt = this.now();
    }
    if (message.toolActivity?.status === 'running') {
      message.toolActivity.status = 'cancelled';
      message.toolActivity.statusText = `已停止${message.toolActivity.label}`;
      message.toolActivity.errorCode = 'CANCELLED';
      message.toolActivity.finishedAt = this.now();
    }
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
    if (message.toolActivity?.status === 'running') {
      message.toolActivity.status = 'failed';
      message.toolActivity.statusText = `${message.toolActivity.label}时发生错误`;
      message.toolActivity.finishedAt = this.now();
    }
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
  };
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
