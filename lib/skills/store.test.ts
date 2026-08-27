import { describe, expect, it, vi } from 'vitest';
import type { BuiltinSkillBundle } from './builtin';
import { MemorySkillRepository, type SkillStorageArea, SkillStore } from './store';

function bundle(name = 'test-skill'): BuiltinSkillBundle {
  return {
    definition: {
      name,
      description: 'Test',
      instructions: '# Workflow',
      version: '1.0.0',
      builtIn: true,
      enabled: true,
      allowedTools: ['read_current_page'],
      capabilities: [],
      references: [{ path: 'references/guide.md', label: 'guide' }],
    },
    instructions: { kind: 'inline', value: '# Workflow' },
    references: { 'references/guide.md': { kind: 'inline', value: '# Guide' } },
    scripts: { 'scripts/collect.js': { kind: 'inline', value: 'return input;' } },
  };
}

function memoryStorage(initial?: unknown) {
  const data: Record<string, unknown> = {};
  if (initial !== undefined) data['bosspilot:skills:v1'] = initial;
  const storage: SkillStorageArea = {
    get: vi.fn(async () => ({ ...data })),
    set: vi.fn(async (items) => Object.assign(data, items)),
  };
  return { storage, data };
}

describe('SkillStore', () => {
  it('lists built-ins, persists disablement, and refuses disabled loads', async () => {
    const memory = memoryStorage();
    const store = new SkillStore(memory.storage, [bundle()]);
    expect((await store.listEnabled()).map(({ name }) => name)).toEqual(['test-skill']);
    expect((await store.setEnabled('test-skill', false)).skills[0]?.enabled).toBe(false);
    await expect(store.load('test-skill')).rejects.toThrow('已停用');
    expect(memory.data['bosspilot:skills:v1']).toEqual({
      version: 1,
      disabled: ['test-skill'],
    });
  });

  it('loads the main instructions and only declared reference files', async () => {
    const store = new SkillStore(memoryStorage().storage, [bundle()]);
    await expect(store.load('test-skill')).resolves.toMatchObject({ content: '# Workflow' });
    await expect(store.load('test-skill', 'references/guide.md')).resolves.toMatchObject({
      content: '# Guide',
    });
    await expect(store.load('test-skill', 'references/secret.md')).rejects.toThrow('没有在');
    await expect(store.load('unknown')).rejects.toThrow('未知');
  });

  it('ignores malformed and unknown persisted names', async () => {
    const invalid = new SkillStore(
      memoryStorage({ version: 2, disabled: ['test-skill'] }).storage,
      [bundle()],
    );
    expect((await invalid.list()).skills[0]?.enabled).toBe(true);
    const unknown = new SkillStore(
      memoryStorage({ version: 1, disabled: ['unknown', 'test-skill', 42] }).storage,
      [bundle()],
    );
    expect((await unknown.list()).skills[0]?.enabled).toBe(false);
  });

  it('fetches packaged resources with credentials omitted and handles read failures', async () => {
    const remote = bundle();
    remote.instructions = { kind: 'url', value: 'chrome-extension://id/SKILL.md' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn(async () => '# Remote') })
      .mockResolvedValueOnce({ ok: false, text: vi.fn() });
    vi.stubGlobal('fetch', fetchMock);
    const store = new SkillStore(memoryStorage().storage, [remote]);
    await expect(store.load('test-skill')).resolves.toMatchObject({ content: '# Remote' });
    expect(fetchMock).toHaveBeenCalledWith('chrome-extension://id/SKILL.md', {
      credentials: 'omit',
      cache: 'force-cache',
    });
    await expect(store.load('test-skill')).rejects.toThrow('本地资源读取失败');
  });

  it('creates, edits, duplicates and deletes isolated local packages', async () => {
    const repository = new MemorySkillRepository();
    const store = new SkillStore(memoryStorage().storage, [], undefined, repository);
    const created = await store.create('local-skill', 10);
    expect(created.files.map(({ path }) => path)).toEqual(['SKILL.md']);
    const markdown = created.files[0];
    if (!markdown) throw new Error('fixture missing');
    const updatedContent = markdown.content.replace(
      '请描述这个 Skill 何时使用以及能完成什么。',
      '整理网页并输出清晰报告。',
    );
    const saved = await store.savePackage(
      'local-skill',
      [
        {
          ...markdown,
          content: updatedContent,
          size: new TextEncoder().encode(updatedContent).byteLength,
        },
        {
          path: 'references/guide.md',
          kind: 'text',
          content: '# Guide',
          mimeType: 'text/markdown',
          size: 7,
        },
      ],
      20,
    );
    expect(saved.definition.description).toBe('整理网页并输出清晰报告。');
    await expect(store.duplicate('local-skill', 'local-copy', 30)).resolves.toMatchObject({
      name: 'local-copy',
    });
    expect((await store.list()).skills.map(({ name }) => name)).toEqual([
      'local-copy',
      'local-skill',
    ]);
    await store.delete('local-copy');
    await expect(store.getPackage('local-copy')).rejects.toThrow('未知');
  });

  it('stores and revokes explicit capability decisions', async () => {
    const repository = new MemorySkillRepository();
    const store = new SkillStore(memoryStorage().storage, [], undefined, repository);
    const created = await store.create('permission-skill');
    expect(created.definition.capabilities).toEqual(['workspace.read']);
    const grant = await store.resolveGrant('permission-skill', 'workspace.read', 'allow', 10);
    expect(await store.persistentGrant('permission-skill', 'workspace.read')).toBe('allow');
    expect((await store.list()).grants).toEqual([grant]);
    await store.revokeGrant(grant.id);
    expect(await store.persistentGrant('permission-skill', 'workspace.read')).toBeNull();
    await expect(store.resolveGrant('permission-skill', 'page.script', 'allow')).rejects.toThrow(
      '未声明',
    );
  });

  it('imports validated packages, reads declared files, and rejects collisions', async () => {
    const sourceStore = new SkillStore(memoryStorage().storage, []);
    const source = await sourceStore.create('imported-skill', 10);
    const skillFile = source.files[0];
    if (!skillFile) throw new Error('fixture missing');
    const markdown = skillFile.content.replace(
      '请在这里编写清晰、可验证的执行步骤。',
      '按需读取 `references/guide.md`。',
    );
    const imported = {
      ...source,
      files: [
        {
          ...skillFile,
          content: markdown,
          size: new TextEncoder().encode(markdown).byteLength,
        },
        {
          path: 'references/guide.md',
          kind: 'text' as const,
          content: '# Guide',
          mimeType: 'text/markdown',
          size: 7,
        },
      ],
    };
    const repository = new MemorySkillRepository();
    const store = new SkillStore(memoryStorage().storage, [bundle()], undefined, repository);
    await store.importPackage(imported);
    await expect(store.load('imported-skill', 'references/guide.md')).resolves.toMatchObject({
      content: '# Guide',
    });
    await expect(store.readFile('imported-skill', 'references/guide.md')).resolves.toMatchObject({
      path: 'references/guide.md',
    });
    await expect(store.readFile('imported-skill', 'missing.md')).rejects.toThrow('不存在');
    expect((await store.listCustomPackages()).map(({ name }) => name)).toEqual(['imported-skill']);
    expect((await store.listAllPackages()).map(({ name }) => name).sort()).toEqual([
      'imported-skill',
      'test-skill',
    ]);
    await expect(store.importPackage(imported)).rejects.toThrow('同名');
    await expect(store.importPackage({ ...imported, name: 'test-skill' })).rejects.toThrow('内置');
    await expect(store.create('test-skill')).rejects.toThrow('已存在');
    await expect(store.duplicate('imported-skill', 'test-skill')).rejects.toThrow('已存在');
    await expect(store.delete('test-skill')).rejects.toThrow('只读');
  });
});
