// Skill ZIP 的唯一安全边界：导入前完整校验路径、体积、重复项、脚本类型和权限声明。
import JSZip from 'jszip';
import { parseSkillMarkdown } from '@/lib/skills/parser';
import type { SkillDefinition, SkillPackage, SkillPackageFile } from '@/lib/skills/types';

export const MAX_SKILL_ARCHIVE_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_UNPACKED_BYTES = 10 * 1024 * 1024;
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_FILES = 100;

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.js',
  '.mjs',
  '.css',
  '.html',
  '.csv',
]);
const UNSUPPORTED_SCRIPT_EXTENSIONS = new Set(['.py', '.sh', '.bash', '.ps1', '.bat', '.cmd']);
const SUSPICIOUS_SCRIPT =
  /\b(?:eval|Function)\s*\(|\bimport\s*\(|\b(?:chrome|browser)\s*\.|document\.cookie|window\.(?:top|parent)|localStorage|indexedDB/iu;

export class SkillPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillPackageError';
  }
}

export async function importSkillArchive(
  bytes: ArrayBuffer,
  now = Date.now(),
): Promise<SkillPackage> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SKILL_ARCHIVE_BYTES) {
    throw new SkillPackageError('Skill ZIP 为空或超过 5 MB。');
  }
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(bytes, { createFolders: false, checkCRC32: true });
  } catch {
    throw new SkillPackageError('Skill ZIP 无法读取或校验失败。');
  }

  const sourceEntries = Object.values(archive.files).filter((entry) => !entry.dir);
  for (const entry of sourceEntries) validateRawPath(entry.unsafeOriginalName ?? entry.name);
  if (sourceEntries.length === 0 || sourceEntries.length > MAX_SKILL_FILES) {
    throw new SkillPackageError('Skill 文件数量必须在 1 到 100 之间。');
  }
  const root = detectRoot(sourceEntries.map(({ name }) => name));
  const seen = new Set<string>();
  const files: SkillPackageFile[] = [];
  let totalSize = 0;

  for (const entry of sourceEntries) {
    const path = normalizeArchivePath(entry.name, root);
    if (!path) continue;
    const canonical = path.toLocaleLowerCase('en-US');
    if (seen.has(canonical)) throw new SkillPackageError(`Skill ZIP 含重复文件：${path}`);
    seen.add(canonical);
    const content = await entry.async('uint8array');
    if (content.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new SkillPackageError(`Skill 文件超过 2 MB：${path}`);
    }
    totalSize += content.byteLength;
    if (totalSize > MAX_SKILL_UNPACKED_BYTES) {
      throw new SkillPackageError('Skill 解压后超过 10 MB。');
    }
    files.push(toPackageFile(path, content));
  }

  const skillFile = files.find(({ path }) => path === 'SKILL.md');
  if (skillFile?.kind !== 'text') {
    throw new SkillPackageError('Skill 根目录必须包含 SKILL.md。');
  }
  const expectedName = root || readFrontmatterName(skillFile.content);
  if (!expectedName) throw new SkillPackageError('无法确定 Skill 目录名称。');
  const definition = parseSkillMarkdown(skillFile.content, {
    expectedName,
    version: '1.0.0',
  });
  validateFiles(files, definition.capabilities.length > 0);
  return { name: definition.name, definition, files, createdAt: now, updatedAt: now };
}

export async function exportSkillArchive(skill: SkillPackage): Promise<Uint8Array> {
  const archive = new JSZip();
  for (const file of skill.files) {
    archive.file(`${skill.name}/${file.path}`, decodeFile(file));
  }
  return archive.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

export async function exportAllSkillArchives(skills: SkillPackage[]): Promise<Uint8Array> {
  const archive = new JSZip();
  for (const skill of skills) {
    for (const file of skill.files) archive.file(`${skill.name}/${file.path}`, decodeFile(file));
  }
  return archive.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

export function textSkillFile(path: string, content: string): SkillPackageFile {
  return {
    path,
    kind: 'text',
    content,
    mimeType: mimeType(path),
    size: new TextEncoder().encode(content).byteLength,
  };
}

export function validateSkillPackageFiles(
  files: SkillPackageFile[],
  expectedName: string,
  version: string,
): SkillDefinition {
  if (files.length === 0 || files.length > MAX_SKILL_FILES) {
    throw new SkillPackageError('Skill 文件数量必须在 1 到 100 之间。');
  }
  const seen = new Set<string>();
  let totalSize = 0;
  for (const file of files) {
    const path = validateRawPath(file.path);
    const canonical = path.toLocaleLowerCase('en-US');
    if (seen.has(canonical)) throw new SkillPackageError(`Skill 包含重复文件：${path}`);
    seen.add(canonical);
    const decoded = decodeFile(file);
    const actualSize =
      typeof decoded === 'string'
        ? new TextEncoder().encode(decoded).byteLength
        : decoded.byteLength;
    if (actualSize !== file.size || actualSize > MAX_SKILL_FILE_BYTES) {
      throw new SkillPackageError(`Skill 文件大小无效：${path}`);
    }
    totalSize += actualSize;
    if (totalSize > MAX_SKILL_UNPACKED_BYTES) throw new SkillPackageError('Skill 超过 10 MB。');
  }
  const skillFile = files.find(({ path }) => path === 'SKILL.md');
  if (skillFile?.kind !== 'text') {
    throw new SkillPackageError('Skill 根目录必须包含 SKILL.md。');
  }
  const definition = parseSkillMarkdown(skillFile.content, { expectedName, version });
  validateFiles(files, definition.capabilities.length > 0);
  return definition;
}

function detectRoot(names: string[]): string {
  const safeNames = names.map((name) => validateRawPath(name));
  if (safeNames.includes('SKILL.md')) return '';
  const roots = new Set(safeNames.map((name) => name.split('/')[0]).filter(Boolean));
  if (roots.size !== 1) throw new SkillPackageError('Skill ZIP 必须只有一个 Skill 根目录。');
  const root = [...roots][0] ?? '';
  if (!safeNames.includes(`${root}/SKILL.md`)) {
    throw new SkillPackageError('Skill 根目录必须包含 SKILL.md。');
  }
  return root;
}

function validateRawPath(value: string): string {
  const decoded = value.normalize('NFC');
  if (
    !decoded ||
    decoded.includes('\\') ||
    decoded.startsWith('/') ||
    /^[a-z]:/iu.test(decoded) ||
    decoded.split('/').some((part) => part === '..' || part === '.' || !part)
  ) {
    throw new SkillPackageError(`Skill ZIP 含不安全路径：${value}`);
  }
  return decoded;
}

function normalizeArchivePath(value: string, root: string): string {
  const safe = validateRawPath(value);
  const relative = root ? safe.slice(root.length + 1) : safe;
  if (!relative || relative.startsWith('.')) {
    throw new SkillPackageError(`Skill ZIP 含不支持的文件：${value}`);
  }
  return relative;
}

function toPackageFile(path: string, bytes: Uint8Array): SkillPackageFile {
  const extension = fileExtension(path);
  const text = TEXT_EXTENSIONS.has(extension);
  return {
    path,
    kind: text ? 'text' : 'binary',
    content: text ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytesToBase64(bytes),
    mimeType: mimeType(path),
    size: bytes.byteLength,
  };
}

function validateFiles(files: SkillPackageFile[], declaresCapabilities: boolean): void {
  for (const file of files) {
    const extension = fileExtension(file.path);
    if (file.path.startsWith('scripts/') && UNSUPPORTED_SCRIPT_EXTENSIONS.has(extension)) continue;
    if (file.path.startsWith('scripts/') && extension !== '.js' && extension !== '.mjs') {
      throw new SkillPackageError(`不支持的 Skill 脚本类型：${file.path}`);
    }
    if (
      file.path.startsWith('scripts/') &&
      file.kind === 'text' &&
      SUSPICIOUS_SCRIPT.test(file.content)
    ) {
      throw new SkillPackageError(`Skill 脚本包含受限能力：${file.path}`);
    }
  }
  const hasRunnableScript = files.some(
    ({ path }) => path.startsWith('scripts/') && ['.js', '.mjs'].includes(fileExtension(path)),
  );
  if (hasRunnableScript && !declaresCapabilities) {
    throw new SkillPackageError('包含可执行脚本的 Skill 必须显式声明 bosspilot-permissions。');
  }
}

function readFrontmatterName(markdown: string): string {
  return /^---\r?\n[\s\S]*?^name:\s*([a-z0-9-]+)\s*$/mu.exec(markdown)?.[1] ?? '';
}

function fileExtension(path: string): string {
  const name = path.split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

function mimeType(path: string): string {
  const extension = fileExtension(path);
  if (extension === '.md') return 'text/markdown';
  if (extension === '.json') return 'application/json';
  if (extension === '.js' || extension === '.mjs') return 'text/javascript';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  return TEXT_EXTENSIONS.has(extension) ? 'text/plain' : 'application/octet-stream';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeFile(file: SkillPackageFile): string | Uint8Array {
  if (file.kind === 'text') return file.content;
  const binary = atob(file.content);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
