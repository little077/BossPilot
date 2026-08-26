// Skills 的本地目录与授权中心：启动时仅列出元数据，正文和资源只在调用后读取。
import {
  type BuiltinSkillBundle,
  loadBuiltinSkillBundles,
  type SkillResource,
} from '@/lib/skills/builtin';
import { textSkillFile, validateSkillPackageFiles } from '@/lib/skills/package';
import { parseSkillMarkdown } from '@/lib/skills/parser';
import type {
  CapabilityGrant,
  SkillCapability,
  SkillCatalogEntry,
  SkillDefinition,
  SkillPackage,
  SkillPackageFile,
  SkillSettingsView,
} from '@/lib/skills/types';
import { db } from '@/lib/storage/db';

const SKILL_SETTINGS_KEY = 'bosspilot:skills:v1';

interface StoredSkillSettings {
  version: 1;
  disabled: string[];
}

export interface SkillRepository {
  list(): Promise<SkillPackage[]>;
  get(name: string): Promise<SkillPackage | undefined>;
  put(skill: SkillPackage): Promise<void>;
  delete(name: string): Promise<void>;
  listGrants(): Promise<CapabilityGrant[]>;
  putGrant(grant: CapabilityGrant): Promise<void>;
  deleteGrant(id: string): Promise<void>;
  deleteGrantsForSkill(name: string): Promise<void>;
}

export class DexieSkillRepository implements SkillRepository {
  async list(): Promise<SkillPackage[]> {
    return (await db.skillPackages.orderBy('updatedAt').reverse().toArray()).map(clonePackage);
  }

  async get(name: string): Promise<SkillPackage | undefined> {
    const skill = await db.skillPackages.get(name);
    return skill ? clonePackage(skill) : undefined;
  }

  async put(skill: SkillPackage): Promise<void> {
    await db.skillPackages.put(clonePackage(skill));
  }

  async delete(name: string): Promise<void> {
    await db.skillPackages.delete(name);
  }

  async listGrants(): Promise<CapabilityGrant[]> {
    return (await db.capabilityGrants.toArray()).map((grant) => ({ ...grant }));
  }

  async putGrant(grant: CapabilityGrant): Promise<void> {
    await db.capabilityGrants.put({ ...grant });
  }

  async deleteGrant(id: string): Promise<void> {
    await db.capabilityGrants.delete(id);
  }

  async deleteGrantsForSkill(name: string): Promise<void> {
    await db.capabilityGrants.where('skillName').equals(name).delete();
  }
}

export class MemorySkillRepository implements SkillRepository {
  private readonly skills = new Map<string, SkillPackage>();
  private readonly grants = new Map<string, CapabilityGrant>();

  async list(): Promise<SkillPackage[]> {
    return [...this.skills.values()].map(clonePackage);
  }

  async get(name: string): Promise<SkillPackage | undefined> {
    const skill = this.skills.get(name);
    return skill ? clonePackage(skill) : undefined;
  }

  async put(skill: SkillPackage): Promise<void> {
    this.skills.set(skill.name, clonePackage(skill));
  }

  async delete(name: string): Promise<void> {
    this.skills.delete(name);
  }

  async listGrants(): Promise<CapabilityGrant[]> {
    return [...this.grants.values()].map((grant) => ({ ...grant }));
  }

  async putGrant(grant: CapabilityGrant): Promise<void> {
    this.grants.set(grant.id, { ...grant });
  }

  async deleteGrant(id: string): Promise<void> {
    this.grants.delete(id);
  }

  async deleteGrantsForSkill(name: string): Promise<void> {
    for (const [id, grant] of this.grants) if (grant.skillName === name) this.grants.delete(id);
  }
}

export type SkillStorageArea = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

export class SkillStore {
  private readonly bundles: BuiltinSkillBundle[];
  private readonly repository: SkillRepository;

  constructor(
    private readonly storage: SkillStorageArea = chrome.storage.local,
    bundles?: BuiltinSkillBundle[],
    private readonly fetchResource: (url: string) => Promise<string> = fetchSkillResource,
    repository?: SkillRepository,
  ) {
    this.bundles = (bundles ?? loadBuiltinSkillBundles()).map(cloneBundle);
    this.repository =
      repository ??
      (bundles === undefined ? new DexieSkillRepository() : new MemorySkillRepository());
  }

  async list(): Promise<SkillSettingsView> {
    const [settings, packages, grants] = await Promise.all([
      this.loadSettings(),
      this.repository.list(),
      this.repository.listGrants(),
    ]);
    const disabled = new Set(settings.disabled);
    return {
      version: 2,
      skills: [
        ...this.bundles.map(({ definition }) =>
          toCatalogEntry(definition, disabled, 1 + definition.references.length),
        ),
        ...packages.map((skill) => toCatalogEntry(skill.definition, disabled, skill.files.length)),
      ].sort((left, right) => left.name.localeCompare(right.name)),
      grants,
    };
  }

  async listEnabled(): Promise<SkillCatalogEntry[]> {
    return (await this.list()).skills.filter(({ enabled }) => enabled);
  }

  async setEnabled(name: string, enabled: boolean): Promise<SkillSettingsView> {
    await this.requireKnown(name);
    const current = await this.loadSettings();
    const disabled = new Set(current.disabled);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    await this.saveSettings(disabled);
    return this.list();
  }

  async create(name: string, now = Date.now()): Promise<SkillPackage> {
    if (
      this.bundles.some(({ definition }) => definition.name === name) ||
      (await this.repository.get(name))
    ) {
      throw new Error('Skill 名称已存在。');
    }
    const markdown = `---\nname: ${name}\ndescription: 请描述这个 Skill 何时使用以及能完成什么。\nmetadata:\n  bosspilot-permissions: workspace.read\nallowed-tools: load_skill\n---\n# 工作流\n\n请在这里编写清晰、可验证的执行步骤。`;
    const definition = parseSkillMarkdown(markdown, { expectedName: name, version: '1.0.0' });
    const skill: SkillPackage = {
      name,
      definition,
      files: [textSkillFile('SKILL.md', markdown)],
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.put(skill);
    return clonePackage(skill);
  }

  async savePackage(
    name: string,
    files: SkillPackageFile[],
    now = Date.now(),
  ): Promise<SkillPackage> {
    const current = await this.requireCustom(name);
    const definition = validateSkillPackageFiles(files, name, current.definition.version);
    const next: SkillPackage = {
      ...current,
      definition,
      files: files.map((file) => ({ ...file })),
      updatedAt: now,
    };
    await this.repository.put(next);
    return clonePackage(next);
  }

  async importPackage(skill: SkillPackage): Promise<SkillPackage> {
    if (this.bundles.some(({ definition }) => definition.name === skill.name)) {
      throw new Error('不能覆盖内置 Skill。');
    }
    const current = await this.repository.get(skill.name);
    if (current) throw new Error('同名 Skill 已存在；请先删除、重命名或在编辑器中更新。');
    const definition = validateSkillPackageFiles(skill.files, skill.name, skill.definition.version);
    const next = clonePackage({
      ...skill,
      definition,
      createdAt: skill.createdAt,
      updatedAt: Date.now(),
    });
    await this.repository.put(next);
    return next;
  }

  async duplicate(name: string, nextName: string, now = Date.now()): Promise<SkillPackage> {
    if (await this.isKnown(nextName)) throw new Error('Skill 名称已存在。');
    const files = await this.readAllFiles(name);
    const source = files.find(({ path }) => path === 'SKILL.md');
    if (source?.kind !== 'text') throw new Error('Skill 缺少 SKILL.md。');
    const nextMarkdown = source.content.replace(/^name:\s*[a-z0-9-]+\s*$/mu, `name: ${nextName}`);
    const nextFiles = files.map((file) =>
      file.path === 'SKILL.md' ? textSkillFile('SKILL.md', nextMarkdown) : { ...file },
    );
    const definition = parseSkillMarkdown(nextMarkdown, {
      expectedName: nextName,
      version: '1.0.0',
    });
    const skill: SkillPackage = {
      name: nextName,
      definition,
      files: nextFiles,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.put(skill);
    return clonePackage(skill);
  }

  async delete(name: string): Promise<void> {
    await this.requireCustom(name);
    await Promise.all([this.repository.delete(name), this.repository.deleteGrantsForSkill(name)]);
    const settings = await this.loadSettings();
    const disabled = new Set(settings.disabled);
    disabled.delete(name);
    await this.saveSettings(disabled);
  }

  async getPackage(name: string): Promise<SkillPackage> {
    const custom = await this.repository.get(name);
    if (custom) return custom;
    const bundle = this.bundles.find(({ definition }) => definition.name === name);
    if (!bundle) throw new Error('未知 Skill。');
    const files: SkillPackageFile[] = [
      textSkillFile('SKILL.md', await this.readResource(bundle.instructions)),
    ];
    for (const [path, resource] of Object.entries(bundle.references)) {
      files.push(textSkillFile(path, await this.readResource(resource)));
    }
    return {
      name,
      definition: cloneDefinition(bundle.definition),
      files,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  async listCustomPackages(): Promise<SkillPackage[]> {
    return this.repository.list();
  }

  async listAllPackages(): Promise<SkillPackage[]> {
    const custom = await this.repository.list();
    const builtins = await Promise.all(
      this.bundles.map(({ definition }) => this.getPackage(definition.name)),
    );
    return [...builtins, ...custom];
  }

  async load(
    name: string,
    reference?: string,
  ): Promise<{ skill: SkillDefinition; content: string }> {
    const settings = await this.loadSettings();
    if (settings.disabled.includes(name)) throw new Error(`Skill ${name} 已停用。`);
    const custom = await this.repository.get(name);
    if (custom) {
      const path = reference ?? 'SKILL.md';
      if (reference && !custom.definition.references.some((item) => item.path === reference)) {
        throw new Error('该参考文件没有在 SKILL.md 中声明。');
      }
      const file = custom.files.find((item) => item.path === path);
      if (file?.kind !== 'text') throw new Error('Skill 文本资源不存在。');
      return { skill: cloneDefinition(custom.definition), content: file.content };
    }
    const bundle = this.requireBundle(name);
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

  async readFile(name: string, path: string): Promise<SkillPackageFile> {
    const files = await this.readAllFiles(name);
    const file = files.find((item) => item.path === path);
    if (!file) throw new Error('Skill 文件不存在。');
    return { ...file };
  }

  async resolveGrant(
    skillName: string,
    capability: SkillCapability,
    decision: 'allow' | 'deny',
    now = Date.now(),
  ): Promise<CapabilityGrant> {
    const skill = await this.requireKnown(skillName);
    if (!skill.capabilities.includes(capability)) throw new Error('Skill 未声明该能力。');
    const id = `${skillName}:${capability}`;
    const previous = (await this.repository.listGrants()).find((grant) => grant.id === id);
    const grant: CapabilityGrant = {
      id,
      skillName,
      capability,
      decision,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await this.repository.putGrant(grant);
    return { ...grant };
  }

  async revokeGrant(id: string): Promise<void> {
    await this.repository.deleteGrant(id);
  }

  async persistentGrant(
    skillName: string,
    capability: SkillCapability,
  ): Promise<'allow' | 'deny' | null> {
    const grant = (await this.repository.listGrants()).find(
      (item) => item.skillName === skillName && item.capability === capability,
    );
    return grant?.decision ?? null;
  }

  private async readAllFiles(name: string): Promise<SkillPackageFile[]> {
    return (await this.getPackage(name)).files;
  }

  private requireBundle(name: string): BuiltinSkillBundle {
    const bundle = this.bundles.find(({ definition }) => definition.name === name);
    if (!bundle) throw new Error('未知 Skill。');
    return bundle;
  }

  private async requireCustom(name: string): Promise<SkillPackage> {
    const skill = await this.repository.get(name);
    if (!skill) throw new Error('本地 Skill 不存在或为只读内置 Skill。');
    return skill;
  }

  private async requireKnown(name: string): Promise<SkillDefinition> {
    const builtin = this.bundles.find(({ definition }) => definition.name === name)?.definition;
    if (builtin) return builtin;
    return (await this.requireCustom(name)).definition;
  }

  private async isKnown(name: string): Promise<boolean> {
    return (
      this.bundles.some(({ definition }) => definition.name === name) ||
      (await this.repository.get(name)) !== undefined
    );
  }

  private async loadSettings(): Promise<StoredSkillSettings> {
    const value = (await this.storage.get(SKILL_SETTINGS_KEY))[SKILL_SETTINGS_KEY];
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.disabled)) {
      return { version: 1, disabled: [] };
    }
    return {
      version: 1,
      disabled: [
        ...new Set(value.disabled.flatMap((item) => (typeof item === 'string' ? [item] : []))),
      ],
    };
  }

  private async saveSettings(disabled: Set<string>): Promise<void> {
    await this.storage.set({
      [SKILL_SETTINGS_KEY]: {
        version: 1,
        disabled: [...disabled].sort(),
      } satisfies StoredSkillSettings,
    });
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

function toCatalogEntry(
  definition: SkillDefinition,
  disabled: Set<string>,
  fileCount: number,
): SkillCatalogEntry {
  return {
    name: definition.name,
    description: definition.description,
    version: definition.version,
    builtIn: definition.builtIn,
    enabled: !disabled.has(definition.name),
    capabilities: [...definition.capabilities],
    fileCount,
    ...(definition.matchedOrigins ? { matchedOrigins: [...definition.matchedOrigins] } : {}),
  };
}

function cloneBundle(bundle: BuiltinSkillBundle): BuiltinSkillBundle {
  return {
    definition: cloneDefinition(bundle.definition),
    instructions: { ...bundle.instructions },
    references: Object.fromEntries(
      Object.entries(bundle.references).map(([path, resource]) => [path, { ...resource }]),
    ),
  };
}

function cloneDefinition(definition: SkillDefinition): SkillDefinition {
  return {
    ...definition,
    allowedTools: [...definition.allowedTools],
    capabilities: [...definition.capabilities],
    references: definition.references.map((reference) => ({ ...reference })),
    ...(definition.matchedOrigins ? { matchedOrigins: [...definition.matchedOrigins] } : {}),
  };
}

function clonePackage(skill: SkillPackage): SkillPackage {
  return {
    ...skill,
    definition: cloneDefinition(skill.definition),
    files: skill.files.map((file) => ({ ...file })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
