import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/storage/db';
import { DexieSkillRepository } from './store';
import type { SkillPackage } from './types';

const packageFixture = (): SkillPackage => ({
  name: 'dexie-skill',
  definition: {
    name: 'dexie-skill',
    description: 'Stored in Dexie',
    instructions: '# Workflow',
    version: '1.0.0',
    builtIn: false,
    enabled: true,
    allowedTools: [],
    capabilities: ['workspace.read'],
    references: [],
  },
  files: [],
  createdAt: 1,
  updatedAt: 2,
});

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterAll(async () => {
  await db.delete();
});

describe('DexieSkillRepository', () => {
  it('persists cloned packages and capability grants', async () => {
    const repository = new DexieSkillRepository();
    const value = packageFixture();
    await repository.put(value);
    value.definition.description = 'mutated outside';
    expect(await repository.get('dexie-skill')).toMatchObject({
      definition: { description: 'Stored in Dexie' },
    });
    expect(await repository.list()).toHaveLength(1);
    expect(await repository.get('missing')).toBeUndefined();

    const grant = {
      id: 'dexie-skill:workspace.read',
      skillName: 'dexie-skill',
      capability: 'workspace.read' as const,
      decision: 'allow' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    await repository.putGrant(grant);
    expect(await repository.listGrants()).toEqual([grant]);
    await repository.deleteGrant(grant.id);
    expect(await repository.listGrants()).toEqual([]);
    await repository.putGrant(grant);
    await repository.deleteGrantsForSkill('dexie-skill');
    expect(await repository.listGrants()).toEqual([]);
    await repository.delete('dexie-skill');
    expect(await repository.list()).toEqual([]);
  });
});
