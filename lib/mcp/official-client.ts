import {
  type AuthProvider,
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { McpToolSchema } from './types';

const MAX_SCHEMA_CHARS = 20_000;

export interface McpCallOutput {
  isError: boolean;
  content: unknown[];
  structuredContent?: unknown;
}

export interface McpRemoteClient {
  listTools(signal?: AbortSignal): Promise<McpToolSchema[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpCallOutput>;
  close(): Promise<void>;
}

export async function connectOfficialMcp(url: string, token: string): Promise<McpRemoteClient> {
  const authProvider: AuthProvider | undefined = token ? { token: async () => token } : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider });
  const client = new Client(
    { name: 'BossPilot', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(transport);
  return {
    async listTools(signal) {
      const result = await client.listTools(undefined, { signal });
      return result.tools.slice(0, 64).map((tool) => ({
        name: tool.name.slice(0, 128),
        description: (tool.description ?? tool.title ?? tool.name).slice(0, 600),
        readOnly: tool.annotations?.readOnlyHint === true,
        inputSchema: normalizeSchema(tool.inputSchema),
      }));
    },
    async callTool(name, args, signal) {
      const result = await client.callTool({ name, arguments: args }, { signal });
      return {
        isError: result.isError === true,
        content: result.content,
        ...('structuredContent' in result ? { structuredContent: result.structuredContent } : {}),
      };
    },
    async close() {
      await transport.terminateSession().catch(() => void 0);
      await client.close();
    },
  };
}

function normalizeSchema(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  const schema = structuredClone(value) as Record<string, unknown>;
  if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS) {
    return { type: 'object', properties: {}, additionalProperties: true };
  }
  return {
    ...schema,
    type: 'object',
    properties:
      typeof schema.properties === 'object' && schema.properties !== null ? schema.properties : {},
  };
}
