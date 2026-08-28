import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

interface BuiltManifest {
  version?: string;
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  web_accessible_resources?: unknown[];
  sandbox?: { pages?: string[] };
  content_security_policy?: { sandbox?: string };
}

interface PackageManifest {
  version: string;
}

test('正式构建只常驻内置站点权限，模型端点保持按需授权', async () => {
  const manifestPath = path.resolve('.output/chrome-mv3/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BuiltManifest;
  const packageManifest = JSON.parse(
    await readFile(path.resolve('package.json'), 'utf8'),
  ) as PackageManifest;

  expect(manifest.version).toBe(packageManifest.version);
  expect(manifest.permissions).toContain('activeTab');
  expect(manifest.permissions).toContain('offscreen');
  expect(manifest.host_permissions).toEqual([
    'https://www.zhipin.com/*',
    'https://www.xiaohongshu.com/*',
  ]);
  expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
  expect([...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])]).not.toContain(
    '<all_urls>',
  );
  expect(manifest.web_accessible_resources).toBeUndefined();
  expect(manifest.sandbox?.pages).toEqual(['skill-sandbox.html']);
  expect(manifest.content_security_policy?.sandbox).toContain("connect-src 'none'");
  expect(manifest.content_security_policy?.sandbox).not.toContain('allow-same-origin');
});
