import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

// BossPilot（LangChain + DeepSeek 流式对话 Demo）扩展配置。
// 权限最小化：模型调用只在 background 发生，host_permissions 收敛到 DeepSeek 端点。
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'BossPilot — LangChain × DeepSeek 流式对话',
    description: '极简 LangChain + DeepSeek 流式对话副驾。BYOK，数据全本地。',
    // alarms：MV3 后台流式保活；storage：配置与密钥存储；
    // scripting：read_current_page 注入抽取函数；activeTab 保留为「用户把站点访问收紧到点击时」的降级选项。
    permissions: ['sidePanel', 'storage', 'alarms', 'activeTab', 'scripting'],
    // 已按用户决定放开到 <all_urls>：读取当前页不再依赖点图标授权，切标签页/页面跳转不会再报
    // page_access_denied。代价：安装时会提示「读取并更改所有网站数据」、商店审核需充分理由；
    // chrome://、扩展页、应用商店、file:// 等仍不可注入（依旧返回 unsupported_page）。
    host_permissions: ['<all_urls>'],
    // 若改用其它 OpenAI 兼容端点，用户可在扩展授权后按需申请。
    optional_host_permissions: ['https://*/*'],
    action: {
      default_title: '打开 BossPilot 侧边栏',
    },
  },
  vite: (env) => {
    // 本地调试快捷配置（侧边栏 DEV 悬浮球「一键应用」的数据源，见 .env.example）。
    // 只有 dev server 构建才读取 .env：WXT 启动时已把 .env 系列文件合并进
    // process.env，这里直接取 WXT_DEV_* 注入为构建期常量；生产构建注入 null，
    // 密钥字面量绝不进入发布包，悬浮球整块也会随 import.meta.env.DEV 被摇树移除。
    const devAccess =
      env.command === 'serve'
        ? {
            apiKey: process.env.WXT_DEV_API_KEY ?? '',
            baseUrl: process.env.WXT_DEV_BASE_URL || 'https://api.deepseek.com',
            model: process.env.WXT_DEV_MODEL || 'deepseek-flash',
          }
        : null;
    return {
      define: {
        __BOSSPILOT_DEV_ACCESS__: JSON.stringify(devAccess),
      },
      // @tailwindcss/vite 自带的 vite 类型与 wxt 内置 vite 版本存在类型层面差异，
      // 运行时兼容，做一次类型收窄即可。
      plugins: [tailwindcss() as never],
      build: {
        // LangChain 运行时较大，放宽单文件体积告警。
        chunkSizeWarningLimit: 1024,
        // MV3 Service Worker 里没有 document，禁用 Vite 预加载 helper。
        modulePreload: false,
      },
    };
  },
});
