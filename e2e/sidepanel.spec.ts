import { expect, test } from './fixtures';

test('侧边栏可在真实扩展环境启动，并提供新的顶部会话入口', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await expect(page.getByRole('button', { name: '对话' })).toBeVisible();
  await expect(page.getByRole('button', { name: '结果' })).toBeVisible();
  await expect(page.getByRole('button', { name: '设置' })).toBeVisible();
  await expect(page.getByRole('button', { name: '报告' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新对话' })).toHaveCount(0);

  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('bosspilot');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('messages', 'readwrite');
        transaction.objectStore('messages').put({
          id: 'e2e-existing-message',
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
    .toBe(0);
});
