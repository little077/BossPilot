export interface McpToolView {
  name: string;
  description: string;
  readOnly: boolean;
}

export interface McpServerView {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  tokenConfigured: boolean;
  tools: McpToolView[];
  updatedAt: number;
}

export interface McpSettingsView {
  version: 1;
  servers: McpServerView[];
}

export interface McpServerRecord extends McpServerView {
  token: string;
  toolSchemas: McpToolSchema[];
}

export interface McpToolSchema extends McpToolView {
  inputSchema: Record<string, unknown>;
}
