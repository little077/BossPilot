import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

function generationChunk(id: string): string | undefined {
  const moduleId = id.replaceAll('\\', '/');
  if (
    moduleId.includes('/lib/skills/') ||
    moduleId.endsWith('/lib/tools/load-skill.ts') ||
    moduleId.includes('/lib/memory/') ||
    moduleId.endsWith('/lib/tools/memory.ts')
  ) {
    return 'agent-context';
  }
  if (
    moduleId.includes('/lib/mcp/') ||
    moduleId.includes('/@modelcontextprotocol/') ||
    moduleId.includes('/eventsource') ||
    moduleId.includes('/pkce-challenge/') ||
    moduleId.includes('/jose/')
  ) {
    return 'mcp-client';
  }
  if (
    moduleId.endsWith('/lib/tools/browser-action.ts') ||
    moduleId.endsWith('/lib/tools/page-interaction.ts') ||
    moduleId.includes('/lib/browser/')
  ) {
    return 'browser-action';
  }
  if (moduleId.includes('/lib/workspace/') || moduleId.endsWith('/lib/tools/workspace.ts')) {
    return 'workspace';
  }
  if (
    moduleId.endsWith('/lib/generation/manager.ts') ||
    moduleId.endsWith('/lib/generation/conversation-title.ts')
  ) {
    return 'generation-core';
  }
  if (!moduleId.includes('/node_modules/')) return undefined;

  if (moduleId.includes('/@earendil-works/pi-ai/')) return 'generation-pi';
  if (
    moduleId.includes('/@mistralai/mistralai/') ||
    moduleId.includes('/@opentelemetry/') ||
    moduleId.includes('/zod/') ||
    moduleId.includes('/zod-to-json-schema/')
  ) {
    return 'generation-mistral';
  }
  if (moduleId.includes('/@google/genai/')) return 'generation-google';
  if (moduleId.includes('/@anthropic-ai/sdk/')) return 'generation-anthropic';
  if (moduleId.includes('/openai/') || moduleId.includes('/partial-json/')) {
    return 'generation-openai';
  }
  return undefined;
}

// BossPilot 扩展配置。
// 权限最小化原则：通用页面读取优先使用 activeTab；长期权限只能由用户按精确 origin 授予。
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'BossPilot — 浏览器 AI 助手',
    description:
      '在浏览器侧边栏与 AI 对话，按需观察并操作当前网页、管理标签页；在 Boss 直聘提供岗位分析增强。',
    permissions: ['sidePanel', 'tabs', 'activeTab', 'scripting', 'storage', 'downloads'],
    host_permissions: ['https://www.zhipin.com/*'],
    // 模型端点在用户点「开通」时按具体 origin 申请；不把模型全网权限设为常驻权限。
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: {
      default_title: '打开 BossPilot 侧边栏',
    },
  },
  vite: () => ({
    // @tailwindcss/vite 自带的 vite 类型与 wxt 内置 vite 版本存在类型层面差异，
    // 运行时兼容，做一次类型收窄即可。
    plugins: [tailwindcss() as never],
    build: {
      chunkSizeWarningLimit: 850,
      // Vite's preload helper touches `document`, which does not exist in a
      // Manifest V3 service worker. Background generation is statically linked.
      modulePreload: false,
    },
    resolve: {
      alias: {
        'node:fs': fileURLToPath(new URL('./lib/shims/node-fs.ts', import.meta.url)),
      },
    },
  }),
  hooks: {
    'vite:build:extendConfig': (entrypoints, viteConfig) => {
      if (!entrypoints.some((entrypoint) => entrypoint.type === 'background')) return;

      viteConfig.build ??= {};
      viteConfig.build.rollupOptions ??= {};
      const output = viteConfig.build.rollupOptions.output;
      const outputs = Array.isArray(output) ? output : [output ?? {}];
      for (const item of outputs) {
        // MV3 禁止 Service Worker 运行时 import()，所以协议实现必须静态链接；
        // 这里只拆分静态 ESM chunk，控制单文件解析成本。
        item.manualChunks = generationChunk;
      }
      viteConfig.build.rollupOptions.output = Array.isArray(output) ? outputs : outputs[0];
    },
  },
});
