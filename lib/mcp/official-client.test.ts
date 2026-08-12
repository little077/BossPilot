import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
  terminateSession: vi.fn(),
  transportOptions: undefined as unknown,
}));

vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    connect = mocks.connect;
    listTools = mocks.listTools;
    callTool = mocks.callTool;
    close = mocks.close;
  },
  StreamableHTTPClientTransport: class {
    terminateSession = mocks.terminateSession;
    constructor(_url: URL, options: unknown) {
      mocks.transportOptions = options;
    }
  },
}));

import { connectOfficialMcp } from './official-client';

describe('official MCP client adapter', () => {
  beforeEach(() => {
    for (const mock of [
      mocks.connect,
      mocks.listTools,
      mocks.callTool,
      mocks.close,
      mocks.terminateSession,
    ]) {
      mock.mockReset().mockResolvedValue(undefined);
    }
    mocks.listTools.mockResolvedValue({
      tools: [
        {
          name: 'search',
          description: 'Search docs',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    mocks.callTool.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { count: 1 },
    });
  });

  it('connects with bearer auth, discovers tools, calls, and closes the official transport', async () => {
    const client = await connectOfficialMcp('https://mcp.example/mcp', 'secret');
    expect(mocks.connect).toHaveBeenCalled();
    const auth = (mocks.transportOptions as { authProvider?: { token(): Promise<string> } })
      .authProvider;
    await expect(auth?.token()).resolves.toBe('secret');
    await expect(client.listTools()).resolves.toEqual([
      expect.objectContaining({ name: 'search', readOnly: true }),
    ]);
    await expect(
      client.callTool('search', { q: 'x' }, new AbortController().signal),
    ).resolves.toMatchObject({ structuredContent: { count: 1 } });
    await client.close();
    expect(mocks.terminateSession).toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalled();
  });

  it('connects without auth and normalizes malformed schemas', async () => {
    mocks.listTools.mockResolvedValueOnce({
      tools: [{ name: 'x', title: 'X', inputSchema: null }],
    });
    const client = await connectOfficialMcp('https://mcp.example/mcp', '');
    expect(mocks.transportOptions).toEqual({ authProvider: undefined });
    await expect(client.listTools()).resolves.toEqual([
      expect.objectContaining({
        name: 'x',
        description: 'X',
        readOnly: false,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }),
    ]);
  });

  it('bounds oversized remote schemas before exposing them to the model', async () => {
    mocks.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'oversized',
          description: 'x'.repeat(1_000),
          inputSchema: { type: 'object', properties: { huge: { enum: ['x'.repeat(21_000)] } } },
        },
      ],
    });
    const client = await connectOfficialMcp('https://mcp.example/mcp', '');
    await expect(client.listTools()).resolves.toEqual([
      expect.objectContaining({
        description: 'x'.repeat(600),
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      }),
    ]);
  });
});
