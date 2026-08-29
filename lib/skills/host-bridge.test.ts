import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillHostBridge } from './host-bridge';

afterEach(() => vi.useRealTimers());

describe('SkillHostBridge', () => {
  it('starts the deadline before the sandbox becomes ready', async () => {
    vi.useFakeTimers();
    const post = vi.fn();
    const respond = vi.fn();
    const bridge = new SkillHostBridge(post, 5_000);

    bridge.run({ runId: 'run-1', code: 'return 1;', input: {} }, respond);
    expect(post).toHaveBeenCalledWith({ type: 'skill-sandbox:ping' });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(respond).toHaveBeenCalledWith({ ok: false, error: 'Skill 脚本执行超过 5 秒。' });
  });

  it('flushes a queued run after the ready handshake and responds once', () => {
    const post = vi.fn();
    const respond = vi.fn();
    const bridge = new SkillHostBridge(post, 5_000);

    bridge.run({ runId: 'run-1', code: 'return 1;', input: { value: 1 } }, respond);
    bridge.receive({ type: 'skill-sandbox:ready' });
    bridge.receive({ type: 'skill-sandbox:ready' });

    expect(post).toHaveBeenCalledWith({
      type: 'skill-sandbox:run',
      runId: 'run-1',
      code: 'return 1;',
      input: { value: 1 },
    });
    expect(
      post.mock.calls.filter(([message]) => message.type === 'skill-sandbox:run'),
    ).toHaveLength(1);

    bridge.receive({ type: 'skill-sandbox:result', runId: 'run-1', ok: true, result: 1 });
    bridge.receive({ type: 'skill-sandbox:result', runId: 'run-1', ok: true, result: 2 });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({ ok: true, result: 1 });
  });

  it('restarts the handshake when the iframe loads or posting temporarily fails', () => {
    let rejectFirstRun = true;
    const post = vi.fn().mockImplementation((message: { type?: string }) => {
      if (message.type === 'skill-sandbox:run' && rejectFirstRun) {
        rejectFirstRun = false;
        throw new Error('frame unavailable');
      }
    });
    const bridge = new SkillHostBridge(post, 5_000);

    bridge.frameLoaded();
    bridge.run({ runId: 'run-1', code: 'return 1;', input: {} }, vi.fn());
    bridge.receive({ type: 'skill-sandbox:ready' });
    bridge.receive({ type: 'skill-sandbox:ready' });
    bridge.receive({ type: 'skill-sandbox:result', runId: 'run-1', ok: true, result: 1 });

    expect(post).toHaveBeenCalledWith({ type: 'skill-sandbox:ping' });
    expect(post).toHaveBeenCalledWith({
      type: 'skill-sandbox:run',
      runId: 'run-1',
      code: 'return 1;',
      input: {},
    });
  });

  it('rejects a duplicate run id without replacing the original run', () => {
    const bridge = new SkillHostBridge(vi.fn(), 5_000);
    const originalRespond = vi.fn();
    const duplicateRespond = vi.fn();
    const request = { runId: 'run-1', code: 'return 1;', input: {} };

    bridge.run(request, originalRespond);
    bridge.run(request, duplicateRespond);

    expect(duplicateRespond).toHaveBeenCalledWith({
      ok: false,
      error: 'Skill 运行标识重复。',
    });
    bridge.receive({ type: 'skill-sandbox:result', runId: 'run-1', ok: true, result: 1 });
    expect(originalRespond).toHaveBeenCalledWith({ ok: true, result: 1 });
  });

  it('passes back bounded sandbox errors and ignores unrelated messages', () => {
    const respond = vi.fn();
    const bridge = new SkillHostBridge(vi.fn(), 5_000);

    expect(bridge.receive(null)).toBe(false);
    expect(bridge.receive({ type: 'unrelated' })).toBe(false);
    bridge.run({ runId: 'run-1', code: 'throw new Error();', input: {} }, respond);
    bridge.receive({ type: 'skill-sandbox:ready' });
    bridge.receive({ type: 'skill-sandbox:result', runId: 'run-1', ok: false, error: 'boom' });

    expect(respond).toHaveBeenCalledWith({ ok: false, error: 'boom' });
  });
});
