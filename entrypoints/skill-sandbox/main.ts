// 该页面由 Chrome sandbox 隔离，无扩展 API；只接受可信父页面发来的单次脚本任务。
const MAX_RESULT_CHARS = 100_000;
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || !isRecord(event.data)) return;
  if (event.data.type === 'skill-sandbox:capability-result') {
    const requestId = boundedString(event.data.requestId, 128);
    if (!requestId) return;
    const deferred = pending.get(requestId);
    if (!deferred) return;
    pending.delete(requestId);
    if (event.data.ok === true) deferred.resolve(event.data.result);
    else deferred.reject(new Error(boundedString(event.data.error, 500) ?? '能力请求失败。'));
    return;
  }
  if (event.data.type !== 'skill-sandbox:run') return;
  const runId = boundedString(event.data.runId, 128);
  const code = boundedString(event.data.code, 200_000);
  if (!runId || !code) return;
  void runScript(runId, code, event.data.input);
});

async function runScript(runId: string, code: string, input: unknown): Promise<void> {
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
      ...arguments_: string[]
    ) => (...values: unknown[]) => Promise<unknown>;
    const api = Object.freeze({
      request: (capability: unknown, payload: unknown) =>
        requestCapability(runId, capability, payload),
    });
    const execute = new AsyncFunction('input', 'api', `"use strict";\n${code}`);
    const result = await execute(cloneSerializable(input), api);
    const serialized = JSON.stringify(result ?? null);
    if (serialized.length > MAX_RESULT_CHARS) throw new Error('Skill 脚本结果超过 100000 个字符。');
    window.parent.postMessage(
      { type: 'skill-sandbox:result', runId, ok: true, result: JSON.parse(serialized) },
      '*',
    );
  } catch (error) {
    window.parent.postMessage(
      {
        type: 'skill-sandbox:result',
        runId,
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 500) : 'Skill 脚本执行失败。',
      },
      '*',
    );
  }
}

function requestCapability(runId: string, capability: unknown, payload: unknown): Promise<unknown> {
  const normalized = boundedString(capability, 256);
  if (!normalized) return Promise.reject(new Error('能力名称无效。'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    window.parent.postMessage(
      {
        type: 'skill-sandbox:capability',
        runId,
        requestId,
        capability: normalized,
        payload: cloneSerializable(payload),
      },
      '*',
    );
  });
}

function cloneSerializable(value: unknown): unknown {
  const serialized = JSON.stringify(value ?? null);
  if (serialized.length > MAX_RESULT_CHARS) throw new Error('Skill 输入超过限制。');
  return JSON.parse(serialized) as unknown;
}

function boundedString(value: unknown, maxChars: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
