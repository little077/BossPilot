import { describe, expect, it } from 'vitest';
import { ASK_USER_TOOL, askUser } from './ask-user';

describe('askUser', () => {
  it('exposes a bounded tool schema and normalizes a valid question', () => {
    expect(ASK_USER_TOOL.name).toBe('ask_user');

    expect(
      askUser({
        id: 'call-1',
        name: 'ask_user',
        arguments: {
          question: '  你希望搜索哪一天？  ',
          options: ['周六', '周日', '周六'],
          customPlaceholder: '  例如：周日下午  ',
        },
      }),
    ).toEqual({
      deferred: true,
      kind: 'user_input',
      statusText: '等待用户补充信息',
      question: '你希望搜索哪一天？',
      options: [
        { id: 'option-1', label: '周六' },
        { id: 'option-2', label: '周日' },
      ],
      allowCustom: true,
      customPlaceholder: '例如：周日下午',
    });
  });

  it('rejects malformed questions instead of creating an unusable pause point', () => {
    expect(
      askUser({
        id: 'call-2',
        name: 'ask_user',
        arguments: { question: '', options: ['只有一个'] },
      }),
    ).toMatchObject({
      isError: true,
      statusText: '澄清问题参数无效',
    });
  });

  it('clips question, options and placeholder to their public limits', () => {
    const result = askUser({
      id: 'call-3',
      name: 'ask_user',
      arguments: {
        question: '问'.repeat(400),
        options: ['一'.repeat(120), '二', '三', '四', '五'],
        customPlaceholder: '例'.repeat(140),
      },
    });
    expect(result).toMatchObject({ deferred: true, kind: 'user_input' });
    if (!('deferred' in result) || result.kind !== 'user_input') {
      throw new Error('expected a user-input deferred result');
    }
    expect(result.question).toHaveLength(300);
    expect(result.options).toHaveLength(4);
    expect(result.options[0]?.label).toHaveLength(100);
    expect(result.customPlaceholder).toHaveLength(120);
  });
});
