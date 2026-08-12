import { describe, expect, it } from 'vitest';
import bossSkillMarkdown from '@/skills/boss-job-search/SKILL.md?raw';
import { loadBuiltinSkillBundles } from './builtin';
import { parseSkillMarkdown } from './parser';

describe('built-in skills', () => {
  it('ships a valid Boss workflow and every declared reference', () => {
    const [bundle] = loadBuiltinSkillBundles();
    const parsed = parseSkillMarkdown(bossSkillMarkdown, {
      expectedName: 'boss-job-search',
      version: '1.0.0',
      builtIn: true,
    });
    expect(bundle?.definition).toMatchObject({
      name: 'boss-job-search',
      builtIn: true,
      enabled: true,
    });
    expect(bundle?.definition.references.length).toBeGreaterThan(0);
    expect(bundle?.definition).toEqual({ ...parsed, instructions: '' });
    for (const reference of bundle?.definition.references ?? []) {
      expect(bundle?.references[reference.path]).toMatchObject({ kind: 'url' });
    }
  });
});
