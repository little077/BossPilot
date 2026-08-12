export interface AgentContextSettings {
  version: 1;
  instructions: string;
  memoryEnabled: boolean;
}

export interface MemoryEntry {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentContextView {
  settings: AgentContextSettings;
  memories: MemoryEntry[];
}
