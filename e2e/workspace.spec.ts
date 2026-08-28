import { expect, test } from './fixtures';

const BASE_URL = 'https://www.zhipin.com/bosspilot-workspace-e2e/v1';
const MODEL_ID = 'workspace-test-model';

test('Agent 经用户确认后创建会话产物，并可在产物页预览', async ({ context, extensionId }) => {
  let requestCount = 0;
  await context.route(`${BASE_URL}/models`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: MODEL_ID, name: 'Workspace Test Model' }] }),
    });
  });
  await context.route(`${BASE_URL}/chat/completions`, async (route) => {
    requestCount += 1;
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream; charset=utf-8',
      },
      body:
        requestCount === 1
          ? toolCallBody('workspace_create', {
              path: '/reports/page-summary.md',
              content: '# 页面摘要\n\n这是本机工作区产物。',
              mimeType: 'text/markdown',
            })
          : finalAnswerBody('文件已经保存到 /reports/page-summary.md。'),
    });
  });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: /显示更多/u }).click();
  await page.getByRole('button', { name: /自定义端点/u }).click();
  const card = page.getByRole('article', { name: '自定义端点 模型配置' });
  await card.getByLabel('Base URL（OpenAI 兼容端点）').fill(BASE_URL);
  await card.getByLabel('API Key（仅存本机）').fill('workspace-secret');
  await card.getByRole('button', { name: /开通|连接|连通/u }).click();
  await card.getByRole('button', { name: 'Workspace Test Model' }).click();

  await page.getByRole('button', { name: '对话' }).click();
  await page
    .locator('.composer-editor [contenteditable="true"]')
    .fill('把当前结论保存为 /reports/page-summary.md');
  await page.getByRole('button', { name: '发送' }).click();

  await expect(page.getByText(/Agent 准备执行“创建工作区文件”/u)).toBeVisible();
  await page.getByRole('radio', { name: '确认执行' }).check({ force: true });
  await page.getByRole('button', { name: '继续执行' }).click();
  await expect(page.locator('.redscope-ai-message')).toContainText(
    '文件已经保存到 /reports/page-summary.md。',
  );

  await page.getByRole('button', { name: '产物' }).click();
  await page.getByTitle('/reports/page-summary.md').click();
  await expect(page.getByText(/这是本机工作区产物/u)).toBeVisible();
  await expect(page.getByText(/text\/markdown/u)).toBeVisible();
});

function toolCallBody(name: string, argumentsValue: Record<string, unknown>): string {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    JSON.stringify({
      id: 'chatcmpl-workspace-tool',
      object: 'chat.completion.chunk',
      created: 1_750_000_100,
      model: MODEL_ID,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(finishReason
        ? { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }
        : {}),
    });
  return [
    `data: ${chunk({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'call-workspace-create',
          type: 'function',
          function: { name, arguments: JSON.stringify(argumentsValue) },
        },
      ],
    })}`,
    `data: ${chunk({}, 'tool_calls')}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
}

function finalAnswerBody(answer: string): string {
  const chunk = (content: string, finishReason: string | null = null) =>
    JSON.stringify({
      id: 'chatcmpl-workspace-answer',
      object: 'chat.completion.chunk',
      created: 1_750_000_101,
      model: MODEL_ID,
      choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
      ...(finishReason
        ? { usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 } }
        : {}),
    });
  return [`data: ${chunk(answer)}`, `data: ${chunk('', 'stop')}`, 'data: [DONE]', ''].join('\n\n');
}
