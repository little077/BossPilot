<div align="center">

# 🧭 BossPilot

**面向 Boss 直聘的定制化 AI 求职副驾 · 浏览器侧边栏扩展**

用一句话描述你要找的岗位，AI 自动搜索、批量采集、语义过滤、匹配打分，并生成可下载的 Markdown 报告。

BYOK（自带模型 Key）· 数据全本地 · 不自动投递 · MIT 开源

[![Build](https://github.com/little077/BossPilot/actions/workflows/build.yml/badge.svg)](https://github.com/little077/BossPilot/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/little077/BossPilot?label=Release&color=00a98f)](https://github.com/little077/BossPilot/releases/latest)

[快速开始](#-快速开始) · [功能特性](#-功能特性) · [工作原理](#-工作原理) · [架构文档](docs/ARCHITECTURE.md) · [参与贡献](CONTRIBUTING.md)

</div>

---

## ✨ 功能特性

- **自然语言发起任务** — 「帮我找西安的前端岗位，15K 以上，排除外包和驻场」，AI 解析为结构化搜索参数，确认后执行。
- **确定性批量采集** — 站点适配层直接结构化抽取列表页/详情页，秒级采集数十条岗位，不靠 LLM 逐步猜页面，快且省 token。
- **语义软条件过滤** — 「排除外包」「要求双休」这类原生筛选器表达不了的条件，交给 LLM 阅读 JD 全文批量判断。
- **匹配度打分** — 在设置页维护你的简历档案，每个岗位输出 0-100 匹配分 + 亮点 + 风险点。
- **Markdown 报告** — 概览、推荐排序表、重点岗位详情、排除清单一键下载，结果可沉淀。
- **人机协同风控** — 拟人化节流、遇验证码自动暂停等待手动通过、单次采集量硬上限（40 条）。
- **本地优先隐私** — API Key 与档案仅存本机 `chrome.storage`；只把结构化岗位字段发给**你自己配置的**模型端点；无遥测、无云端。

## 🚀 快速开始

### 环境要求

- Node.js ≥ 18
- Chrome / Edge 等 Chromium 内核浏览器（支持 MV3 侧边栏）
- 一个 OpenAI 兼容的大模型 API Key（DeepSeek / OpenAI / Kimi / 智谱 / 本地 Ollama 等均可）

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

1. 进入侧边栏「设置」页，填入模型 **Base URL**（如 `https://api.deepseek.com/v1`）、**API Key** 与**模型名**。
2. （推荐）填写「简历要点」和「长期偏好」，匹配打分会显著更准。
3. 在浏览器中登录 [Boss 直聘](https://www.zhipin.com)（扩展复用你的登录态，不采集账号密码）。
4. 回到「对话」页，输入需求 → 确认任务卡片 → 等待报告。

### 开发模式

```bash
npm run dev          # WXT 热更新开发
npm run compile      # TypeScript 类型检查
npm run zip          # 打包发布 zip
```

## 🧠 工作原理

区别于「通用 Agent 每一步都让 LLM 读全页、猜选择器」的模式，BossPilot 采用**三段式流水线**：

```
① 意图解析（1 次 LLM）      自然语言 → 结构化任务参数（硬条件 + 软条件）
② 确定性采集（0 次 LLM）    站点适配层执行搜索/翻页/详情抓取 → 结构化岗位数组
③ 批量语义评估（1~2 次 LLM）软条件过滤 + 匹配打分 + 报告总评
```

页面结构知识全部集中在[站点适配层](lib/adapter/zhipin.ts)（单一事实源），站点改版只需修一处。详见[架构文档](docs/ARCHITECTURE.md)。

## 📁 项目结构

```
├─ entrypoints/            # WXT 入口
│  ├─ background.ts        #   后台 SW：Port 服务端 + 编排调度
│  ├─ zhipin.content.ts    #   内容脚本：验证码检测上报（职责极小）
│  └─ sidepanel/           #   侧边栏 React UI（对话/结果/报告/设置）
├─ lib/
│  ├─ domain/types.ts      # 领域实体模型（单一事实源）
│  ├─ ipc/protocol.ts      # Sidepanel ↔ Background 消息协议
│  ├─ adapter/             # 站点适配层：URL 规则 + 选择器 + 抽取函数
│  ├─ llm/                 # OpenAI 兼容客户端 + 三段式 Prompt
│  ├─ pipeline/            # 编排器（三段式流水线）+ 拟人化节流
│  ├─ report/              # Markdown 报告生成
│  └─ storage/             # BYOK 配置与用户档案（chrome.storage.local）
├─ assets/app.css          # Tailwind v4 + 设计令牌
└─ docs/                   # 架构 / 适配层契约 / 消息协议文档
```

## 🔐 隐私与合规

- **不做全自动投递、不自动打招呼、不自动发消息** —— 这是本项目的合规红线。
- 扩展权限最小化：`host_permissions` 仅 `https://www.zhipin.com/*`，不申请 `<all_urls>`。
- 数据仅在本机与**你自己配置的**模型端点之间流动，项目方没有任何服务器。
- 内建拟人化节流与单次采集上限。请合理控制使用频率，遵守目标网站的用户协议；因过度使用导致的账号风控由使用者自行承担。
- 本项目仅供个人求职效率场景的学习与研究使用。

## 🗺️ 路线图

- [x] MVP：三段式流水线 / 语义过滤 / 匹配打分 / Markdown 报告 / 验证码人机协同
- [ ] 结果台账（本地去重、已看/已投状态跟踪）
- [ ] 个性化打招呼文案生成（预填输入框，人工发送）
- [ ] 一键任务卡片（Slash 模板）与自定义 Prompt
- [ ] 适配层启动自检与改版提示
- [ ] 招聘者端（筛候选人）、Firefox 兼容、CSV 导出

## 🤝 参与贡献

欢迎 Issue 与 PR！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)（代码规范、分支流程、适配层维护指南）与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 📄 许可证

[MIT](LICENSE) © BossPilot Contributors

> 本项目为独立的全新实现，架构思路受社区通用浏览器 Agent 项目启发，未复制任何第三方源码。
