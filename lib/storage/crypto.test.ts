import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptString, encryptString, generateKeyBase64, lastFour } from './crypto';

// jsdom 不提供 Web Crypto 的 subtle 实现，用 node 的 webcrypto 顶替。
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});

describe('密钥加解密', () => {
  it('加密后可用同一密钥还原明文，密文不含原文', async () => {
    const key = await generateKeyBase64();
    const blob = await encryptString('sk-secret-123456', key);
    expect(blob.startsWith('v1.')).toBe(true);
    expect(blob).not.toContain('sk-secret-123456');
    expect(await decryptString(blob, key)).toBe('sk-secret-123456');
  });

  it('用错误密钥解密会失败', async () => {
    const key = await generateKeyBase64();
    const other = await generateKeyBase64();
    const blob = await encryptString('hello', key);
    await expect(decryptString(blob, other)).rejects.toThrow();
  });

  it('拒绝非 v1 前缀的密文', async () => {
    const key = await generateKeyBase64();
    await expect(decryptString('plain', key)).rejects.toThrow('密文格式无效');
  });

  it('lastFour 只保留末四位', () => {
    expect(lastFour('abcdefgh')).toBe('efgh');
    expect(lastFour('ab')).toBe('ab');
  });
});
