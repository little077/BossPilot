import { describe, expect, it, vi } from 'vitest';
import { type MemoryStorageArea, MemoryStore } from './store';

function memoryStorage(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  const storage: MemoryStorageArea = {
    get: vi.fn(async () => ({ ...data })),
    set: vi.fn(async (items) => Object.assign(data, items)),
  };
  return { storage, data };
}

describe('MemoryStore', () => {
  it('defaults to disabled and bounds custom instructions', async () => {
    const store = new MemoryStore(memoryStorage().storage);
    await expect(store.settings()).resolves.toEqual({
      version: 1,
      instructions: '',
      memoryEnabled: false,
    });
    await expect(
      store.saveSettings({ instructions: '  请用中文\n回答  ', memoryEnabled: true }),
    ).resolves.toMatchObject({
      settings: { instructions: '请用中文 回答', memoryEnabled: true },
    });
    await expect(
      store.saveSettings({ instructions: 'x'.repeat(4_001), memoryEnabled: false }),
    ).resolves.toMatchObject({ settings: { instructions: '' } });
  });

  it('adds, deduplicates, updates, removes, and clears local memories', async () => {
    const memory = memoryStorage();
    let tick = 10;
    const store = new MemoryStore(
      memory.storage,
      () => `id-${tick}`,
      () => tick++,
    );
    await store.add('优先看技术成长');
    await store.add('优先看技术成长');
    expect(await store.list()).toHaveLength(1);
    await expect(store.update('id-11', '优先看团队技术氛围')).resolves.toMatchObject({
      memories: [{ content: '优先看团队技术氛围', updatedAt: 11 }],
    });
    await expect(store.update('missing', 'x')).rejects.toThrow('不存在');
    await expect(store.remove('missing')).rejects.toThrow('不存在');
    await expect(store.remove('id-11')).resolves.toMatchObject({ memories: [] });
    await store.add('常驻西安');
    await expect(store.clear()).resolves.toMatchObject({ memories: [] });
    expect(memory.data).toHaveProperty('bosspilot:memories:v1');
  });

  it('filters malformed rows and ranks Chinese or word matches deterministically', async () => {
    const store = new MemoryStore(
      memoryStorage({
        'bosspilot:memories:v1': [
          { id: 'a', content: '偏好 React 技术栈和远程岗位', createdAt: 1, updatedAt: 2 },
          { id: 'b', content: '希望岗位在西安', createdAt: 1, updatedAt: 3 },
          { id: '', content: 'invalid', createdAt: 1, updatedAt: 2 },
        ],
        'bosspilot:agent-context:v1': { instructions: 42, memoryEnabled: 'yes' },
      }).storage,
    );
    expect(await store.settings()).toMatchObject({ instructions: '', memoryEnabled: false });
    expect((await store.search('React 前端')).map(({ id }) => id)).toEqual(['a']);
    expect((await store.search('西安工作')).map(({ id }) => id)).toEqual(['b']);
    expect(await store.search('')).toEqual([]);
  });

  it('rejects empty or oversized memory content', async () => {
    const store = new MemoryStore(memoryStorage().storage);
    await expect(store.add('')).rejects.toThrow('1-500');
    await expect(store.add('x'.repeat(501))).rejects.toThrow('1-500');
  });
});
