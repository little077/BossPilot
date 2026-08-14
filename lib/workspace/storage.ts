import { db } from '@/lib/storage/db';
import {
  normalizeWorkspacePath,
  workspaceEntryId,
  workspaceName,
  workspaceParentPath,
} from './path';
import type {
  WorkspaceBody,
  WorkspaceEntry,
  WorkspaceFileView,
  WorkspaceStorageKind,
  WorkspaceVersion,
  WorkspaceView,
} from './types';

export const WORKSPACE_FILE_LIMIT = 20 * 1024 * 1024;
export const WORKSPACE_QUOTA = 200 * 1024 * 1024;
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;

export interface WorkspaceWriteOptions {
  mimeType?: string;
  overwrite?: boolean;
  now?: number;
}

export class WorkspaceStore {
  async list(conversationId: string, directory = '/'): Promise<WorkspaceView> {
    const normalized = normalizeWorkspacePath(directory, true);
    const entries = await db.workspaceEntries
      .where('conversationId')
      .equals(conversationId)
      .toArray();
    const visible = entries
      .filter(
        (entry) =>
          normalized === '/' ||
          entry.path === normalized ||
          entry.path.startsWith(`${normalized}/`),
      )
      .sort((left, right) => left.path.localeCompare(right.path));
    return {
      conversationId,
      usedBytes: entries.reduce(
        (total, entry) => total + (entry.kind === 'file' ? entry.size : 0),
        0,
      ),
      quotaBytes: WORKSPACE_QUOTA,
      entries: visible.map((entry) => ({ ...entry })),
    };
  }

  async read(conversationId: string, requestedPath: string): Promise<WorkspaceFileView> {
    const path = normalizeWorkspacePath(requestedPath);
    const entry = await this.requireEntry(conversationId, path);
    if (entry.kind !== 'file') throw new Error('该路径不是文件。');
    const body = await this.readBody(entry);
    if (isTextMime(entry.mimeType) && body.size <= TEXT_PREVIEW_LIMIT) {
      return { ...entry, content: await blobText(body) };
    }
    if (entry.mimeType.startsWith('image/') && body.size <= WORKSPACE_FILE_LIMIT) {
      return { ...entry, dataUrl: await blobToDataUrl(body) };
    }
    return { ...entry };
  }

  async readBlob(
    conversationId: string,
    requestedPath: string,
  ): Promise<{ entry: WorkspaceEntry; data: Blob }> {
    const path = normalizeWorkspacePath(requestedPath);
    const entry = await this.requireEntry(conversationId, path);
    if (entry.kind !== 'file') throw new Error('该路径不是文件。');
    return { entry, data: await this.readBody(entry) };
  }

  async createDirectory(
    conversationId: string,
    requestedPath: string,
    now = Date.now(),
  ): Promise<WorkspaceEntry> {
    const path = normalizeWorkspacePath(requestedPath);
    const id = workspaceEntryId(conversationId, path);
    const existing = await db.workspaceEntries.get(id);
    if (existing) {
      if (existing.kind === 'directory') return { ...existing };
      throw new Error('同名文件已经存在。');
    }
    const storage = await preferredStorage();
    if (storage === 'opfs') await ensureOpfsDirectory(conversationId, path);
    const entry: WorkspaceEntry = {
      id,
      conversationId,
      path,
      parentPath: workspaceParentPath(path),
      name: workspaceName(path),
      kind: 'directory',
      mimeType: 'application/x-directory',
      size: 0,
      version: 1,
      storage,
      createdAt: now,
      updatedAt: now,
    };
    await db.workspaceEntries.add(entry);
    return { ...entry };
  }

  async write(
    conversationId: string,
    requestedPath: string,
    content: string | Blob,
    options: WorkspaceWriteOptions = {},
  ): Promise<WorkspaceEntry> {
    const path = normalizeWorkspacePath(requestedPath);
    const id = workspaceEntryId(conversationId, path);
    const data =
      typeof content === 'string'
        ? new Blob([content], { type: options.mimeType ?? inferMime(path) })
        : content;
    if (data.size > WORKSPACE_FILE_LIMIT) throw new Error('单个文件不能超过 20 MB。');
    const existing = await db.workspaceEntries.get(id);
    if (existing?.kind === 'directory') throw new Error('目标路径是目录。');
    if (existing && !options.overwrite) throw new Error('文件已存在，覆盖前必须获得用户确认。');
    await this.assertQuota(conversationId, data.size - (existing?.size ?? 0));
    const now = options.now ?? Date.now();
    const storage = existing?.storage ?? (await preferredStorage());
    if (existing) {
      const previous = await this.readBody(existing);
      const version: WorkspaceVersion = {
        id: `${id}@${existing.version}`,
        entryId: id,
        conversationId,
        path,
        version: existing.version,
        mimeType: existing.mimeType,
        size: existing.size,
        data: previous,
        createdAt: now,
      };
      await db.workspaceVersions.put(version);
    }
    await writeBody(storage, conversationId, path, data);
    const entry: WorkspaceEntry = {
      id,
      conversationId,
      path,
      parentPath: workspaceParentPath(path),
      name: workspaceName(path),
      kind: 'file',
      mimeType: options.mimeType ?? (data.type || inferMime(path)),
      size: data.size,
      version: (existing?.version ?? 0) + 1,
      storage,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await db.workspaceEntries.put(entry);
    return { ...entry };
  }

  async rename(conversationId: string, fromPath: string, toPath: string): Promise<WorkspaceEntry> {
    const sourcePath = normalizeWorkspacePath(fromPath);
    const destinationPath = normalizeWorkspacePath(toPath);
    const source = await this.requireEntry(conversationId, sourcePath);
    if (await db.workspaceEntries.get(workspaceEntryId(conversationId, destinationPath))) {
      throw new Error('目标路径已经存在。');
    }
    if (source.kind === 'directory') throw new Error('当前版本仅支持重命名文件。');
    const body = await this.readBody(source);
    const destination = await this.write(conversationId, destinationPath, body, {
      mimeType: source.mimeType,
    });
    await this.delete(conversationId, sourcePath);
    return destination;
  }

  async delete(conversationId: string, requestedPath: string): Promise<void> {
    const path = normalizeWorkspacePath(requestedPath);
    const entry = await this.requireEntry(conversationId, path);
    if (entry.kind === 'directory') {
      const descendants = await db.workspaceEntries
        .where('conversationId')
        .equals(conversationId)
        .filter((item) => item.path.startsWith(`${path}/`))
        .count();
      if (descendants > 0) throw new Error('目录不为空，不能删除。');
    }
    await deleteBody(entry).catch(() => void 0);
    await db.transaction('rw', db.workspaceEntries, db.workspaceBodies, async () => {
      await db.workspaceEntries.delete(entry.id);
      await db.workspaceBodies.delete(entry.id);
    });
  }

  async search(
    conversationId: string,
    query: string,
  ): Promise<Array<{ path: string; matches: string[] }>> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) throw new Error('搜索内容不能为空。');
    const entries = await db.workspaceEntries
      .where('conversationId')
      .equals(conversationId)
      .toArray();
    const results: Array<{ path: string; matches: string[] }> = [];
    for (const entry of entries) {
      if (entry.kind !== 'file' || !isTextMime(entry.mimeType) || entry.size > TEXT_PREVIEW_LIMIT)
        continue;
      const text = await blobText(await this.readBody(entry));
      const matches = text
        .split(/\r?\n/u)
        .filter((line) => line.toLocaleLowerCase().includes(needle))
        .slice(0, 5);
      if (matches.length > 0) results.push({ path: entry.path, matches });
      if (results.length >= 20) break;
    }
    return results;
  }

  async versions(conversationId: string, requestedPath: string): Promise<WorkspaceVersion[]> {
    const path = normalizeWorkspacePath(requestedPath);
    const rows = await db.workspaceVersions
      .where('entryId')
      .equals(workspaceEntryId(conversationId, path))
      .toArray();
    return rows.sort((left, right) => right.version - left.version);
  }

  private async requireEntry(conversationId: string, path: string): Promise<WorkspaceEntry> {
    const entry = await db.workspaceEntries.get(workspaceEntryId(conversationId, path));
    if (!entry || entry.conversationId !== conversationId)
      throw new Error('当前会话工作区中不存在该路径。');
    return entry;
  }

  private async readBody(entry: WorkspaceEntry): Promise<Blob> {
    if (entry.storage === 'opfs') return readOpfsBody(entry.conversationId, entry.path);
    const row = await db.workspaceBodies.get(entry.id);
    if (!row) throw new Error('文件正文不存在或已损坏。');
    if (row.text !== undefined) return new Blob([row.text], { type: entry.mimeType });
    return row.data;
  }

  private async assertQuota(conversationId: string, delta: number): Promise<void> {
    if (delta <= 0) return;
    const view = await this.list(conversationId);
    if (view.usedBytes + delta > WORKSPACE_QUOTA)
      throw new Error('当前会话工作区已超过 200 MB 限额。');
    const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
    if (
      estimate?.quota !== undefined &&
      estimate.usage !== undefined &&
      estimate.usage + delta > estimate.quota
    ) {
      throw new Error('浏览器剩余存储空间不足。');
    }
  }
}

async function preferredStorage(): Promise<WorkspaceStorageKind> {
  try {
    if (navigator.storage?.getDirectory) {
      await navigator.storage.getDirectory();
      return 'opfs';
    }
  } catch {
    // IndexedDB Blob is the required compatibility fallback.
  }
  return 'indexeddb';
}

async function writeBody(
  storage: WorkspaceStorageKind,
  conversationId: string,
  path: string,
  data: Blob,
): Promise<void> {
  const id = workspaceEntryId(conversationId, path);
  if (storage === 'indexeddb') {
    const row: WorkspaceBody = {
      id,
      conversationId,
      path,
      data,
      ...(isTextMime(data.type) ? { text: await blobText(data) } : {}),
    };
    await db.workspaceBodies.put(row);
    return;
  }
  const fileHandle = await opfsFile(conversationId, path, true);
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => void 0);
    throw error;
  }
}

async function readOpfsBody(conversationId: string, path: string): Promise<Blob> {
  const handle = await opfsFile(conversationId, path, false);
  return handle.getFile();
}

async function deleteBody(entry: WorkspaceEntry): Promise<void> {
  if (entry.storage === 'indexeddb') return;
  const { directory, name } = await opfsParent(entry.conversationId, entry.path, false);
  await directory.removeEntry(name);
}

async function ensureOpfsDirectory(conversationId: string, path: string): Promise<void> {
  const root = await workspaceRoot(conversationId, true);
  let directory = root;
  for (const segment of path.split('/').filter(Boolean)) {
    directory = await directory.getDirectoryHandle(segment, { create: true });
  }
}

async function opfsFile(
  conversationId: string,
  path: string,
  create: boolean,
): Promise<FileSystemFileHandle> {
  const { directory, name } = await opfsParent(conversationId, path, create);
  return directory.getFileHandle(name, { create });
}

async function opfsParent(
  conversationId: string,
  path: string,
  create: boolean,
): Promise<{ directory: FileSystemDirectoryHandle; name: string }> {
  const segments = path.split('/').filter(Boolean);
  const name = segments.pop();
  if (!name) throw new Error('文件路径无效。');
  let directory = await workspaceRoot(conversationId, create);
  for (const segment of segments)
    directory = await directory.getDirectoryHandle(segment, { create });
  return { directory, name };
}

async function workspaceRoot(
  conversationId: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const workspaces = await root.getDirectoryHandle('workspaces', { create });
  return workspaces.getDirectoryHandle(conversationId, { create });
}

function inferMime(path: string): string {
  const extension = path.split('.').at(-1)?.toLocaleLowerCase();
  const known: Record<string, string> = {
    md: 'text/markdown',
    markdown: 'text/markdown',
    json: 'application/json',
    txt: 'text/plain',
    csv: 'text/csv',
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    ts: 'text/typescript',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    pdf: 'application/pdf',
  };
  return extension ? (known[extension] ?? 'application/octet-stream') : 'text/plain';
}

function isTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml'
  );
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blobArrayBuffer(blob));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('读取文本文件失败。'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(blob);
  });
}

async function blobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('读取二进制文件失败。'));
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(reader.result)
        : reject(new Error('二进制文件格式无效。'));
    reader.readAsArrayBuffer(blob);
  });
}
