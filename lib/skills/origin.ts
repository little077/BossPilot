import type { SkillCatalogEntry, SkillDefinition } from '@/lib/skills/types';

type OriginScopedSkill = Pick<SkillCatalogEntry | SkillDefinition, 'matchedOrigins'>;

/**
 * Skill 的 matched-origins 是执行边界，不只是给模型看的提示。
 * 当前只接受 Chrome match pattern 中与浏览器 Agent 有关的 HTTP(S) 子集。
 */
export function skillAppliesToUrl(skill: OriginScopedSkill, urlText: string | undefined): boolean {
  const patterns = skill.matchedOrigins ?? [];
  if (patterns.length === 0) return true;
  if (!urlText) return false;
  return patterns.some((pattern) => matchesHttpPattern(urlText, pattern));
}

function matchesHttpPattern(urlText: string, pattern: string): boolean {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (pattern === '<all_urls>') return true;

  const match = pattern.match(/^(\*|https?):\/\/([^/]+)(\/.*)$/u);
  if (!match) return false;
  const scheme = match[1];
  const hostPattern = match[2];
  const pathPattern = match[3];
  if (!scheme || !hostPattern || !pathPattern) return false;
  if (scheme !== '*' && `${scheme}:` !== url.protocol) return false;
  if (!hostMatches(url.hostname, hostPattern.toLowerCase())) return false;
  return wildcardMatches(`${url.pathname}${url.search}`, pathPattern);
}

function hostMatches(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === pattern;
}

function wildcardMatches(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'u').test(value);
}
