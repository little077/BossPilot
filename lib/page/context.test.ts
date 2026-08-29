// ─── M1 页面上下文注入的单元测试 ───
// 验证：注入块字段完整、安全转义；注入只落在最后一条 user 消息且不突变历史。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/domain/chat';
import type { PageTurnSnapshot } from '@/lib/domain/types';
import {
  activeTabContext,
  attachPageContext,
  composePageContext,
  summarizeTab,
  withPageContext,
} from './context';
import { pageContextHistory, snapshotFromTab } from './snapshot';

const query = vi.fn();

beforeEach(() => {
  query.mockReset();
  vi.stubGlobal('chrome', { tabs: { query } });
});

afterEach(() => vi.unstubAllGlobals());

const SNAPSHOT = (): PageTurnSnapshot =>
  snapshotFromTab({
    id: 7,
    windowId: 3,
    url: 'https://example.com/docs/page?token=secret#section',
    title: '<title>',
  } as chrome.tabs.Tab);

const HISTORY: ChatMessage[] = [
  { id: 'u1', role: 'user', content: '第一问', createdAt: 1 },
  {
    id: 'a1',
    role: 'assistant',
    content: '回答',
    createdAt: 2,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      cost: 0,
    },
  },
  { id: 'u2', role: 'user', content: '总结当前页', createdAt: 3 },
];

describe('composePageContext', () => {
  it('包含活动页字段与标签页列表', () => {
    const block = composePageContext(activeTabContext(SNAPSHOT()), [
      { windowId: 3, tabId: 7, title: 'Page', url: 'https://example.com/docs/page', active: true },
      { windowId: 3, tabId: 9, title: 'Baidu', url: 'https://www.baidu.com', active: false },
    ]);
    expect(block).toContain('untrusted_page_context');
    expect(block).toContain('"tabId":7');
    expect(block).toContain('"windowId":3');
    expect(block).toContain('https://example.com/docs/page');
    expect(block).toContain('"active":true');
    expect(block).toContain('https://www.baidu.com');
  });

  it('脱敏 URL 并转义尖括号', () => {
    const block = composePageContext(activeTabContext(SNAPSHOT()));
    expect(block).not.toContain('token=secret');
    expect(block).toContain('\\u003ctitle>');
    expect(block).not.toMatch(/<title>/u);
  });

  it('无标签页列表时不输出 tabs 字段', () => {
    const block = composePageContext(activeTabContext(SNAPSHOT()));
    expect(block).not.toContain('"tabs"');
  });

  it('M5.2：注入 page_changed_since_last_read 变化感知字段', () => {
    const unchanged = composePageContext(activeTabContext(SNAPSHOT(), undefined, false));
    expect(unchanged).toContain('"changedSinceLastRead":false');
    const changed = composePageContext(activeTabContext(SNAPSHOT(), undefined, true));
    expect(changed).toContain('"changedSinceLastRead":true');
    // 未提供时保持向后兼容，不输出该字段
    expect(composePageContext(activeTabContext(SNAPSHOT()))).not.toContain('changedSinceLastRead');
  });
});

describe('withPageContext', () => {
  it('只给最后一条 user 消息追加上下文，不突变原历史', () => {
    const contextual = withPageContext(HISTORY, SNAPSHOT());
    expect(contextual).not.toBe(HISTORY);
    expect(contextual[0]?.content).toBe('第一问');
    expect(contextual[1]?.content).toBe('回答');
    expect(contextual[2]?.content).toContain('总结当前页');
    expect(contextual[2]?.content).toContain('untrusted_page_context');
    expect(contextual[2]?.content).toContain('read_current_page');
    expect(HISTORY[2]?.content).toBe('总结当前页');
  });

  it('无快照或无 user 消息时原样返回克隆', () => {
    expect(withPageContext(HISTORY, null)).toEqual(HISTORY);
    const onlyAssistant = [{ id: 'a', role: 'assistant' as const, content: 'x', createdAt: 1 }];
    expect(withPageContext(onlyAssistant, SNAPSHOT())).toEqual(onlyAssistant);
  });

  it('兼容入口 pageContextHistory 行为一致', () => {
    const contextual = pageContextHistory(HISTORY, SNAPSHOT());
    expect(contextual[2]?.content).toContain('untrusted_page_context');
  });
});

describe('attachPageContext', () => {
  it('查询全部标签页并注入列表', async () => {
    query.mockResolvedValue([
      { id: 7, windowId: 3, url: 'https://example.com/docs/page', title: 'Page', active: true },
      { id: 9, windowId: 3, url: 'https://www.baidu.com?wd=secret', title: '百度', active: false },
      { id: 11, windowId: 4, url: 'chrome://extensions', title: '扩展', active: true },
    ]);
    const contextual = await attachPageContext(HISTORY, SNAPSHOT());
    expect(query).toHaveBeenCalledWith({});
    expect(contextual[2]?.content).toContain('"tabId":9');
    expect(contextual[2]?.content).toContain('https://www.baidu.com');
    expect(contextual[2]?.content).not.toContain('wd=secret');
    expect(contextual[2]?.content).not.toContain('chrome://extensions');
  });

  it('查询失败时退回仅注入活动页', async () => {
    query.mockRejectedValue(new Error('tabs unavailable'));
    const contextual = await attachPageContext(HISTORY, SNAPSHOT());
    expect(contextual[2]?.content).toContain('untrusted_page_context');
    expect(contextual[2]?.content).not.toContain('"tabs"');
  });

  it('无快照时原样返回', async () => {
    await expect(attachPageContext(HISTORY, null)).resolves.toEqual(HISTORY);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('summarizeTab / activeTabContext', () => {
  it('缺 id 或 windowId 的标签页被忽略', () => {
    expect(summarizeTab({ title: 'x' } as chrome.tabs.Tab)).toBeNull();
    expect(summarizeTab({ id: 1 } as chrome.tabs.Tab)).toBeNull();
  });

  it('activeTabContext 识别 PDF 与 Boss 页面', () => {
    const pdf = activeTabContext(
      snapshotFromTab({
        id: 1,
        windowId: 1,
        url: 'https://example.com/report.pdf?x=1',
        title: 'R',
      } as chrome.tabs.Tab),
    );
    expect(pdf.isPdf).toBe(true);
    const boss = activeTabContext(
      snapshotFromTab({
        id: 1,
        windowId: 1,
        url: 'https://www.zhipin.com/web/geek/job',
        title: 'Boss',
      } as chrome.tabs.Tab),
      { status: 'loading' } as chrome.tabs.Tab,
    );
    expect(boss.isBoss).toBe(true);
    expect(boss.status).toBe('loading');
  });
});
