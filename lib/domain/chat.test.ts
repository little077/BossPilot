import { describe, expect, it, vi } from 'vitest';
import { makeMessage } from './chat';

describe('makeMessage', () => {
  it('补齐稳定 id、角色和创建时间', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    expect(makeMessage('user', '你好')).toEqual({
      id: '00000000-0000-4000-8000-000000000000',
      role: 'user',
      content: '你好',
      createdAt: 1_700_000_000_000,
    });
  });
});
