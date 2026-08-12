import { describe, expect, it, vi } from 'vitest';
import type { BuiltinSkillBundle } from './builtin';
import { type SkillStorageArea, SkillStore } from './store';

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
      references: [{ path: 'references/guide.md', label: 'guide' }],
    },
    instructions: { kind: 'inline', value: '# Workflow' },
    references: { 'references/guide.md': { kind: 'inline', value: '# Guide' } },
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
});
