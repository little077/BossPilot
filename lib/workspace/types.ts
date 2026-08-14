export type WorkspaceEntryKind = 'file' | 'directory';
export type WorkspaceStorageKind = 'opfs' | 'indexeddb';

export interface WorkspaceEntry {
  id: string;
  conversationId: string;
  path: string;
  parentPath: string;
  name: string;
  kind: WorkspaceEntryKind;
  mimeType: string;
  size: number;
  version: number;
  storage: WorkspaceStorageKind;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceBody {
  id: string;
  conversationId: string;
  path: string;
  data: Blob;
  /** Text mirror keeps the IndexedDB fallback readable in older Blob implementations. */
  text?: string;
}

export interface WorkspaceVersion {
  id: string;
  entryId: string;
  conversationId: string;
  path: string;
  version: number;
  mimeType: string;
  size: number;
  data: Blob;
  createdAt: number;
}

export interface WorkspaceFileView extends WorkspaceEntry {
  content?: string;
  dataUrl?: string;
}

export interface WorkspaceView {
  conversationId: string;
  usedBytes: number;
  quotaBytes: number;
  entries: WorkspaceEntry[];
}
