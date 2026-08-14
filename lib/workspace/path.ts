const MAX_PATH_CHARS = 512;
const MAX_SEGMENT_CHARS = 120;

export function normalizeWorkspacePath(input: string, allowRoot = false): string {
  const raw = input.trim();
  if (!raw || raw.includes('\0')) throw new Error('工作区路径不能为空。');
  if (/^[a-zA-Z]:[\\/]/u.test(raw) || raw.startsWith('\\\\')) {
    throw new Error('不允许使用系统绝对路径。');
  }
  const slashPath = raw.replaceAll('\\', '/');
  const segments = slashPath.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '..')) {
    throw new Error('路径不能包含 ..，也不能访问当前会话之外的文件。');
  }
  const cleaned = segments.filter((segment) => segment !== '.');
  if (cleaned.length === 0) {
    if (allowRoot) return '/';
    throw new Error('文件路径不能指向工作区根目录。');
  }
  if (
    cleaned.some(
      (segment) =>
        segment.length > MAX_SEGMENT_CHARS ||
        /[<>:"|?*]/u.test(segment) ||
        [...segment].some((character) => character.charCodeAt(0) < 32) ||
        segment === '.' ||
        segment === '..',
    )
  ) {
    throw new Error('路径包含不受支持的名称或名称过长。');
  }
  const normalized = `/${cleaned.join('/')}`;
  if (normalized.length > MAX_PATH_CHARS) throw new Error('工作区路径过长。');
  return normalized;
}

export function workspaceParentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

export function workspaceName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function workspaceEntryId(conversationId: string, path: string): string {
  return `${conversationId}:${path}`;
}
