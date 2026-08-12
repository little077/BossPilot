import { describe, expect, it } from 'vitest';
import { buildAgentContextPrompt } from './prompt';

describe('buildAgentContextPrompt', () => {
  it('escapes user instructions and exposes explicit memory policy', () => {
    const prompt = buildAgentContextPrompt({
      version: 1,
      instructions: '回答 <中文> & 简洁',
      memoryEnabled: true,
    });
    expect(prompt).toContain('回答 &lt;中文&gt; &amp; 简洁');
    expect(prompt).toContain('enabled="true"');
    expect(prompt).toContain('明确');
  });

  it('declares memory disabled without an empty instruction block', () => {
    const prompt = buildAgentContextPrompt({ version: 1, instructions: '', memoryEnabled: false });
    expect(prompt).toContain('enabled="false"');
    expect(prompt).not.toContain('user_instructions');
  });
});
