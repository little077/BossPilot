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
npm run test:e2e:install # 首次安装扩展冒烟测试所需的 Chromium
npm run dev          # 热更新开发（自动打开带扩展的浏览器）
```

要求 Node.js ≥ 22。仓库根目录的 `.nvmrc` 可用于切换统一版本。

提交前必须通过完整门禁：

```bash
npm run verify       # Biome + 类型 + 覆盖率 + 审计 + 构建 + MV3 端到端测试
```

`npm install` 会安装 Git hooks：提交前对暂存文件执行 Biome，推送前执行完整 `quality`。

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
- Biome 是唯一的格式化、Lint 和 import 整理工具；不要额外引入 ESLint 或 Prettier。
- 提交代码前运行 `npm run check:fix`；CI 使用只读的 `npm run check:ci`，任何错误都会阻止合并。
- 跨运行时传输的数据结构一律定义在 `lib/domain/types.ts`，消息类型定义在 `lib/ipc/protocol.ts`——两处是单一事实源，不要在别处重复声明。
- 中文注释，重要模块头部写「职责说明」块注释；解释「为什么这么做」而非复述代码。
- UI 使用 Tailwind 工具类 + `assets/app.css` 中的设计令牌（`--color-brand` 等），不要硬编码颜色值。
- 所有交互按钮必须声明 `type`、可访问名称和键盘路径；表单标签必须与控件显式关联。

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

## 🧪 自动测试与覆盖率

测试栈统一为：

- Vitest：单元与组件测试运行器；
- React Testing Library + user-event：按用户可观察行为测试 React UI；
- jsdom：浏览器 DOM 模拟；
- V8 coverage：覆盖率统计；
- Playwright Chromium：加载 `.output/chrome-mv3`，验证真实扩展启动、导航与关键会话行为。

当前覆盖率硬门槛为：语句 80%、分支 75%、函数 80%、行 80%。不得通过排除新增业务文件来绕过门槛；新增核心模块时应同步加入 `vitest.config.ts` 的覆盖范围。

常用命令：

```bash
npm run test            # 一次性测试
npm run test:watch      # 开发时监听
npm run test:coverage   # 测试 + 覆盖率门槛
npm run test:e2e        # 需先构建；真实 Chromium 扩展冒烟测试
npm run quality         # CI 质量链，不含生产构建
```

适配层变更必须附脱敏 DOM fixture；缺陷修复必须先补能复现问题的回归测试。

## 🔒 依赖与供应链约束

- 质量工具和 Git hook 工具使用精确版本，避免门禁随安装时间漂移。
- `package-lock.json` 必须随依赖变更提交，CI 一律使用 `npm ci`。
- 依赖安装脚本通过 `package.json#allowScripts` 显式审核；不得使用“允许全部脚本”的逃生配置。
- Dependabot 每周检查 npm 与 GitHub Actions 更新；合并升级前必须通过 `npm run verify`。
- 高危及严重漏洞由 `npm audit --audit-level=high` 阻断合并与发版。
- 生产构建设置体积预算：单个 JavaScript 文件不超过 850 KiB，完整扩展不超过 950 KiB；超限需先拆包或说明并审议预算调整。

## 🧪 手动验证清单

自动化测试通过后，涉及扩展运行时、流水线或适配层的 PR 仍需手动验证：

- [ ] `npm run verify` 通过
- [ ] 加载 `.output/chrome-mv3/` 后侧边栏可打开，三个页签正常
- [ ] 发起一次真实搜索：解析 → 采集 → 评估 → 结果全流程跑通
- [ ] 任务执行中点「取消」能立即停止
- [ ] （如可复现）验证码暂停 → 手动通过 → 「继续」恢复正常

## 📦 发布流程（维护者）

CI 已接管质量门禁和打包发布（见 `.github/workflows/`）：每次 push 到 `main` 或 PR 都会执行 Biome、类型检查、测试覆盖率、依赖审计、生产构建和 Playwright 扩展冒烟测试；推送 `v*` 标签则在相同门禁通过后创建 GitHub Release。

1. 更新 `package.json` 版本号（遵循 semver）并提交。
2. 打 tag 并推送，剩下的交给流水线：

```bash
git tag v0.2.0
git push origin v0.2.0
```

3. 稍等几分钟，到 [Releases](https://github.com/little077/BossPilot/releases) 确认自动生成的发布与 zip 附件。
