// ─── Service Worker 保活管理器 ───
// 职责：在 Agent 运行期间防止 MV3 Service Worker 因 30s 空闲被终止。
// 原理：通过周期性调用 chrome.runtime.getPlatformInfo() 重置空闲计时器。

const KEEP_ALIVE_INTERVAL_MS = 20_000; // 20s，小于 Chrome 30s 空闲阈值

interface KeepAliveSession {
  sessionId: string;
  acquiredAt: number;
}

class ServiceWorkerKeepAlive {
  private readonly sessions = new Map<string, KeepAliveSession>();
  private readonly refCounts = new Map<string, number>();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * 为指定会话获取保活锁。返回释放函数，必须成对调用。
   * 同一会话多次获取会合并为一次，避免重复计时。
   */
  acquire(sessionId: string): () => void {
    const currentCount = this.refCounts.get(sessionId) ?? 0;
    this.refCounts.set(sessionId, currentCount + 1);

    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, { sessionId, acquiredAt: this.now() });
      this.startIfNeeded();
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(sessionId);
    };
  }

  /**
   * 释放指定会话的保活锁。当所有会话都释放后，停止保活计时器。
   */
  release(sessionId: string): void {
    const currentCount = this.refCounts.get(sessionId) ?? 0;
    if (currentCount <= 1) {
      this.refCounts.delete(sessionId);
      this.sessions.delete(sessionId);
      if (this.sessions.size === 0) {
        this.stop();
      }
    } else {
      this.refCounts.set(sessionId, currentCount - 1);
    }
  }

  /**
   * 当前是否有活跃的保活会话。
   */
  get isActive(): boolean {
    return this.sessions.size > 0;
  }

  /**
   * 当前活跃会话数（用于诊断和测试）。
   */
  get activeCount(): number {
    return this.sessions.size;
  }

  private startIfNeeded(): void {
    if (this.intervalId !== null) return;

    this.intervalId = setInterval(() => {
      // 空操作调用，仅用于重置 Chrome 的空闲计时器
      chrome.runtime.getPlatformInfo().catch(() => {
        // 忽略错误，SW 可能正在关闭
      });
    }, KEEP_ALIVE_INTERVAL_MS);
  }

  private stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * 清理所有会话并停止计时器（用于测试或 SW 关闭前）。
   */
  dispose(): void {
    this.sessions.clear();
    this.refCounts.clear();
    this.stop();
  }
}

// 全局单例
export const keepAlive = new ServiceWorkerKeepAlive();

// 类型导出，便于测试 mock
export type { KeepAliveSession };
export { ServiceWorkerKeepAlive };
