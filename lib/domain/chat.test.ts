import { describe, expect, it, vi } from 'vitest';
import { cloneAttachment, makeMessage } from './chat';

describe('chat message attachments', () => {
  it('creates defensive attachment copies and omits an empty list', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
    vi.spyOn(Date, 'now').mockReturnValue(10);
    const attachment = {
      id: 'a1',
      kind: 'text' as const,
      name: 'notes.txt',
      mimeType: 'text/plain' as const,
      size: 4,
      content: 'test',
    };
    const message = makeMessage('user', 'hello', [attachment]);
    expect(message).toMatchObject({ content: 'hello', createdAt: 10, attachments: [attachment] });
    expect(message.attachments?.[0]).not.toBe(attachment);
    expect(makeMessage('assistant', 'ok', [])).not.toHaveProperty('attachments');
    expect(cloneAttachment(attachment)).toEqual(attachment);
  });
});
