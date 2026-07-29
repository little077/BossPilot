import { describe, expect, it } from 'vitest';
import { hostOf, redact } from './redaction';

describe('诊断脱敏', () => {
  it('擦除常见密钥、Bearer 令牌和密码字段', () => {
    expect(
      redact(
        'sk-proj-abcdefgh Authorization: Bearer abcdefgh123 api_key=secret-value password:"hunter22"',
      ),
    ).toBe('sk-*** Authorization: Bearer *** api_key=*** password:"***"');
  });

  it('安全处理空值和端点主机名', () => {
    expect(redact(undefined)).toBe('');
    expect(hostOf('https://api.deepseek.com/v1?token=secret')).toBe('api.deepseek.com');
    expect(hostOf('not-a-url/path')).toBe('not-a-url');
    expect(hostOf(null)).toBe('');
  });
});
