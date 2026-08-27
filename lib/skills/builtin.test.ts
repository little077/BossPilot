import { describe, expect, it } from 'vitest';
import bossSkillMarkdown from '@/skills/boss-job-search/SKILL.md?raw';
import xhsSkillMarkdown from '@/skills/xhs-note-scout/SKILL.md?raw';
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

  it('ships a valid Xiaohongshu workflow with page capabilities and executable scripts', () => {
    const bundle = loadBuiltinSkillBundles().find(
      ({ definition }) => definition.name === 'xhs-note-scout',
    );
    expect(bundle).toBeDefined();
    const parsed = parseSkillMarkdown(xhsSkillMarkdown, {
      expectedName: 'xhs-note-scout',
      version: '1.0.0',
      builtIn: true,
    });
    expect(bundle?.definition).toEqual({ ...parsed, instructions: '' });
    expect(bundle?.definition.capabilities).toEqual([
      'page.read',
      'page.script',
      'workspace.write',
    ]);
    expect(bundle?.definition.matchedOrigins).toEqual(['https://www.xiaohongshu.com/*']);
    for (const reference of bundle?.definition.references ?? []) {
      expect(bundle?.references[reference.path]).toMatchObject({ kind: 'url' });
    }
    const scriptPaths = Object.keys(bundle?.scripts ?? {});
    expect(scriptPaths).toEqual([
      'scripts/read-profile.js',
      'scripts/collect-page.js',
      'scripts/open-note.js',
      'scripts/read-note.js',
      'scripts/read-comments.js',
      'scripts/close-note.js',
      'scripts/save-results.js',
    ]);
    for (const [path, resource] of Object.entries(bundle?.scripts ?? {})) {
      expect(path).toMatch(/^scripts\/[a-z-]+\.js$/);
      expect(resource).toMatchObject({ kind: 'url' });
    }
  });
});
