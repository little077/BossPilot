import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getChatHistorySettings,
  getLlmConfig,
  getUserProfile,
  setChatHistorySettings,
  setLlmConfig,
  setUserProfile,
} from '@/lib/storage/config';

const values: Record<string, unknown> = {};

beforeEach(() => {
  for (const key of Object.keys(values)) delete values[key];
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: values[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(values, items);
        }),
      },
    },
  });
});

describe('local configuration', () => {
  it('uses safe defaults and stores LLM/profile values', async () => {
    expect(await getLlmConfig()).toMatchObject({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
    });
    expect(await getUserProfile()).toEqual({ resumeText: '', preferences: '' });

    const llm = {
      baseUrl: 'https://example.com/v1',
      apiKey: 'key',
      model: 'model',
      batchSize: 5,
    };
    const profile = { resumeText: 'resume', preferences: 'remote' };
    await setLlmConfig(llm);
    await setUserProfile(profile);
    expect(await getLlmConfig()).toEqual(llm);
    expect(await getUserProfile()).toEqual(profile);
  });

  it('defaults automatic titles to off and narrows malformed stored values', async () => {
    expect(await getChatHistorySettings()).toEqual({ autoTitle: false });
    values['bosspilot:chat-history'] = 'invalid';
    expect(await getChatHistorySettings()).toEqual({ autoTitle: false });
    values['bosspilot:chat-history'] = { autoTitle: 'yes' };
    expect(await getChatHistorySettings()).toEqual({ autoTitle: false });
  });

  it('persists automatic-title preference locally', async () => {
    await setChatHistorySettings({ autoTitle: true });
    expect(await getChatHistorySettings()).toEqual({ autoTitle: true });
  });
});
