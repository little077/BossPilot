import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, GenerationUsage } from '@/lib/domain/chat';
import { GenerationError } from '@/lib/generation/errors';
import { type ChatGenerationEvent, ChatGenerationManager } from '@/lib/generation/manager';
import type {
  GenerationAdapter,
  GenerationEvent,
  GenerationRequest,
  GenerationToolDefinition,
  GenerationToolExecutor,
  ResolvedGenerationTarget,
} from '@/lib/generation/types';

const USAGE: GenerationUsage = {
  inputTokens: 4,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 6,
  cost: 0.001,
};

const HISTORY: ChatMessage[] = [
  {
    id: 'user-1',
    role: 'user',
    content: '你好',
    createdAt: 10,
  },
];

const READ_JOB_TOOL: GenerationToolDefinition = {
  name: 'read_current_job',
  label: '读取当前岗位',
  description: '读取当前岗位',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

function target(
  providerId = 'openai',
  modelId = 'gpt-test',
  apiKey = 'sk-private-test-value',
): ResolvedGenerationTarget {
  return {
    identity: { providerId, modelId },
    providerLabel: providerId,
    modelName: modelId,
    protocol: 'openai-completions',
    baseUrl: `https://${providerId}.example/v1`,
    apiKey,
  };
}

function adapterFrom(
  stream: (target: ResolvedGenerationTarget, signal: AbortSignal) => AsyncIterable<GenerationEvent>,
): GenerationAdapter {
  return {
    stream: (resolvedTarget, request) => stream(resolvedTarget, request.signal),
  };
}

function createManager(
  adapter: GenerationAdapter,
  resolveTarget: () => ResolvedGenerationTarget | Promise<ResolvedGenerationTarget> = () =>
    target(),
  runtimeOptions: {
    maxOutputChars?: number;
    streamUpdateIntervalMs?: number;
    tools?: GenerationToolDefinition[];
    executeTool?: GenerationToolExecutor;
  } = {},
) {
  return new ChatGenerationManager({
    adapter,
    resolveTarget,
    createMessageId: () => 'assistant-1',
    now: () => 20,
    systemPrompt: 'system',
    streamUpdateIntervalMs: 0,
    ...runtimeOptions,
  });
}

function collect(manager: ChatGenerationManager): ChatGenerationEvent[] {
  const events: ChatGenerationEvent[] = [];
  manager.subscribe((event) => events.push(event));
  return events;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => void 0;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition was not met');
}

describe('ChatGenerationManager', () => {
  it('emits complete immutable snapshots for a normal streaming round', async () => {
    const seenHistory: GenerationRequest['messages'][] = [];
    const adapter: GenerationAdapter = {
      async *stream(_target, request) {
        seenHistory.push(request.messages);
        yield { type: 'start' };
        yield { type: 'text-delta', delta: '你' };
        yield { type: 'text-delta', delta: '好' };
        yield { type: 'finish', reason: 'stop', usage: USAGE };
      },
    };
    const manager = createManager(adapter);
    const events = collect(manager);

    const result = await manager.start('request-1', HISTORY);

    expect(events.map(({ type }) => type)).toEqual(['start', 'update', 'update', 'end']);
    expect(events.map(({ message }) => message.content)).toEqual(['', '你', '你好', '你好']);
    expect(events[1]?.message).toMatchObject({
      id: 'assistant-1',
      role: 'assistant',
      createdAt: 20,
      status: 'streaming',
      modelIdentity: { providerId: 'openai', modelId: 'gpt-test' },
    });
    expect(result).toMatchObject({
      content: '你好',
      status: 'completed',
      finishReason: 'stop',
      usage: USAGE,
    });
    expect(seenHistory[0]).not.toBe(HISTORY);
    expect(seenHistory[0]?.[0]).not.toBe(HISTORY[0]);

    const terminalEvent = events[3];
    expect(terminalEvent).toBeDefined();
    if (terminalEvent) terminalEvent.message.content = '被订阅方篡改';
    expect(manager.getSnapshot()?.message.content).toBe('你好');
  });

  it('executes exactly one tool and continues with a second model request', async () => {
    const requests: GenerationRequest[] = [];
    const executeTool = vi.fn<GenerationToolExecutor>().mockResolvedValue({
      isError: false,
      statusText: '已读取当前岗位',
      detail: '岗位描述 1200 字',
      content: '<untrusted_job_page_data>{"description":"React"}</untrusted_job_page_data>',
    });
    const adapter: GenerationAdapter = {
      async *stream(_target, request) {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            type: 'tool-call',
            toolCall: { id: 'call-1', name: 'read_current_job', arguments: {} },
          };
          yield { type: 'finish', reason: 'tool', usage: USAGE };
          return;
        }
        yield { type: 'text-delta', delta: '这个岗位要求熟悉 React。' };
        yield { type: 'finish', reason: 'stop', usage: USAGE };
      },
    };
    const manager = createManager(adapter, () => target(), {
      tools: [READ_JOB_TOOL],
      executeTool,
    });
    const events = collect(manager);

    const result = await manager.start('request-tool', HISTORY);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools).toEqual([READ_JOB_TOOL]);
    expect(requests[1]?.tools).toBeUndefined();
    expect(requests[1]?.messages).toContainEqual({
      role: 'assistant',
      content: '',
      createdAt: 20,
      finishReason: 'tool',
      toolCalls: [{ id: 'call-1', name: 'read_current_job', arguments: {} }],
    });
    expect(requests[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read_current_job',
        isError: false,
      }),
    );
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      content: '这个岗位要求熟悉 React。',
      status: 'completed',
      finishReason: 'stop',
      usage: {
        inputTokens: 8,
        outputTokens: 4,
        totalTokens: 12,
        cost: 0.002,
      },
      reasoningActivity: {
        status: 'completed',
        summary: '已判断需要读取当前页面',
      },
      toolActivity: {
        name: 'read_current_job',
        status: 'succeeded',
        statusText: '已读取当前岗位',
      },
    });
    expect(events.some(({ message }) => message.toolActivity?.status === 'running')).toBe(true);
    expect(events.some(({ message }) => message.toolActivity?.status === 'succeeded')).toBe(true);
  });

  it('lets the model explain a deterministic tool failure without inventing page data', async () => {
    let requestCount = 0;
    const adapter: GenerationAdapter = {
      async *stream() {
        requestCount += 1;
        if (requestCount === 1) {
          yield {
            type: 'tool-call',
            toolCall: { id: 'call-1', name: 'read_current_job', arguments: {} },
          };
          yield { type: 'finish', reason: 'tool', usage: USAGE };
          return;
        }
        yield { type: 'text-delta', delta: '请先打开一个 Boss 直聘岗位详情页。' };
        yield { type: 'finish', reason: 'stop', usage: USAGE };
      },
    };
    const manager = createManager(adapter, () => target(), {
      tools: [READ_JOB_TOOL],
      executeTool: async () => ({
        isError: true,
        errorCode: 'NOT_ON_JOB_PAGE',
        statusText: '当前不是岗位详情页',
        content: '工具读取失败（NOT_ON_JOB_PAGE）',
      }),
    });

    await expect(manager.start('request-tool-error', HISTORY)).resolves.toMatchObject({
      content: '请先打开一个 Boss 直聘岗位详情页。',
      status: 'completed',
      toolActivity: {
        status: 'failed',
        errorCode: 'NOT_ON_JOB_PAGE',
      },
    });
    expect(requestCount).toBe(2);
  });

  it('treats an executor cancellation result as the only terminal state', async () => {
    const adapter = adapterFrom(async function* () {
      yield {
        type: 'tool-call',
        toolCall: { id: 'call-1', name: 'read_current_job', arguments: {} },
      };
      yield { type: 'finish', reason: 'tool', usage: USAGE };
    });
    const manager = createManager(adapter, () => target(), {
      tools: [READ_JOB_TOOL],
      executeTool: async () => ({
        isError: true,
        errorCode: 'CANCELLED',
        statusText: '已停止读取当前岗位',
        content: '用户取消了读取',
      }),
    });

    await expect(manager.start('request-tool-cancelled-result', HISTORY)).resolves.toMatchObject({
      status: 'cancelled',
      finishReason: 'cancelled',
    });
  });

  it('cancels during page reading and ignores the late tool result', async () => {
    const toolResult = deferred<{
      isError: false;
      statusText: string;
      content: string;
    }>();
    const adapter: GenerationAdapter = {
      async *stream() {
        yield {
          type: 'tool-call',
          toolCall: { id: 'call-1', name: 'read_current_job', arguments: {} },
        };
        yield { type: 'finish', reason: 'tool', usage: USAGE };
      },
    };
    const manager = createManager(adapter, () => target(), {
      tools: [READ_JOB_TOOL],
      executeTool: () => toolResult.promise,
    });
    const resultPromise = manager.start('request-tool-cancel', HISTORY);

    await waitFor(() => manager.getSnapshot()?.message.toolActivity?.status === 'running');
    expect(manager.stop('request-tool-cancel')).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({
      status: 'cancelled',
      toolActivity: {
        status: 'cancelled',
        errorCode: 'CANCELLED',
      },
    });

    toolResult.resolve({ isError: false, statusText: '晚到结果', content: 'late' });
    await Promise.resolve();
    expect(manager.getSnapshot()?.message.toolActivity?.status).toBe('cancelled');
  });

  it('rejects a second tool request after the one-call budget is consumed', async () => {
    let requestCount = 0;
    const adapter: GenerationAdapter = {
      async *stream() {
        requestCount += 1;
        yield {
          type: 'tool-call',
          toolCall: {
            id: `call-${requestCount}`,
            name: 'read_current_job',
            arguments: {},
          },
        };
        yield { type: 'finish', reason: 'tool', usage: USAGE };
      },
    };
    const manager = createManager(adapter, () => target(), {
      tools: [READ_JOB_TOOL],
      executeTool: async () => ({
        isError: false,
        statusText: '已读取当前岗位',
        content: '岗位资料',
      }),
    });

    await expect(manager.start('request-second-tool', HISTORY)).resolves.toMatchObject({
      status: 'error',
      errorCode: 'INVALID_RESPONSE',
      errorMessage: expect.stringContaining('不能继续调用'),
    });
    expect(requestCount).toBe(2);
  });

  it('rejects malformed tool termination sequences', async () => {
    const missingCall = adapterFrom(async function* () {
      yield { type: 'finish', reason: 'tool', usage: USAGE };
    });
    const missingCallManager = createManager(missingCall, () => target(), {
      tools: [READ_JOB_TOOL],
      executeTool: async () => ({
        isError: false,
        statusText: 'unused',
        content: 'unused',
      }),
    });
    await expect(missingCallManager.start('request-missing-call', HISTORY)).resolves.toMatchObject({
      status: 'error',
      errorCode: 'INVALID_RESPONSE',
    });

    const unfinishedCall = adapterFrom(async function* () {
      yield {
        type: 'tool-call',
        toolCall: { id: 'call-1', name: 'read_current_job', arguments: {} },
      };
      yield { type: 'finish', reason: 'stop', usage: USAGE };
    });
    const unfinishedCallManager = createManager(unfinishedCall, () => target(), {
      tools: [READ_JOB_TOOL],
      executeTool: async () => ({
        isError: false,
        statusText: 'unused',
        content: 'unused',
      }),
    });
    await expect(
      unfinishedCallManager.start('request-unfinished-call', HISTORY),
    ).resolves.toMatchObject({
      status: 'error',
      errorCode: 'INVALID_RESPONSE',
    });
  });

  it('rejects unknown or repeated tool calls without executing them', async () => {
    const executeTool = vi.fn<GenerationToolExecutor>();
    const unknown = adapterFrom(async function* () {
      yield {
        type: 'tool-call',
        toolCall: { id: 'call-1', name: 'search_jobs', arguments: {} },
      };
      yield { type: 'finish', reason: 'tool', usage: USAGE };
    });
    const unknownManager = createManager(unknown, () => target(), {
      tools: [READ_JOB_TOOL],
      executeTool,
    });
    await expect(unknownManager.start('request-unknown', HISTORY)).resolves.toMatchObject({
      status: 'error',
      errorCode: 'INVALID_RESPONSE',
    });

    const repeated = adapterFrom(async function* () {
      yield {
        type: 'tool-call',
        toolCall: { id: 'call-1', name: 'read_current_job', arguments: {} },
      };
      yield {
        type: 'tool-call',
        toolCall: { id: 'call-2', name: 'read_current_job', arguments: {} },
      };
    });
    const repeatedManager = createManager(repeated, () => target(), {
      tools: [READ_JOB_TOOL],
      executeTool,
    });
    await expect(repeatedManager.start('request-repeat', HISTORY)).resolves.toMatchObject({
      status: 'error',
      errorCode: 'INVALID_RESPONSE',
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('rejects a concurrent round with BUSY while preserving the first round', async () => {
    const release = deferred<void>();
    const adapter = adapterFrom(async function* () {
      yield { type: 'text-delta', delta: '第一轮' };
      await release.promise;
      yield { type: 'finish', reason: 'stop', usage: USAGE };
    });
    const manager = createManager(adapter);
    const first = manager.start('request-1', HISTORY);

    await waitFor(() => manager.getSnapshot()?.type === 'update');
    const secondError = await manager.start('request-2', HISTORY).catch((error: unknown) => error);
    expect(secondError).toBeInstanceOf(GenerationError);
    expect((secondError as GenerationError).code).toBe('BUSY');
    expect(manager.currentRequestId).toBe('request-1');

    release.resolve();
    await expect(first).resolves.toMatchObject({ content: '第一轮', status: 'completed' });
  });

  it('freezes the resolved model for each round and picks up a switch on the next round', async () => {
    let selected = target('openai', 'gpt-first');
    const usedTargets: ResolvedGenerationTarget[] = [];
    const adapter: GenerationAdapter = {
      async *stream(resolvedTarget) {
        usedTargets.push(resolvedTarget);
        yield { type: 'finish', reason: 'stop', usage: USAGE };
      },
    };
    const manager = createManager(adapter, () => selected);
    const events = collect(manager);

    const first = manager.start('request-1', HISTORY);
    selected.identity.modelId = 'mutated-outside';
    await first;
    selected = target('anthropic', 'claude-next');
    await manager.start('request-2', HISTORY);

    expect(usedTargets.map(({ identity }) => identity)).toEqual([
      { providerId: 'openai', modelId: 'gpt-first' },
      { providerId: 'anthropic', modelId: 'claude-next' },
    ]);
    expect(
      events.filter(({ type }) => type === 'start').map(({ message }) => message.modelIdentity),
    ).toEqual([
      { providerId: 'openai', modelId: 'gpt-first' },
      { providerId: 'anthropic', modelId: 'claude-next' },
    ]);
  });

  it('cancels only the exact request, keeps partial text, and emits one terminal event', async () => {
    const never = deferred<void>();
    const adapter = adapterFrom(async function* () {
      yield { type: 'text-delta', delta: '已生成部分' };
      await never.promise;
    });
    const manager = createManager(adapter);
    const events = collect(manager);
    const resultPromise = manager.start('request-1', HISTORY);

    await waitFor(() => manager.getSnapshot()?.type === 'update');
    expect(manager.stop('other-request')).toBe(false);
    expect(manager.stop('request-1')).toBe(true);
    expect(manager.cancel('request-1')).toBe(true);

    await expect(resultPromise).resolves.toMatchObject({
      content: '已生成部分',
      status: 'cancelled',
      finishReason: 'cancelled',
    });
    expect(events.filter(({ type }) => type === 'end')).toHaveLength(1);
    expect(events.filter(({ type }) => type === 'error')).toHaveLength(0);
    expect(manager.stop('request-1')).toBe(false);
  });

  it('accepts an adapter cancellation finish with its usage snapshot', async () => {
    const adapter = adapterFrom(async function* () {
      yield { type: 'text-delta', delta: '厂商返回的部分内容' };
      yield { type: 'finish', reason: 'cancelled', usage: USAGE };
    });
    const manager = createManager(adapter);

    await expect(manager.start('request-1', HISTORY)).resolves.toMatchObject({
      content: '厂商返回的部分内容',
      status: 'cancelled',
      finishReason: 'cancelled',
      usage: USAGE,
    });
  });

  it('keeps partial text and sanitizes a streaming error separately', async () => {
    const secret = 'sk-private-test-value';
    const adapter = adapterFrom(async function* () {
      yield { type: 'text-delta', delta: '可保留正文' };
      throw new Error(`upstream rejected apiKey=${secret}`);
    });
    const manager = createManager(adapter, () => target('openai', 'gpt-test', secret));
    const events = collect(manager);

    const result = await manager.start('request-1', HISTORY);

    expect(result).toMatchObject({
      content: '可保留正文',
      status: 'error',
      error: true,
    });
    expect(result.errorMessage).not.toContain(secret);
    expect(events.filter(({ type }) => type === 'error')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('throws a sanitized resolver error without publishing an empty assistant', async () => {
    const secret = 'sk-resolver-secret-value';
    const adapter = adapterFrom(async function* () {
      yield { type: 'finish', reason: 'stop', usage: USAGE };
    });
    const manager = createManager(adapter, async () => {
      throw new Error(`apiKey=${secret}`);
    });
    const events = collect(manager);

    const error = await manager.start('request-1', HISTORY).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(GenerationError);
    expect((error as Error).message).not.toContain(secret);
    expect(events).toEqual([]);
    expect(manager.getSnapshot()).toBeNull();
    expect(manager.isRunning).toBe(false);
  });

  it('replays the latest snapshot, supports unsubscribe, and clears only terminal replay', async () => {
    const release = deferred<void>();
    const adapter = adapterFrom(async function* () {
      yield { type: 'text-delta', delta: '回放内容' };
      await release.promise;
      yield { type: 'finish', reason: 'stop', usage: USAGE };
    });
    const manager = createManager(adapter);
    const first = manager.start('request-1', HISTORY);
    await waitFor(() => manager.getSnapshot()?.type === 'update');

    manager.clearReplay();
    const duringStream: ChatGenerationEvent[] = [];
    const unsubscribe = manager.subscribe((event) => duringStream.push(event));
    expect(duringStream).toHaveLength(1);
    expect(duringStream[0]).toMatchObject({
      type: 'update',
      requestId: 'request-1',
      message: { content: '回放内容', status: 'streaming' },
    });

    unsubscribe();
    release.resolve();
    await first;
    expect(duringStream).toHaveLength(1);

    const afterTerminal: ChatGenerationEvent[] = [];
    manager.subscribe((event) => afterTerminal.push(event));
    expect(afterTerminal[0]?.type).toBe('end');
    manager.clearReplay();
    expect(manager.getSnapshot()).toBeNull();
    const afterClear = vi.fn();
    manager.subscribe(afterClear);
    expect(afterClear).not.toHaveBeenCalled();
  });

  it('does not revive an old terminal while the next target is resolving', async () => {
    const targetResolution = deferred<ResolvedGenerationTarget>();
    let resolveCalls = 0;
    const adapter = adapterFrom(async function* () {
      yield { type: 'finish', reason: 'stop', usage: USAGE };
    });
    const manager = createManager(adapter, () => {
      resolveCalls += 1;
      return resolveCalls === 1 ? target() : targetResolution.promise;
    });

    await manager.start('request-1', HISTORY);
    expect(manager.getSnapshot()?.requestId).toBe('request-1');
    const second = manager.start('request-2', HISTORY);
    expect(manager.getSnapshot()).toBeNull();
    const listener = vi.fn();
    manager.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();

    targetResolution.resolve(target('gemini', 'gemini-next'));
    await second;
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'start', requestId: 'request-2' }),
    );
  });

  it('turns a premature EOF into one INVALID_RESPONSE terminal error', async () => {
    const adapter = adapterFrom(async function* () {
      yield { type: 'text-delta', delta: '不完整' };
    });
    const manager = createManager(adapter);
    const events = collect(manager);

    const result = await manager.start('request-1', HISTORY);

    expect(result).toMatchObject({
      content: '不完整',
      status: 'error',
      error: true,
    });
    expect(events.filter(({ type }) => type === 'error')).toHaveLength(1);
  });

  it('never publishes an API key even when it is split across deltas', async () => {
    const secret = 'private-key';
    const adapter = adapterFrom(async function* () {
      yield { type: 'text-delta', delta: 'answer private-' };
      yield { type: 'text-delta', delta: 'key done' };
      yield { type: 'finish', reason: 'stop', usage: USAGE };
    });
    const manager = createManager(adapter, () => target('custom', 'model', secret));
    const events = collect(manager);

    const result = await manager.start('request-1', HISTORY);

    expect(result.content).toBe('answer [REDACTED] done');
    expect(events.map(({ message }) => message.content)).toEqual([
      '',
      'answer ',
      'answer [REDACTED] done',
      'answer [REDACTED] done',
    ]);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('coalesces rapid full-snapshot updates while still publishing the terminal immediately', async () => {
    const adapter = adapterFrom(async function* () {
      for (let index = 0; index < 200; index += 1) {
        yield { type: 'text-delta', delta: 'x' };
      }
      yield { type: 'finish', reason: 'stop', usage: USAGE };
    });
    const manager = createManager(adapter, () => target(), {
      streamUpdateIntervalMs: 50,
    });
    const events = collect(manager);

    const result = await manager.start('request-1', HISTORY);

    expect(events.map(({ type }) => type)).toEqual(['start', 'update', 'end']);
    expect(events[1]?.message.content).toBe('x');
    expect(result.content).toBe('x'.repeat(200));
  });

  it('flushes the latest queued snapshot once the update interval elapses', async () => {
    vi.useFakeTimers();
    const waiting = deferred<void>();
    const release = deferred<void>();
    try {
      const adapter = adapterFrom(async function* () {
        yield { type: 'text-delta', delta: 'a' };
        yield { type: 'text-delta', delta: 'b' };
        waiting.resolve();
        await release.promise;
        yield { type: 'finish', reason: 'stop', usage: USAGE };
      });
      const manager = createManager(adapter, () => target(), {
        streamUpdateIntervalMs: 50,
      });
      const events = collect(manager);
      const resultPromise = manager.start('request-1', HISTORY);

      await waiting.promise;
      expect(
        events.filter(({ type }) => type === 'update').map(({ message }) => message.content),
      ).toEqual(['a']);

      await vi.advanceTimersByTimeAsync(50);
      expect(
        events.filter(({ type }) => type === 'update').map(({ message }) => message.content),
      ).toEqual(['a', 'ab']);

      release.resolve();
      await expect(resultPromise).resolves.toMatchObject({ content: 'ab', status: 'completed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops an upstream that ignores maxTokens at the hard output character limit', async () => {
    let iteratorClosed = false;
    let upstreamSignal: AbortSignal | undefined;
    const adapter = adapterFrom(async function* (_target, signal) {
      upstreamSignal = signal;
      try {
        yield { type: 'text-delta', delta: 'abc' };
        yield { type: 'text-delta', delta: 'def' };
        yield { type: 'finish', reason: 'stop', usage: USAGE };
      } finally {
        iteratorClosed = true;
      }
    });
    const manager = createManager(adapter, () => target(), { maxOutputChars: 5 });
    const events = collect(manager);

    const result = await manager.start('request-1', HISTORY);
    await waitFor(() => iteratorClosed);

    expect(result).toMatchObject({
      content: 'abcde',
      status: 'error',
      error: true,
      errorCode: 'OUTPUT_LIMIT_EXCEEDED',
      retryable: false,
    });
    expect(events.map(({ type }) => type)).toEqual(['start', 'update', 'error']);
    expect(events.at(-1)?.message.content).toBe('abcde');
    expect(upstreamSignal?.aborted).toBe(true);
    expect(iteratorClosed).toBe(true);
  });
});
