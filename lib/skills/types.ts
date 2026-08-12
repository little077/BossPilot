export interface SkillReference {
  path: string;
  label: string;
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
  references: SkillReference[];
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  version: string;
  builtIn: boolean;
  enabled: boolean;
  matchedOrigins?: string[];
}

export interface SkillSettingsView {
  version: 1;
  skills: SkillCatalogEntry[];
}
