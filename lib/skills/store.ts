import {
  type BuiltinSkillBundle,
  loadBuiltinSkillBundles,
  type SkillResource,
} from '@/lib/skills/builtin';
import type { SkillCatalogEntry, SkillDefinition, SkillSettingsView } from '@/lib/skills/types';

const SKILL_SETTINGS_KEY = 'bosspilot:skills:v1';

interface StoredSkillSettings {
  version: 1;
  disabled: string[];
}

export type SkillStorageArea = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

export class SkillStore {
  private readonly bundles: BuiltinSkillBundle[];

  constructor(
    private readonly storage: SkillStorageArea = chrome.storage.local,
    bundles: BuiltinSkillBundle[] = loadBuiltinSkillBundles(),
    private readonly fetchResource: (url: string) => Promise<string> = fetchSkillResource,
  ) {
    this.bundles = bundles.map((bundle) => ({
      definition: cloneDefinition(bundle.definition),
      instructions: { ...bundle.instructions },
      references: Object.fromEntries(
        Object.entries(bundle.references).map(([path, resource]) => [path, { ...resource }]),
      ),
    }));
  }

  async list(): Promise<SkillSettingsView> {
    const disabled = new Set((await this.loadSettings()).disabled);
    return {
      version: 1,
      skills: this.bundles.map(({ definition }) => toCatalogEntry(definition, disabled)),
    };
  }

  async listEnabled(): Promise<SkillCatalogEntry[]> {
    return (await this.list()).skills.filter(({ enabled }) => enabled);
  }

  async setEnabled(name: string, enabled: boolean): Promise<SkillSettingsView> {
    this.requireBundle(name);
    const current = await this.loadSettings();
    const disabled = new Set(current.disabled);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    await this.storage.set({
      [SKILL_SETTINGS_KEY]: {
        version: 1,
        disabled: [...disabled].sort(),
      } satisfies StoredSkillSettings,
    });
    return this.list();
  }

  async load(
    name: string,
    reference?: string,
  ): Promise<{ skill: SkillDefinition; content: string }> {
    const bundle = this.requireBundle(name);
    const settings = await this.loadSettings();
    if (settings.disabled.includes(name)) throw new Error(`Skill ${name} 已停用。`);
    if (!reference) {
      const content = await this.readResource(bundle.instructions);
      return { skill: { ...cloneDefinition(bundle.definition), instructions: content }, content };
    }
    if (!bundle.definition.references.some(({ path }) => path === reference)) {
      throw new Error('该参考文件没有在 SKILL.md 中声明。');
    }
    const resource = bundle.references[reference];
    if (!resource) throw new Error('Skill 参考文件不存在。');
    const content = await this.readResource(resource);
    return { skill: cloneDefinition(bundle.definition), content };
  }

  private requireBundle(name: string): BuiltinSkillBundle {
    const bundle = this.bundles.find(({ definition }) => definition.name === name);
    if (!bundle) throw new Error('未知 Skill。');
    return bundle;
  }

  private async loadSettings(): Promise<StoredSkillSettings> {
    const value = (await this.storage.get(SKILL_SETTINGS_KEY))[SKILL_SETTINGS_KEY];
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.disabled)) {
      return { version: 1, disabled: [] };
    }
    const known = new Set(this.bundles.map(({ definition }) => definition.name));
    return {
      version: 1,
      disabled: [
        ...new Set(
          value.disabled.flatMap((item) =>
            typeof item === 'string' && known.has(item) ? [item] : [],
          ),
        ),
      ],
    };
  }

  private async readResource(resource: SkillResource): Promise<string> {
    return resource.kind === 'inline' ? resource.value : this.fetchResource(resource.value);
  }
}

async function fetchSkillResource(url: string): Promise<string> {
  const response = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!response.ok) throw new Error('Skill 本地资源读取失败。');
  return await response.text();
}

function toCatalogEntry(definition: SkillDefinition, disabled: Set<string>): SkillCatalogEntry {
  return {
    name: definition.name,
    description: definition.description,
    version: definition.version,
    builtIn: definition.builtIn,
    enabled: !disabled.has(definition.name),
    ...(definition.matchedOrigins ? { matchedOrigins: [...definition.matchedOrigins] } : {}),
  };
}

function cloneDefinition(definition: SkillDefinition): SkillDefinition {
  return {
    ...definition,
    allowedTools: [...definition.allowedTools],
    references: definition.references.map((reference) => ({ ...reference })),
    ...(definition.matchedOrigins ? { matchedOrigins: [...definition.matchedOrigins] } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
