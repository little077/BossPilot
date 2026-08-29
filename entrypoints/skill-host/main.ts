// 可信 offscreen host 仅负责桥接 sandbox postMessage 与 Background 能力代理。
import { SkillHostBridge } from '@/lib/skills/host-bridge';

const frame = document.querySelector<HTMLIFrameElement>('#skill-sandbox');
if (!frame) throw new Error('Skill sandbox iframe 缺失。');
const sandboxFrame = frame;
const bridge = new SkillHostBridge((message) => {
  const target = sandboxFrame.contentWindow;
  if (!target) throw new Error('Skill sandbox iframe 尚未就绪。');
  target.postMessage(message, '*');
});

// 模块脚本可能在 iframe load 之后才执行；立即 ping 与后续 load ping 共同消除时序竞态。
sandboxFrame.addEventListener('load', () => bridge.frameLoaded());
bridge.ping();

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isRecord(message) || message.type !== 'skill-host:run') return;
  const runId = boundedString(message.runId, 128);
  const code = boundedString(message.code, 200_000);
  if (!runId || !code) return;
  bridge.run({ runId, code, input: message.input }, sendResponse);
  return true;
});

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== sandboxFrame.contentWindow || !isRecord(event.data)) return;
  if (bridge.receive(event.data)) return;
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

function boundedString(value: unknown, maxChars: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
