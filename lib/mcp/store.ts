import type { McpServerRecord, McpServerView, McpSettingsView, McpToolSchema } from './types';

const MCP_KEY = 'bosspilot:mcp:v1';
const MAX_SERVERS = 8;

export type McpStorageArea = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

export class McpStore {
  constructor(private readonly storage: McpStorageArea = chrome.storage.local) {}

  async listRecords(): Promise<McpServerRecord[]> {
    const value = (await this.storage.get(MCP_KEY))[MCP_KEY];
    if (!Array.isArray(value)) return [];
    return value
      .flatMap((record) => (isServerRecord(record) ? [cloneRecord(record)] : []))
      .slice(0, MAX_SERVERS);
  }

  async view(): Promise<McpSettingsView> {
    return { version: 1, servers: (await this.listRecords()).map(toView) };
  }

  async upsert(
    input: { id?: string; name: string; url: string; token: string },
    tools: McpToolSchema[],
  ) {
    const records = await this.listRecords();
    const current = input.id ? records.find((record) => record.id === input.id) : undefined;
    if (!current && records.length >= MAX_SERVERS) throw new Error('最多配置 8 个 MCP 服务。');
    const timestamp = Date.now();
    const record: McpServerRecord = {
      id: current?.id ?? crypto.randomUUID(),
      name: bounded(input.name, 80) ?? 'MCP 服务',
      url: validateMcpUrl(input.url),
      enabled: current?.enabled ?? true,
      token: input.token.trim() || current?.token || '',
      tokenConfigured: Boolean(input.token.trim() || current?.token),
      tools: tools.map(({ name, description, readOnly }) => ({ name, description, readOnly })),
      toolSchemas: tools.map(cloneTool),
      updatedAt: timestamp,
    };
    const next = current
      ? records.map((item) => (item.id === current.id ? record : item))
      : [...records, record];
    await this.save(next);
    return this.view();
  }

  async setEnabled(id: string, enabled: boolean) {
    const records = await this.listRecords();
    if (!records.some((record) => record.id === id)) throw new Error('MCP 服务不存在。');
    await this.save(records.map((record) => (record.id === id ? { ...record, enabled } : record)));
    return this.view();
  }

  async remove(id: string) {
    const records = await this.listRecords();
    const next = records.filter((record) => record.id !== id);
    if (next.length === records.length) throw new Error('MCP 服务不存在。');
    await this.save(next);
    return this.view();
  }

  private async save(records: McpServerRecord[]) {
    await this.storage.set({ [MCP_KEY]: records.map(cloneRecord) });
  }
}

export function validateMcpUrl(value: string): string {
  const url = new URL(value.trim());
  const local =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('MCP 地址必须使用 HTTPS；仅 localhost 允许 HTTP。');
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  return url.toString();
}

export function permissionPatternForMcp(value: string): string {
  const url = new URL(validateMcpUrl(value));
  return `${url.origin}/*`;
}

function toView(record: McpServerRecord): McpServerView {
  const { token: _token, toolSchemas: _toolSchemas, ...view } = record;
  return { ...view, tools: view.tools.map((tool) => ({ ...tool })) };
}

function cloneRecord(record: McpServerRecord): McpServerRecord {
  return {
    ...record,
    tools: record.tools.map((tool) => ({ ...tool })),
    toolSchemas: record.toolSchemas.map(cloneTool),
  };
}

function cloneTool(tool: McpToolSchema): McpToolSchema {
  return { ...tool, inputSchema: structuredClone(tool.inputSchema) };
}

function isServerRecord(value: unknown): value is McpServerRecord {
  return (
    isRecord(value) &&
    Boolean(bounded(value.id, 128)) &&
    Boolean(bounded(value.name, 80)) &&
    typeof value.url === 'string' &&
    isValidPersistedUrl(value.url) &&
    typeof value.enabled === 'boolean' &&
    typeof value.token === 'string' &&
    value.token.length <= 16_384 &&
    Array.isArray(value.tools) &&
    Array.isArray(value.toolSchemas) &&
    value.toolSchemas.every(isToolSchema) &&
    typeof value.updatedAt === 'number'
  );
}

function isValidPersistedUrl(value: string): boolean {
  try {
    return validateMcpUrl(value) === value;
  } catch {
    return false;
  }
}

function isToolSchema(value: unknown): value is McpToolSchema {
  return (
    isRecord(value) &&
    Boolean(bounded(value.name, 128)) &&
    typeof value.description === 'string' &&
    typeof value.readOnly === 'boolean' &&
    isRecord(value.inputSchema)
  );
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replaceAll('\u0000', '').trim();
  return normalized && normalized.length <= max ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
