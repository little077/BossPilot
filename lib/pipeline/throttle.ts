// ─── 拟人化节流器 ───
// 风控核心手段之一：所有对 zhipin 页面的连续操作（翻页、进详情）之间
// 加入带随机抖动的延迟，模拟人类浏览节奏，避免固定间隔被识别为机器行为。

/** 可中断的 sleep：signal 触发时立刻 reject，保证取消及时生效。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** [min, max] 均匀随机整数。 */
function randBetween(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

/** 翻页间隔：2.5s ~ 5s。 */
export function pageDelay(signal?: AbortSignal): Promise<void> {
  return sleep(randBetween(2500, 5000), signal);
}

/** 进详情页间隔：1.8s ~ 4s。 */
export function detailDelay(signal?: AbortSignal): Promise<void> {
  return sleep(randBetween(1800, 4000), signal);
}

/** 页面导航后等待渲染：SPA 首屏 + 列表异步加载。 */
export function renderWait(signal?: AbortSignal): Promise<void> {
  return sleep(randBetween(1500, 2500), signal);
}
