import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

interface BuiltManifest {
  version?: string;
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  web_accessible_resources?: unknown[];
}

test('正式构建只常驻 Boss 直聘权限，模型端点保持按需授权', async () => {
  const manifestPath = path.resolve('.output/chrome-mv3/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BuiltManifest;

  expect(manifest.version).toBe('0.11.0');
  expect(manifest.permissions).toContain('activeTab');
  expect(manifest.host_permissions).toEqual(['https://www.zhipin.com/*']);
  expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
  expect([...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])]).not.toContain(
    '<all_urls>',
  );
  expect(manifest.web_accessible_resources).toBeUndefined();
});
