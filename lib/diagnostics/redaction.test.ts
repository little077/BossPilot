// ─── 脱敏器单测 ───
// 覆盖三条契约：密钥剥离、空白折叠、截断边界；并验证空 secrets 与「只屏蔽不补文案」。

import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_LOG_CHARS, sanitizeForLog } from './redaction';

describe('sanitizeForLog', () => {
  it('命中密钥明文时替换为 [REDACTED]', () => {
    const out = sanitizeForLog('请求失败 key=sk-secret-123 请重试', ['sk-secret-123']);
    expect(out).toBe('请求失败 key=[REDACTED] 请重试');
    expect(out).not.toContain('sk-secret-123');
  });

  it('多个 secrets 逐个剥离，空串 secret 被忽略', () => {
    const out = sanitizeForLog('a=AAA b=BBB', ['', 'AAA', 'BBB']);
    expect(out).toBe('a=[REDACTED] b=[REDACTED]');
  });

  it('折叠连续空白（换行/制表/多空格）为单空格并 trim', () => {
    const out = sanitizeForLog('  第一行\n\t第二行   第三行  ', []);
    expect(out).toBe('第一行 第二行 第三行');
  });

  it('按 maxLength 截断，缺省用 DEFAULT_MAX_LOG_CHARS', () => {
    const long = 'x'.repeat(500);
    expect(sanitizeForLog(long, [])).toHaveLength(DEFAULT_MAX_LOG_CHARS);
    expect(sanitizeForLog(long, [], 10)).toHaveLength(10);
  });

  it('纯空白输入归一化后为空串（不补默认文案，兜底交调用方）', () => {
    expect(sanitizeForLog('   \n  ', [])).toBe('');
  });
});
