export interface SkillReference {
  path: string;
  label: string;
}

export type SkillCapability =
  | 'workspace.read'
  | 'workspace.write'
  | 'page.read'
  | 'page.script'
  | 'chrome.tabs'
  | 'chrome.bookmarks'
  | `network:${string}`;

export interface SkillPackageFile {
  path: string;
  kind: 'text' | 'binary';
  content: string;
  mimeType: string;
  size: number;
}

export interface SkillDefinition {
  name: string;
  description: string;
  instructions: string;
  version: string;
  builtIn: boolean;
  enabled: boolean;
  matchedOrigins?: string[];
  allowedTools: string[];
  capabilities: SkillCapability[];
  references: SkillReference[];
}

export interface SkillPackage {
  name: string;
  definition: SkillDefinition;
  files: SkillPackageFile[];
  createdAt: number;
  updatedAt: number;
}

export interface CapabilityGrant {
  id: string;
  skillName: string;
  capability: SkillCapability;
  decision: 'allow' | 'deny';
  createdAt: number;
  updatedAt: number;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  version: string;
  builtIn: boolean;
  enabled: boolean;
  matchedOrigins?: string[];
  capabilities: SkillCapability[];
  fileCount: number;
}

export interface SkillSettingsView {
  version: 2;
  skills: SkillCatalogEntry[];
  grants: CapabilityGrant[];
}
