// 可信 offscreen host 仅负责桥接 sandbox postMessage 与 Background 能力代理。
const frame = document.querySelector<HTMLIFrameElement>('#skill-sandbox');
if (!frame) throw new Error('Skill sandbox iframe 缺失。');
const sandboxFrame = frame;
const ready = new Promise<void>((resolve) => {
  if (sandboxFrame.contentDocument?.readyState === 'complete') resolve();
  else sandboxFrame.addEventListener('load', () => resolve(), { once: true });
});
const callbacks = new Map<
  string,
  { resolve: (value: SkillHostResponse) => void; timeout: ReturnType<typeof setTimeout> }
>();

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isRecord(message) || message.type !== 'skill-host:run') return;
  const runId = boundedString(message.runId, 128);
  const code = boundedString(message.code, 200_000);
  if (!runId || !code) return;
  void ready.then(() => {
    const timeout = setTimeout(() => {
      callbacks.delete(runId);
      sendResponse({ ok: false, error: 'Skill 脚本执行超过 5 秒。' } satisfies SkillHostResponse);
    }, 5_000);
    callbacks.set(runId, { resolve: sendResponse, timeout });
    sandboxFrame.contentWindow?.postMessage(
      { type: 'skill-sandbox:run', runId, code, input: message.input },
      '*',
    );
  });
  return true;
});

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== sandboxFrame.contentWindow || !isRecord(event.data)) return;
  if (event.data.type === 'skill-sandbox:result') {
    const runId = boundedString(event.data.runId, 128);
    if (!runId) return;
    const callback = callbacks.get(runId);
    if (!callback) return;
    clearTimeout(callback.timeout);
    callbacks.delete(runId);
    callback.resolve(
      event.data.ok === true
        ? { ok: true, result: event.data.result }
        : { ok: false, error: boundedString(event.data.error, 500) ?? 'Skill 脚本失败。' },
    );
    return;
  }
  if (event.data.type === 'skill-sandbox:capability') void proxyCapability(event.data);
});

async function proxyCapability(message: Record<string, unknown>): Promise<void> {
  const runId = boundedString(message.runId, 128);
  const requestId = boundedString(message.requestId, 128);
  const capability = boundedString(message.capability, 256);
  if (!runId || !requestId || !capability) return;
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage({
      type: 'skill-capability:request',
      runId,
      requestId,
      capability,
      payload: message.payload,
    });
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : '能力代理失败。' };
  }
  sandboxFrame.contentWindow?.postMessage(
    {
      type: 'skill-sandbox:capability-result',
      requestId,
      ...(isRecord(response) ? response : { ok: false }),
    },
    '*',
  );
}

type SkillHostResponse = { ok: true; result: unknown } | { ok: false; error: string };

function boundedString(value: unknown, maxChars: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
