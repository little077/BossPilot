import type { AgentContextSettings, AgentContextView, MemoryEntry } from './types';

const SETTINGS_KEY = 'bosspilot:agent-context:v1';
const MEMORIES_KEY = 'bosspilot:memories:v1';
const MAX_INSTRUCTIONS_CHARS = 4_000;
const MAX_MEMORY_CHARS = 500;
const MAX_MEMORIES = 100;

export type MemoryStorageArea = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

export class MemoryStore {
  constructor(
    private readonly storage: MemoryStorageArea = chrome.storage.local,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = Date.now,
  ) {}

  async view(): Promise<AgentContextView> {
    const [settings, memories] = await Promise.all([this.settings(), this.list()]);
    return { settings, memories };
  }

  async settings(): Promise<AgentContextSettings> {
    const raw = (await this.storage.get(SETTINGS_KEY))[SETTINGS_KEY];
    if (!isRecord(raw)) return defaults();
    return {
      version: 1,
      instructions: cleanText(raw.instructions, MAX_INSTRUCTIONS_CHARS) ?? '',
      memoryEnabled: raw.memoryEnabled === true,
    };
  }

  async saveSettings(input: Pick<AgentContextSettings, 'instructions' | 'memoryEnabled'>) {
    const settings: AgentContextSettings = {
      version: 1,
      instructions: cleanText(input.instructions, MAX_INSTRUCTIONS_CHARS) ?? '',
      memoryEnabled: input.memoryEnabled === true,
    };
    await this.storage.set({ [SETTINGS_KEY]: settings });
    return this.view();
  }

  async list(): Promise<MemoryEntry[]> {
    const raw = (await this.storage.get(MEMORIES_KEY))[MEMORIES_KEY];
    if (!Array.isArray(raw)) return [];
    return raw
      .flatMap((item) => (isMemoryEntry(item) ? [clone(item)] : []))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_MEMORIES);
  }

  async add(content: string): Promise<AgentContextView> {
    const normalized = requireContent(content);
    const memories = await this.list();
    const existing = memories.find(
      (item) => item.content.localeCompare(normalized, undefined, { sensitivity: 'base' }) === 0,
    );
    if (existing) return this.view();
    const timestamp = this.now();
    const entry: MemoryEntry = {
      id: this.createId(),
      content: normalized,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.saveMemories([entry, ...memories].slice(0, MAX_MEMORIES));
    return this.view();
  }

  async update(id: string, content: string): Promise<AgentContextView> {
    const normalized = requireContent(content);
    const memories = await this.list();
    const index = memories.findIndex((item) => item.id === id);
    if (index < 0) throw new Error('记忆不存在。');
    const current = memories[index];
    if (!current) throw new Error('记忆不存在。');
    memories[index] = { ...current, content: normalized, updatedAt: this.now() };
    await this.saveMemories(memories);
    return this.view();
  }

  async remove(id: string): Promise<AgentContextView> {
    const memories = await this.list();
    const next = memories.filter((item) => item.id !== id);
    if (next.length === memories.length) throw new Error('记忆不存在。');
    await this.saveMemories(next);
    return this.view();
  }

  async clear(): Promise<AgentContextView> {
    await this.saveMemories([]);
    return this.view();
  }

  async search(query: string, limit = 6): Promise<MemoryEntry[]> {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const memories = await this.list();
    return memories
      .map((memory) => ({ memory, score: relevance(memory.content, terms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt)
      .slice(0, Math.max(1, Math.min(10, limit)))
      .map(({ memory }) => memory);
  }

  private async saveMemories(memories: MemoryEntry[]): Promise<void> {
    await this.storage.set({ [MEMORIES_KEY]: memories.map(clone) });
  }
}

function defaults(): AgentContextSettings {
  return { version: 1, instructions: '', memoryEnabled: false };
}

function requireContent(value: string): string {
  const normalized = cleanText(value, MAX_MEMORY_CHARS);
  if (!normalized) throw new Error(`记忆必须为 1-${MAX_MEMORY_CHARS} 个字符。`);
  return normalized;
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replaceAll('\u0000', '').replace(/\s+/gu, ' ').trim();
  return normalized && normalized.length <= max ? normalized : undefined;
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  return (
    isRecord(value) &&
    Boolean(cleanText(value.id, 128)) &&
    Boolean(cleanText(value.content, MAX_MEMORY_CHARS)) &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt)
  );
}

function clone(value: MemoryEntry): MemoryEntry {
  return { ...value };
}

function searchTerms(query: string): string[] {
  const normalized = query
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const words = normalized.split(/\s+/u).filter((word) => word.length >= 2);
  const han = [...normalized.replace(/[^\p{Script=Han}]/gu, '')];
  const bigrams = han.slice(0, -1).map((char, index) => `${char}${han[index + 1]}`);
  return [...new Set([...words, ...bigrams])].slice(0, 32);
}

function relevance(content: string, terms: string[]): number {
  const haystack = content.toLocaleLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? term.length : 0), 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
