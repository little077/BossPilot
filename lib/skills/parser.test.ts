import { describe, expect, it } from 'vitest';
import { parseSkillMarkdown, SkillParseError, safeReferencePath } from './parser';

const VALID = `---
name: test-skill
description: A focused browser workflow
metadata:
  matched-origins:
    - https://example.com/*
allowed-tools: browser_action read_current_page browser_action INVALID
---
# Test

Read \`references/guide.md\` only when needed.`;

describe('parseSkillMarkdown', () => {
  it('parses bounded metadata and declared references', () => {
    expect(
      parseSkillMarkdown(VALID, { expectedName: 'test-skill', version: '1.2.0', builtIn: true }),
    ).toEqual(
      expect.objectContaining({
        name: 'test-skill',
        version: '1.2.0',
        builtIn: true,
        enabled: true,
        matchedOrigins: ['https://example.com/*'],
        allowedTools: ['browser_action', 'read_current_page'],
        references: [{ path: 'references/guide.md', label: 'guide' }],
      }),
    );
  });

  it.each([
    ['', 'empty'],
    ['# no frontmatter', 'frontmatter'],
    [VALID.replace('name: test-skill', 'name: Wrong'), 'name'],
    [VALID.replace('description:', 'name: duplicate\ndescription:'), 'yaml'],
    ['x'.repeat(20_001), 'large'],
  ])('rejects malformed skill input: %s', (markdown) => {
    expect(() =>
      parseSkillMarkdown(markdown, { expectedName: 'test-skill', version: '1' }),
    ).toThrow(SkillParseError);
  });

  it('only accepts one-level safe markdown reference paths', () => {
    expect(safeReferencePath('references/guide.md')).toBe(true);
    expect(safeReferencePath('references/nested/guide.md')).toBe(true);
    expect(safeReferencePath('references/../secret.md')).toBe(false);
    expect(safeReferencePath('references\\guide.md')).toBe(false);
    expect(safeReferencePath('scripts/run.js')).toBe(false);
  });
});
