// ─── 配置与档案存储（chrome.storage.local） ───
// BYOK 配置、用户简历档案全部本地存储，无云同步、无遥测。

import type { ChatHistorySettings } from '@/lib/domain/chat';
import type { LlmConfig, UserProfile } from '@/lib/domain/types';

const KEY_LLM = 'bosspilot:llm';
const KEY_PROFILE = 'bosspilot:profile';
const KEY_CHAT_HISTORY = 'bosspilot:chat-history';

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

const DEFAULT_CHAT_HISTORY: ChatHistorySettings = {
  autoTitle: false,
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

export async function getChatHistorySettings(): Promise<ChatHistorySettings> {
  const result = await chrome.storage.local.get(KEY_CHAT_HISTORY);
  const stored = result[KEY_CHAT_HISTORY];
  if (!isRecord(stored)) return { ...DEFAULT_CHAT_HISTORY };
  return { autoTitle: stored.autoTitle === true };
}

export async function setChatHistorySettings(settings: ChatHistorySettings): Promise<void> {
  await chrome.storage.local.set({ [KEY_CHAT_HISTORY]: settings });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
