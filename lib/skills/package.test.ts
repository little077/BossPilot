import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  exportAllSkillArchives,
  exportSkillArchive,
  importSkillArchive,
  MAX_SKILL_ARCHIVE_BYTES,
  MAX_SKILL_FILE_BYTES,
  SkillPackageError,
  textSkillFile,
  validateSkillPackageFiles,
} from './package';

const SKILL = `---
name: table-maker
description: Turn a page into a Markdown table
metadata:
  bosspilot-permissions: workspace.write
allowed-tools: run_skill
---
# Workflow
Run \`scripts/main.js\` when the user asks for a table.`;

async function zip(files: Record<string, string | Uint8Array>): Promise<ArrayBuffer> {
  const archive = new JSZip();
  for (const [path, content] of Object.entries(files)) archive.file(path, content);
  return (
    await archive.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    })
  ).buffer as ArrayBuffer;
}

describe('Skill ZIP packages', () => {
  it('imports an official package and exports it with its root directory', async () => {
    const imported = await importSkillArchive(
      await zip({
        'table-maker/SKILL.md': SKILL,
        'table-maker/scripts/main.js': 'return { markdown: input.rows.join("|") };',
        'table-maker/references/guide.md': '# Guide',
      }),
      42,
    );
    expect(imported).toMatchObject({ name: 'table-maker', createdAt: 42, updatedAt: 42 });
    expect(imported.files.map(({ path }) => path)).toEqual([
      'SKILL.md',
      'scripts/main.js',
      'references/guide.md',
    ]);
    expect(imported.definition.capabilities).toEqual(['workspace.write']);
    const roundTrip = await JSZip.loadAsync(await exportSkillArchive(imported));
    expect(roundTrip.file('table-maker/SKILL.md')).not.toBeNull();
    const all = await JSZip.loadAsync(await exportAllSkillArchives([imported]));
    expect(all.file('table-maker/scripts/main.js')).not.toBeNull();
  });

  it.each([
    ['path traversal', { '../SKILL.md': SKILL }],
    ['duplicate canonical path', { 'table-maker/SKILL.md': SKILL, 'table-maker/skill.md': SKILL }],
    [
      'suspicious script',
      { 'table-maker/SKILL.md': SKILL, 'table-maker/scripts/main.js': 'return eval(input.code)' },
    ],
  ])('rejects %s', async (_case, files) => {
    await expect(importSkillArchive(await zip(files))).rejects.toBeInstanceOf(SkillPackageError);
  });

  it('requires a permission declaration for runnable scripts', async () => {
    const withoutPermission = SKILL.replace(
      'metadata:\n  bosspilot-permissions: workspace.write\n',
      '',
    );
    await expect(
      importSkillArchive(
        await zip({
          'table-maker/SKILL.md': withoutPermission,
          'table-maker/scripts/main.js': 'return input;',
        }),
      ),
    ).rejects.toThrow('必须显式声明');
  });

  it('keeps unsupported Python scripts for editing but does not treat them as runnable', async () => {
    const imported = await importSkillArchive(
      await zip({ 'table-maker/SKILL.md': SKILL, 'table-maker/scripts/main.py': 'print("ok")' }),
    );
    expect(imported.files[1]?.path).toBe('scripts/main.py');
  });

  it('supports a rootless package and preserves binary assets across export', async () => {
    const imported = await importSkillArchive(
      await zip({ 'SKILL.md': SKILL, 'assets/icon.png': Uint8Array.from([1, 2, 3]) }),
    );
    expect(imported.files[1]).toMatchObject({
      path: 'assets/icon.png',
      kind: 'binary',
      mimeType: 'image/png',
      size: 3,
    });
    const exported = await JSZip.loadAsync(await exportSkillArchive(imported));
    await expect(
      exported.file('table-maker/assets/icon.png')?.async('uint8array'),
    ).resolves.toEqual(Uint8Array.from([1, 2, 3]));
  });

  it.each([
    ['invalid bytes', async () => Uint8Array.from([1, 2, 3]).buffer],
    ['empty archive', async () => zip({})],
    ['multiple roots', async () => zip({ 'a/SKILL.md': SKILL, 'b/readme.md': '# b' })],
    ['missing SKILL.md', async () => zip({ 'table-maker/readme.md': '# no skill' })],
    [
      'unsupported script extension',
      async () => zip({ 'table-maker/SKILL.md': SKILL, 'table-maker/scripts/tool.exe': 'binary' }),
    ],
  ])('rejects %s archives', async (_case, archive) => {
    await expect(importSkillArchive(await archive())).rejects.toBeInstanceOf(SkillPackageError);
  });

  it('revalidates editor files, sizes, paths and duplicates before storage', () => {
    const skillFile = textSkillFile('SKILL.md', SKILL);
    expect(validateSkillPackageFiles([skillFile], 'table-maker', '2.0.0')).toMatchObject({
      version: '2.0.0',
    });
    expect(() => validateSkillPackageFiles([], 'table-maker', '1')).toThrow('文件数量');
    expect(() =>
      validateSkillPackageFiles([{ ...skillFile, size: skillFile.size + 1 }], 'table-maker', '1'),
    ).toThrow('大小无效');
    expect(() =>
      validateSkillPackageFiles(
        [skillFile, { ...skillFile, path: 'skill.md' }],
        'table-maker',
        '1',
      ),
    ).toThrow('重复');
    expect(() =>
      validateSkillPackageFiles([{ ...skillFile, path: '../SKILL.md' }], 'table-maker', '1'),
    ).toThrow('不安全路径');
    expect(() =>
      validateSkillPackageFiles(
        [textSkillFile('references/guide.md', '# Guide')],
        'table-maker',
        '1',
      ),
    ).toThrow('必须包含');
  });

  it('enforces compressed, per-file and total unpacked limits', async () => {
    await expect(importSkillArchive(new ArrayBuffer(MAX_SKILL_ARCHIVE_BYTES + 1))).rejects.toThrow(
      '超过 5 MB',
    );
    await expect(
      importSkillArchive(
        await zip({
          'table-maker/SKILL.md': SKILL,
          'table-maker/assets/large.txt': 'x'.repeat(MAX_SKILL_FILE_BYTES + 1),
        }),
      ),
    ).rejects.toThrow('超过 2 MB');
    const chunk = 'x'.repeat(MAX_SKILL_FILE_BYTES);
    await expect(
      importSkillArchive(
        await zip({
          'table-maker/SKILL.md': SKILL,
          'table-maker/assets/a.txt': chunk,
          'table-maker/assets/b.txt': chunk,
          'table-maker/assets/c.txt': chunk,
          'table-maker/assets/d.txt': chunk,
          'table-maker/assets/e.txt': chunk,
          'table-maker/assets/f.txt': chunk,
        }),
      ),
    ).rejects.toThrow('超过 10 MB');
  }, 15_000);

  it('rejects hidden root files that cannot be addressed safely', async () => {
    await expect(
      importSkillArchive(
        await zip({ 'table-maker/SKILL.md': SKILL, 'table-maker/.secret': 'hidden' }),
      ),
    ).rejects.toThrow('不支持的文件');
  });
});
