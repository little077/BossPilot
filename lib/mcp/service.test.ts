import { describe, expect, it, vi } from 'vitest';
import type { GenerationToolCall } from '@/lib/generation/types';
import type { McpRemoteClient } from './official-client';
import { isMcpToolName, type McpRepository, McpService } from './service';
import type { McpServerRecord, McpSettingsView, McpToolSchema } from './types';

const TOOL: McpToolSchema = {
  name: 'search docs',
  description: 'Search',
  readOnly: true,
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};

const RECORD: McpServerRecord = {
  id: 'server123',
  name: 'Docs',
  url: 'https://mcp.example/mcp',
  enabled: true,
  token: 'secret',
  tokenConfigured: true,
  tools: [{ name: TOOL.name, description: TOOL.description, readOnly: TOOL.readOnly }],
  toolSchemas: [TOOL],
  updatedAt: 1,
};

function repository(record = RECORD): McpRepository {
  const view: McpSettingsView = { version: 1, servers: [] };
  return {
    listRecords: vi.fn(async () => [record]),
    upsert: vi.fn(async () => view),
    view: vi.fn(async () => view),
    setEnabled: vi.fn(async () => view),
    remove: vi.fn(async () => view),
  };
}

function remote(output: Partial<McpRemoteClient> = {}): McpRemoteClient {
  return {
    listTools: vi.fn(async () => [TOOL]),
    callTool: vi.fn(async () => ({ isError: false, content: [{ type: 'text', text: 'result' }] })),
    close: vi.fn(async () => undefined),
    ...output,
  };
}

describe('McpService', () => {
  it('publishes cached MCP schemas as dynamic model tools', async () => {
    const service = new McpService(
      repository(),
      vi.fn(async () => remote()),
    );
    const tools = await service.generationTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: expect.stringMatching(/^mcp__server12__/u),
      label: 'Docs · search docs',
      parameters: { required: ['q'] },
    });
  });

  it('executes read-only tools, converts safe content, and closes the client', async () => {
    const client = remote({
      callTool: vi.fn(async () => ({
        isError: false,
        content: [
          { type: 'text', text: 'result' },
          { type: 'image', data: 'AQID', mimeType: 'image/png' },
          { type: 'resource', uri: 'file:///secret' },
        ],
        structuredContent: { count: 1 },
      })),
    });
    const service = new McpService(
      repository(),
      vi.fn(async () => client),
    );
    const [definition] = await service.generationTools();
    if (!definition) throw new Error('missing tool');
    const call: GenerationToolCall = { id: 'c1', name: definition.name, arguments: { q: 'x' } };
    await expect(service.execute(call, false, new AbortController().signal)).resolves.toMatchObject(
      {
        isError: false,
        content: expect.stringContaining('result'),
        images: [{ data: 'AQID', mimeType: 'image/png' }],
      },
    );
    expect(client.close).toHaveBeenCalled();
  });

  it('requires per-call confirmation for tools not declared read-only', async () => {
    const write = { ...TOOL, readOnly: false };
    const service = new McpService(
      repository({ ...RECORD, toolSchemas: [write] }),
      vi.fn(async () => remote()),
    );
    const [definition] = await service.generationTools();
    if (!definition) throw new Error('missing tool');
    await expect(
      service.execute(
        { id: 'c1', name: definition.name, arguments: {} },
        false,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      deferred: true,
      kind: 'user_input',
      question: expect.stringContaining('是否继续'),
    });
  });

  it('refreshes a catalog and fails closed for unknown tools or remote errors', async () => {
    const repo = repository();
    const client = remote();
    const service = new McpService(
      repo,
      vi.fn(async () => client),
    );
    await service.addOrRefresh({ name: 'Docs', url: RECORD.url, token: '' });
    expect(repo.upsert).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
    await expect(
      service.execute(
        { id: 'x', name: 'mcp__unknown', arguments: {} },
        true,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true });
  });

  it('normalizes endpoints before connecting and closes after discovery failures', async () => {
    const client = remote({ listTools: vi.fn(async () => []) });
    const connect = vi.fn(async () => client);
    const service = new McpService(repository(), connect);
    await expect(
      service.addOrRefresh({ name: 'Docs', url: 'https://user:pass@mcp.example/mcp#x', token: '' }),
    ).rejects.toThrow();
    expect(connect).toHaveBeenCalledWith('https://mcp.example/mcp', '');
    expect(client.close).toHaveBeenCalled();
    await expect(
      service.addOrRefresh({ name: 'Bad', url: 'http://mcp.example/mcp', token: '' }),
    ).rejects.toThrow('HTTPS');
  });

  it('filters disabled servers and safely reports remote failures', async () => {
    const disabled = { ...RECORD, enabled: false };
    const service = new McpService(
      repository(disabled),
      vi.fn(async () => remote()),
    );
    await expect(service.generationTools()).resolves.toEqual([]);
    expect(isMcpToolName('mcp__tool')).toBe(true);
    expect(isMcpToolName('read_current_page')).toBe(false);

    const failed = new McpService(
      repository({ ...RECORD, toolSchemas: [{ ...TOOL, readOnly: false }] }),
      vi.fn(async () =>
        remote({ callTool: vi.fn(async () => Promise.reject(new Error('Bearer secret leaked'))) }),
      ),
    );
    const [definition] = await failed.generationTools();
    if (!definition) throw new Error('missing tool');
    await expect(
      failed.execute(
        { id: 'c2', name: definition.name, arguments: {} },
        true,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, detail: expect.stringContaining('[REDACTED]') });
  });

  it('ignores unsafe result parts and propagates cancellation', async () => {
    const controller = new AbortController();
    const client = remote({
      callTool: vi.fn(async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      }),
    });
    const service = new McpService(
      repository(),
      vi.fn(async () => client),
    );
    const [definition] = await service.generationTools();
    if (!definition) throw new Error('missing tool');
    await expect(
      service.execute({ id: 'c3', name: definition.name, arguments: {} }, true, controller.signal),
    ).rejects.toThrow('aborted');
    expect(client.close).toHaveBeenCalled();
  });
});
