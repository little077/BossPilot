import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'acorn';

const outputDirectory = path.resolve('.output/chrome-mv3');
const manifestPath = path.join(outputDirectory, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const background = manifest.background;

if (
  background?.type !== 'module' ||
  typeof background.service_worker !== 'string' ||
  !background.service_worker
) {
  throw new Error('MV3 Background 必须声明为 module service worker。');
}

const visited = new Set();
const pending = [path.resolve(outputDirectory, background.service_worker)];
const failures = [];

while (pending.length > 0) {
  const file = pending.pop();
  if (!file || visited.has(file)) continue;
  assertInsideOutput(file);
  visited.add(file);

  const source = await readFile(file, 'utf8');
  const program = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  });

  walk(program, (node) => {
    if (node.type === 'ImportExpression') {
      failures.push(`${relative(file)} 含运行时 import()`);
      return;
    }

    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      node.source
    ) {
      const specifier = node.source.value;
      if (typeof specifier !== 'string' || !specifier.startsWith('.')) {
        failures.push(`${relative(file)} 含未打包的外部模块：${String(specifier)}`);
        return;
      }
      pending.push(path.resolve(path.dirname(file), specifier));
    }
  });
}

if (failures.length > 0) {
  throw new Error(`MV3 Background 构建不安全：\n${[...new Set(failures)].join('\n')}`);
}

console.log(`MV3 Background 安全检查通过：${visited.size} 个静态 ESM 文件，无运行时 import()。`);

function assertInsideOutput(file) {
  const relativePath = path.relative(outputDirectory, file);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Background 静态依赖越过构建目录：${file}`);
  }
}

function relative(file) {
  return path.relative(outputDirectory, file) || path.basename(file);
}

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }

  if (typeof value.type === 'string') visit(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'start' || key === 'end' || key === 'type') continue;
    walk(child, visit);
  }
}
