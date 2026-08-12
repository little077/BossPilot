import { expect, test } from './fixtures';

test('侧边栏可启动，并在新建对话后保留本地历史', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await expect(page.getByRole('button', { name: '对话' })).toBeVisible();
  await expect(page.getByRole('button', { name: '历史记录' })).toBeVisible();
  await expect(page.getByRole('button', { name: '设置' })).toBeVisible();
  await expect(page.getByRole('button', { name: '报告' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新对话' })).toHaveCount(0);

  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('bosspilot');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(['conversations', 'messages'], 'readwrite');
        transaction.objectStore('conversations').put({
          id: 'e2e-conversation',
          ordinal: 1,
          title: 'E2E 历史记录',
          titleSource: 'user',
          createdAt: 1,
          updatedAt: 1,
          lastMessagePreview: '用于验证新对话入口',
          messageCount: 1,
          unread: false,
        });
        transaction.objectStore('messages').put({
          id: 'e2e-existing-message',
          conversationId: 'e2e-conversation',
          role: 'user',
          content: '用于验证新对话入口',
          createdAt: 1,
        });
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });

  await page.reload();
  const newChat = page.locator('header').getByRole('button', { name: '新对话' });
  await expect(newChat).toBeVisible();
  await newChat.click();

  await expect(page.getByRole('heading', { name: /聊两句/ })).toBeVisible();
  await expect(newChat).toHaveCount(0);
  await page.getByRole('button', { name: '历史记录' }).click();
  const restoreHistory = page.getByRole('button', { name: '恢复会话：E2E 历史记录' });
  await expect(restoreHistory).toBeVisible();
  await restoreHistory.click();
  await expect(page.locator('.redscope-user-message')).toContainText('用于验证新对话入口');
  await expect(page.locator('.redscope-dock')).toBeVisible();
  await expect(page.getByText('历史会话')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const request = indexedDB.open('bosspilot');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const database = request.result;
              const transaction = database.transaction('messages', 'readonly');
              const countRequest = transaction.objectStore('messages').count();
              countRequest.onsuccess = () => {
                database.close();
                resolve(countRequest.result);
              };
              countRequest.onerror = () => reject(countRequest.error);
            };
          }),
      ),
    )
    .toBe(1);
});

test('设置页可以运行本地 Agent 自检并提供安全备份入口', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: '设置' }).click();

  await expect(page.getByRole('region', { name: 'Agent 运行自检' })).toBeVisible();
  await expect(page.getByRole('region', { name: '数据备份与恢复' })).toBeVisible();
  await expect(page.getByRole('button', { name: '导出备份' })).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复备份' })).toBeVisible();

  await page.getByRole('button', { name: '运行自检' }).click();
  await expect(page.getByText('默认模型')).toBeVisible();
  await expect(page.getByText(/未发现常驻的全站网页权限/)).toBeVisible();
});
