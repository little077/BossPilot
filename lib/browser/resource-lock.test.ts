import { describe, expect, it, vi } from 'vitest';
import { BrowserResourceCoordinator } from './resource-lock';

describe('BrowserResourceCoordinator', () => {
  it('serializes work that targets the same tab', async () => {
    const coordinator = new BrowserResourceCoordinator();
    const signal = new AbortController().signal;
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });

    const first = coordinator.withTab(7, signal, async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = coordinator.withTab(7, signal, async () => {
      order.push('second');
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('allows different tabs to run independently', async () => {
    const coordinator = new BrowserResourceCoordinator();
    const signal = new AbortController().signal;
    const started = vi.fn();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });

    const first = coordinator.withTab(1, signal, async () => {
      started(1);
      await gate;
    });
    const second = coordinator.withTab(2, signal, async () => {
      started(2);
    });
    await second;
    expect(started).toHaveBeenCalledWith(2);
    release();
    await first;
  });

  it('removes an aborted waiter without blocking the following task', async () => {
    const coordinator = new BrowserResourceCoordinator();
    const signal = new AbortController().signal;
    const waiting = new AbortController();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const first = coordinator.withFocus(signal, () => gate);
    const skipped = coordinator.withFocus(waiting.signal, async () => 'skipped');
    const last = coordinator.withFocus(signal, async () => 'last');

    waiting.abort();
    await expect(skipped).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await first;
    await expect(last).resolves.toBe('last');
  });

  it('rejects already-aborted work and keeps running after a task failure', async () => {
    const coordinator = new BrowserResourceCoordinator();
    const aborted = new AbortController();
    aborted.abort();
    await expect(coordinator.withTab(1, aborted.signal, async () => 'never')).rejects.toBe(
      aborted.signal.reason,
    );

    const signal = new AbortController().signal;
    await expect(
      coordinator.withFocus(signal, async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    await expect(coordinator.withFocus(signal, async () => 'recovered')).resolves.toBe('recovered');
  });

  it('creates a standard AbortError when an aborted host signal has no reason', async () => {
    const coordinator = new BrowserResourceCoordinator();
    const signal = { aborted: true, reason: undefined } as AbortSignal;
    await expect(coordinator.withFocus(signal, async () => 'never')).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
