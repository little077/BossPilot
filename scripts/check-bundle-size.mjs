import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const outputDirectory = path.resolve('.output/chrome-mv3');
const maximumJavaScriptBytes = 850 * 1024;
const maximumExtensionBytes = 950 * 1024;

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
  files.map(async (file) => ({
    file,
    bytes: (await stat(file)).size,
  })),
);
const javascriptFiles = sizedFiles.filter(({ file }) => file.endsWith('.js'));
const largestJavaScriptFile = javascriptFiles.reduce(
  (largest, current) => (current.bytes > largest.bytes ? current : largest),
  { file: '', bytes: 0 },
);
const totalBytes = sizedFiles.reduce((sum, file) => sum + file.bytes, 0);

const failures = [];
if (largestJavaScriptFile.bytes > maximumJavaScriptBytes) {
  failures.push(
    `最大 JavaScript 文件 ${path.relative(outputDirectory, largestJavaScriptFile.file)} 为 ${formatKib(largestJavaScriptFile.bytes)}，超过 ${formatKib(maximumJavaScriptBytes)}。`,
  );
}
if (totalBytes > maximumExtensionBytes) {
  failures.push(
    `扩展总大小为 ${formatKib(totalBytes)}，超过 ${formatKib(maximumExtensionBytes)}。`,
  );
}

if (failures.length > 0) {
  throw new Error(`构建体积预算超限：\n${failures.join('\n')}`);
}

console.log(
  `构建体积符合预算：最大 JS ${formatKib(largestJavaScriptFile.bytes)}，扩展总计 ${formatKib(totalBytes)}。`,
);
