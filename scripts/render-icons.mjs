/**
 * 图标渲染脚本：将 assets/icon.svg 渲染为 public/icon/ 下的多尺寸 PNG。
 *
 * 用法：npm run icons
 *
 * 说明：
 * - 16px 使用简化变体 assets/icon-small.svg（描边加粗、细节精简），其余尺寸用主图标；
 * - 渲染时按目标尺寸设置 density，保证 librsvg 直接以目标分辨率栅格化（避免先小后放大的模糊）；
 * - public/icon/{size}.png 是 WXT 的约定路径，构建时会自动写入 manifest 的 icons / action.default_icon。
 */
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'public', 'icon');

/** 尺寸 → 源 SVG 的映射；16px 走简化变体 */
const TASKS = [
  { size: 16, src: 'assets/icon-small.svg' },
  { size: 32, src: 'assets/icon.svg' },
  { size: 48, src: 'assets/icon.svg' },
  { size: 96, src: 'assets/icon.svg' },
  { size: 128, src: 'assets/icon.svg' },
];

// SVG viewBox 基准边长，用于换算渲染 density
const BASE = 128;
const BASE_DENSITY = 72;

await mkdir(outDir, { recursive: true });

for (const { size, src } of TASKS) {
  const out = path.join(outDir, `${size}.png`);
  await sharp(path.join(root, src), { density: (BASE_DENSITY * size) / BASE })
    .resize(size, size)
    .png()
    .toFile(out);
  console.log(`✓ ${path.relative(root, out)} (${size}x${size}, 源: ${src})`);
}

console.log('图标渲染完成。');
