import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const outputDirectory = path.resolve('.output/chrome-mv3');
const maximumJavaScriptBytes = 850 * 1024;
const maximumBackgroundEntryBytes = 110 * 1024;
// v1.3 引入 CodeMirror 6 多文件编辑器与 JSZip 安全导入器；两者均按页面/静态 chunk 隔离，
// 仍保留单文件 850 KiB 门禁，并将商店压缩包增量限制在约 176 KiB 内。
const maximumExtensionBytes = 4.25 * 1024 * 1024;
const maximumCompressedExtensionBytes = 1.1 * 1024 * 1024;

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map((entry) => {
      const absolutePath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(absolutePath) : [absolutePath];
    }),
  );
  return nestedFiles.flat();
}

function formatKib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

const files = await listFiles(outputDirectory);
const sizedFiles = await Promise.all(
  files.map(async (file) => {
    const bytes = (await stat(file)).size;
    const content = await readFile(file);
    return {
      file,
      bytes,
      compressedBytes: gzipSync(content, { level: 9 }).length,
    };
  }),
);
const javascriptFiles = sizedFiles.filter(({ file }) => file.endsWith('.js'));
const largestJavaScriptFile = javascriptFiles.reduce(
  (largest, current) => (current.bytes > largest.bytes ? current : largest),
  { file: '', bytes: 0 },
);
const totalBytes = sizedFiles.reduce((sum, file) => sum + file.bytes, 0);
const compressedTotalBytes = sizedFiles.reduce((sum, file) => sum + file.compressedBytes, 0);
const backgroundEntry = sizedFiles.find(
  ({ file }) => path.relative(outputDirectory, file) === 'background.js',
);

const failures = [];
if (largestJavaScriptFile.bytes > maximumJavaScriptBytes) {
  failures.push(
    `最大 JavaScript 文件 ${path.relative(outputDirectory, largestJavaScriptFile.file)} 为 ${formatKib(largestJavaScriptFile.bytes)}，超过 ${formatKib(maximumJavaScriptBytes)}。`,
  );
}
if (backgroundEntry && backgroundEntry.bytes > maximumBackgroundEntryBytes) {
  failures.push(
    `Background 入口为 ${formatKib(backgroundEntry.bytes)}，超过 ${formatKib(maximumBackgroundEntryBytes)}。`,
  );
}
if (totalBytes > maximumExtensionBytes) {
  failures.push(
    `扩展总大小为 ${formatKib(totalBytes)}，超过 ${formatKib(maximumExtensionBytes)}。`,
  );
}
if (compressedTotalBytes > maximumCompressedExtensionBytes) {
  failures.push(
    `扩展压缩体积估算为 ${formatKib(compressedTotalBytes)}，超过 ${formatKib(maximumCompressedExtensionBytes)}。`,
  );
}

if (failures.length > 0) {
  throw new Error(`构建体积预算超限：\n${failures.join('\n')}`);
}

console.log(
  `构建体积符合预算：Background ${formatKib(backgroundEntry?.bytes ?? 0)}，最大 JS ${formatKib(largestJavaScriptFile.bytes)}，未压缩 ${formatKib(totalBytes)}，压缩估算 ${formatKib(compressedTotalBytes)}。`,
);
