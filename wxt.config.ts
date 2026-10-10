import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

// BossPilot（LangChain + DeepSeek 流式对话 Demo）扩展配置。
// 权限最小化：模型调用只在 background 发生，host_permissions 收敛到 DeepSeek 端点。
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'BossPilot — LangChain × DeepSeek 流式对话',
    description: '极简 LangChain + DeepSeek 流式对话副驾。BYOK，数据全本地。',
    // alarms：MV3 后台流式保活；storage：配置与密钥存储。
    permissions: ['sidePanel', 'storage', 'alarms'],
    host_permissions: ['https://api.deepseek.com/*'],
    // 若改用其它 OpenAI 兼容端点，用户可在扩展授权后按需申请。
    optional_host_permissions: ['https://*/*'],
    action: {
      default_title: '打开 BossPilot 侧边栏',
    },
  },
  vite: () => ({
    // @tailwindcss/vite 自带的 vite 类型与 wxt 内置 vite 版本存在类型层面差异，
    // 运行时兼容，做一次类型收窄即可。
    plugins: [tailwindcss() as never],
    build: {
      // LangChain 运行时较大，放宽单文件体积告警。
      chunkSizeWarningLimit: 1024,
      // MV3 Service Worker 里没有 document，禁用 Vite 预加载 helper。
      modulePreload: false,
    },
  }),
});
