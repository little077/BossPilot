import { describe, expect, it } from 'vitest';
import { appendTranscript, cleanTranscript } from './transcript';

describe('cleanTranscript', () => {
  it('去除 CJK 字符间的空格（SODA 中文结果特征），保留英文词间空格', () => {
    expect(cleanTranscript('今 天 天 气 不 错')).toBe('今天天气不错');
    expect(cleanTranscript('hello world')).toBe('hello world');
  });

  it('反复处理相邻间隙（三个字连排）', () => {
    expect(cleanTranscript('你 好 世 界')).toBe('你好世界');
  });

  it('裁剪首尾空白', () => {
    expect(cleanTranscript('  你好  ')).toBe('你好');
    expect(cleanTranscript('  hello  ')).toBe('hello');
  });

  it('混合内容：中英文各自保留/去除空格', () => {
    expect(cleanTranscript('今天 天气 晴 hello world')).toBe('今天天气晴 hello world');
  });

  it('空串与无空白文本原样返回', () => {
    expect(cleanTranscript('')).toBe('');
    expect(cleanTranscript('你好')).toBe('你好');
  });
});

describe('appendTranscript', () => {
  it('基础内容为空：直接返回归一化后的新段', () => {
    expect(appendTranscript('', '你好')).toBe('你好');
    expect(appendTranscript('', '  你好')).toBe('你好');
  });

  it('新段为空：返回基础内容', () => {
    expect(appendTranscript('你好', '')).toBe('你好');
    expect(appendTranscript('你好', '   ')).toBe('你好');
  });

  it('基础内容尾部已有空白：直接拼接不再补空格', () => {
    expect(appendTranscript('你好 ', '世界')).toBe('你好 世界');
  });

  it('CJK 边界：不加空格（中文不分词）', () => {
    expect(appendTranscript('你好', '世界')).toBe('你好世界');
    expect(appendTranscript('你好', 'world')).toBe('你好world');
    expect(appendTranscript('hello', '世界')).toBe('hello世界');
  });

  it('非 CJK 边界：补一个空格（英文单词/句子间）', () => {
    expect(appendTranscript('hello', 'world')).toBe('hello world');
    expect(appendTranscript('foo', 'bar')).toBe('foo bar');
  });
});
