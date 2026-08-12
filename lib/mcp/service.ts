import type {
  GenerationImageContent,
  GenerationToolCall,
  GenerationToolDefinition,
  GenerationToolExecutionOutcome,
} from '@/lib/generation/types';
import { connectOfficialMcp, type McpRemoteClient } from './official-client';
import { McpStore, validateMcpUrl } from './store';
import type { McpServerRecord, McpSettingsView, McpToolSchema } from './types';

const MAX_RESULT_CHARS = 20_000;
const MCP_PREFIX = 'mcp__';

export type McpConnector = (url: string, token: string) => Promise<McpRemoteClient>;

export interface McpRepository {
  upsert(
    input: { id?: string; name: string; url: string; token: string },
    tools: McpToolSchema[],
  ): Promise<McpSettingsView>;
  view(): Promise<McpSettingsView>;
  setEnabled(id: string, enabled: boolean): Promise<McpSettingsView>;
  remove(id: string): Promise<McpSettingsView>;
  listRecords(): Promise<McpServerRecord[]>;
}

export class McpService {
  constructor(
    private readonly store: McpRepository = new McpStore(),
    private readonly connect: McpConnector = connectOfficialMcp,
  ) {}

  async addOrRefresh(
    input: { id?: string; name: string; url: string; token: string },
    signal?: AbortSignal,
  ) {
    const normalizedUrl = validateMcpUrl(input.url);
    const normalizedInput = { ...input, url: normalizedUrl };
    const client = await this.connect(normalizedUrl, input.token);
    try {
      const tools = await client.listTools(signal);
      if (!tools.length) throw new Error('这个 MCP 服务没有公开可用工具。');
      return await this.store.upsert(normalizedInput, tools);
    } finally {
      await client.close().catch(() => void 0);
    }
  }

  view(): Promise<McpSettingsView> {
    return this.store.view();
  }

  setEnabled(id: string, enabled: boolean) {
    return this.store.setEnabled(id, enabled);
  }

  remove(id: string) {
    return this.store.remove(id);
  }

  async generationTools(): Promise<GenerationToolDefinition[]> {
    const servers = (await this.store.listRecords()).filter(({ enabled }) => enabled);
    return servers.flatMap((server) =>
      server.toolSchemas.map((tool) => ({
        name: dynamicName(server, tool),
        label: `${server.name} · ${tool.name}`,
        description: [
          `来自用户配置的 MCP 服务“${server.name}”。`,
          tool.description,
          tool.readOnly
            ? '服务声明这是只读工具。'
            : '这不是已声明的只读工具，调用前必须获得用户逐次确认。',
        ].join(' '),
        parameters: {
          type: 'object' as const,
          properties: isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {},
          ...(Array.isArray(tool.inputSchema.required)
            ? {
                required: tool.inputSchema.required.flatMap((item) =>
                  typeof item === 'string' ? [item] : [],
                ),
              }
            : {}),
          additionalProperties: tool.inputSchema.additionalProperties !== false,
        },
      })),
    );
  }

  async execute(
    call: GenerationToolCall,
    approved: boolean,
    signal: AbortSignal,
  ): Promise<GenerationToolExecutionOutcome> {
    const match = await this.findTool(call.name);
    if (!match) return failure('MCP 工具不存在或所属服务已停用。');
    if (!match.tool.readOnly && !approved) {
      return {
        deferred: true,
        kind: 'user_input',
        statusText: '等待确认 MCP 外部操作',
        question: `“${match.server.name}”将执行“${match.tool.name}”。该服务未声明这是只读操作，是否继续？`,
        options: [
          { id: 'confirm', label: '确认执行' },
          { id: 'cancel', label: '取消' },
        ],
        allowCustom: false,
      };
    }

    const client = await this.connect(match.server.url, match.server.token);
    try {
      const result = await client.callTool(match.tool.name, call.arguments, signal);
      signal.throwIfAborted();
      const converted = convertResult(result.content, result.structuredContent);
      return {
        isError: result.isError,
        statusText: result.isError ? 'MCP 工具执行失败' : 'MCP 工具执行完成',
        detail: `${match.server.name} · ${match.tool.name}`,
        content: converted.text,
        ...(converted.images.length ? { images: converted.images } : {}),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return failure(publicError(error));
    } finally {
      await client.close().catch(() => void 0);
    }
  }

  private async findTool(name: string) {
    if (!name.startsWith(MCP_PREFIX)) return undefined;
    for (const server of await this.store.listRecords()) {
      if (!server.enabled) continue;
      const tool = server.toolSchemas.find((candidate) => dynamicName(server, candidate) === name);
      if (tool) return { server, tool };
    }
    return undefined;
  }
}

export function isMcpToolName(name: string): name is `mcp__${string}` {
  return name.startsWith(MCP_PREFIX);
}

function dynamicName(server: McpServerRecord, tool: McpToolSchema): `mcp__${string}` {
  const serverPart = server.id.replace(/[^a-zA-Z0-9]/gu, '').slice(0, 8) || 'server';
  const slug = tool.name.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 30) || 'tool';
  return `mcp__${serverPart}__${slug}_${hash(tool.name)}`;
}

function hash(value: string): string {
  let result = 2_166_136_261;
  for (const char of value) {
    result ^= char.codePointAt(0) ?? 0;
    result = Math.imul(result, 16_777_619);
  }
  return (result >>> 0).toString(36).slice(0, 6);
}

function convertResult(content: unknown[], structured: unknown) {
  const texts: string[] = [];
  const images: GenerationImageContent[] = [];
  for (const item of content.slice(0, 32)) {
    if (!isRecord(item) || typeof item.type !== 'string') continue;
    if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text);
    if (
      item.type === 'image' &&
      typeof item.data === 'string' &&
      item.data.length <= 2_800_000 &&
      (item.mimeType === 'image/png' ||
        item.mimeType === 'image/jpeg' ||
        item.mimeType === 'image/webp')
    ) {
      images.push({ data: item.data, mimeType: item.mimeType });
    }
  }
  if (structured !== undefined) texts.push(JSON.stringify(structured));
  return {
    text: (texts.join('\n') || 'MCP 工具没有返回可展示的文本。').slice(0, MAX_RESULT_CHARS),
    images: images.slice(0, 3),
  };
}

function failure(detail: string): GenerationToolExecutionOutcome {
  return {
    isError: true,
    statusText: 'MCP 工具执行失败',
    detail,
    content: `MCP 工具失败：${detail}`,
  };
}

function publicError(error: unknown): string {
  const value = error instanceof Error ? error.message : 'MCP 服务请求失败。';
  return value.replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]').slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
