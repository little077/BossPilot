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
    tools?: Array<{ function?: { name?: string } }>;
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
  await expect(restoreHistory).toBeVisible({ timeout: 10_000 });
  await restoreHistory.click();
  await expect(page.locator('.redscope-user-message')).toContainText(USER_TEXT);
  await expect(page.locator('.redscope-ai-message')).toContainText(ASSISTANT_TEXT);
  await expect(page.locator('.redscope-dock')).toBeVisible();

  await page.reload();
  await expect(page.locator('.redscope-user-message')).toContainText(USER_TEXT);
  await expect(page.locator('.redscope-ai-message')).toContainText(ASSISTANT_TEXT);
  await expect(page.locator('body')).not.toContainText(SECRET);
});

test('Ask User 固定在输入框上方，切换页面后仍可回答并恢复原循环', async ({
  context,
  extensionId,
}) => {
  const chatRequests: CapturedChatRequest[] = [];
  await context.route(`${BASE_URL}/models`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: MODEL_ID, name: 'Boss Stream Test' }] }),
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
      body: hasToolResult
        ? openAiFinalAnswerBody(
            'chatcmpl-bosspilot-ask-answer-e2e',
            '收到，我会按周日继续执行，之前的进度已经保留。',
          )
        : openAiToolCallBody('ask_user', {
            question: '你更方便哪一天？',
            options: ['周六', '周日'],
            customPlaceholder: '例如：周日下午',
          }),
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

  await panel.getByRole('button', { name: '对话', exact: true }).click();
  await panel.locator('.composer-editor [contenteditable="true"]').fill('帮我安排周末活动');
  await panel.getByRole('button', { name: '发送' }).click();

  const askPanel = panel.locator('.ask-user-panel');
  await expect(askPanel).toBeVisible();
  await expect(askPanel.getByText('你更方便哪一天？')).toBeVisible();
  await expect(
    panel.locator('.redscope-ai-message').filter({ hasText: '你更方便哪一天？' }),
  ).toHaveCount(0);
  await expect(
    panel.locator('.redscope-dock .composer-editor [contenteditable="false"]'),
  ).toBeVisible();
  await panel.setViewportSize({ width: 420, height: 720 });
  await panel.screenshot({ path: 'test-results/ask-user-sidepanel.png' });

  await panel.getByRole('button', { name: '历史记录' }).click();
  await expect(askPanel).toHaveCount(0);
  await panel.getByRole('button', { name: '对话', exact: true }).click();
  await expect(panel.locator('.ask-user-panel')).toBeVisible();

  await panel.locator('.ask-user-option').filter({ hasText: '周日' }).click();
  await panel.getByRole('button', { name: '继续执行' }).click();
  await expect(panel.locator('.ask-user-panel')).toHaveCount(0);
  await expect(panel.locator('.redscope-ai-message')).toContainText(
    '收到，我会按周日继续执行，之前的进度已经保留。',
  );
  await expect.poll(() => chatRequests.length).toBe(2);
  expect(chatRequests[1]?.body.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('周日'),
      }),
    ]),
  );
});

test('通用当前页工具读取 Boss 岗位并附加领域增强', async ({ context, extensionId }) => {
  test.setTimeout(60_000);
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
  expect(chatRequests[1]?.body.tools?.map((tool) => tool.function?.name)).toEqual([
    'read_current_page',
    'browser_action',
    'tab',
    'observe_page',
    'inspect_page',
    'observe_visual_page',
    'interact_page',
    'load_skill',
    'run_skill',
    'search_memory',
    'save_memory',
    'workspace_create',
    'workspace_mkdir',
    'workspace_read',
    'workspace_edit',
    'workspace_rename',
    'workspace_delete',
    'workspace_list',
    'workspace_search',
    'workspace_save_url',
    'ask_user',
  ]);
  expect(chatRequests[0]?.body.messages).toContainEqual(
    expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('<available_skills>'),
    }),
  );
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
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('"structure":{"version":1'),
      }),
    ]),
  );

  const diagnosticsButton = panel.getByRole('button', { name: '下载诊断日志' });
  // 诊断日志按钮仅 dev 构建显示（aee154e）；正式构建跳过下载断言，其余工具链路断言仍然有效。
  if (await diagnosticsButton.isVisible().catch(() => false)) {
    await diagnosticsButton.click();
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
  }
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

test('浏览器操作工具在当前页语义识别搜索框、提交并验证结果', async ({ context, extensionId }) => {
  const chatRequests: CapturedChatRequest[] = [];
  await context.route(`${BASE_URL}/models`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: MODEL_ID, name: 'Boss Stream Test' }] }),
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
      body: hasToolResult
        ? openAiFinalAnswerBody(
            'chatcmpl-browser-action-answer-e2e',
            '已经在当前页面搜索 AI Agent，并确认页面已更新。',
          )
        : openAiToolCallBody('browser_action', {
            action: 'search',
            destination: 'current',
            query: 'AI Agent',
          }),
    });
  });

  const searchPageUrl = 'https://www.zhipin.com/bosspilot-browser-action-e2e';
  await context.route(searchPageUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
        <html lang="zh-CN">
          <head><title>通用搜索测试页</title></head>
          <body>
            <main>
              <form role="search" id="search-form">
                <label for="search-query">搜索知识库</label>
                <input id="search-query" type="search" placeholder="输入关键词" />
                <button type="submit">搜索</button>
              </form>
              <section id="result">等待搜索</section>
            </main>
            <script>
              document.querySelector('#search-form').addEventListener('submit', (event) => {
                event.preventDefault();
                const value = document.querySelector('#search-query').value;
                document.querySelector('#result').textContent = '搜索结果：' + value;
                document.title = value + ' - 搜索结果';
              });
            </script>
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
  await panel.locator('.composer-editor [contenteditable="true"]').fill('在当前页面搜索 AI Agent');

  const targetPage = await context.newPage();
  await targetPage.goto(searchPageUrl);
  await targetPage.bringToFront();
  await panel.getByRole('button', { name: '发送' }).evaluate((button: HTMLElement) => {
    button.click();
  });

  await expect(targetPage.locator('#search-query')).toHaveValue('AI Agent');
  await expect(targetPage.locator('#result')).toHaveText('搜索结果：AI Agent');
  await expect(panel.getByText('browser_action')).toBeVisible();
  await expect(panel.getByText('已完成并验证页面搜索')).toBeVisible();
  await expect(panel.locator('.redscope-ai-message')).toContainText(
    '已经在当前页面搜索 AI Agent，并确认页面已更新。',
  );
  await expect.poll(() => chatRequests.length).toBe(2);
  expect(chatRequests[0]?.body.tools).toBeDefined();
  expect(chatRequests[1]?.body.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('"action":"search"'),
      }),
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('"verifiedBy":"页面内容已更新"'),
      }),
    ]),
  );
});

test('通用页面 Agent 先检查目标元素，高风险提交经用户确认后恢复原动作', async ({
  context,
  extensionId,
}) => {
  const chatRequests: CapturedChatRequest[] = [];
  const targetUrl = 'https://www.zhipin.com/bosspilot-interaction-e2e';

  await context.route(`${BASE_URL}/models`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: MODEL_ID, name: 'Boss Stream Test' }] }),
    });
  });
  await context.route(`${BASE_URL}/chat/completions`, async (route) => {
    const request = await captureChatRequest(route.request());
    chatRequests.push(request);
    const toolMessages = request.body.messages?.filter(({ role }) => role === 'tool') ?? [];
    let body: string;
    if (toolMessages.length === 0) {
      body = openAiToolCallBody('inspect_page', { query: '提交申请', role: 'button' });
    } else if (toolMessages.length === 1) {
      const observationId = /"observationId":"([^"]+)"/u.exec(
        typeof toolMessages[0]?.content === 'string' ? toolMessages[0].content : '',
      )?.[1];
      body = observationId
        ? openAiToolCallBody('interact_page', {
            action: 'click',
            observationId,
            ref: 'e1',
          })
        : openAiFinalAnswerBody('chatcmpl-observation-error', '没有拿到页面观察编号。');
    } else {
      body = openAiFinalAnswerBody(
        'chatcmpl-interaction-answer-e2e',
        '已经在你确认后提交申请，并验证页面显示为已提交。',
      );
    }
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream; charset=utf-8',
      },
      body,
    });
  });
  await context.route(targetUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
        <html lang="zh-CN">
          <head><title>页面交互验收</title></head>
          <body>
            <main>
              <form id="application-form">
                <button type="submit">提交申请</button>
              </form>
              <output id="result">尚未提交</output>
            </main>
            <script>
              document.querySelector('#application-form').addEventListener('submit', (event) => {
                event.preventDefault();
                document.querySelector('#result').textContent = '已提交';
              });
            </script>
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

  const target = await context.newPage();
  await target.goto(targetUrl);
  await target.bringToFront();
  await expect(target.locator('#result')).toHaveText('尚未提交');

  await panel.getByRole('button', { name: '对话' }).click();
  await panel
    .locator('.composer-editor [contenteditable="true"]')
    .fill('请点击当前页面的提交申请按钮');
  await panel.getByRole('button', { name: '发送' }).evaluate((button: HTMLElement) => {
    button.click();
  });

  await expect(panel.locator('.ask-user-panel')).toBeVisible();
  await expect(panel.locator('.ask-user-panel')).toContainText('提交申请');
  await expect(panel.locator('.ask-user-panel')).toContainText('该控件可能提交表单或产生外部影响');
  await expect(target.locator('#result')).toHaveText('尚未提交');
  await expect.poll(() => chatRequests.length).toBe(2);

  await panel.locator('.ask-user-option').filter({ hasText: '确认执行' }).click();
  await panel.getByRole('button', { name: '继续执行' }).click();

  await expect(target.locator('#result')).toHaveText('已提交');
  await expect(panel.locator('.ask-user-panel')).toHaveCount(0);
  await expect(panel.locator('.redscope-ai-message')).toContainText(
    '已经在你确认后提交申请，并验证页面显示为已提交。',
  );
  await expect.poll(() => chatRequests.length).toBe(3);
  expect(chatRequests[2]?.body.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('"name":"提交申请"'),
      }),
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('"status":"verified"'),
      }),
    ]),
  );
});

test('视觉观察逐次授权，缺少 activeTab 时安全失败且不泄露页面字段', async ({
  context,
  extensionId,
}) => {
  const chatRequests: CapturedChatRequest[] = [];
  const targetUrl = 'https://www.zhipin.com/bosspilot-visual-e2e';

  await context.route(`${BASE_URL}/models`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: MODEL_ID, name: 'Boss Stream Test' }] }),
    });
  });
  await context.route(`${BASE_URL}/chat/completions`, async (route) => {
    const request = await captureChatRequest(route.request());
    chatRequests.push(request);
    const toolContent =
      request.body.messages
        ?.filter(({ role, content }) => role === 'tool' && typeof content === 'string')
        .map(({ content }) => content as string)
        .join('\n') ?? '';
    const observationId = /"observationId":"([^"]+)"/u.exec(toolContent)?.[1];
    const body =
      chatRequests.length === 1
        ? openAiToolCallBody(
            'observe_visual_page',
            {
              reason: '需要确认无文字图标按钮的位置和含义',
              query: '筛选图标',
            },
            'call-observe-visual',
          )
        : observationId
          ? openAiToolCallBody(
              'interact_page',
              { action: 'click', observationId, ref: 'e1' },
              'call-click-visual-ref',
            )
          : openAiFinalAnswerBody(
              'chatcmpl-visual-permission-e2e',
              '当前没有临时截图权限，请在目标页面点击 BossPilot 扩展图标后重试。',
            );
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream; charset=utf-8',
      },
      body,
    });
  });
  await context.route(targetUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
        <html lang="zh-CN">
          <head><title>视觉观察验收</title></head>
          <body>
            <main>
              <button id="filter" type="button" aria-label="筛选">⚙</button>
              <input aria-label="候选人备注" value="candidate-private-note" />
              <output id="result">筛选面板未打开</output>
            </main>
            <script>
              document.querySelector('#filter').addEventListener('click', () => {
                document.querySelector('#result').textContent = '筛选面板已打开';
              });
            </script>
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
  await card.getByRole('switch', { name: 'boss-stream-test 支持图片输入' }).click();
  await expect(panel.getByText('boss-stream-test 已声明支持图片输入。')).toBeVisible();

  const target = await context.newPage();
  await target.goto(targetUrl);
  await target.bringToFront();

  await panel.getByRole('button', { name: '对话', exact: true }).click();
  await panel
    .locator('.composer-editor [contenteditable="true"]')
    .fill('请用视觉查看页面，并打开筛选图标');
  await panel.getByRole('button', { name: '发送' }).evaluate((button: HTMLElement) => {
    button.click();
  });

  const askPanel = panel.locator('.ask-user-panel');
  await expect(askPanel).toContainText('当前可见区域截图');
  await expect(askPanel).toContainText('需要确认无文字图标按钮的位置和含义');
  await expect(target.locator('#result')).toHaveText('筛选面板未打开');
  await askPanel.locator('.ask-user-option').filter({ hasText: '仅本次允许' }).click();
  await askPanel.getByRole('button', { name: '继续执行' }).click();

  await expect.poll(() => chatRequests.length).toBe(2);
  const visualToolResults =
    chatRequests[1]?.body.messages
      ?.filter(({ role, content }) => role === 'tool' && typeof content === 'string')
      .map(({ content }) => content as string) ?? [];
  expect(visualToolResults.at(-1)).toContain('未把截图发送给模型');
  expect(visualToolResults.at(-1)).toContain('点击 BossPilot 扩展图标');
  expect(JSON.stringify(chatRequests[1]?.body.messages ?? [])).not.toContain('data:image/');
  await expect(target.locator('#result')).toHaveText('筛选面板未打开');
  await expect(panel.locator('.redscope-ai-message')).toContainText(
    '当前没有临时截图权限，请在目标页面点击 BossPilot 扩展图标后重试。',
  );
  expect(JSON.stringify(chatRequests)).not.toContain('candidate-private-note');

  const stored = await panel.evaluate(async () => chrome.storage.local.get(null));
  expect(JSON.stringify(stored)).not.toContain('data:image/');
});

test('页面 Agent 跟随点击打开的新标签页并继续执行', async ({ context, extensionId }) => {
  const chatRequests: CapturedChatRequest[] = [];
  const sourceUrl = 'https://www.zhipin.com/bosspilot-new-tab-e2e';
  const reportUrl = 'https://www.zhipin.com/bosspilot-report-e2e';

  await context.route(`${BASE_URL}/models`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: MODEL_ID, name: 'Boss Stream Test' }] }),
    });
  });
  await context.route(`${BASE_URL}/chat/completions`, async (route) => {
    const request = await captureChatRequest(route.request());
    chatRequests.push(request);
    const toolMessages = request.body.messages?.filter(({ role }) => role === 'tool') ?? [];
    const lastToolMessage = toolMessages.at(-1);
    const toolContent = typeof lastToolMessage?.content === 'string' ? lastToolMessage.content : '';
    const observationId = /"observationId":"([^"]+)"/u.exec(toolContent)?.[1];

    let body: string;
    if (toolMessages.length === 0) {
      body = openAiToolCallBody('observe_page', {}, 'call-observe-source');
    } else if (toolMessages.length === 1 && observationId) {
      body = openAiToolCallBody(
        'interact_page',
        { action: 'click', observationId, ref: 'e1' },
        'call-open-report',
      );
    } else if (toolMessages.length === 2 && observationId) {
      body = openAiToolCallBody(
        'interact_page',
        { action: 'click', observationId, ref: 'e1' },
        'call-view-detail',
      );
    } else if (toolMessages.length >= 3) {
      body = openAiFinalAnswerBody(
        'chatcmpl-new-tab-answer-e2e',
        '已经跟随新标签页，并验证详情已打开。',
      );
    } else {
      body = openAiFinalAnswerBody(
        'chatcmpl-new-tab-observation-error',
        '没有拿到新页面的观察编号。',
      );
    }

    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream; charset=utf-8',
      },
      body,
    });
  });
  await context.route(sourceUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
        <html lang="zh-CN">
          <head><title>新标签页来源</title></head>
          <body><a href="${reportUrl}" target="_blank">打开报告</a></body>
        </html>`,
    });
  });
  await context.route(reportUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
        <html lang="zh-CN">
          <head><title>报告页面</title></head>
          <body>
            <main>
              <h1>报告页面</h1>
              <button type="button" id="view-detail">查看详情</button>
              <output id="result">尚未查看</output>
            </main>
            <script>
              document.querySelector('#view-detail').addEventListener('click', () => {
                document.querySelector('#result').textContent = '已查看详情';
              });
            </script>
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

  const source = await context.newPage();
  await source.goto(sourceUrl);
  await source.bringToFront();

  await panel.getByRole('button', { name: '对话' }).click();
  await panel
    .locator('.composer-editor [contenteditable="true"]')
    .fill('打开报告，并在新页面查看详情');
  await panel.getByRole('button', { name: '发送' }).evaluate((button: HTMLElement) => {
    button.click();
  });

  await expect.poll(() => context.pages().some((page) => page.url() === reportUrl)).toBe(true);
  const report = context.pages().find((page) => page.url() === reportUrl);
  if (!report) throw new Error('点击后没有找到报告标签页');
  await expect(report.locator('#result')).toHaveText('已查看详情');
  await expect(panel.locator('.redscope-ai-message')).toContainText(
    '已经跟随新标签页，并验证详情已打开。',
  );
  await expect.poll(() => chatRequests.length).toBe(4);
  expect(chatRequests[2]?.body.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('点击后打开了一个新标签页'),
      }),
    ]),
  );
  expect(chatRequests[3]?.body.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('"status":"verified"'),
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
      tools: Array.isArray(body.tools)
        ? body.tools.flatMap((tool) => {
            if (!isRecord(tool) || !isRecord(tool.function)) return [];
            return [
              {
                function: {
                  name: typeof tool.function.name === 'string' ? tool.function.name : undefined,
                },
              },
            ];
          })
        : undefined,
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

function openAiToolCallBody(
  toolName = 'read_current_page',
  toolArguments: Record<string, unknown> = {},
  toolCallId?: string,
): string {
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
          id: toolCallId ?? `call-${toolName.replaceAll('_', '-')}`,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(toolArguments) },
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
