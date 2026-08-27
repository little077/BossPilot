import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceStore } from '@/lib/workspace/storage';
import {
  ChromeSkillHostClient,
  type PageExecutor,
  type SkillHostClient,
  SkillSandboxRunner,
} from './sandbox';

describe('ChromeSkillHostClient', () => {
  const hasDocument = vi.fn();
  const createDocument = vi.fn();
  const sendMessage = vi.fn();

  beforeEach(() => {
    hasDocument.mockReset().mockResolvedValue(true);
    createDocument.mockReset().mockResolvedValue(undefined);
    sendMessage.mockReset().mockResolvedValue({ ok: true, result: { value: 1 } });
    vi.stubGlobal('chrome', {
      offscreen: {
        hasDocument,
        createDocument,
        Reason: { WORKERS: 'WORKERS' },
      },
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://id/${path}`),
        sendMessage,
      },
    });
  });

  it('reuses an existing offscreen host and validates its result', async () => {
    const client = new ChromeSkillHostClient();
    await expect(client.run({ runId: 'run', code: 'return 1', input: {} })).resolves.toEqual({
      value: 1,
    });
    expect(createDocument).not.toHaveBeenCalled();
    sendMessage.mockResolvedValueOnce({ ok: false, error: 'sandbox failed' });
    await expect(client.run({ runId: 'run', code: 'return 1', input: {} })).rejects.toThrow(
      'sandbox failed',
    );
    sendMessage.mockResolvedValueOnce(null);
    await expect(client.run({ runId: 'run', code: 'return 1', input: {} })).rejects.toThrow(
      '无效结果',
    );
  });

  it('creates the offscreen host when missing', async () => {
    hasDocument.mockResolvedValueOnce(false);
    const client = new ChromeSkillHostClient();
    await client.run({ runId: 'run', code: 'return 1', input: {} });
    expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'chrome-extension://id/skill-host.html',
        reasons: ['WORKERS'],
      }),
    );
  });
});

describe('SkillSandboxRunner guards', () => {
  it('proxies read, mkdir and exact-origin GET while a run is active', async () => {
    let activeRunId = '';
    let release: ((value: unknown) => void) | undefined;
    const host: SkillHostClient = {
      run: vi.fn(({ runId }) => {
        activeRunId = runId;
        return new Promise((resolve) => {
          release = resolve;
        });
      }),
    };
    const workspace = {
      read: vi.fn(async () => ({
        path: '/a.md',
        mimeType: 'text/markdown',
        size: 2,
        content: 'ok',
      })),
      write: vi.fn(),
      createDirectory: vi.fn(async () => ({ path: '/reports' })),
    } as unknown as WorkspaceStore;
    const fetcher = vi.fn(
      async () =>
        new Response('network body', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const pageExecutor: PageExecutor = {
      execute: vi.fn(async () => ({ source: 'page' })),
    };
    vi.stubGlobal('chrome', {
      permissions: { contains: vi.fn(async () => true) },
      tabs: {
        query: vi.fn(async () => [{ id: 7, url: 'https://www.xiaohongshu.com/user/profile/a' }]),
        get: vi.fn(async () => ({ id: 7, url: 'https://www.xiaohongshu.com/user/profile/a' })),
      },
    });
    const runner = new SkillSandboxRunner(host, workspace, fetcher as typeof fetch, pageExecutor);
    const running = runner.run(
      'conversation',
      'return input;',
      {},
      [
        'workspace.read',
        'workspace.write',
        'network:https://example.com',
        'page.read',
        'page.script',
      ],
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(activeRunId).not.toBe(''));
    const request = (capability: string, payload: unknown) =>
      runner.handleCapabilityRequest({
        type: 'skill-capability:request',
        runId: activeRunId,
        capability,
        payload,
      });
    await expect(request('workspace.read', { path: '/a.md' })).resolves.toMatchObject({
      ok: true,
      result: { content: 'ok' },
    });
    await expect(
      request('workspace.write', { operation: 'mkdir', path: '/reports' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      request('network:https://example.com', { url: 'https://example.com/data' }),
    ).resolves.toMatchObject({ ok: true, result: { status: 200, body: 'network body' } });
    await expect(
      request('network:https://example.com', { url: 'https://evil.example/data' }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('超出') });
    await expect(request('page.read', {})).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('页面函数名'),
    });
    await expect(request('page.read', { fn: 'xhs.unknown' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('未注册'),
    });
    await expect(request('page.read', { fn: 'xhs.scrollFeeds' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('不匹配'),
    });
    await expect(
      request('page.read', { fn: 'xhs.extractProfile', tabId: 7 }),
    ).resolves.toMatchObject({ ok: true, result: { source: 'page' } });
    await expect(
      request('page.script', { fn: 'xhs.scrollFeeds', args: [600], tabId: 7 }),
    ).resolves.toMatchObject({ ok: true });
    expect(pageExecutor.execute).toHaveBeenCalledWith(7, expect.any(Function), [600]);
    await expect(
      request('workspace.write', { operation: 'delete', path: '/a.md' }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('不受支持') });
    await expect(request('workspace.write', { path: '/a.md', content: 42 })).resolves.toMatchObject(
      { ok: false, error: expect.stringContaining('无效或过大') },
    );
    release?.({ complete: true });
    await running;
    await expect(request('workspace.read', { path: '/a.md' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('已经结束'),
    });
  });

  it('rejects malformed, oversized, unserializable and cancelled runs', async () => {
    const runner = new SkillSandboxRunner({ run: vi.fn(async () => null) });
    await expect(runner.handleCapabilityRequest(null)).resolves.toMatchObject({ ok: false });
    await expect(
      runner.run('conversation', '', {}, [], new AbortController().signal),
    ).rejects.toThrow('脚本为空');
    const circular: { self?: unknown } = {};
    circular.self = circular;
    await expect(
      runner.run('conversation', 'return input;', circular, [], new AbortController().signal),
    ).rejects.toThrow('序列化');
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      runner.run('conversation', 'return input;', {}, [], controller.signal),
    ).rejects.toThrow('cancelled');
  });

  it('cancels a script that is already running at the host boundary', async () => {
    const controller = new AbortController();
    const runner = new SkillSandboxRunner({ run: () => new Promise(() => undefined) });
    const running = runner.run('conversation', 'return input;', {}, [], controller.signal);
    controller.abort(new Error('stopped while running'));
    await expect(running).rejects.toThrow('stopped while running');
  });

  it('requires Chrome origin permission before a declared network request', async () => {
    let runId = '';
    let release: ((value: unknown) => void) | undefined;
    vi.stubGlobal('chrome', { permissions: { contains: vi.fn(async () => false) } });
    const runner = new SkillSandboxRunner(
      {
        run: ({ runId: current }) => {
          runId = current;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
      undefined,
      vi.fn() as unknown as typeof fetch,
    );
    const running = runner.run(
      'conversation',
      'return input;',
      {},
      ['network:https://example.com'],
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(runId).not.toBe(''));
    await expect(
      runner.handleCapabilityRequest({
        type: 'skill-capability:request',
        runId,
        capability: 'network:https://example.com',
        payload: { url: 'https://example.com/data' },
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('尚未授予') });
    release?.(null);
    await running;
  });
});
