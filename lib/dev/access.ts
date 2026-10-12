// ─── 本地调试访问配置（仅 DEV 使用） ───
// 「悬浮球一键应用」的数据源：读取 wxt.config.ts 在构建期注入的常量。
// dev server 注入从 .env（WXT_DEV_*）解析出的 { apiKey, baseUrl, model }；
// 生产构建注入 null，因此密钥字面量不会进入发布包。

/** .env 提供的调试模型配置。 */
export interface DevAccess {
  apiKey: string;
  baseUrl: string;
  model: string;
}

// 构建期注入：dev 为对象，生产为 null。模块内声明即可，无需全局类型。
declare const __BOSSPILOT_DEV_ACCESS__: DevAccess | null;

/** 读取调试访问配置；未注入（如单测环境）或生产构建时返回 null。 */
export function getDevAccess(): DevAccess | null {
  if (typeof __BOSSPILOT_DEV_ACCESS__ === 'undefined') return null;
  return __BOSSPILOT_DEV_ACCESS__;
}
