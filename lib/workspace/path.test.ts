import { describe, expect, it } from 'vitest';
import {
  normalizeWorkspacePath,
  workspaceEntryId,
  workspaceName,
  workspaceParentPath,
} from './path';

describe('workspace path boundary', () => {
  it('canonicalizes safe workspace paths', () => {
    expect(normalizeWorkspacePath('reports\\2026/./summary.md')).toBe('/reports/2026/summary.md');
    expect(normalizeWorkspacePath('/', true)).toBe('/');
    expect(workspaceParentPath('/reports/summary.md')).toBe('/reports');
    expect(workspaceParentPath('/summary.md')).toBe('/');
    expect(workspaceName('/reports/summary.md')).toBe('summary.md');
    expect(workspaceEntryId('conversation-a', '/summary.md')).toBe('conversation-a:/summary.md');
  });

  it.each([
    '../../config.json',
    '/reports/../secret.txt',
    'C:\\Users\\secret.txt',
    '\\\\server\\share.txt',
    '/bad*name.txt',
    '',
  ])('rejects unsafe or invalid path %s', (path) => {
    expect(() => normalizeWorkspacePath(path)).toThrow();
  });

  it('allows the root only for directory listing', () => {
    expect(() => normalizeWorkspacePath('/')).toThrow('根目录');
    expect(normalizeWorkspacePath('/', true)).toBe('/');
  });
});
