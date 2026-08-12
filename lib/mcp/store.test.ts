import { describe, expect, it, vi } from 'vitest';
import { type McpStorageArea, McpStore, permissionPatternForMcp, validateMcpUrl } from './store';
import type { McpToolSchema } from './types';

const TOOL: McpToolSchema = {
  name: 'search',
  description: 'Search docs',
  readOnly: true,
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};

function memoryStorage(initial?: unknown) {
  const data: Record<string, unknown> = {};
  if (initial !== undefined) data['bosspilot:mcp:v1'] = initial;
  const storage: McpStorageArea = {
    get: vi.fn(async () => ({ ...data })),
    set: vi.fn(async (items) => Object.assign(data, items)),
  };
  return { storage, data };
}

describe('McpStore', () => {
  it('stores private records but never returns tokens in the settings view', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
    const memory = memoryStorage();
    const store = new McpStore(memory.storage);
    const view = await store.upsert(
      { name: 'Docs', url: 'https://mcp.example.com/mcp#x', token: 'secret' },
      [TOOL],
    );
    expect(view.servers[0]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      url: 'https://mcp.example.com/mcp',
      tokenConfigured: true,
      tools: [{ name: 'search', readOnly: true }],
    });
    expect(view.servers[0]).not.toHaveProperty('token');
    expect(JSON.stringify(memory.data)).toContain('secret');
  });

  it('updates, disables, and removes a server while preserving an omitted token', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
    const store = new McpStore(memoryStorage().storage);
    await store.upsert({ name: 'Docs', url: 'https://mcp.example/mcp', token: 'secret' }, [TOOL]);
    await store.upsert(
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'New',
        url: 'https://mcp.example/mcp',
        token: '',
      },
      [TOOL],
    );
    expect((await store.listRecords())[0]?.token).toBe('secret');
    expect(
      (await store.setEnabled('00000000-0000-4000-8000-000000000001', false)).servers[0]?.enabled,
    ).toBe(false);
    await expect(store.setEnabled('missing', true)).rejects.toThrow('不存在');
    await expect(store.remove('missing')).rejects.toThrow('不存在');
    await expect(store.remove('00000000-0000-4000-8000-000000000001')).resolves.toMatchObject({
      servers: [],
    });
  });

  it('validates secure endpoints and exact permission patterns', () => {
    expect(validateMcpUrl('https://user:pass@example.com/mcp#x')).toBe('https://example.com/mcp');
    expect(validateMcpUrl('http://localhost:3000/mcp')).toBe('http://localhost:3000/mcp');
    expect(permissionPatternForMcp('https://example.com/mcp')).toBe('https://example.com/*');
    expect(() => validateMcpUrl('http://example.com/mcp')).toThrow('HTTPS');
  });

  it('ignores malformed stored rows and enforces the server cap', async () => {
    expect(await new McpStore(memoryStorage([{}]).storage).listRecords()).toEqual([]);
    const records = Array.from({ length: 8 }, (_, index) => ({
      id: `s-${index}`,
      name: `S${index}`,
      url: 'https://example.com/mcp',
      enabled: true,
      token: '',
      tokenConfigured: false,
      tools: [],
      toolSchemas: [],
      updatedAt: 1,
    }));
    const store = new McpStore(memoryStorage(records).storage);
    await expect(
      store.upsert({ name: 'extra', url: 'https://x.example/mcp', token: '' }, [TOOL]),
    ).rejects.toThrow('8');

    const unsafe = { ...records[0], url: 'http://example.com/mcp' };
    expect(await new McpStore(memoryStorage([unsafe]).storage).listRecords()).toEqual([]);
  });
});
