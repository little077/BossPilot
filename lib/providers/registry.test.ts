import { describe, expect, it } from 'vitest';
import { getProviderBaseUrl, getProviderDefinition, PROVIDERS } from './registry';

describe('模型厂商注册表', () => {
  it('厂商 ID 唯一并覆盖一期与原型入口', () => {
    const ids = PROVIDERS.map((provider) => provider.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        'deepseek',
        'anthropic',
        'google',
        'openai',
        'openrouter',
        'moonshotai',
        'moonshotai-cn',
        'kimi-coding',
        'minimax',
        'minimax-cn',
        'mistral',
        'groq',
        'cerebras',
        'fireworks',
        'huggingface',
        'nvidia',
        'together',
        'vercel-ai-gateway',
        'xai',
        'xiaomi',
        'xiaomi-token-plan-cn',
        'zai',
        'ant-ling',
        'zhipu',
        'qwen',
        'ollama',
        'custom',
      ]),
    );
  });

  it('内置厂商返回固定地址，自定义厂商使用用户地址', () => {
    expect(getProviderBaseUrl('deepseek')).toBe('https://api.deepseek.com/v1');
    expect(getProviderBaseUrl('custom', 'https://example.com/v1')).toBe('https://example.com/v1');
    expect(getProviderDefinition('missing')).toBeUndefined();
    expect(() => getProviderBaseUrl('missing')).toThrow('未知的模型厂商');
  });

  it('只有明确的本地或自定义入口允许空密钥', () => {
    const optional = PROVIDERS.filter((provider) => provider.keyOptional).map(
      (provider) => provider.id,
    );
    expect(optional).toEqual(['ollama', 'custom']);
  });

  it('显式声明生成协议，不从模型发现协议推断', () => {
    expect(PROVIDERS.every((provider) => Object.hasOwn(provider, 'generation'))).toBe(true);
    expect(getProviderDefinition('openai')?.generation).toBe('openai-responses');
    expect(getProviderDefinition('anthropic')?.generation).toBe('anthropic-messages');
    expect(getProviderDefinition('google')?.generation).toBe('google-generative-ai');
    expect(getProviderDefinition('ollama')?.generation).toBe('openai-completions');
    expect(getProviderDefinition('custom')?.generation).toBe('openai-completions');
    expect(getProviderDefinition('kimi-coding')).toMatchObject({
      discovery: 'openai',
      generation: 'anthropic-messages',
    });
  });
});
