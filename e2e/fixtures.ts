import path from 'node:path';
import { type BrowserContext, test as base, chromium } from '@playwright/test';

const extensionPath = path.resolve('.output/chrome-mv3');

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture 回调要求对象解构参数。
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });

    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    const [serviceWorker] = context.serviceWorkers();
    if (serviceWorker) {
      await use(new URL(serviceWorker.url()).host);
      return;
    }

    /*
     * 体积较大的 MV3 Background 可能保持休眠，不能把 serviceworker 事件当作
     * 获取扩展 ID 的前置条件。扩展管理页能稳定给出当前唯一加载的待测扩展。
     */
    const extensionsPage = await context.newPage();
    await extensionsPage.goto('chrome://extensions/');
    const extension = extensionsPage.locator('extensions-item').first();
    await extension.waitFor({ state: 'attached' });
    const extensionId = await extension.getAttribute('id');
    await extensionsPage.close();
    if (!extensionId) throw new Error('无法从 chrome://extensions 读取 BossPilot 扩展 ID。');
    await use(extensionId);
  },
});

export { expect } from '@playwright/test';
