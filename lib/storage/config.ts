// ─── 配置与档案存储（chrome.storage.local） ───
// BYOK 配置、用户简历档案全部本地存储，无云同步、无遥测。

import type { LlmConfig, UserProfile } from '@/lib/domain/types';

const KEY_LLM = 'bosspilot:llm';
const KEY_PROFILE = 'bosspilot:profile';

const DEFAULT_LLM: LlmConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  batchSize: 10,
};

const DEFAULT_PROFILE: UserProfile = {
  resumeText: '',
  preferences: '',
};

export async function getLlmConfig(): Promise<LlmConfig> {
  const r = await chrome.storage.local.get(KEY_LLM);
  return { ...DEFAULT_LLM, ...(r[KEY_LLM] as Partial<LlmConfig> | undefined) };
}

export async function setLlmConfig(config: LlmConfig): Promise<void> {
  await chrome.storage.local.set({ [KEY_LLM]: config });
}

export async function getUserProfile(): Promise<UserProfile> {
  const r = await chrome.storage.local.get(KEY_PROFILE);
  return { ...DEFAULT_PROFILE, ...(r[KEY_PROFILE] as Partial<UserProfile> | undefined) };
}

export async function setUserProfile(profile: UserProfile): Promise<void> {
  await chrome.storage.local.set({ [KEY_PROFILE]: profile });
}
