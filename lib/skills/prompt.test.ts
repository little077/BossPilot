import { describe, expect, it } from 'vitest';
import { buildSkillCatalogPrompt } from './prompt';
import type { SkillCatalogEntry } from './types';

const skill = (name: string, enabled = true): SkillCatalogEntry => ({
  name,
  description: `Use <${name}> & verify`,
  version: '1.0.0',
  builtIn: true,
  enabled,
  matchedOrigins: ['https://example.com/*'],
  capabilities: [],
  fileCount: 1,
});

describe('buildSkillCatalogPrompt', () => {
  it('publishes enabled metadata in stable order without skill instructions', () => {
    const prompt = buildSkillCatalogPrompt([skill('zeta'), skill('alpha'), skill('off', false)]);
    expect(prompt.indexOf('alpha')).toBeLessThan(prompt.indexOf('zeta'));
    expect(prompt).not.toContain('name="off"');
    expect(prompt).toContain('&lt;alpha&gt; &amp; verify');
    expect(prompt).not.toContain('# Workflow');
  });

  it('omits the catalog when all skills are disabled', () => {
    expect(buildSkillCatalogPrompt([skill('off', false)])).toBe('');
  });
});
