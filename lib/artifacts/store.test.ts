// ─── 工件仓库单测 ───
// jsdom 没有 IndexedDB，用内存表 mock db 模块：验证写入形状、超限按时间淘最旧、查询与清空。

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeRow {
  id: string;
  tool: string;
  summary: string;
  text: string;
  createdAt: number;
}

const fake = vi.hoisted(() => {
  const rows: FakeRow[] = [];
  const artifacts = {
    put: vi.fn(async (row: FakeRow) => {
      const index = rows.findIndex((item) => item.id === row.id);
      if (index >= 0) rows[index] = row;
      else rows.push(row);
    }),
    get: vi.fn(async (id: string) => rows.find((row) => row.id === id)),
    clear: vi.fn(async () => {
      rows.length = 0;
    }),
    bulkDelete: vi.fn(async (ids: string[]) => {
      const removed = new Set(ids);
      const kept = rows.filter((row) => !removed.has(row.id));
      rows.length = 0;
      rows.push(...kept);
    }),
    orderBy: vi.fn((key: 'createdAt') => ({
      toArray: async () => [...rows].sort((a, b) => a[key] - b[key]),
    })),
  };
  return { rows, artifacts };
});

vi.mock('@/lib/storage/db', () => ({ db: { artifacts: fake.artifacts } }));

import { clearArtifacts, getArtifact, MAX_ARTIFACTS, putArtifact } from './store';

beforeEach(() => {
  // setup.ts 的 restoreAllMocks 不清理调用历史与数据，这里显式复位保证用例互不污染。
  fake.rows.length = 0;
  vi.clearAllMocks();
});

describe('putArtifact', () => {
  it('生成 id/createdAt 并落库，返回完整记录', async () => {
    const record = await putArtifact({
      tool: 'read_current_page',
      summary: '已读取',
      text: '正文',
    });

    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.createdAt).toBeTypeOf('number');
    expect(record.tool).toBe('read_current_page');
    expect(fake.rows).toEqual([record]);
  });

  it('超出总量上限时按 createdAt 淘汰最旧的一条，新工件保留', async () => {
    for (let i = 0; i < MAX_ARTIFACTS; i += 1) {
      fake.rows.push({ id: `old-${i}`, tool: 't', summary: 's', text: 'x', createdAt: 1000 + i });
    }

    const record = await putArtifact({ tool: 't', summary: 's', text: '最新正文' });

    expect(fake.rows).toHaveLength(MAX_ARTIFACTS);
    expect(fake.rows.some((row) => row.id === 'old-0')).toBe(false);
    expect(fake.rows.some((row) => row.id === 'old-1')).toBe(true);
    expect(fake.rows.some((row) => row.id === record.id)).toBe(true);
  });

  it('未超限时不触发删除', async () => {
    await putArtifact({ tool: 't', summary: 's', text: 'x' });
    expect(fake.artifacts.bulkDelete).not.toHaveBeenCalled();
  });
});

describe('getArtifact', () => {
  it('命中返回记录，未命中返回 null（淘汰后的诚实路径由调用方映射错误码）', async () => {
    const record = await putArtifact({ tool: 't', summary: 's', text: 'x' });

    await expect(getArtifact(record.id)).resolves.toEqual(record);
    await expect(getArtifact('no-such-id')).resolves.toBeNull();
  });
});

describe('clearArtifacts', () => {
  it('全量清空档案柜', async () => {
    await putArtifact({ tool: 't', summary: 's', text: 'x' });
    await clearArtifacts();
    expect(fake.rows).toHaveLength(0);
  });
});
