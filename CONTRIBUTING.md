# 贡献指南

感谢你对 BossPilot 的兴趣！本文档说明参与贡献的流程与规范。

BossPilot 当前定位为本地优先、由 Skills 驱动的可扩展浏览器 AI Agent。Boss 直聘和
小红书能力属于内置 Skill；新增通用能力时不要把站点专用逻辑写入 Agent 核心。

当前源码按 [PolyForm Noncommercial License 1.0.0](LICENSE) 提供。提交贡献即表示你有权
提交相关代码，并同意其按仓库接收贡献时适用的许可提供。涉及未来商业双许可的外部代码
贡献，维护者可能要求另行签署贡献者协议。

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

要求 Node.js ≥ 22.19.0。仓库根目录的 `.nvmrc` 可用于切换统一版本。

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

1. **站点知识必须集中**。任何网站专用选择器、URL 规则和字段抽取，只能放在对应
   `lib/adapter/*` 或内置 Skill 的受审查脚本中；通用 Agent 与工具模块不得散落站点逻辑。
2. **注入函数必须自包含**。`chrome.scripting.executeScript` 会序列化函数后在页面执行，函数体内不能引用任何闭包变量或外部 import。
3. **模型规划，执行器裁决**。模型可以选择开放工具，但权限、参数、资源锁、副作用、
   验证和重试上限必须由确定性代码控制；不得让模型提交 selector 或任意脚本。
4. **高影响动作必须确认**：提交、发送、投递、发布、删除、支付、登录等操作必须逐次
   征得用户确认；密码、文件输入和验证码必须由用户亲自处理。
5. **隐私红线**：不引入遥测、不新增云端依赖；外发数据仅限用户自己配置的模型端点，且只发必要的结构化字段。
6. **Skill 与 MCP 不扩大权限**：Skill 脚本只能使用声明并获批的能力；MCP 返回内容按
   不可信数据处理，未声明只读的调用逐次确认。
7. **权限最小化**：常驻站点权限只覆盖内置 Skill 的精确来源；通用网页、模型和 MCP
   端点按精确 origin 请求可选权限，不申请常驻 `<all_urls>`。
8. **兼容标识不可直接改名**：`bosspilot:*` 存储键、IndexedDB、Port 和备份格式涉及既有
   数据，更名必须提供双读迁移与 E2E。
9. **站点风控不放宽**：Boss 内置 Skill 的单次采集上限（40）、翻页上限（5）和节流边界
   不得删除；如需调整请先开 Issue 讨论。

### 已知站点适配层维护指南

网站改版导致选择器失效是最常见的维护场景：

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

当前全局覆盖率硬门槛为：语句 95%、分支 89%、函数 95%、行 97%。
不得通过排除新增业务文件来绕过门槛；新增核心模块时必须同步加入
`vitest.config.ts` 的覆盖范围，并为失败、取消和边界路径补测试。

常用命令：

```bash
npm run test            # 一次性测试
npm run test:watch      # 开发时监听
npm run test:coverage   # 测试 + 覆盖率门槛
npm run test:e2e        # 需先构建；真实 Chromium 扩展冒烟测试
npm run quality         # CI 质量链，不含生产构建
npm run mv3:check       # Background 静态模块闭包与 runtime import() 门禁
npm run bundle:check    # MV3 安全检查 + 构建体积预算
```

适配层变更必须附脱敏 DOM fixture；缺陷修复必须先补能复现问题的回归测试。

## 🔒 依赖与供应链约束

- 质量工具和 Git hook 工具使用精确版本，避免门禁随安装时间漂移。
- `package-lock.json` 必须随依赖变更提交，CI 一律使用 `npm ci`。
- 依赖安装脚本通过 `package.json#allowScripts` 显式审核；不得使用“允许全部脚本”的逃生配置。
- Dependabot 每周检查 npm 与 GitHub Actions 更新；合并升级前必须通过 `npm run verify`。
- 高危及严重漏洞由 `npm audit --audit-level=high` 阻断合并与发版。
- 生产构建设置分层体积预算：Background 入口不超过 100 KiB，任一 JavaScript
  chunk 不超过 850 KiB，完整扩展未压缩不超过 3 MiB、压缩估算不超过 950 KiB。
  多模型 SDK 必须在构建期拆成静态 ESM chunk，并通过零运行时 `import()` 门禁；
  超限需先拆包或说明并审议预算调整。

## 🧪 手动验证清单

自动化测试通过后，涉及扩展运行时、流水线或适配层的 PR 仍需手动验证：

- [ ] `npm run verify` 通过
- [ ] 加载 `.output/chrome-mv3/` 后侧边栏可打开，对话 / 历史 / 产物 / 设置正常
- [ ] 发起一次普通页面读取并核对授权、工具活动和结果来源
- [ ] 使用一个内置 Skill 完成其最小工作流
- [ ] 任务执行中点「取消」能立即停止
- [ ] 高影响操作在执行前暂停并显示确认卡片
- [ ] （涉及 Boss Skill 时）验证码暂停 → 手动通过 → 「继续」恢复正常

## 📦 发布流程（维护者）

CI 已接管质量门禁和打包发布（见 `.github/workflows/`）：每次 push 到 `main` 或 PR 都会执行 Biome、类型检查、测试覆盖率、依赖审计、生产构建和 Playwright 扩展冒烟测试；推送 `v*` 标签则在相同门禁通过后创建 GitHub Release。

1. 更新 `package.json` 版本号（遵循 semver）并提交。
2. 打 tag 并推送，剩下的交给流水线：

```bash
git tag v0.2.0
git push origin v0.2.0
```

3. 稍等几分钟，到 [Releases](https://github.com/little077/BossPilot/releases) 确认自动生成的发布与 zip 附件。
