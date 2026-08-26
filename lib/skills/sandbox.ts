// Skill 脚本宿主：脚本只在 Chrome sandbox 页运行，本模块是唯一受控能力代理。
import type { SkillCapability } from '@/lib/skills/types';
import { WorkspaceStore } from '@/lib/workspace/storage';

const MAX_SCRIPT_CHARS = 200_000;
const MAX_INPUT_CHARS = 100_000;
const MAX_NETWORK_RESULT_CHARS = 200_000;
let offscreenCreation: Promise<void> | null = null;

interface ActiveSkillRun {
  conversationId: string;
  capabilities: Set<SkillCapability>;
}

export interface SkillHostClient {
  run(message: { runId: string; code: string; input: unknown }): Promise<unknown>;
}

export class ChromeSkillHostClient implements SkillHostClient {
  async run(message: { runId: string; code: string; input: unknown }): Promise<unknown> {
    await ensureOffscreenHost();
    const response: unknown = await chrome.runtime.sendMessage({
      type: 'skill-host:run',
      ...message,
    });
    if (!isRecord(response) || typeof response.ok !== 'boolean') {
      throw new Error('Skill 沙箱返回了无效结果。');
    }
    if (!response.ok) throw new Error(boundedString(response.error, 500) ?? 'Skill 沙箱执行失败。');
    return cloneSerializable(response.result, MAX_INPUT_CHARS);
  }
}

export class SkillSandboxRunner {
  private readonly active = new Map<string, ActiveSkillRun>();

  constructor(
    private readonly host: SkillHostClient = new ChromeSkillHostClient(),
    private readonly workspace: WorkspaceStore = new WorkspaceStore(),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async run(
    conversationId: string,
    code: string,
    input: unknown,
    capabilities: SkillCapability[],
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (!code || code.length > MAX_SCRIPT_CHARS) throw new Error('Skill 脚本为空或超过限制。');
    const safeInput = cloneSerializable(input, MAX_INPUT_CHARS);
    const runId = crypto.randomUUID();
    this.active.set(runId, { conversationId, capabilities: new Set(capabilities) });
    try {
      const result = await Promise.race([
        this.host.run({ runId, code, input: safeInput }),
        abortPromise(signal),
      ]);
      return cloneSerializable(result, MAX_INPUT_CHARS);
    } finally {
      this.active.delete(runId);
    }
  }

  async handleCapabilityRequest(
    message: unknown,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    try {
      if (!isCapabilityRequest(message)) throw new Error('Skill 能力请求无效。');
      const active = this.active.get(message.runId);
      if (!active) throw new Error('Skill 运行已经结束。');
      if (!active.capabilities.has(message.capability as SkillCapability)) {
        throw new Error('Skill 没有获得该能力授权。');
      }
      const result = await this.executeCapability(
        active,
        message.capability as SkillCapability,
        message.payload,
      );
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Skill 能力调用失败。' };
    }
  }

  private async executeCapability(
    active: ActiveSkillRun,
    capability: SkillCapability,
    payload: unknown,
  ): Promise<unknown> {
    if (!isRecord(payload)) throw new Error('Skill 能力参数无效。');
    if (capability === 'workspace.read') {
      const path = boundedString(payload.path, 512);
      if (!path) throw new Error('工作区读取路径无效。');
      const file = await this.workspace.read(active.conversationId, path);
      return { path: file.path, mimeType: file.mimeType, size: file.size, content: file.content };
    }
    if (capability === 'workspace.write') {
      const operation = boundedString(payload.operation, 16) ?? 'write';
      const path = boundedString(payload.path, 512);
      if (!path) throw new Error('工作区写入路径无效。');
      if (operation === 'mkdir') return this.workspace.createDirectory(active.conversationId, path);
      if (operation !== 'write') throw new Error('Skill 工作区写入操作不受支持。');
      const content = typeof payload.content === 'string' ? payload.content : undefined;
      if (content === undefined || content.length > 2_000_000)
        throw new Error('Skill 写入内容无效或过大。');
      if (payload.overwrite === true) {
        throw new Error('Skill 脚本不能直接覆盖已有文件，请改用可逐次确认的工作区工具。');
      }
      return this.workspace.write(active.conversationId, path, content, {
        mimeType: boundedString(payload.mimeType, 128),
      });
    }
    if (capability.startsWith('network:')) {
      const urlText = boundedString(payload.url, 2_048);
      if (!urlText) throw new Error('网络 URL 无效。');
      const url = new URL(urlText);
      const allowedOrigin = capability.slice('network:'.length);
      if (url.origin !== allowedOrigin || url.protocol !== 'https:') {
        throw new Error('网络请求超出 Skill 声明的 HTTPS 来源。');
      }
      const pattern = `${url.origin}/*`;
      if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
        throw new Error('Chrome 尚未授予该网络来源权限，请先在设置中授权。');
      }
      const response = await this.fetcher(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
      });
      const body = (await response.text()).slice(0, MAX_NETWORK_RESULT_CHARS);
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body,
      };
    }
    throw new Error('该能力将在 v1.4 浏览器工具箱中开放。');
  }
}

async function ensureOffscreenHost(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  offscreenCreation ??= chrome.offscreen
    .createDocument({
      url: chrome.runtime.getURL('skill-host.html'),
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: '在无 UI 的可信桥接页中托管隔离的 Skill sandbox iframe。',
    })
    .finally(() => {
      offscreenCreation = null;
    });
  await offscreenCreation;
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function cloneSerializable(value: unknown, maxChars: number): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value ?? null);
  } catch {
    throw new Error('Skill 数据必须可以序列化。');
  }
  if (serialized.length > maxChars) throw new Error('Skill 数据超过大小限制。');
  return JSON.parse(serialized) as unknown;
}

function isCapabilityRequest(value: unknown): value is {
  type: 'skill-capability:request';
  runId: string;
  capability: string;
  payload: unknown;
} {
  return (
    isRecord(value) &&
    value.type === 'skill-capability:request' &&
    Boolean(boundedString(value.runId, 128)) &&
    Boolean(boundedString(value.capability, 256))
  );
}

function boundedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replaceAll('\u0000', '').trim();
  return normalized && normalized.length <= maxChars ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
