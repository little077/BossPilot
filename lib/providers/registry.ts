// ─── 模型厂商注册表 ───
// 职责：维护 BossPilot 独立验证的厂商元数据与模型目录协议。
// 这里只描述公开 API 入口，不包含任何第三方项目的实现或模型静态清单。

import type { GenerationProtocol } from '@/lib/generation/types';

export type ProviderDiscoveryKind = 'openai' | 'anthropic' | 'gemini' | 'ollama';
export type ProviderTone = 'blue' | 'ink' | 'violet' | 'teal' | 'amber' | 'slate';

export interface ProviderDefinition {
  id: string;
  label: string;
  shortLabel: string;
  baseUrl: string;
  keyUrl: string;
  discovery: ProviderDiscoveryKind;
  generation: GenerationProtocol;
  /** 生成 SDK 使用的地址；未填写时与模型目录地址相同。 */
  generationBaseUrl?: string;
  tone: ProviderTone;
  featured?: boolean;
  keyOptional?: boolean;
  custom?: boolean;
  /** 模型目录为公开接口时不发送用户密钥，但仍保存密钥供第二版调用。 */
  publicCatalog?: boolean;
}

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    shortLabel: 'D',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    discovery: 'openai',
    generation: 'openai-completions',
    generationBaseUrl: 'https://api.deepseek.com',
    tone: 'blue',
    featured: true,
  },
  {
    id: 'moonshotai-cn',
    label: 'Kimi / Moonshot（CN）',
    shortLabel: 'K',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'ink',
    featured: true,
  },
  {
    id: 'zhipu',
    label: '智谱 BigModel',
    shortLabel: 'Z',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'blue',
    featured: true,
  },
  {
    id: 'qwen',
    label: '通义千问',
    shortLabel: 'Q',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'violet',
    featured: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    shortLabel: 'O',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    discovery: 'openai',
    generation: 'openai-responses',
    tone: 'teal',
    featured: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    shortLabel: 'R',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'violet',
    featured: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    shortLabel: 'G',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'amber',
    featured: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    shortLabel: 'A',
    baseUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    discovery: 'anthropic',
    generation: 'anthropic-messages',
    generationBaseUrl: 'https://api.anthropic.com',
    tone: 'amber',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    shortLabel: 'G',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    discovery: 'gemini',
    generation: 'google-generative-ai',
    tone: 'blue',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    shortLabel: 'M',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    discovery: 'openai',
    generation: 'mistral-conversations',
    generationBaseUrl: 'https://api.mistral.ai',
    tone: 'amber',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    shortLabel: 'C',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyUrl: 'https://cloud.cerebras.ai/',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'teal',
  },
  {
    id: 'fireworks',
    label: 'Fireworks',
    shortLabel: 'F',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    keyUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'amber',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    shortLabel: 'HF',
    baseUrl: 'https://router.huggingface.co/v1',
    keyUrl: 'https://huggingface.co/settings/tokens',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'amber',
  },
  {
    id: 'kimi-coding',
    label: 'Kimi Coding Plan',
    shortLabel: 'KC',
    baseUrl: 'https://api.kimi.com/coding',
    keyUrl: 'https://www.kimi.com/code/console',
    discovery: 'openai',
    generation: 'anthropic-messages',
    tone: 'ink',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    shortLabel: 'M',
    baseUrl: 'https://api.minimax.io/v1',
    keyUrl: 'https://platform.minimax.io/',
    discovery: 'openai',
    generation: 'anthropic-messages',
    generationBaseUrl: 'https://api.minimax.io/anthropic',
    tone: 'violet',
  },
  {
    id: 'minimax-cn',
    label: 'MiniMax（CN）',
    shortLabel: 'M',
    baseUrl: 'https://api.minimaxi.com/v1',
    keyUrl: 'https://platform.minimaxi.com/',
    discovery: 'openai',
    generation: 'anthropic-messages',
    generationBaseUrl: 'https://api.minimaxi.com/anthropic',
    tone: 'violet',
  },
  {
    id: 'moonshotai',
    label: 'Moonshot',
    shortLabel: 'K',
    baseUrl: 'https://api.moonshot.ai/v1',
    keyUrl: 'https://platform.moonshot.ai/',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'ink',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    shortLabel: 'N',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyUrl: 'https://build.nvidia.com/',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'teal',
  },
  {
    id: 'together',
    label: 'Together AI',
    shortLabel: 'T',
    baseUrl: 'https://api.together.ai/v1',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'blue',
  },
  {
    id: 'vercel-ai-gateway',
    label: 'Vercel AI Gateway',
    shortLabel: 'V',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    keyUrl: 'https://vercel.com/ai-gateway',
    discovery: 'openai',
    generation: 'anthropic-messages',
    generationBaseUrl: 'https://ai-gateway.vercel.sh',
    tone: 'ink',
    publicCatalog: true,
  },
  {
    id: 'xai',
    label: 'xAI',
    shortLabel: 'X',
    baseUrl: 'https://api.x.ai/v1',
    keyUrl: 'https://console.x.ai/',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'ink',
  },
  {
    id: 'xiaomi',
    label: 'Xiaomi MiMo',
    shortLabel: 'Mi',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    keyUrl: 'https://platform.xiaomimimo.com/',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'amber',
  },
  {
    id: 'xiaomi-token-plan-cn',
    label: 'Xiaomi MiMo Plan（CN）',
    shortLabel: 'Mi',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    keyUrl: 'https://platform.xiaomimimo.com/',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'amber',
  },
  {
    id: 'zai',
    label: 'zAI',
    shortLabel: 'Z',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'blue',
  },
  {
    id: 'ant-ling',
    label: 'Ant Ling',
    shortLabel: 'L',
    baseUrl: 'https://api.ant-ling.com/v1',
    keyUrl: 'https://ant-ling.com/',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'teal',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    shortLabel: '◉',
    baseUrl: 'http://localhost:11434',
    keyUrl: 'https://ollama.com/download',
    discovery: 'ollama',
    generation: 'openai-completions',
    tone: 'slate',
    featured: true,
    keyOptional: true,
  },
  {
    id: 'custom',
    label: '自定义端点',
    shortLabel: '+',
    baseUrl: '',
    keyUrl: 'https://platform.openai.com/docs/api-reference/models/list',
    discovery: 'openai',
    generation: 'openai-completions',
    tone: 'slate',
    featured: true,
    keyOptional: true,
    custom: true,
  },
] as const;

const PROVIDER_BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

export function getProviderDefinition(providerId: string): ProviderDefinition | undefined {
  return PROVIDER_BY_ID.get(providerId);
}

export function getProviderBaseUrl(providerId: string, customBaseUrl?: string): string {
  const provider = getProviderDefinition(providerId);
  if (!provider) throw new Error('未知的模型厂商。');
  return provider.custom ? (customBaseUrl ?? '') : provider.baseUrl;
}
