import { describe, expect, it, vi } from 'vitest';
import { attachmentFromFile, validateAttachmentSet } from './input';

describe('attachment input', () => {
  it('reads a supported image as bounded base64', async () => {
    vi.stubGlobal('btoa', (value: string) => Buffer.from(value, 'binary').toString('base64'));
    const file = new File([new Uint8Array([1, 2, 3])], 'screen.png', { type: 'image/png' });
    await expect(attachmentFromFile(file)).resolves.toMatchObject({
      kind: 'image',
      name: 'screen.png',
      mimeType: 'image/png',
      size: 3,
      data: 'AQID',
    });
  });

  it('reads supported text types and rejects empty, unsupported, or oversized files', async () => {
    await expect(
      attachmentFromFile(new File(['# Hello'], 'notes.md', { type: 'text/markdown' })),
    ).resolves.toMatchObject({ kind: 'text', content: '# Hello' });
    await expect(
      attachmentFromFile(new File([], 'empty.txt', { type: 'text/plain' })),
    ).rejects.toThrow('为空');
    await expect(
      attachmentFromFile(new File(['x'], 'archive.zip', { type: 'application/zip' })),
    ).rejects.toThrow('只支持');
    await expect(
      attachmentFromFile(
        new File([new Uint8Array(200 * 1024 + 1)], 'large.txt', { type: 'text/plain' }),
      ),
    ).rejects.toThrow('200 KB');
    await expect(
      attachmentFromFile(
        new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }),
      ),
    ).rejects.toThrow('2 MB');
    await expect(
      attachmentFromFile(new File(['{}'], 'notes.json', { type: 'application/javascript' })),
    ).rejects.toThrow('只支持');
  });

  it('validates attachment count and total size limits', () => {
    const selection = {
      id: 'legacy-selection',
      kind: 'selection' as const,
      name: '旧版选中文本',
      content: 'selected text',
      sourceOrigin: 'https://example.com',
      sourceTitle: 'Example',
    };
    expect(() => validateAttachmentSet([selection, selection, selection, selection])).toThrow(
      '最多',
    );
    const huge = { ...selection, content: 'x'.repeat(1_500_000) };
    expect(() => validateAttachmentSet([huge, huge, huge])).toThrow('4 MB');
  });

  it('fails closed when the browser file reader returns a non-binary result', async () => {
    class InvalidReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsArrayBuffer() {
        this.result = 'invalid';
        this.onload?.();
      }
    }
    vi.stubGlobal('FileReader', InvalidReader);
    await expect(
      attachmentFromFile(new File(['x'], 'screen.png', { type: 'image/png' })),
    ).rejects.toThrow('附件读取失败');
  });
});
