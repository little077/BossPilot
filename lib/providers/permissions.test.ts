import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  containsProviderHostPermission,
  getProviderHostPermission,
  normalizeProviderBaseUrl,
  requestProviderHostPermission,
} from './permissions';

const request = vi.fn();
const contains = vi.fn();

beforeEach(() => {
  request.mockReset();
  contains.mockReset();
  vi.stubGlobal('chrome', {
    permissions: {
      contains,
      request,
    },
  });
});

describe('模型端点 URL 与权限', () => {
  it('清理尾斜杠、查询和哈希', () => {
    expect(normalizeProviderBaseUrl(' https://api.example.com/v1/?debug=1#x ')).toBe(
      'https://api.example.com/v1',
    );
  });

  it('拒绝不安全协议、URL 凭据和远程 HTTP', () => {
    expect(() => normalizeProviderBaseUrl('')).toThrow('请先填写');
    expect(() => normalizeProviderBaseUrl('not-a-url')).toThrow('格式不正确');
    expect(() => normalizeProviderBaseUrl('file:///tmp/models')).toThrow('只支持');
    expect(() => normalizeProviderBaseUrl('https://user:pass@example.com/v1')).toThrow(
      '不能包含用户名或密码',
    );
    expect(() => normalizeProviderBaseUrl('http://example.com/v1')).toThrow(
      '远程模型端点必须使用 HTTPS',
    );
  });

  it('允许本机 HTTP，并把端点收敛为精确主机权限', () => {
    expect(normalizeProviderBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(getProviderHostPermission('http://localhost:11434/v1')).toBe('http://localhost/*');
    expect(getProviderHostPermission('https://api.example.com/v1')).toBe(
      'https://api.example.com/*',
    );
  });

  it('在用户动作中申请对应的 optional host permission', async () => {
    request.mockResolvedValue(true);

    await expect(requestProviderHostPermission('https://api.example.com/v1')).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: ['https://api.example.com/*'] });
  });

  it('只检查对应端点的精确 host permission', async () => {
    contains.mockResolvedValue(true);

    await expect(containsProviderHostPermission('https://api.example.com/v1')).resolves.toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: ['https://api.example.com/*'] });
  });
});
