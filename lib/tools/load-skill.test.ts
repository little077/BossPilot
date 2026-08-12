import { describe, expect, it, vi } from 'vitest';
import { SkillLoadCoordinator, type SkillReader } from './load-skill';

const call = (skill: unknown, reference?: unknown) => ({
  id: crypto.randomUUID(),
  name: 'load_skill' as const,
  arguments: { skill, ...(reference === undefined ? {} : { reference }) },
});

function reader(): SkillReader {
  return {
    load: vi.fn(async (name, reference) => ({
      skill: { name, version: '1.0.0' },
      content: reference ? `# ${reference}` : '# Main <unsafe>',
    })),
  };
}

describe('SkillLoadCoordinator', () => {
  it('loads main instructions, deduplicates them, then permits declared references', async () => {
    const coordinator = new SkillLoadCoordinator(reader());
    const signal = new AbortController().signal;
    const first = await coordinator.execute(call('test-skill'), 'request-1', signal);
    expect(first).toMatchObject({ isError: false, statusText: '已启用专业技能' });
    expect('content' in first ? first.content : '').toContain('\\u003cunsafe>');
    expect(await coordinator.execute(call('test-skill'), 'request-1', signal)).toMatchObject({
      isError: false,
      statusText: 'Skill 已加载',
    });
    expect(
      await coordinator.execute(call('test-skill', 'references/guide.md'), 'request-1', signal),
    ).toMatchObject({ isError: false, statusText: '已加载 Skill 参考' });
    coordinator.clear('request-1');
    expect(
      await coordinator.execute(call('test-skill', 'references/guide.md'), 'request-1', signal),
    ).toMatchObject({ isError: true, detail: expect.stringContaining('先加载') });
  });

  it('rejects malformed paths, missing names, store failures, and aborted calls', async () => {
    const failing: SkillReader = { load: vi.fn(async () => Promise.reject(new Error('missing'))) };
    const coordinator = new SkillLoadCoordinator(failing);
    const signal = new AbortController().signal;
    expect(await coordinator.execute(call(''), 'r', signal)).toMatchObject({ isError: true });
    expect(await coordinator.execute(call('x', '../secret.md'), 'r', signal)).toMatchObject({
      isError: true,
    });
    expect(await coordinator.execute(call('x'), 'r', signal)).toMatchObject({
      isError: true,
      detail: 'missing',
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(coordinator.execute(call('x'), 'r', aborted.signal)).rejects.toThrow();
  });

  it('caps distinct skills and references per request', async () => {
    const coordinator = new SkillLoadCoordinator(reader());
    const signal = new AbortController().signal;
    for (const name of ['one', 'two', 'three']) {
      expect((await coordinator.execute(call(name), 'r', signal)).isError).toBe(false);
    }
    expect(await coordinator.execute(call('four'), 'r', signal)).toMatchObject({ isError: true });
    for (let index = 0; index < 5; index += 1) {
      expect(
        (await coordinator.execute(call('one', `references/${index}.md`), 'r', signal)).isError,
      ).toBe(false);
    }
    expect(await coordinator.execute(call('one', 'references/6.md'), 'r', signal)).toMatchObject({
      isError: true,
    });
  });
});
