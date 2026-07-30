import type { Request } from '@playwright/test';
import { expect, test } from './fixtures';

const BASE_URL = 'https://www.zhipin.com/bosspilot-chat-e2e/v1';
const MODEL_ID = 'boss-stream-test';
const SECRET = 'e2e-chat-secret-2468';
const USER_TEXT = '请用一句话介绍 BossPilot';
const ASSISTANT_TEXT = 'BossPilot 是你的本地隐私 AI 求职副驾。';

interface CapturedChatRequest {
  authorization?: string;
  body: {
    messages?: Array<{ role?: string; content?: unknown }>;
    model?: unknown;
    stream?: unknown;
  };
}

test('已选自定义模型完成真实扩展流式对话，并在刷新后保留历史', async ({ context, extensionId }) => {
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
      body: openAiStreamBody(),
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
  await expect(page.locator('body')).not.toContainText(SECRET);

  await page.getByRole('button', { name: '对话' }).click();
  const editor = page.locator('.composer-editor [contenteditable="true"]');
  await editor.fill(USER_TEXT);
  await page.getByRole('button', { name: '发送' }).click();

  await expect(page.locator('.redscope-user-message')).toContainText(USER_TEXT);
  await expect(page.locator('.redscope-ai-message')).toContainText(ASSISTANT_TEXT);
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0);
  await expect.poll(() => chatRequests.length).toBe(1);
  expect(chatRequests[0]).toMatchObject({
    authorization: `Bearer ${SECRET}`,
    body: {
      model: MODEL_ID,
      stream: true,
    },
  });
  expect(chatRequests[0]?.body.messages).toEqual(
    expect.arrayContaining([expect.objectContaining({ role: 'user', content: USER_TEXT })]),
  );
  await expect(page.locator('body')).not.toContainText(SECRET);

  await page.reload();
  await expect(page.locator('.redscope-user-message')).toContainText(USER_TEXT);
  await expect(page.locator('.redscope-ai-message')).toContainText(ASSISTANT_TEXT);
  await expect(page.locator('body')).not.toContainText(SECRET);
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
    `data: ${chunk('本地隐私 AI 求职副驾。')}`,
    `data: ${chunk('', 'stop')}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
