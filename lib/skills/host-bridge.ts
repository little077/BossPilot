// Skill Host 消息桥：以显式 ping/ready 握手派发脚本，并从收到运行请求时开始计时。

export interface SkillHostRunRequest {
  runId: string;
  code: string;
  input: unknown;
}

export type SkillHostResponse = { ok: true; result: unknown } | { ok: false; error: string };

type Respond = (response: SkillHostResponse) => void;

interface PendingRun {
  request: SkillHostRunRequest;
  respond: Respond;
  timeout: ReturnType<typeof setTimeout>;
  dispatched: boolean;
}

/**
 * iframe 的 load 事件可能在 Host 模块注册监听前已经发生，sandbox 页面也可能因
 * 隔离来源无法读取 contentDocument。因此这里只信任显式 ready 消息；ping 同时在
 * 初始化、iframe load 和每次排队时发送，任何先后顺序都能重新建立握手。
 */
export class SkillHostBridge {
  private readonly runs = new Map<string, PendingRun>();
  private ready = false;

  constructor(
    private readonly postToSandbox: (message: unknown) => void,
    private readonly timeoutMs = 5_000,
  ) {}

  ping(): void {
    this.safePost({ type: 'skill-sandbox:ping' });
  }

  frameLoaded(): void {
    this.ready = false;
    this.ping();
  }

  run(request: SkillHostRunRequest, respond: Respond): void {
    if (this.runs.has(request.runId)) {
      respond({ ok: false, error: 'Skill 运行标识重复。' });
      return;
    }
    const timeout = setTimeout(() => {
      this.finish(request.runId, { ok: false, error: 'Skill 脚本执行超过 5 秒。' });
    }, this.timeoutMs);
    this.runs.set(request.runId, { request, respond, timeout, dispatched: false });
    if (this.ready) this.dispatch(request.runId);
    else this.ping();
  }

  /** 返回 true 表示消息已由桥处理。 */
  receive(message: unknown): boolean {
    if (!isRecord(message)) return false;
    if (message.type === 'skill-sandbox:ready') {
      this.ready = true;
      for (const runId of this.runs.keys()) this.dispatch(runId);
      return true;
    }
    if (message.type !== 'skill-sandbox:result') return false;
    const runId = boundedString(message.runId, 128);
    if (!runId || !this.runs.has(runId)) return true;
    if (message.ok === true) {
      this.finish(runId, { ok: true, result: message.result });
    } else {
      this.finish(runId, {
        ok: false,
        error: boundedString(message.error, 500) ?? 'Skill 脚本失败。',
      });
    }
    return true;
  }

  private dispatch(runId: string): void {
    const pending = this.runs.get(runId);
    if (!pending || pending.dispatched) return;
    pending.dispatched = this.safePost({ type: 'skill-sandbox:run', ...pending.request });
  }

  private finish(runId: string, response: SkillHostResponse): void {
    const pending = this.runs.get(runId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.runs.delete(runId);
    pending.respond(response);
  }

  private safePost(message: unknown): boolean {
    try {
      this.postToSandbox(message);
      return true;
    } catch {
      // iframe 暂未可用时保留排队项，由 load/ready 握手或总超时完成收尾。
      return false;
    }
  }
}

function boundedString(value: unknown, maxChars: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
