# 贡献指南

感谢你对 BossPilot 的兴趣！本文档说明参与贡献的流程与规范。

## 📋 开始之前

- 提交代码前请先搜索现有 [Issues](https://github.com/little077/BossPilot/issues)，避免重复工作。
- 较大的功能改动请**先开 Issue 讨论方案**，达成一致后再动手，避免白费力气。
- 所有参与者需遵守[社区行为准则](CODE_OF_CONDUCT.md)。

## 🛠 开发环境

```bash
git clone https://github.com/little077/BossPilot.git
cd BossPilot
npm install          # 会自动执行 wxt prepare 生成类型
npm run dev          # 热更新开发（自动打开带扩展的浏览器）
```

提交前必须通过：

```bash
npm run compile      # TypeScript 类型检查（零错误）
npm run build        # 生产构建成功
```

## 🌿 分支与提交

- 从 `main` 切出分支：`feat/xxx`、`fix/xxx`、`docs/xxx`。
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
feat(adapter): 支持新版职位卡片选择器
fix(pipeline): 修复取消任务后验证码门未释放
docs(readme): 补充 Ollama 配置示例
```

- 一个 PR 只做一件事；附上改动说明与验证方式（截图/复现步骤）。

## 📐 代码规范

### 通用

- TypeScript 严格模式，**禁止 `any`**（确有必要时用 `unknown` + 类型收窄）。
- 跨运行时传输的数据结构一律定义在 `lib/domain/types.ts`，消息类型定义在 `lib/ipc/protocol.ts`——两处是单一事实源，不要在别处重复声明。
- 中文注释，重要模块头部写「职责说明」块注释；解释「为什么这么做」而非复述代码。
- UI 使用 Tailwind 工具类 + `assets/app.css` 中的设计令牌（`--color-brand` 等），不要硬编码颜色值。

### 架构约束（重要）

这些约束是项目的核心设计，PR 违反将不被合并：

1. **选择器只能出现在适配层**（`lib/adapter/zhipin.ts`）。任何与 zhipin.com 页面结构耦合的知识（选择器 / URL 规则 / 字段抽取）都必须集中于此。
2. **注入函数必须自包含**。`chrome.scripting.executeScript` 会序列化函数后在页面执行，函数体内不能引用任何闭包变量或外部 import。
3. **LLM 只做语义，不做流程决策**。意图解析 / 软条件判断 / 打分 / 文案是 LLM 的职责；搜索、翻页、抽取必须是确定性代码。
4. **合规红线**：不接受任何「全自动投递 / 自动打招呼 / 自动发消息」相关 PR；发消息类功能最多做到「AI 生成 + 预填输入框，人工点击发送」。
5. **隐私红线**：不引入遥测、不新增云端依赖；外发数据仅限用户自己配置的模型端点，且只发必要的结构化字段。
6. **风控参数不放宽**：单次采集上限（40）、翻页上限（5）、节流延迟区间不得调低；如需调整请先开 Issue 讨论。

### 适配层维护指南

Boss 直聘改版导致选择器失效是最常见的维护场景：

1. 在 `lib/adapter/zhipin.ts` 顶部注释中记录新的「选择器契约」观察日期。
2. 采用**多候选选择器**策略：新选择器加入候选数组，保留旧的做兜底。
3. 契约不兼容变更时递增 `ADAPTER_VERSION`。
4. 在 PR 中附上页面 DOM 片段截图（脱敏），说明验证方式。

## 🧪 手动验证清单

目前项目没有自动化测试（欢迎贡献！）。涉及流水线/适配层的 PR，请手动验证：

- [ ] `npm run compile` 与 `npm run build` 通过
- [ ] 加载 `.output/chrome-mv3/` 后侧边栏可打开、四个页签正常
- [ ] 发起一次真实搜索：解析 → 采集 → 评估 → 报告全流程跑通
- [ ] 任务执行中点「取消」能立即停止
- [ ] （如可复现）验证码暂停 → 手动通过 → 「继续」恢复正常

## 📦 发布流程（维护者）

CI 已接管打包发布（见 `.github/workflows/`）：每次 push 到 `main` 会自动做类型检查、构建并把 zip 存为 Actions Artifact；推送 `v*` 标签则自动创建 GitHub Release 并附上安装包。

1. 更新 `package.json` 版本号（遵循 semver）并提交。
2. 打 tag 并推送，剩下的交给流水线：

```bash
git tag v0.2.0
git push origin v0.2.0
```

3. 稍等几分钟，到 [Releases](https://github.com/little077/BossPilot/releases) 确认自动生成的发布与 zip 附件。
