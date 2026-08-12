import { describe, expect, it } from 'vitest';
import { type AgentHealthSnapshot, evaluateAgentHealth } from './health';

function snapshot(): AgentHealthSnapshot {
  return {
    providers: {
      version: 1,
      activeModel: { providerId: 'openai', modelId: 'gpt-test' },
      connections: [
        {
          providerId: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          hasApiKey: true,
          apiKeyLastFour: 'test',
          models: [{ id: 'gpt-test', name: 'GPT Test' }],
          selectedModelId: 'gpt-test',
        },
      ],
    },
    skills: {
      version: 1,
      skills: [
        {
          name: 'boss-job-search',
          description: 'Search jobs',
          version: '1',
          builtIn: true,
          enabled: true,
        },
      ],
    },
    context: {
      settings: { version: 1, instructions: '', memoryEnabled: true },
      memories: [{ id: 'm1', content: '偏好双休', createdAt: 1, updatedAt: 1 }],
    },
    mcp: { version: 1, servers: [] },
    manifest: { manifest_version: 3, name: 'BossPilot', version: '0.13.0' },
  };
}

describe('evaluateAgentHealth', () => {
  it('reports a healthy local configuration without making network decisions', () => {
    const checks = evaluateAgentHealth(snapshot());
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'model', status: 'pass' }),
        expect.objectContaining({ id: 'skills', status: 'pass' }),
        expect.objectContaining({ id: 'permissions', status: 'pass' }),
      ]),
    );
  });

  it('warns about missing models, empty enabled MCP catalogs, and broad host access', () => {
    const value = snapshot();
    value.providers.activeModel = undefined;
    value.skills.skills = value.skills.skills.map((skill) => ({ ...skill, enabled: false }));
    value.context.settings.memoryEnabled = false;
    value.mcp.servers = [
      {
        id: 'mcp-1',
        name: 'Empty',
        url: 'https://mcp.example/mcp',
        enabled: true,
        tokenConfigured: false,
        tools: [],
        updatedAt: 1,
      },
    ];
    value.manifest.host_permissions = ['https://*/*'];
    const byId = Object.fromEntries(evaluateAgentHealth(value).map((check) => [check.id, check]));
    expect(byId.model?.status).toBe('warning');
    expect(byId.skills?.status).toBe('info');
    expect(byId.memory?.detail).toContain('已关闭');
    expect(byId.mcp?.status).toBe('warning');
    expect(byId.permissions?.status).toBe('warning');
  });
});
