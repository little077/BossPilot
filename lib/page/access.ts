// ─── 通用页面来源权限 ───
// 职责：只允许由当前 HTTP(S) origin 计算出的精确来源权限，并维护可撤销的页面授权清单。

const PAGE_ORIGINS_KEY = 'bosspilot_page_origins_v1';

export interface GrantedPageOrigin {
  origin: string;
  pattern: string;
}

export function pageOriginPattern(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.origin !== origin ||
      parsed.hostname.includes('*')
    ) {
      return null;
    }
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

export function isExactPageOriginPattern(pattern: string): boolean {
  if (!pattern.endsWith('/*')) return false;
  const origin = pattern.slice(0, -2);
  return pageOriginPattern(origin) === pattern;
}

export async function hasExactPageOriginAccess(pattern: string): Promise<boolean> {
  if (!isExactPageOriginPattern(pattern)) return false;
  return chrome.permissions.contains({ origins: [pattern] });
}

export function isPageInjectionPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cannot access contents|cannot access a chrome|missing host permission|permission.*required|not allowed to access|extensions gallery/i.test(
    message,
  );
}

/** 必须直接从按钮点击处理器调用，避免丢失 Chrome 要求的 user gesture。 */
export async function requestPageOriginAccess(pattern: string): Promise<boolean> {
  if (!isExactPageOriginPattern(pattern)) return false;
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (granted) await rememberPageOrigin(pattern);
  return granted;
}

export async function listGrantedPageOrigins(): Promise<GrantedPageOrigin[]> {
  const patterns = await readRememberedPatterns();
  const checks = await Promise.all(
    patterns.map(async (pattern) => ({
      pattern,
      granted: await hasExactPageOriginAccess(pattern),
    })),
  );
  const active = checks.filter((item) => item.granted).map((item) => item.pattern);
  if (active.length !== patterns.length) await writeRememberedPatterns(active);
  return active.map((pattern) => ({ origin: pattern.slice(0, -2), pattern }));
}

export async function removePageOriginAccess(pattern: string): Promise<boolean> {
  if (!isExactPageOriginPattern(pattern)) return false;
  const removed = await chrome.permissions.remove({ origins: [pattern] });
  const patterns = (await readRememberedPatterns()).filter((candidate) => candidate !== pattern);
  await writeRememberedPatterns(patterns);
  return removed;
}

async function rememberPageOrigin(pattern: string): Promise<void> {
  const patterns = await readRememberedPatterns();
  if (!patterns.includes(pattern)) await writeRememberedPatterns([...patterns, pattern]);
}

async function readRememberedPatterns(): Promise<string[]> {
  const stored = await chrome.storage.local.get(PAGE_ORIGINS_KEY);
  const value = stored[PAGE_ORIGINS_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (candidate): candidate is string =>
      typeof candidate === 'string' && isExactPageOriginPattern(candidate),
  );
}

async function writeRememberedPatterns(patterns: string[]): Promise<void> {
  await chrome.storage.local.set({ [PAGE_ORIGINS_KEY]: [...new Set(patterns)].sort() });
}
