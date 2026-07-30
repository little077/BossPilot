import { expect, test } from './fixtures';

test('可在真实扩展中读取自定义端点目录、选择模型并持久化', async ({ context, extensionId }) => {
  let directoryRequests = 0;
  await context.route('https://www.zhipin.com/bosspilot-e2e/v1/models', async (route) => {
    directoryRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          { id: 'boss-test-chat', name: 'Boss Test Chat' },
          { id: 'boss-test-reasoner', name: 'Boss Test Reasoner' },
        ],
      }),
    });
  });

  // 使用正式构建已经拥有的 Boss 直聘权限承载 mock 路由，避免测试环境绕过或
  // 自动接受 optional permission；生产 Manifest 的模型权限边界由 manifest.spec 单独断言。
  const baseUrl = 'https://www.zhipin.com/bosspilot-e2e/v1';
  const secret = 'e2e-local-secret-9876';
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: '我的模型卡包' })).toBeVisible();
  await page.getByRole('button', { name: /显示更多/ }).click();
  await page.getByRole('button', { name: /自定义端点/ }).click();

  const card = page.getByRole('article', { name: '自定义端点 模型配置' });
  await card.getByLabel('Base URL（OpenAI 兼容端点）').fill(baseUrl);
  await card.getByLabel('API Key（仅存本机）').fill(secret);
  await card.getByRole('button', { name: '开通' }).click();

  const model = card.getByRole('button', { name: 'Boss Test Chat' });
  await expect(model).toBeVisible();
  expect(directoryRequests).toBe(1);
  await expect(card.getByLabel('API Key（仅存本机）')).toHaveValue('');
  await expect(page.locator('body')).not.toContainText(secret);

  await model.click();
  await expect(model).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByText('使用中 ✦')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: '设置' }).click();
  const restoredCard = page.getByRole('article', {
    name: '自定义端点 模型配置',
  });
  await expect(restoredCard.getByText('当前模型：boss-test-chat')).toBeVisible();
  await expect(restoredCard.getByLabel('API Key（仅存本机）')).toHaveValue('');
  await expect(restoredCard.getByLabel('API Key（仅存本机）')).toHaveAttribute(
    'placeholder',
    /9876/,
  );
  await expect(page.locator('body')).not.toContainText(secret);
});
