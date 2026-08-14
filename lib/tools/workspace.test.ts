import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/storage/db';
import type { WorkspaceStore } from '@/lib/workspace/storage';
import { WorkspaceToolCoordinator } from './workspace';

const coordinator = new WorkspaceToolCoordinator();

beforeEach(async () => {
  vi.stubGlobal('navigator', {
    storage: { estimate: vi.fn(async () => ({ usage: 0, quota: 500 * 1024 * 1024 })) },
  });
  await db.delete();
  await db.open();
});

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => db.delete());

describe('workspace Agent tools', () => {
  it('pauses every write and executes it only after explicit approval', async () => {
    const call = {
      id: 'call-1',
      name: 'workspace_create',
      arguments: { path: '/reports/summary.md', content: '# Summary' },
    };
    await expect(
      coordinator.execute(call, 'conversation-a', false, new AbortController().signal),
    ).resolves.toMatchObject({ deferred: true, kind: 'user_input' });
    await expect(
      coordinator.execute(call, 'conversation-a', true, new AbortController().signal),
    ).resolves.toMatchObject({
      isError: false,
      outputPath: '/reports/summary.md',
      riskLevel: 'write',
      authorizationStatus: 'granted',
    });
  });

  it('reads, lists, searches, edits, renames and deletes only the current workspace', async () => {
    const signal = new AbortController().signal;
    await coordinator.execute(
      { id: 'create', name: 'workspace_create', arguments: { path: '/a.txt', content: 'alpha' } },
      'conversation-a',
      true,
      signal,
    );
    const read = await coordinator.execute(
      { id: 'read', name: 'workspace_read', arguments: { path: '/a.txt' } },
      'conversation-a',
      false,
      signal,
    );
    expect(read).toMatchObject({ isError: false, outputPath: '/a.txt', riskLevel: 'read' });
    await expect(
      coordinator.execute(
        { id: 'cross', name: 'workspace_read', arguments: { path: '/a.txt' } },
        'conversation-b',
        false,
        signal,
      ),
    ).resolves.toMatchObject({ isError: true });

    for (const call of [
      { id: 'list', name: 'workspace_list', arguments: {} },
      { id: 'search', name: 'workspace_search', arguments: { query: 'alpha' } },
    ]) {
      await expect(
        coordinator.execute(call, 'conversation-a', false, signal),
      ).resolves.toMatchObject({ isError: false });
    }
    await coordinator.execute(
      {
        id: 'edit',
        name: 'workspace_edit',
        arguments: { path: '/a.txt', content: ' beta', mode: 'append' },
      },
      'conversation-a',
      true,
      signal,
    );
    await coordinator.execute(
      {
        id: 'rename',
        name: 'workspace_rename',
        arguments: { fromPath: '/a.txt', toPath: '/b.txt' },
      },
      'conversation-a',
      true,
      signal,
    );
    await expect(
      coordinator.execute(
        { id: 'delete', name: 'workspace_delete', arguments: { path: '/b.txt' } },
        'conversation-a',
        true,
        signal,
      ),
    ).resolves.toMatchObject({ isError: false, riskLevel: 'dangerous' });
  });

  it('fails safely for missing conversation, cancellation, malformed calls and unsafe URL sources', async () => {
    const signal = new AbortController().signal;
    await expect(
      coordinator.execute(
        { id: 'missing', name: 'workspace_list', arguments: {} },
        '',
        false,
        signal,
      ),
    ).resolves.toMatchObject({ isError: true });
    const controller = new AbortController();
    controller.abort();
    await expect(
      coordinator.execute(
        { id: 'cancelled', name: 'workspace_list', arguments: {} },
        'conversation-a',
        false,
        controller.signal,
      ),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      coordinator.execute(
        { id: 'bad', name: 'workspace_read', arguments: {} },
        'conversation-a',
        false,
        signal,
      ),
    ).resolves.toMatchObject({ isError: true });
    vi.stubGlobal('chrome', { permissions: { contains: vi.fn(async () => false) } });
    await expect(
      coordinator.execute(
        {
          id: 'url',
          name: 'workspace_save_url',
          arguments: { url: 'https://example.com/a', path: '/a.html' },
        },
        'conversation-a',
        true,
        signal,
      ),
    ).resolves.toMatchObject({ isError: true });
  });

  it('supports directory creation, replace editing and reports invalid operations', async () => {
    const signal = new AbortController().signal;
    await expect(
      coordinator.execute(
        { id: 'mkdir', name: 'workspace_mkdir', arguments: { path: '/reports' } },
        'conversation-a',
        true,
        signal,
      ),
    ).resolves.toMatchObject({ isError: false, outputPath: '/reports' });
    await coordinator.execute(
      {
        id: 'create',
        name: 'workspace_create',
        arguments: { path: '/reports/a.txt', content: 'first', mimeType: 'text/plain' },
      },
      'conversation-a',
      true,
      signal,
    );
    await expect(
      coordinator.execute(
        {
          id: 'replace',
          name: 'workspace_edit',
          arguments: { path: '/reports/a.txt', content: 'second', mode: 'replace' },
        },
        'conversation-a',
        true,
        signal,
      ),
    ).resolves.toMatchObject({ isError: false });
    await expect(
      coordinator.execute(
        {
          id: 'invalid-mode',
          name: 'workspace_edit',
          arguments: { path: '/reports/a.txt', content: 'x', mode: 'invalid' },
        },
        'conversation-a',
        true,
        signal,
      ),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      coordinator.execute(
        { id: 'unknown', name: 'not_a_tool', arguments: {} },
        'conversation-a',
        false,
        signal,
      ),
    ).resolves.toMatchObject({ isError: true });
  });

  it('downloads an authorized URL and handles unsupported protocols and HTTP errors', async () => {
    const signal = new AbortController().signal;
    vi.stubGlobal('chrome', { permissions: { contains: vi.fn(async () => true) } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('saved page', { status: 200, headers: { 'content-type': 'text/plain' } }),
      )
      .mockResolvedValueOnce(new Response('failed', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      coordinator.execute(
        {
          id: 'save-url',
          name: 'workspace_save_url',
          arguments: { url: 'https://example.com/a', path: '/saved.txt' },
        },
        'conversation-a',
        true,
        signal,
      ),
    ).resolves.toMatchObject({ isError: false, outputPath: '/saved.txt' });
    await expect(
      coordinator.execute(
        {
          id: 'http-error',
          name: 'workspace_save_url',
          arguments: { url: 'https://example.com/fail', path: '/failed.txt' },
        },
        'conversation-a',
        true,
        signal,
      ),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      coordinator.execute(
        {
          id: 'ftp',
          name: 'workspace_save_url',
          arguments: { url: 'ftp://example.com/a', path: '/ftp.txt' },
        },
        'conversation-a',
        true,
        signal,
      ),
    ).resolves.toMatchObject({ isError: true });
  });

  it('normalizes non-Error failures and safely rejects unknown internal writes', async () => {
    const failingStore = {
      list: vi.fn(async () => {
        throw 'storage offline';
      }),
    } as unknown as WorkspaceStore;
    const failingCoordinator = new WorkspaceToolCoordinator(failingStore);
    await expect(
      failingCoordinator.execute(
        { id: 'list', name: 'workspace_list', arguments: {} },
        'conversation-a',
        false,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, detail: 'storage offline' });

    const internal = coordinator as unknown as {
      executeWrite(
        call: { id: string; name: string; arguments: Record<string, unknown> },
        conversationId: string,
        signal: AbortSignal,
      ): Promise<{ isError?: boolean }>;
    };
    await expect(
      internal.executeWrite(
        { id: 'unknown-write', name: 'unknown_write', arguments: {} },
        'conversation-a',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true });
  });
});
