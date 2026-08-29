# AGENTS.md — BossPilot AI 协作规约

> 本文件是 AI 编码助手（Cursor / Codex / Claude / Qoder 等）在本仓库工作的**唯一入口规约**。
> 动手写代码前必须先读完本文件。它与 [`CONTRIBUTING.md`](CONTRIBUTING.md) 一致，若有冲突以 `CONTRIBUTING.md` 为准。

## 项目定位

BossPilot 是一个以 **Chrome MV3 浏览器扩展**（WXT + React 19 + TypeScript）运行的
本地优先、可扩展浏览器 AI Agent。核心是多会话 loop agent：以流式对话为入口，通过
受约束工具、Agent Skills 和 MCP 完成页面读取、交互与内容产出。Boss 直聘岗位分析和
小红书内容调研是内置 Skill，不是产品边界。项目采用 BYOK（用户自带 Key），无项目方
服务器、无遥测；源码按非商业许可提供，商业使用需另行取得授权。

## 目录职责（改代码前先对号入座）

| 目录 / 文件 | 职责 | 红线 |
| --- | --- | --- |
| `entrypoints/background.ts` | 后台 SW：Agent 编排 + 工具目录 + Port 服务端 | 不绕过 Policy Engine |
| `entrypoints/*.content.ts` | 内容脚本，职责极小（如验证码检测上报） | 不放通用业务逻辑 |
| `entrypoints/sidepanel/` | 侧边栏 React UI（对话 / 历史 / 产物 / 设置） | 不直接访问密钥、页面或模型 |
| `entrypoints/skill-host/` | Skill 能力桥 | 只暴露已声明且获批的能力 |
| `entrypoints/skill-sandbox/` | 无扩展 API 的脚本隔离页 | 不扩大 CSP 与宿主能力 |
| `lib/domain/types.ts` | 领域实体模型 | **跨运行时数据结构的单一事实源** |
| `lib/ipc/protocol.ts` | Sidepanel ↔ Background 消息协议 | **消息类型的单一事实源** |
| `lib/agent/` | 多会话 Agent、策略、状态机与工具台账 | 工具必须从目录注册 |
| `lib/tools/` | 模型可调用的确定性工具 | 每个工具必须声明风险与边界 |
| `lib/page/`、`lib/browser/` | 页面快照、授权、语义观察、交互与标签页协调 | 不向模型暴露 selector 或任意脚本 |
| `lib/adapter/` | 已知站点 URL、选择器与结构化抽取 | **站点页面结构知识只能在对应适配器** |
| `lib/skills/` | Skill 包、渐进加载、授权与沙箱 | 脚本能力必须显式声明 |
| `lib/mcp/` | MCP 配置、发现和调用 | 外部结果按不可信数据处理 |
| `lib/memory/`、`lib/workspace/` | 本地记忆与会话私有产物 | 不跨会话泄露、不静默写入 |
| `lib/generation/`、`lib/providers/` | 多模型生成、上下文与厂商配置 | 密钥仅留在可信 Background |
| `lib/llm/`、`lib/pipeline/` | 早期 Boss 三段式流水线兼容代码 | 不作为通用主架构扩展点 |

## 架构红线（违反 = 直接拒绝合并）

1. **站点选择器必须集中**。任何与已知网站页面结构耦合的 CSS 选择器、URL 规则和字段
   抽取逻辑，只能出现在对应 `lib/adapter/*` 或该站点内置 Skill 的受审查脚本中；通用
   Agent、页面与工具模块不得散落站点知识。
2. **注入函数必须自包含**。`chrome.scripting.executeScript` 会把函数序列化后在页面上下文执行，函数体内**不能引用任何闭包变量或外部 import**，所有依赖都得通过参数传入。
3. **模型规划，执行器裁决**。模型可以选择已开放工具与组合步骤，但权限、参数、资源锁、
   副作用、验证和重试上限必须由确定性代码控制；模型不能提交 selector、任意脚本或
   伪造工具结果。
4. **高影响动作必须确认**：提交、发送、投递、发布、删除、支付、登录等操作逐次征得
   用户确认；密码、文件输入和验证码必须由用户亲自处理，不接受绕过确认的实现。
5. **隐私红线**：不引入遥测、不新增任何云端依赖。外发数据仅限用户自己配置的模型端点，且只发送必要的结构化字段。日志导出前必须经 `lib/diagnostics/redaction.ts` 脱敏。
6. **Skill 与 MCP 不能扩大系统权限**。Skill 脚本在隔离页运行，只能使用声明并获批的能力；
   MCP 返回内容不可信，未声明只读的外部调用逐次确认。
7. **权限最小化**：常驻 `host_permissions` 只覆盖内置 Skill 必需的精确站点；通用网页、
   模型与 MCP 端点按精确 origin 请求可选权限，不申请常驻 `<all_urls>`。新增权限必须在
   PR 中说明用户价值、数据流和撤销方式。
8. **兼容标识不可随品牌文案直接改名**：`bosspilot:*` 存储键、IndexedDB 名、Port 名和
   备份格式涉及既有数据。任何更名必须提供双读迁移、回滚和 E2E，不能全局替换。
9. **站点专用风控不放宽**：Boss 内置 Skill 的单次采集上限（40）、翻页上限（5）和
   节流边界不得删除；调整前先开 Issue 讨论。

## 代码规范

- **TypeScript 严格模式，禁止 `any`**（Biome 已将 `noExplicitAny` 设为 error）。确有必要时用 `unknown` + 类型收窄。
- **Biome 是唯一**的格式化、Lint 与 import 整理工具。**不要引入 ESLint 或 Prettier**。
- 跨运行时传输的数据结构定义在 `lib/domain/types.ts`，消息类型定义在 `lib/ipc/protocol.ts`——不要在别处重复声明。
- **中文注释**：重要模块头部写「职责说明」块注释；注释解释「为什么这么做」，而非复述代码在做什么。
- UI 新增或修改的组件样式统一使用 Tailwind 工具类；`assets/app.css` 只保留设计令牌、全局基础样式和无法由组件承载的跨页面规则，**不要新增组件级选择器，也不要硬编码颜色值**。
- 所有交互按钮必须声明 `type`、可访问名称与键盘路径；表单标签必须与控件显式关联（Biome a11y 会检查）。
- 新增核心模块时，**同步把文件加入 `vitest.config.ts` 的覆盖范围**并补测试，不得靠排除文件来绕过覆盖率门槛。

## 已知站点适配层维护

选择器失效是最常见的维护场景。修改 `lib/adapter/zhipin.ts`、`lib/adapter/xhs.ts` 或对应
内置 Skill 脚本时：

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
