import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceWorkerKeepAlive } from './keep-alive';

describe('ServiceWorkerKeepAlive', () => {
  let keepAlive: ServiceWorkerKeepAlive;
  let mockNow: number;

  beforeEach(() => {
    mockNow = 1000;
    keepAlive = new ServiceWorkerKeepAlive(() => mockNow);
    vi.useFakeTimers();
  });

  afterEach(() => {
    keepAlive.dispose();
    vi.useRealTimers();
  });

  it('首次 acquire 启动保活计时器', () => {
    expect(keepAlive.isActive).toBe(false);
    expect(keepAlive.activeCount).toBe(0);

    const release = keepAlive.acquire('session-1');

    expect(keepAlive.isActive).toBe(true);
    expect(keepAlive.activeCount).toBe(1);

    release();
    expect(keepAlive.isActive).toBe(false);
  });

  it('同一会话重复 acquire 合并为一次', () => {
    const release1 = keepAlive.acquire('session-1');
    const release2 = keepAlive.acquire('session-1');

    expect(keepAlive.activeCount).toBe(1);

    release1();
    expect(keepAlive.isActive).toBe(true); // 仍活跃，因为 release2 未调用

    release2();
    expect(keepAlive.isActive).toBe(false);
  });

  it('多会话独立管理，全部释放后停止', () => {
    const release1 = keepAlive.acquire('session-1');
    const release2 = keepAlive.acquire('session-2');
    const release3 = keepAlive.acquire('session-3');

    expect(keepAlive.activeCount).toBe(3);

    release1();
    expect(keepAlive.isActive).toBe(true);
    expect(keepAlive.activeCount).toBe(2);

    release2();
    expect(keepAlive.isActive).toBe(true);
    expect(keepAlive.activeCount).toBe(1);

    release3();
    expect(keepAlive.isActive).toBe(false);
    expect(keepAlive.activeCount).toBe(0);
  });

  it('dispose 清理所有会话', () => {
    keepAlive.acquire('session-1');
    keepAlive.acquire('session-2');

    expect(keepAlive.activeCount).toBe(2);

    keepAlive.dispose();

    expect(keepAlive.isActive).toBe(false);
    expect(keepAlive.activeCount).toBe(0);
  });

  it('release 未获取的会话不报错', () => {
    expect(() => keepAlive.release('non-existent')).not.toThrow();
    expect(keepAlive.isActive).toBe(false);
  });
});
