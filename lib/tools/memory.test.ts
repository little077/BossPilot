import { describe, expect, it, vi } from 'vitest';
import type { GenerationToolCall } from '@/lib/generation/types';
import { type MemoryRepository, MemoryToolCoordinator } from './memory';

type FakeStore = MemoryRepository;

const call = (name: 'search_memory' | 'save_memory', value: unknown): GenerationToolCall => ({
  id: 'call-1',
  name,
  arguments: name === 'search_memory' ? { query: value } : { content: value },
});

function store(enabled = true): FakeStore {
  return {
    settings: vi.fn(async () => ({
      version: 1 as const,
      instructions: '',
      memoryEnabled: enabled,
    })),
    search: vi.fn(async () => [{ id: 'm1', content: '优先 React', createdAt: 1, updatedAt: 2 }]),
    add: vi.fn(async () => ({
      settings: { version: 1 as const, instructions: '', memoryEnabled: true },
      memories: [],
    })),
  };
}

describe('MemoryToolCoordinator', () => {
  it('searches only when enabled and returns a bounded local result envelope', async () => {
    const fake = store();
    const coordinator = new MemoryToolCoordinator(fake);
    await expect(
      coordinator.execute(
        call('search_memory', 'React'),
        '帮我找工作',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: false, detail: '找到 1 条' });
    expect(fake.search).toHaveBeenCalledWith('React');
    await expect(
      new MemoryToolCoordinator(store(false)).execute(
        call('search_memory', 'React'),
        'test',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, detail: '本地长期记忆已关闭。' });
  });

  it('saves only explicit non-sensitive user-directed memory', async () => {
    const fake = store();
    const coordinator = new MemoryToolCoordinator(fake);
    await expect(
      coordinator.execute(
        call('save_memory', '优先远程岗位'),
        '请记住我优先远程岗位',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: false, statusText: '已保存本地记忆' });
    expect(fake.add).toHaveBeenCalledWith('优先远程岗位');
    await expect(
      coordinator.execute(
        call('save_memory', '优先远程岗位'),
        '推荐岗位',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, detail: expect.stringContaining('明确要求') });
    await expect(
      coordinator.execute(
        call('save_memory', '我的 API Key 是 secret'),
        '请记住',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, detail: expect.stringContaining('敏感') });
  });

  it('rejects malformed and aborted calls', async () => {
    const coordinator = new MemoryToolCoordinator(store());
    await expect(
      coordinator.execute(call('search_memory', ''), 'test', new AbortController().signal),
    ).resolves.toMatchObject({ isError: true });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      coordinator.execute(call('search_memory', 'x'), 'test', aborted.signal),
    ).rejects.toThrow();
  });
});
