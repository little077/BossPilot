import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/storage/db';
import { WORKSPACE_FILE_LIMIT, WORKSPACE_QUOTA, WorkspaceStore } from './storage';
import type { WorkspaceEntry } from './types';

const store = new WorkspaceStore();

beforeEach(async () => {
  vi.stubGlobal('navigator', {
    storage: {
      estimate: vi.fn(async () => ({ usage: 0, quota: 500 * 1024 * 1024 })),
    },
  });
  await db.delete();
  await db.open();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await db.delete();
});

describe('conversation workspace store', () => {
  it('creates, reads, searches, edits, versions, renames and deletes a local file', async () => {
    await store.createDirectory('conversation-a', '/reports', 1);
    const created = await store.write(
      'conversation-a',
      '/reports/page-summary.md',
      '# Summary\nInitial risk',
      { now: 2 },
    );
    expect(created).toMatchObject({ storage: 'indexeddb', version: 1, size: 22 });
    await expect(store.read('conversation-a', created.path)).resolves.toMatchObject({
      content: '# Summary\nInitial risk',
    });
    await expect(store.search('conversation-a', 'risk')).resolves.toEqual([
      { path: created.path, matches: ['Initial risk'] },
    ]);

    const edited = await store.write('conversation-a', created.path, '# Summary\nRisk and advice', {
      overwrite: true,
      now: 3,
    });
    expect(edited.version).toBe(2);
    expect(await store.versions('conversation-a', created.path)).toEqual([
      expect.objectContaining({ version: 1, size: 22 }),
    ]);

    const renamed = await store.rename('conversation-a', created.path, '/reports/final.md');
    expect(renamed.path).toBe('/reports/final.md');
    await expect(store.read('conversation-a', created.path)).rejects.toThrow();
    await store.delete('conversation-a', renamed.path);
    await store.delete('conversation-a', '/reports');
    expect((await store.list('conversation-a')).entries).toEqual([]);
  });

  it('isolates conversations and rejects traversal, unconfirmed overwrite and oversized files', async () => {
    await store.write('conversation-a', '/private.txt', 'secret');
    await expect(store.read('conversation-b', '/private.txt')).rejects.toThrow();
    await expect(store.write('conversation-a', '../../config.json', 'bad')).rejects.toThrow('..');
    await expect(store.write('conversation-a', '/private.txt', 'overwrite')).rejects.toThrow(
      '确认',
    );
    await expect(
      store.write(
        'conversation-a',
        '/large.bin',
        new Blob([new Uint8Array(WORKSPACE_FILE_LIMIT + 1)]),
      ),
    ).rejects.toThrow('20 MB');
  });

  it('checks browser quota before writing and does not create partial metadata', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        estimate: vi.fn(async () => ({ usage: 100, quota: 100 })),
      },
    });
    await expect(store.write('conversation-a', '/no-space.txt', 'x')).rejects.toThrow('存储空间');
    expect((await store.list('conversation-a')).entries).toEqual([]);
  });

  it('prevents deleting a non-empty directory', async () => {
    await store.createDirectory('conversation-a', '/reports');
    await store.write('conversation-a', '/reports/a.txt', 'a');
    await expect(store.delete('conversation-a', '/reports')).rejects.toThrow('不为空');
  });

  it('handles binary metadata, directory conflicts, scoped lists and missing bodies', async () => {
    await store.createDirectory('conversation-a', '/reports');
    await expect(store.createDirectory('conversation-a', '/reports')).resolves.toMatchObject({
      kind: 'directory',
    });
    await expect(store.read('conversation-a', '/reports')).rejects.toThrow('不是文件');
    await expect(store.readBlob('conversation-a', '/reports')).rejects.toThrow('不是文件');
    await store.write('conversation-a', '/reports/a.bin', new Blob(['binary']));
    await expect(store.read('conversation-a', '/reports/a.bin')).resolves.toMatchObject({
      mimeType: 'application/octet-stream',
    });
    await expect(store.readBlob('conversation-a', '/reports/a.bin')).resolves.toMatchObject({
      entry: expect.objectContaining({ path: '/reports/a.bin' }),
    });
    await expect(store.createDirectory('conversation-a', '/reports/a.bin')).rejects.toThrow(
      '同名文件',
    );
    await expect(store.write('conversation-a', '/reports', 'x')).rejects.toThrow('目录');
    expect((await store.list('conversation-a', '/reports')).entries).toHaveLength(2);

    const broken: WorkspaceEntry = {
      id: 'conversation-a:/broken.txt',
      conversationId: 'conversation-a',
      path: '/broken.txt',
      parentPath: '/',
      name: 'broken.txt',
      kind: 'file',
      mimeType: 'text/plain',
      size: 1,
      version: 1,
      storage: 'indexeddb',
      createdAt: 1,
      updatedAt: 1,
    };
    await db.workspaceEntries.put(broken);
    await expect(store.read('conversation-a', broken.path)).rejects.toThrow('损坏');
  });

  it('enforces the per-workspace quota independently of browser quota', async () => {
    await db.workspaceEntries.put({
      id: 'conversation-a:/existing.bin',
      conversationId: 'conversation-a',
      path: '/existing.bin',
      parentPath: '/',
      name: 'existing.bin',
      kind: 'file',
      mimeType: 'application/octet-stream',
      size: WORKSPACE_QUOTA,
      version: 1,
      storage: 'indexeddb',
      createdAt: 1,
      updatedAt: 1,
    });
    await expect(store.write('conversation-a', '/new.txt', 'x')).rejects.toThrow('200 MB');
  });

  it('falls back to IndexedDB when OPFS probing fails', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(async () => {
          throw new Error('OPFS unavailable');
        }),
        estimate: vi.fn(async () => ({ usage: 0, quota: 500 * 1024 * 1024 })),
      },
    });
    await expect(store.write('conversation-a', '/fallback.json', '{}')).resolves.toMatchObject({
      storage: 'indexeddb',
      mimeType: 'application/json',
    });
  });

  it('refuses to rename over an existing destination', async () => {
    await store.write('conversation-a', '/source.txt', 'source');
    await store.write('conversation-a', '/destination.txt', 'destination');
    await expect(store.rename('conversation-a', '/source.txt', '/destination.txt')).rejects.toThrow(
      '已经存在',
    );
  });
});

class FakeDirectory {
  readonly directories = new Map<string, FakeDirectory>();
  readonly files = new Map<string, Blob>();
  failNextWrite = false;
  failRemove = false;
  abortedWrites = 0;

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options.create) throw new Error('directory missing');
    const directory = new FakeDirectory();
    this.directories.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}) {
    if (!this.files.has(name) && !options.create) throw new Error('file missing');
    if (!this.files.has(name)) this.files.set(name, new Blob([]));
    return {
      getFile: async () => this.files.get(name) ?? new Blob([]),
      createWritable: async () => ({
        write: async (data: Blob) => {
          if (this.failNextWrite) {
            this.failNextWrite = false;
            throw new Error('write failed');
          }
          this.files.set(name, data);
        },
        close: async () => undefined,
        abort: async () => {
          this.abortedWrites += 1;
        },
      }),
    };
  }

  async removeEntry(name: string) {
    if (this.failRemove) throw new Error('remove failed');
    this.files.delete(name);
    this.directories.delete(name);
  }
}

describe('OPFS workspace backend', () => {
  let root: FakeDirectory;

  beforeEach(() => {
    root = new FakeDirectory();
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(async () => root as unknown as FileSystemDirectoryHandle),
        estimate: vi.fn(async () => ({ usage: 0, quota: 500 * 1024 * 1024 })),
      },
    });
  });

  it('creates nested OPFS directories and performs text, image, version and rename flows', async () => {
    await store.createDirectory('conversation-opfs', '/reports/2026');
    await store.write('conversation-opfs', '/reports/2026/a.txt', 'alpha');
    await store.write('conversation-opfs', '/reports/2026/a.txt', 'beta', { overwrite: true });
    await expect(store.read('conversation-opfs', '/reports/2026/a.txt')).resolves.toMatchObject({
      content: 'beta',
      storage: 'opfs',
      version: 2,
    });
    expect(await store.versions('conversation-opfs', '/reports/2026/a.txt')).toEqual([
      expect.objectContaining({ version: 1 }),
    ]);
    const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await store.write('conversation-opfs', '/reports/2026/image.png', image);
    await expect(store.read('conversation-opfs', '/reports/2026/image.png')).resolves.toMatchObject(
      {
        dataUrl: expect.stringMatching(/^data:image\/png;base64,/u),
      },
    );
    await store.write(
      'conversation-opfs',
      '/reports/2026/native.txt',
      new NodeBlob(['native text'], { type: 'text/plain' }) as unknown as Blob,
    );
    await expect(
      store.read('conversation-opfs', '/reports/2026/native.txt'),
    ).resolves.toMatchObject({ content: 'native text' });
    await store.write(
      'conversation-opfs',
      '/reports/2026/native.png',
      new NodeBlob([new Uint8Array([4, 5, 6])], { type: 'image/png' }) as unknown as Blob,
    );
    await expect(
      store.read('conversation-opfs', '/reports/2026/native.png'),
    ).resolves.toMatchObject({ dataUrl: expect.stringContaining('base64,') });
    await store.rename('conversation-opfs', '/reports/2026/a.txt', '/reports/2026/b.txt');
    await store.delete('conversation-opfs', '/reports/2026/b.txt');
  });

  it('aborts failed OPFS writes and avoids partial metadata', async () => {
    const workspaces = await root.getDirectoryHandle('workspaces', { create: true });
    const conversation = await workspaces.getDirectoryHandle('conversation-opfs', { create: true });
    conversation.failNextWrite = true;
    await expect(store.write('conversation-opfs', '/failed.txt', 'x')).rejects.toThrow(
      'write failed',
    );
    expect(conversation.abortedWrites).toBe(1);
    expect((await store.list('conversation-opfs')).entries).toEqual([]);
  });

  it('keeps metadata deletion recoverable when the OPFS file was already removed', async () => {
    const entry = await store.write('conversation-opfs', '/gone.txt', 'x');
    const workspaces = root.directories.get('workspaces');
    const conversation = workspaces?.directories.get('conversation-opfs');
    if (!conversation) throw new Error('fake OPFS setup failed');
    conversation.failRemove = true;
    await store.delete('conversation-opfs', entry.path);
    expect((await store.list('conversation-opfs')).entries).toEqual([]);
  });
});
