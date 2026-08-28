# AGENTS.md — BossPilot AI 协作规约

> 本文件是 AI 编码助手（Cursor / Codex / Claude / Qoder 等）在本仓库工作的**唯一入口规约**。
> 动手写代码前必须先读完本文件。它与 [`CONTRIBUTING.md`](CONTRIBUTING.md) 一致，若有冲突以 `CONTRIBUTING.md` 为准。

## 项目定位

BossPilot 是一个类 Cebian 的 AI 求职副驾，以 **Chrome MV3 浏览器扩展**（WXT + React 19 + TypeScript）形式深度适配 Boss 直聘网站，面向求职者。核心是一个 loop agent：以流式对话为主入口，底层能力封装为 AI 可调用的确定性领域工具。BYOK（用户自带 Key）、本地优先、无任何项目方服务器。

## 目录职责（改代码前先对号入座）

| 目录 / 文件 | 职责 | 红线 |
| --- | --- | --- |
| `entrypoints/background.ts` | 后台 SW：Port 服务端 + 编排调度 | — |
| `entrypoints/*.content.ts` | 内容脚本，职责极小（如验证码检测上报） | 不放业务逻辑 |
| `entrypoints/sidepanel/` | 侧边栏 React UI（对话 / 结果 / 设置） | — |
| `lib/domain/types.ts` | 领域实体模型 | **跨运行时数据结构的单一事实源** |
| `lib/ipc/protocol.ts` | Sidepanel ↔ Background 消息协议 | **消息类型的单一事实源** |
| `lib/adapter/zhipin.ts` | 站点适配层：URL 规则 + 选择器 + 抽取函数 | **所有页面结构知识只能在这里** |
| `lib/llm/` | OpenAI 兼容客户端 + 三段式 Prompt | 只做语义 |
| `lib/pipeline/` | 编排器（三段式流水线）+ 拟人化节流 | 确定性代码 |
| `lib/storage/` | BYOK 配置与用户档案（chrome.storage.local） | — |

## 架构红线（违反 = 直接拒绝合并）

1. **选择器只能出现在适配层**（`lib/adapter/zhipin.ts`）。任何与 zhipin.com 页面结构耦合的知识（CSS 选择器 / URL 规则 / 字段抽取逻辑）都必须集中于此，其他任何文件里出现选择器都算违规。
2. **注入函数必须自包含**。`chrome.scripting.executeScript` 会把函数序列化后在页面上下文执行，函数体内**不能引用任何闭包变量或外部 import**，所有依赖都得通过参数传入。
3. **LLM 只做语义，不做流程决策**。意图解析 / 软条件判断 / 匹配打分 / 文案生成是 LLM 的职责；搜索、翻页、抽取、跳转等**流程控制必须是确定性代码**，不得交给模型决定。
4. **合规红线**：不接受任何「全自动投递 / 自动打招呼 / 自动发消息」相关代码。发消息类功能最多做到「AI 生成内容 + 预填输入框，由人工点击发送」。
5. **隐私红线**：不引入遥测、不新增任何云端依赖。外发数据仅限用户自己配置的模型端点，且只发送必要的结构化字段。日志导出前必须经 `lib/diagnostics/redaction.ts` 脱敏。
6. **风控参数不放宽**：单次采集上限（40）、翻页上限（5）、拟人化节流延迟区间**不得调低或删除**。如需调整，先开 Issue 讨论，不要在代码里擅自改。
7. **权限最小化**：`host_permissions` 只收敛到 `https://www.zhipin.com/*`，不申请 `<all_urls>`；新增权限需在 PR 说明理由。

## 代码规范

- **TypeScript 严格模式，禁止 `any`**（Biome 已将 `noExplicitAny` 设为 error）。确有必要时用 `unknown` + 类型收窄。
- **Biome 是唯一**的格式化、Lint 与 import 整理工具。**不要引入 ESLint 或 Prettier**。
- 跨运行时传输的数据结构定义在 `lib/domain/types.ts`，消息类型定义在 `lib/ipc/protocol.ts`——不要在别处重复声明。
- **中文注释**：重要模块头部写「职责说明」块注释；注释解释「为什么这么做」，而非复述代码在做什么。
- UI 新增或修改的组件样式统一使用 Tailwind 工具类；`assets/app.css` 只保留设计令牌、全局基础样式和无法由组件承载的跨页面规则，**不要新增组件级选择器，也不要硬编码颜色值**。
- 所有交互按钮必须声明 `type`、可访问名称与键盘路径；表单标签必须与控件显式关联（Biome a11y 会检查）。
- 新增核心模块时，**同步把文件加入 `vitest.config.ts` 的覆盖范围**并补测试，不得靠排除文件来绕过覆盖率门槛。

## 适配层维护（Boss 直聘改版时）

选择器失效是最常见的维护场景，改 `lib/adapter/zhipin.ts` 时：

1. 在文件顶部注释记录新的「选择器契约」观察日期。
2. 采用**多候选选择器**策略：新选择器加入候选数组，保留旧的做兜底，不要直接替换。
3. 契约发生不兼容变更时递增 `ADAPTER_VERSION`。
4. 在 PR 中附上脱敏后的页面 DOM 片段，说明验证方式。

## 提交前必做的验证命令

```bash
npm run check:fix    # Biome 自动格式化 + 修复 lint + 整理 import（写代码后先跑这个）
npm run verify       # 完整质量门禁：Biome + 类型检查 + 覆盖率测试 + 安全审计 + 构建 + MV3 端到端
```

- 提交代码前至少跑通 `npm run check:fix`；`npm run verify` 是 CI 与推送前的完整门禁，任何错误都会阻止合并。
- Git hooks 已接线：`pre-commit` 对暂存文件跑 Biome，`commit-msg` 校验提交信息，`pre-push` 跑完整 `quality`。

## 提交信息规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，由 commitlint 在 `commit-msg` hook 强制校验：

```
feat(adapter): 支持新版职位卡片选择器
fix(pipeline): 修复取消任务后验证码门未释放
docs(readme): 补充 Ollama 配置示例
```

- 从 `main` 切出分支：`feat/xxx`、`fix/xxx`、`docs/xxx`。
- 一个 PR 只做一件事，附上改动说明与验证方式。
- **不要提交** API Key、账号信息、页面原文或其他敏感数据。
