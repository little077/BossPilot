import { describe, expect, it, vi } from 'vitest';
import { type SkillHostClient, SkillSandboxRunner } from '@/lib/skills/sandbox';
import { MemorySkillRepository, type SkillStorageArea, SkillStore } from '@/lib/skills/store';
import type { SkillPackage } from '@/lib/skills/types';
import type { WorkspaceStore } from '@/lib/workspace/storage';
import { SkillRunCoordinator } from './run-skill';

const storage: SkillStorageArea = {
  get: vi.fn(async () => ({})),
  set: vi.fn(async () => undefined),
};

function persistentStorage(): SkillStorageArea {
  const data: Record<string, unknown> = {};
  return {
    get: vi.fn(async () => ({ ...data })),
    set: vi.fn(async (items) => Object.assign(data, items)),
  };
}

function packageFixture(): SkillPackage {
  const markdown = `---
name: table-maker
description: Make tables
metadata:
  bosspilot-permissions: workspace.write
allowed-tools: load_skill run_skill
---
# Workflow
Run scripts/main.js.`;
  return {
    name: 'table-maker',
    definition: {
      name: 'table-maker',
      description: 'Make tables',
      instructions: '# Workflow',
      version: '1.0.0',
      builtIn: false,
      enabled: true,
      allowedTools: ['load_skill', 'run_skill'],
      capabilities: ['workspace.write'],
      references: [],
    },
    files: [
      {
        path: 'SKILL.md',
        kind: 'text',
        content: markdown,
        mimeType: 'text/markdown',
        size: new TextEncoder().encode(markdown).byteLength,
      },
      {
        path: 'scripts/main.js',
        kind: 'text',
        content: 'return input;',
        mimeType: 'text/javascript',
        size: 13,
      },
      {
        path: 'scripts/main.py',
        kind: 'text',
        content: 'print(1)',
        mimeType: 'text/plain',
        size: 8,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

function call(script = 'scripts/main.js') {
  return {
    id: 'call-1',
    name: 'run_skill',
    arguments: { skill: 'table-maker', script, input: { rows: ['A'] } },
  };
}

describe('SkillRunCoordinator', () => {
  it('pauses for missing capabilities then runs once without persisting', async () => {
    const repository = new MemorySkillRepository();
    const store = new SkillStore(persistentStorage(), [], undefined, repository);
    await store.importPackage(packageFixture());
    const host: SkillHostClient = { run: vi.fn(async ({ input }) => input) };
    const runner = new SkillSandboxRunner(host);
    const coordinator = new SkillRunCoordinator(store, runner);
    const signal = new AbortController().signal;
    const deferred = await coordinator.execute(call(), 'conversation-1', null, signal);
    expect(deferred).toMatchObject({ deferred: true, kind: 'user_input' });
    const result = await coordinator.execute(call(), 'conversation-1', 'once', signal);
    expect(result).toMatchObject({ isError: false, statusText: 'Skill 脚本已完成' });
    expect(await store.persistentGrant('table-maker', 'workspace.write')).toBeNull();
  });

  it('persists an always grant and honors a stored denial', async () => {
    const repository = new MemorySkillRepository();
    const store = new SkillStore(storage, [], undefined, repository);
    await store.importPackage(packageFixture());
    const runner = new SkillSandboxRunner({ run: vi.fn(async () => ({ ok: true })) });
    const coordinator = new SkillRunCoordinator(store, runner);
    const signal = new AbortController().signal;
    await coordinator.execute(call(), 'conversation-1', 'always', signal);
    expect(await store.persistentGrant('table-maker', 'workspace.write')).toBe('allow');
    await store.resolveGrant('table-maker', 'workspace.write', 'deny');
    const denied = await coordinator.execute(call(), 'conversation-1', null, signal);
    expect(denied).toMatchObject({ isError: true, authorizationStatus: 'denied' });
  });

  it('reports unsupported scripts explicitly', async () => {
    const store = new SkillStore(storage, [], undefined, new MemorySkillRepository());
    await store.importPackage(packageFixture());
    const coordinator = new SkillRunCoordinator(
      store,
      new SkillSandboxRunner({ run: vi.fn(async () => null) }),
    );
    await expect(
      coordinator.execute(
        call('scripts/main.py'),
        'conversation-1',
        'once',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, detail: expect.stringContaining('Python') });
  });

  it('rejects malformed calls, disabled skills, missing files and undeclared run_skill', async () => {
    const repository = new MemorySkillRepository();
    const store = new SkillStore(persistentStorage(), [], undefined, repository);
    await store.importPackage(packageFixture());
    const coordinator = new SkillRunCoordinator(
      store,
      new SkillSandboxRunner({ run: vi.fn(async () => null) }),
    );
    const signal = new AbortController().signal;
    await expect(
      coordinator.execute(
        { id: 'bad', name: 'run_skill', arguments: { skill: '', script: '../x.js', input: {} } },
        'conversation',
        null,
        signal,
      ),
    ).resolves.toMatchObject({ isError: true, detail: expect.stringContaining('路径无效') });
    await expect(
      coordinator.execute(
        { ...call(), arguments: { ...call().arguments, input: 'invalid' } },
        'conversation',
        null,
        signal,
      ),
    ).resolves.toMatchObject({ isError: true, detail: expect.stringContaining('必须是对象') });
    await store.setEnabled('table-maker', false);
    await expect(
      coordinator.execute(call(), 'conversation', 'once', signal),
    ).resolves.toMatchObject({
      isError: true,
      detail: expect.stringContaining('停用'),
    });
    await store.setEnabled('table-maker', true);
    await expect(
      coordinator.execute(call('scripts/missing.js'), 'conversation', 'once', signal),
    ).resolves.toMatchObject({ isError: true, detail: expect.stringContaining('不存在') });

    const withoutTool = packageFixture();
    withoutTool.definition.allowedTools = ['load_skill'];
    await repository.put(withoutTool);
    await expect(
      coordinator.execute(call(), 'conversation', 'once', signal),
    ).resolves.toMatchObject({
      isError: true,
      detail: expect.stringContaining('没有声明'),
    });
    const binary = packageFixture();
    const script = binary.files.find(({ path }) => path === 'scripts/main.js');
    if (!script) throw new Error('fixture missing');
    script.kind = 'binary';
    script.content = btoa('return input;');
    await repository.put(binary);
    await expect(
      coordinator.execute(call(), 'conversation', 'once', signal),
    ).resolves.toMatchObject({
      isError: true,
      detail: expect.stringContaining('不是文本'),
    });
  });

  it('uses an existing grant and surfaces sandbox failures', async () => {
    const store = new SkillStore(storage, [], undefined, new MemorySkillRepository());
    await store.importPackage(packageFixture());
    await store.resolveGrant('table-maker', 'workspace.write', 'allow');
    const coordinator = new SkillRunCoordinator(
      store,
      new SkillSandboxRunner({
        run: vi.fn(async () => {
          throw new Error('sandbox crashed');
        }),
      }),
    );
    await expect(
      coordinator.execute(call(), 'conversation', null, new AbortController().signal),
    ).resolves.toMatchObject({ isError: true, detail: 'sandbox crashed' });
  });
});

describe('SkillSandboxRunner capability proxy', () => {
  it('allows only granted workspace capabilities and rejects overwrite', async () => {
    let release: ((value: unknown) => void) | undefined;
    let activeRunId = '';
    const host: SkillHostClient = {
      run: vi.fn(({ runId }) => {
        activeRunId = runId;
        return new Promise((resolve) => {
          release = resolve;
        });
      }),
    };
    const workspace = {
      write: vi.fn(async () => ({ path: '/report.md' })),
      read: vi.fn(async () => ({
        path: '/report.md',
        mimeType: 'text/markdown',
        size: 2,
        content: 'ok',
      })),
      createDirectory: vi.fn(async () => ({ path: '/reports' })),
    } as unknown as WorkspaceStore;
    const runner = new SkillSandboxRunner(host, workspace);
    const running = runner.run(
      'conversation-1',
      'return input;',
      {},
      ['workspace.write'],
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(activeRunId).not.toBe(''));
    await expect(
      runner.handleCapabilityRequest({
        type: 'skill-capability:request',
        runId: activeRunId,
        capability: 'workspace.write',
        payload: { operation: 'write', path: '/report.md', content: 'ok' },
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      runner.handleCapabilityRequest({
        type: 'skill-capability:request',
        runId: activeRunId,
        capability: 'workspace.read',
        payload: { path: '/report.md' },
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      runner.handleCapabilityRequest({
        type: 'skill-capability:request',
        runId: activeRunId,
        capability: 'workspace.write',
        payload: { path: '/report.md', content: 'new', overwrite: true },
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('不能直接覆盖') });
    release?.({ done: true });
    await running;
  });
});
