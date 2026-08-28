// ─── 浏览器资源锁 ───
// 职责：把会争用同一标签页或浏览器焦点的异步操作串行化，并允许等待中的任务被取消。

export class BrowserResourceCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  withTab<T>(tabId: number, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    return this.withLock(`tab:${tabId}`, signal, run);
  }

  withFocus<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    return this.withLock('browser-focus', signal, run);
  }

  withTabAndFocus<T>(tabId: number, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    return this.withFocus(signal, () => this.withTab(tabId, signal, run));
  }

  private async withLock<T>(key: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw abortReason(signal);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);

    try {
      await waitForTurn(previous, signal);
      return await run();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export const browserResourceCoordinator = new BrowserResourceCoordinator();

function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(abortReason(signal));
      else resolve();
    });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}
