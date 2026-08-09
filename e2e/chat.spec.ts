import type { Request } from '@playwright/test';
import { expect, test } from './fixtures';

const BASE_URL = 'https://www.zhipin.com/bosspilot-chat-e2e/v1';
const MODEL_ID = 'boss-stream-test';
const SECRET = 'e2e-chat-secret-2468';
const USER_TEXT = '请用一句话介绍 BossPilot';
const ASSISTANT_TEXT = 'BossPilot 是你的 BYOK 浏览器 AI 助手。';

interface CapturedChatRequest {
  authorization?: string;
  body: {
    messages?: Array<{ role?: string; content?: unknown }>;
    model?: unknown;
    stream?: unknown;
    tools?: unknown;
  };
}

test('真实流式对话写入历史、生成自动标题，并在刷新后回放', async ({ context, extensionId }) => {
  const chatRequests: CapturedChatRequest[] = [];

  await context.route(`${BASE_URL}/models`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [{ id: MODEL_ID, name: 'Boss Stream Test' }],
      }),
    });
  });

  await context.route(`${BASE_URL}/chat/completions`, async (route) => {
    chatRequests.push(await captureChatRequest(route.request()));
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream; charset=utf-8',
      },
      body:
        chatRequests.length === 1
          ? openAiStreamBody()
          : openAiFinalAnswerBody('chatcmpl-bosspilot-title-e2e', 'BossPilot 功能介绍'),
    });
  });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: '我的模型卡包' })).toBeVisible();
  await page.getByRole('button', { name: /显示更多/ }).click();
  await page.getByRole('button', { name: /自定义端点/ }).click();

  const card = page.getByRole('article', { name: '自定义端点 模型配置' });
  await card.getByLabel('Base URL（OpenAI 兼容端点）').fill(BASE_URL);
  await card.getByLabel('API Key（仅存本机）').fill(SECRET);
  await card.getByRole('button', { name: '开通' }).click();
  await card.getByRole('button', { name: 'Boss Stream Test' }).click();
  await expect(card.getByRole('button', { name: 'Boss Stream Test' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('switch', { name: '自动生成会话标题' }).click();
  await expect(page.getByText('已开启自动会话标题。')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(SECRET);

  await page.getByRole('button', { name: '对话' }).click();
  const editor = page.locator('.composer-editor [contenteditable="true"]');
  await editor.fill(USER_TEXT);
  await page.getByRole('button', { name: '发送' }).click();

  await expect(page.locator('.redscope-user-message')).toContainText(USER_TEXT);
  await expect(page.locator('.redscope-ai-message')).toContainText(ASSISTANT_TEXT);
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0);
  await expect.poll(() => chatRequests.length).toBe(2);
  expect(chatRequests[0]).toMatchObject({
    authorization: `Bearer ${SECRET}`,
    body: {
      model: MODEL_ID,
      stream: true,
    },
  });
  expect(chatRequests[0]?.body.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining(USER_TEXT) }),
    ]),
  );
  expect(chatRequests[1]?.body.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('请为下面的对话生成标题'),
      }),
    ]),
  );
  await expect(page.locator('body')).not.toContainText(SECRET);

  await page.getByRole('button', { name: '历史记录' }).click();
  const restoreHistory = page.getByRole('button', { name: /恢复会话：BossPilot 功能介绍/ });
  await expect(restoreHistory).toBeVisible();
  await restoreHistory.click();
  await expect(page.locator('.redscope-user-message')).toContainText(USER_TEXT);
  await expect(page.locator('.redscope-ai-message')).toContainText(ASSISTANT_TEXT);
  await expect(page.locator('.redscope-dock')).toBeVisible();

  await page.reload();
  await expect(page.locator('.redscope-user-message')).toContainText(USER_TEXT);
  await expect(page.locator('.redscope-ai-message')).toContainText(ASSISTANT_TEXT);
  await expect(page.locator('body')).not.toContainText(SECRET);
});

test('通用当前页工具读取 Boss 岗位并附加领域增强', async ({ context, extensionId }) => {
  const chatRequests: CapturedChatRequest[] = [];

  await context.route(`${BASE_URL}/models`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [{ id: MODEL_ID, name: 'Boss Stream Test' }],
      }),
    });
  });
  await context.route(`${BASE_URL}/chat/completions`, async (route) => {
    const request = await captureChatRequest(route.request());
    chatRequests.push(request);
    const hasToolResult = request.body.messages?.some(({ role }) => role === 'tool') ?? false;
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream; charset=utf-8',
      },
      body: hasToolResult ? openAiToolAnswerBody() : openAiToolCallBody(),
    });
  });
  const selectedJobUrl = 'https://www.zhipin.com/web/geek/job?query=frontend';
  await context.route(selectedJobUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
        <html lang="zh-CN">
          <body>
            <main>
              <ul class="job-list-box">
                <li class="job-card-wrapper">
                  <a href="/job_detail/bosspilot-e2e.html"><span class="job-name">列表岗位</span></a>
                </li>
              </ul>
              <div class="job-detail-container">
                <aside class="job-detail-box">
                  <header class="job-detail-header">
                    <div class="job-detail-info">
                      <h2 class="job-name">高级前端工程师</h2>
                      <span class="job-salary">20-30K</span>
                      <a class="company-name">示例科技</a>
                    </div>
                    <ul class="tag-list"><li>3-5年</li><li>本科</li></ul>
                  </header>
                  <div class="job-detail-body">
                    <h3 class="title">职位描述</h3>
                    <p class="desc">负责 React 与 TypeScript 项目开发，要求三年前端经验。</p>
                    <div class="job-address">
                      <span class="job-address-title">工作地址</span>
                      <p class="job-address-desc">西安高新区软件园</p>
                    </div>
                  </div>
                </aside>
              </div>
            </main>
          </body>
        </html>`,
    });
  });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: '设置' }).click();
  await panel.getByRole('button', { name: /显示更多/ }).click();
  await panel.getByRole('button', { name: /自定义端点/ }).click();
  const card = panel.getByRole('article', { name: '自定义端点 模型配置' });
  await card.getByLabel('Base URL（OpenAI 兼容端点）').fill(BASE_URL);
  await card.getByLabel('API Key（仅存本机）').fill(SECRET);
  await card.getByRole('button', { name: '开通' }).click();
  await card.getByRole('button', { name: 'Boss Stream Test' }).click();

  await panel.getByRole('button', { name: '对话' }).click();
  await panel
    .locator('.composer-editor [contenteditable="true"]')
    .fill('帮我解读当前选中的岗位要求');

  const jobPage = await context.newPage();
  await jobPage.goto(selectedJobUrl);
  await jobPage.bringToFront();
  await panel.getByRole('button', { name: '发送' }).evaluate((button: HTMLElement) => {
    button.click();
  });

  await expect(panel.getByText('已读取当前页面')).toBeVisible();
  await expect(panel.getByText('read_current_page')).toBeVisible();
  await expect(panel.getByText(/基于当前页面 ·/)).toBeVisible();
  await expect(panel.locator('.redscope-ai-message')).toContainText(
    '该岗位要求 React、TypeScript，并希望候选人具备三年前端经验。',
  );
  await expect.poll(() => chatRequests.length).toBe(2);
  expect(chatRequests[0]?.body.tools).toBeDefined();
  expect(chatRequests[1]?.body.tools).toEqual([]);
  expect(chatRequests[1]?.body.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('负责 React 与 TypeScript 项目开发'),
      }),
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('"title":"高级前端工程师"'),
      }),
    ]),
  );

  await panel.getByRole('button', { name: '下载诊断日志' }).click();
  await expect
    .poll(() =>
      panel.evaluate(async () => {
        const [latest] = await chrome.downloads.search({
          limit: 1,
          orderBy: ['-startTime'],
        });
        return latest?.url.startsWith('data:text/markdown') ?? false;
      }),
    )
    .toBe(true);
  const diagnosticsUrl = await panel.evaluate(async () => {
    const [latest] = await chrome.downloads.search({
      limit: 1,
      orderBy: ['-startTime'],
    });
    return latest?.url ?? '';
  });
  const diagnostics = Buffer.from(diagnosticsUrl.split(',')[1] ?? '', 'base64').toString('utf8');
  expect(diagnostics).toContain('## 当前页面结构诊断');
  expect(diagnostics).toContain('列表页内展开的岗位详情');
  expect(diagnostics).not.toContain('?query=frontend');
  await expect(panel.locator('body')).not.toContainText(SECRET);

  await panel.bringToFront();
  await expect(panel.locator('.is-launching')).toHaveCount(0);
  await panel.setViewportSize({ width: 420, height: 720 });
  await panel.screenshot({ path: 'test-results/read-current-page-chatflow.png' });
});

test('通用当前页工具在不滚动页面的前提下读取 Boss 当前岗位卡片', async ({
  context,
  extensionId,
}) => {
  const chatRequests: CapturedChatRequest[] = [];

  await context.route(`${BASE_URL}/models`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [{ id: MODEL_ID, name: 'Boss Stream Test' }],
      }),
    });
  });
  await context.route(`${BASE_URL}/chat/completions`, async (route) => {
    const request = await captureChatRequest(route.request());
    chatRequests.push(request);
    const hasToolResult = request.body.messages?.some(({ role }) => role === 'tool') ?? false;
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream; charset=utf-8',
      },
      body: hasToolResult ? openAiJobListAnswerBody() : openAiToolCallBody(),
    });
  });

  const jobListUrl = 'https://www.zhipin.com/web/geek/jobs?query=frontend';
  await context.route(jobListUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
        <html lang="zh-CN">
          <head>
            <style>
              .job-list-container { height: 300px; overflow-y: auto; }
              .job-card-box { display: block; height: 220px; }
            </style>
          </head>
          <body>
            <main>
              <div class="job-list-container">
                <ul class="rec-job-list">
                  <li class="job-card-box">
                    <a href="/job_detail/list-a.html"><span class="job-name">前端工程师</span></a>
                    <span class="job-salary">18-25K</span>
                    <span class="company-name">甲公司</span>
                    <span class="job-area">杭州</span>
                  </li>
                  <li class="job-card-box">
                    <a href="/job_detail/list-b.html"><span class="job-name">React 工程师</span></a>
                    <span class="job-salary">20-30K</span>
                    <span class="company-name">乙公司</span>
                    <span class="job-area">杭州</span>
                  </li>
                </ul>
              </div>
            </main>
          </body>
        </html>`,
    });
  });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: '设置' }).click();
  await panel.getByRole('button', { name: /显示更多/ }).click();
  await panel.getByRole('button', { name: /自定义端点/ }).click();
  const card = panel.getByRole('article', { name: '自定义端点 模型配置' });
  await card.getByLabel('Base URL（OpenAI 兼容端点）').fill(BASE_URL);
  await card.getByLabel('API Key（仅存本机）').fill(SECRET);
  await card.getByRole('button', { name: '开通' }).click();
  await card.getByRole('button', { name: 'Boss Stream Test' }).click();

  await panel.getByRole('button', { name: '对话' }).click();
  await panel.locator('.composer-editor [contenteditable="true"]').fill('查看页面有哪些岗位');

  const jobPage = await context.newPage();
  await jobPage.goto(jobListUrl);
  await jobPage.bringToFront();
  await panel.getByRole('button', { name: '发送' }).evaluate((button: HTMLElement) => {
    button.click();
  });

  await expect(panel.getByText('已读取当前页面')).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText('read_current_page')).toBeVisible();
  await expect(panel.locator('.redscope-ai-message')).toContainText(
    '当前页面读取到 2 个岗位：前端工程师、React 工程师。',
  );
  await expect.poll(() => chatRequests.length).toBe(2);
  expect(chatRequests[1]?.body.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('"kind":"job_list"'),
      }),
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('"title":"React 工程师"'),
      }),
    ]),
  );
});

async function captureChatRequest(request: Request): Promise<CapturedChatRequest> {
  const rawBody = request.postDataJSON() as unknown;
  const body = isRecord(rawBody) ? rawBody : {};
  return {
    authorization: request.headers().authorization,
    body: {
      messages: Array.isArray(body.messages)
        ? body.messages.flatMap((message) =>
            isRecord(message)
              ? [
                  {
                    role: typeof message.role === 'string' ? message.role : undefined,
                    content: message.content,
                  },
                ]
              : [],
          )
        : undefined,
      model: body.model,
      stream: body.stream,
      tools: body.tools,
    },
  };
}

function openAiStreamBody(): string {
  const chunk = (content: string, finishReason: string | null = null) =>
    JSON.stringify({
      id: 'chatcmpl-bosspilot-e2e',
      object: 'chat.completion.chunk',
      created: 1_750_000_000,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          delta: content ? { content } : {},
          finish_reason: finishReason,
        },
      ],
      ...(finishReason
        ? {
            usage: {
              prompt_tokens: 12,
              completion_tokens: 15,
              total_tokens: 27,
            },
          }
        : {}),
    });

  return [
    `data: ${chunk('BossPilot 是你的')}`,
    `data: ${chunk(' BYOK 浏览器 AI 助手。')}`,
    `data: ${chunk('', 'stop')}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
}

function openAiToolCallBody(toolName = 'read_current_page'): string {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    JSON.stringify({
      id: 'chatcmpl-bosspilot-tool-e2e',
      object: 'chat.completion.chunk',
      created: 1_750_000_001,
      model: MODEL_ID,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(finishReason
        ? {
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
            },
          }
        : {}),
    });

  return [
    `data: ${chunk({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'call-read-current-page',
          type: 'function',
          function: { name: toolName, arguments: '{}' },
        },
      ],
    })}`,
    `data: ${chunk({}, 'tool_calls')}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
}

function openAiToolAnswerBody(): string {
  const answer = '该岗位要求 React、TypeScript，并希望候选人具备三年前端经验。';
  return openAiFinalAnswerBody('chatcmpl-bosspilot-tool-answer-e2e', answer);
}

function openAiJobListAnswerBody(): string {
  const answer = '当前页面读取到 2 个岗位：前端工程师、React 工程师。';
  return openAiFinalAnswerBody('chatcmpl-bosspilot-job-list-answer-e2e', answer);
}

function openAiFinalAnswerBody(id: string, answer: string): string {
  const chunk = (content: string, finishReason: string | null = null) =>
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 1_750_000_002,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          delta: content ? { content } : {},
          finish_reason: finishReason,
        },
      ],
      ...(finishReason
        ? {
            usage: {
              prompt_tokens: 20,
              completion_tokens: 16,
              total_tokens: 36,
            },
          }
        : {}),
    });

  return [
    `data: ${chunk(answer.slice(0, 18))}`,
    `data: ${chunk(answer.slice(18))}`,
    `data: ${chunk('', 'stop')}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
