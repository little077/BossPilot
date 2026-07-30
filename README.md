<div align="center">

# 🧭 BossPilot

**面向 Boss 直聘的定制化 AI 求职副驾 · 浏览器侧边栏扩展**

选择自己的模型，在侧边栏流式对话；也可以用一句话发起岗位搜索、批量采集、
语义过滤和匹配打分。

BYOK（自带模型 Key）· 数据全本地 · 不自动投递 · MIT 开源

[![Build](https://github.com/little077/BossPilot/actions/workflows/build.yml/badge.svg)](https://github.com/little077/BossPilot/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/little077/BossPilot?label=Release&color=00a98f)](https://github.com/little077/BossPilot/releases/latest)

[快速开始](#-快速开始) · [功能特性](#-功能特性) · [架构文档](docs/ARCHITECTURE.md) · [多模型二期报告](docs/multi-model-phase-2-report.md) · [参与贡献](CONTRIBUTING.md)

</div>

---

## ✨ 功能特性

- **真实多模型流式聊天** — 配置并选中模型后，普通聊天会固定使用该模型，
  支持流式回复、停止生成、错误现场保留、会话持久化和侧边栏断线恢复。
- **多厂商 BYOK** — 提供 27 个厂商、本地或自定义端点入口，覆盖 OpenAI、
  Anthropic、Gemini、Mistral 与 OpenAI-compatible 模型协议。
- **自然语言发起任务** — 「帮我找西安的前端岗位，15K 以上，排除外包和驻场」，AI 解析为结构化搜索参数，确认后执行。
- **确定性批量采集** — 站点适配层直接结构化抽取列表页/详情页，秒级采集数十条岗位，不靠 LLM 逐步猜页面，快且省 token。
- **语义软条件过滤** — 「排除外包」「要求双休」这类原生筛选器表达不了的条件，交给 LLM 阅读 JD 全文批量判断。
- **匹配度打分** — 在设置页维护你的简历档案，每个岗位输出 0-100 匹配分 + 亮点 + 风险点。
- **结构化结果页** — 推荐排序、岗位亮点、风险点和排除原因集中展示，支持直接打开原岗位。
- **人机协同风控** — 拟人化节流、遇验证码自动暂停等待手动通过、单次采集量硬上限（40 条）。
- **本地优先隐私** — API Key 与档案仅存本机 `chrome.storage`；只把结构化岗位字段发给**你自己配置的**模型端点；无遥测、无云端。

## 🚀 快速开始

### 环境要求

- Node.js ≥ 22.19.0
- Chrome / Edge 等 Chromium 内核浏览器（支持 MV3 侧边栏）
- 一个受支持厂商的 API Key，或本地 Ollama / 自定义 OpenAI-compatible 端点

### 方式一：直接下载（推荐）

从 [Releases](https://github.com/little077/BossPilot/releases/latest) 下载最新的 `bosspilot-*-chrome.zip` 并解压，然后跳到下方「加载扩展」（选择解压后的文件夹即可）。

### 方式二：从源码构建

```bash
git clone https://github.com/little077/BossPilot.git
cd BossPilot
npm install
npm run build        # 产物在 .output/chrome-mv3/
```

### 加载扩展

1. 打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 点「加载已解压的扩展程序」，选择 `.output/chrome-mv3/` 目录。
3. 点击工具栏中的 BossPilot 图标打开侧边栏。

### 首次配置

1. 进入侧边栏「设置」，从「发卡台」领取一个模型厂商。
2. 填写 API Key 后开通；BossPilot 会读取厂商模型目录，再由你明确选择当前模型。
3. 回到「对话」即可流式聊天。停止或失败时已生成内容会保留。
4. 若要执行岗位搜索任务，请先在浏览器登录
   [Boss 直聘](https://www.zhipin.com)；扩展复用现有登录态，不采集账号密码。

### 开发模式

```bash
npm run dev          # WXT 热更新开发
npm run compile      # TypeScript 类型检查
npm run test         # Vitest 单元与组件测试
npm run test:e2e:install # 首次安装 Playwright Chromium
npm run test:e2e     # 在真实 MV3 扩展环境运行冒烟测试
npm run quality      # Biome + 类型 + 覆盖率 + 依赖审计
npm run mv3:check    # 检查 Background 静态模块闭包，不允许运行时 import()
npm run bundle:check # MV3 安全检查 + Background/chunk/总体积预算
npm run verify       # 完整质量门禁 + 生产构建 + 扩展端到端测试
npm run zip          # 打包发布 zip
```

## 🧠 工作原理

区别于「通用 Agent 每一步都让 LLM 读全页、猜选择器」的模式，BossPilot 采用**三段式流水线**：

```
① 意图解析（1 次 LLM）      自然语言 → 结构化任务参数（硬条件 + 软条件）
② 确定性采集（0 次 LLM）    站点适配层执行搜索/翻页/详情抓取 → 结构化岗位数组
③ 批量语义评估（1~N 次 LLM）软条件过滤 + 匹配打分 → 结构化结果
```

页面结构知识全部集中在[站点适配层](lib/adapter/zhipin.ts)（单一事实源），站点改版只需修一处。详见[架构文档](docs/ARCHITECTURE.md)。

## 📁 项目结构

```
├─ entrypoints/            # WXT 入口
│  ├─ background.ts        #   模块化后台 SW：流式生成 + Port + 编排
│  ├─ zhipin.content.ts    #   内容脚本：验证码检测上报（职责极小）
│  └─ sidepanel/           #   侧边栏 React UI（对话/结果/设置）
├─ lib/
│  ├─ domain/              # 聊天、Provider 与任务实体
│  ├─ ipc/protocol.ts      # Sidepanel ↔ Background 消息协议
│  ├─ adapter/             # 站点适配层：URL 规则 + 选择器 + 抽取函数
│  ├─ generation/          # 活动模型解析、统一适配、会话状态机与错误
│  ├─ providers/           # 厂商注册表、目录、权限、存储与配置状态机
│  ├─ llm/                 # 旧任务流水线客户端 + 三段式 Prompt
│  ├─ pipeline/            # 编排器（三段式流水线）+ 拟人化节流
│  └─ storage/             # BYOK 配置与用户档案（chrome.storage.local）
├─ assets/app.css          # Tailwind v4 + 设计令牌
├─ tests/                  # Vitest 全局测试环境
├─ e2e/                    # Playwright 真实 MV3 扩展冒烟测试
├─ biome.json              # 格式、Lint、无障碍与 import 规范
├─ vitest.config.ts        # 测试环境与覆盖率硬门槛
├─ playwright.config.ts    # 扩展端到端测试配置
└─ docs/                   # 架构 / 适配层契约 / 消息协议文档
```

## 🔐 隐私与合规

- **不做全自动投递、不自动打招呼、不自动发消息** —— 这是本项目的合规红线。
- 常驻 `host_permissions` 仅 `https://www.zhipin.com/*`；模型端点只在用户点击
  「开通」时按具体 origin 申请可选权限。
- 数据仅在本机与**你自己配置的**模型端点之间流动，项目方没有任何服务器。
- API Key 不进入 UI 快照、诊断和导出；本地存储被限制为可信扩展上下文。
- 内建拟人化节流与单次采集上限。请合理控制使用频率，遵守目标网站的用户协议；因过度使用导致的账号风控由使用者自行承担。
- 本项目仅供个人求职效率场景的学习与研究使用。

## 🗺️ 路线图

- [x] v0.1：任务流水线与多模型配置基座
- [x] v0.2：真实多协议流式聊天、停止、错误与断线恢复
- [ ] v0.3：求职者档案、上下文个性化与任务流水线迁移
- [ ] v0.4：岗位工作台与结果沉淀
- [ ] v0.5：Agent 工具循环与智能化
- [ ] v0.6：求职 Skills 与提示词模板
- [ ] v0.7：求职记忆与长期陪跑
- [ ] v1.0：隐私、诊断、测试、迁移与 Chrome Web Store 发布

OAuth Provider 不在 v0.2 范围内，将作为独立安全里程碑评审。完整范围与验收标准见
[产品路线图](docs/ROADMAP.md)。

## 🤝 参与贡献

欢迎 Issue 与 PR！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)（代码规范、分支流程、适配层维护指南）与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 📄 许可证

[MIT](LICENSE) © BossPilot Contributors

> 本项目为独立的全新实现，架构思路受社区通用浏览器 Agent 项目启发，未复制任何第三方源码。
