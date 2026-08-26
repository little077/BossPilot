import { parseDocument } from 'yaml';
import type { SkillCapability, SkillDefinition, SkillReference } from '@/lib/skills/types';

const MAX_SKILL_CHARS = 20_000;
const MAX_DESCRIPTION_CHARS = 1_024;
const MAX_REFERENCE_COUNT = 16;
const MAX_ALLOWED_TOOL_COUNT = 32;
const MAX_CAPABILITY_COUNT = 32;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const REFERENCE_LINK = /`(references\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.md)`/gu;

export interface ParseSkillOptions {
  expectedName: string;
  version: string;
  builtIn?: boolean;
  enabled?: boolean;
}

export class SkillParseError extends Error {
  constructor(
    message: string,
    readonly line = 1,
    readonly column = 1,
  ) {
    super(message);
    this.name = 'SkillParseError';
  }
}

export function parseSkillMarkdown(markdown: string, options: ParseSkillOptions): SkillDefinition {
  if (!markdown || markdown.length > MAX_SKILL_CHARS) {
    throw new SkillParseError('Skill 内容为空或超过 20000 个字符。');
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(markdown);
  if (!frontmatter?.[1] || !frontmatter[2]?.trim()) {
    throw new SkillParseError('SKILL.md 必须包含 YAML frontmatter 和指令正文。');
  }
  const document = parseDocument(frontmatter[1], { uniqueKeys: true });
  const yamlError = document.errors[0];
  if (yamlError) {
    const position = yamlError.linePos?.[0];
    throw new SkillParseError(
      'Skill frontmatter 不是有效 YAML。',
      (position?.line ?? 1) + 1,
      position?.col ?? 1,
    );
  }
  const data = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!isRecord(data)) throw new SkillParseError('Skill frontmatter 必须是对象。');

  const name = boundedString(data.name, 64);
  const description = boundedString(data.description, MAX_DESCRIPTION_CHARS);
  if (!name || !SKILL_NAME.test(name) || name !== options.expectedName) {
    throw new SkillParseError('Skill 名称无效或与目录名不一致。');
  }
  if (!description) throw new SkillParseError('Skill description 不能为空。');

  const metadata = isRecord(data.metadata) ? data.metadata : {};
  const matchedOrigins = readWords(
    metadata['bosspilot-origins'] ?? metadata['matched-origins'],
    16,
    256,
  ).filter(isOriginPattern);
  const allowedTools = readAllowedTools(data['allowed-tools']);
  const capabilities = readCapabilities(metadata['bosspilot-permissions']);
  const instructions = frontmatter[2].trim();

  return {
    name,
    description,
    instructions,
    version: options.version,
    builtIn: options.builtIn ?? false,
    enabled: options.enabled ?? true,
    ...(matchedOrigins.length ? { matchedOrigins } : {}),
    allowedTools,
    capabilities,
    references: collectReferences(instructions),
  };
}

function readCapabilities(value: unknown): SkillCapability[] {
  return readWords(value, MAX_CAPABILITY_COUNT, 256).filter(isSkillCapability);
}

function isSkillCapability(value: string): value is SkillCapability {
  if (
    value === 'workspace.read' ||
    value === 'workspace.write' ||
    value === 'page.read' ||
    value === 'page.script' ||
    value === 'chrome.tabs' ||
    value === 'chrome.bookmarks'
  ) {
    return true;
  }
  if (!value.startsWith('network:')) return false;
  return isOriginPattern(`${value.slice('network:'.length).replace(/\/$/u, '')}/*`);
}

function readAllowedTools(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [
    ...new Set(value.split(/\s+/u).filter((item) => /^[a-z][a-z0-9_-]{0,63}$/u.test(item))),
  ].slice(0, MAX_ALLOWED_TOOL_COUNT);
}

function collectReferences(instructions: string): SkillReference[] {
  const paths = [...instructions.matchAll(REFERENCE_LINK)].flatMap((match) =>
    match[1] && safeReferencePath(match[1]) ? [match[1]] : [],
  );
  return [...new Set(paths)].slice(0, MAX_REFERENCE_COUNT).map((path) => ({
    path,
    label: path.split('/').at(-1)?.replace(/\.md$/u, '') ?? path,
  }));
}

export function safeReferencePath(path: string): boolean {
  return (
    path.startsWith('references/') &&
    !path.includes('..') &&
    !path.includes('\\') &&
    /^[a-zA-Z0-9._/-]+\.md$/u.test(path)
  );
}

function isOriginPattern(value: string): boolean {
  try {
    const url = new URL(value.replace(/\*$/u, ''));
    return (url.protocol === 'https:' || url.protocol === 'http:') && value.endsWith('/*');
  } catch {
    return false;
  }
}

function readWords(value: unknown, maxItems: number, maxChars: number): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\s+/u)
      : [];
  return [
    ...new Set(values.flatMap((item) => (boundedString(item, maxChars) ? [item] : []))),
  ].slice(0, maxItems);
}

function boundedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxChars ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
