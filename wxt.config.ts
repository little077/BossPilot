import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// BossPilot 扩展配置。
// 权限最小化原则：host_permissions 只收敛到 Boss 直聘域名，不申请 <all_urls>。
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'BossPilot — Boss直聘 AI 求职副驾',
    description:
      '在侧边栏用自然语言搜索岗位、批量采集 JD、语义过滤（排除外包等）、匹配度打分并生成 Markdown 报告。BYOK，数据全本地。',
    permissions: ['sidePanel', 'tabs', 'scripting', 'storage', 'downloads'],
    host_permissions: ['https://www.zhipin.com/*'],
    action: {
      default_title: '打开 BossPilot 侧边栏',
    },
  },
  vite: () => ({
    // @tailwindcss/vite 自带的 vite 类型与 wxt 内置 vite 版本存在类型层面差异，
    // 运行时兼容，做一次类型收窄即可。
    plugins: [tailwindcss() as never],
  }),
});
