import type { ChatAttachment } from '@/lib/domain/chat';

export const MAX_ATTACHMENTS = 3;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_BYTES = 200 * 1024;
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const TEXT_TYPES = new Map<
  string,
  'text/plain' | 'text/markdown' | 'application/json' | 'text/csv'
>([
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.json', 'application/json'],
  ['.csv', 'text/csv'],
]);

export async function attachmentFromFile(file: File): Promise<ChatAttachment> {
  if (IMAGE_TYPES.has(file.type)) {
    if (file.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 2 MB。');
    const mimeType = file.type as 'image/jpeg' | 'image/png' | 'image/webp';
    return {
      id: crypto.randomUUID(),
      kind: 'image',
      name: safeName(file.name),
      mimeType,
      size: file.size,
      data: bytesToBase64(await readFileBuffer(file)),
    };
  }
  const mimeType = textMime(file.name, file.type);
  if (!mimeType) throw new Error('只支持 PNG、JPEG、WebP、TXT、Markdown、JSON 和 CSV。');
  if (file.size > MAX_TEXT_BYTES) throw new Error('单个文本文件不能超过 200 KB。');
  const content = new TextDecoder()
    .decode(await readFileBuffer(file))
    .replaceAll('\u0000', '')
    .slice(0, MAX_TEXT_BYTES);
  if (!content.trim()) throw new Error('文本文件为空。');
  return {
    id: crypto.randomUUID(),
    kind: 'text',
    name: safeName(file.name),
    mimeType,
    size: file.size,
    content,
  };
}

export function validateAttachmentSet(attachments: ChatAttachment[]): void {
  if (attachments.length > MAX_ATTACHMENTS) throw new Error('每条消息最多添加 3 个附件。');
  const bytes = attachments.reduce(
    (total, item) => total + ('size' in item ? item.size : new Blob([item.content]).size),
    0,
  );
  if (bytes > MAX_TOTAL_BYTES) throw new Error('附件总大小不能超过 4 MB。');
}

function textMime(name: string, declared: string) {
  const lower = name.toLocaleLowerCase();
  const extension = [...TEXT_TYPES.keys()].find((candidate) => lower.endsWith(candidate));
  if (!extension) return undefined;
  const expected = TEXT_TYPES.get(extension);
  if (!declared || declared === expected || declared === 'text/plain') return expected;
  return undefined;
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function readFileBuffer(file: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('附件读取失败。'));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('附件读取失败。'));
    };
    reader.readAsArrayBuffer(file);
  });
}

function safeName(value: string): string {
  return (
    value
      .replaceAll('\u0000', '_')
      .replace(/[\\/:*?"<>|]/gu, '_')
      .trim()
      .slice(0, 120) || '附件'
  );
}
