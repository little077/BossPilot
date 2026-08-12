import { describe, expect, it, vi } from 'vitest';
import { attachmentFromFile, selectionAttachment, validateAttachmentSet } from './input';

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

  it('creates a safe current-page selection and validates set limits', () => {
    const selection = selectionAttachment({
      text: ' selected text ',
      origin: 'https://example.com/private/path',
      title: 'Example',
    });
    expect(selection).toMatchObject({
      kind: 'selection',
      content: 'selected text',
      sourceOrigin: 'https://example.com',
    });
    expect(() =>
      selectionAttachment({ text: '', origin: 'https://example.com', title: '' }),
    ).toThrow('没有选中');
    expect(() => validateAttachmentSet([selection, selection, selection, selection])).toThrow(
      '最多',
    );
    const huge = { ...selection, content: 'x'.repeat(1_500_000) };
    expect(() => validateAttachmentSet([huge, huge, huge])).toThrow('4 MB');
    expect(
      selectionAttachment({ text: 'x', origin: 'chrome://settings', title: 'x\u0000y' }),
    ).toMatchObject({ sourceOrigin: '', sourceTitle: 'xy' });
    expect(selectionAttachment({ text: 'x', origin: 'not a url', title: 'x' })).toMatchObject({
      sourceOrigin: '',
    });
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
