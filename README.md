<div align="center">

# 🧭 BossPilot

**本地优先、由 Skills 驱动的可扩展浏览器 AI Agent**

在浏览器侧边栏与自己的模型对话，通过 Skills、MCP 和受控网页工具完成页面理解、
多步骤交互与内容整理。Boss 直聘岗位分析和小红书内容调研是内置技能，而不是产品边界。

BYOK · 本地优先 · Skills / MCP · 敏感操作确认 · 源码可用 · 商业使用需授权

[![Build](https://github.com/little077/BossPilot/actions/workflows/build.yml/badge.svg)](https://github.com/little077/BossPilot/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/little077/BossPilot?label=Release&color=00a98f)](https://github.com/little077/BossPilot/releases/latest)

[快速开始](#-快速开始) · [核心能力](#-核心能力) · [内置技能](#-内置技能) · [安全边界](#-安全边界) · [架构文档](docs/ARCHITECTURE.md) · [参与贡献](CONTRIBUTING.md)

</div>

---

## 产品定位

BossPilot 是一个运行在 Chromium 浏览器侧边栏中的通用 AI Agent。它把模型、页面、
Skills、MCP 工具、本地记忆和会话产物连接成一条可恢复、可验证、需要授权的执行链。

它不是只面向某个网站的自动化脚本，也不把任意网页控制权直接交给模型：模型负责理解
目标与选择受约束工具，确定性执行器负责权限、参数、风险确认和结果验证。

## ✨ 核心能力

- **多模型 BYOK** — 支持多家模型厂商、本地模型与自定义 OpenAI-compatible 端点；
  密钥只保存在本机可信扩展上下文中。
- **可恢复 Agent Loop** — 流式多轮对话、工具调用、停止、失败现场保留、上下文压缩、
  多会话并行和 MV3 Service Worker 中断恢复。
- **通用页面理解** — 按需读取正文、标题、区域、链接与可交互控件摘要；网页内容始终
  作为不可信数据处理。
- **受控网页操作** — 管理标签页、搜索网站、查找控件、点击、填写、选择、滚动、等待与
  导航；每一步都使用短生命周期引用并验证结果。
- **视觉兜底** — 仅在 DOM 语义不足时，经用户同意截取当前可见区域并遮盖输入内容。
- **Agent Skills** — 按需加载 `SKILL.md`、引用和脚本；支持创建、复制、编辑、导入、导出、
  启停与能力授权，脚本在隔离页中运行。
- **MCP 工具** — 连接用户信任的 Streamable HTTP MCP 服务；只读工具按声明执行，其他
  外部操作逐次确认。
- **本地上下文与产物** — 用户指令、可编辑长期记忆、会话历史和私有工作区全部保存在
  本机；Agent 可以生成、读取、搜索和版本化会话产物。
- **可移植与可诊断** — 备份恢复不包含 API Key、MCP Token 或网站权限；诊断日志在导出前
  脱敏。

## 🧩 内置技能

| Skill | 能力 | 站点范围 |
| --- | --- | --- |
| `boss-job-search` | 岗位搜索、列表整理、职位详情分析和多岗位对比 | `zhipin.com` |
| `xhs-note-scout` | 博主主页笔记采集、详情与评论读取、内容调研报告 | `xiaohongshu.com` |

内置技能只是首批示例。用户可以在设置页创建或导入自己的 Skill，并为脚本声明页面读取、
页面脚本、工作区写入等能力。完整说明只在任务匹配后渐进加载，避免每轮对话都携带全部
技能正文。

## 🚀 快速开始

### 环境要求

- Node.js ≥ 22.19.0
- Chrome、Edge 等支持 MV3 Side Panel 的 Chromium 浏览器
- 一个受支持厂商的 API Key，或本地 Ollama / 自定义 OpenAI-compatible 端点

### 方式一：下载 Release

从 [Releases](https://github.com/little077/BossPilot/releases/latest) 下载最新的
`bosspilot-*-chrome.zip` 并解压。

### 方式二：从源码构建

```bash
git clone https://github.com/little077/BossPilot.git
cd BossPilot
npm install
npm run build
```

生产构建位于 `.output/chrome-mv3/`。

### 加载扩展

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择 `.output/chrome-mv3/`。
3. 点击 BossPilot 图标打开侧边栏。
4. 在「设置」中配置模型厂商、API Key 和默认模型。
5. 回到「对话」开始使用；输入 `/` 可以选择已启用的 Skill。

## 🧠 工作方式

```text
用户目标
   │
   ▼
Sidepanel 对话与授权 UI
   │  Port 快照
   ▼
Background Agent Manager
   ├─ 模型生成与上下文压缩
   ├─ Tool Catalog + Policy Engine
   ├─ Skills（渐进加载 + 隔离脚本）
   ├─ MCP（动态外部工具）
   └─ 页面 / 标签页 / 记忆 / 工作区工具
              │
              ▼
       验证后的工具结果与会话产物
```

Boss 直聘等已知站点仍使用确定性适配器增强结构化读取；通用网站则使用统一语义快照、
可访问名称和短生命周期元素引用。详见[架构文档](docs/ARCHITECTURE.md)。

## 🔐 安全边界

- **权限按来源收敛**：内置 Skill 只拥有对应站点权限；通用网站按精确 origin 请求授权，
  不申请常驻 `<all_urls>`。
- **高影响动作确认**：提交、发送、投递、发布、删除、支付等操作必须由用户逐次确认。
- **敏感输入禁用**：密码、文件上传和验证码必须由用户亲自处理。
- **结果必须验证**：只有工具返回明确成功证据时，Agent 才能声称操作完成。
- **网页内容不可信**：页面文字、截图和外部 MCP 返回值不能改变系统规则或扩大权限。
- **本地优先**：无项目方服务器、无遥测、无账号体系；数据只在本机与用户主动配置的
  模型或 MCP 端点之间流动。
- **站点合规**：不绕过登录、验证码、频率限制或网站安全机制。

## 📁 项目结构

```text
├─ entrypoints/
│  ├─ background.ts          # Agent 编排、工具目录、策略与 Port 服务端
│  ├─ sidepanel/             # 对话、历史、产物和设置 UI
│  ├─ skill-host/            # Skill 能力桥
│  └─ skill-sandbox/         # 无扩展 API 的脚本隔离页
├─ lib/
│  ├─ agent/                 # 会话 Agent、状态机、策略与工具台账
│  ├─ browser/               # 标签页路由、语义搜索、视觉观察与资源锁
│  ├─ page/                  # 页面快照、授权、抽取与暂停恢复
│  ├─ tools/                 # 模型可调用的受约束工具
│  ├─ skills/                # Skill 解析、存储、加载、打包与沙箱
│  ├─ mcp/                   # MCP 配置、发现与调用
│  ├─ memory/                # 用户指令与本地长期记忆
│  ├─ workspace/             # 会话私有文件与版本
│  ├─ generation/            # 多模型流式生成与上下文治理
│  ├─ providers/             # 厂商目录、权限和配置
│  ├─ adapter/               # 已知站点的确定性增强适配器
│  └─ diagnostics/           # 脱敏诊断与健康检查
├─ skills/                   # 随扩展发布的内置 Skills
├─ e2e/                      # Playwright 真实 MV3 测试
└─ docs/                     # 架构、权限、协议和历史设计文档
```

## 🛠 开发与验证

```bash
npm run dev              # WXT 热更新开发
npm run compile          # TypeScript 类型检查
npm run test             # Vitest 单元与组件测试
npm run test:e2e:install # 首次安装 Playwright Chromium
npm run test:e2e         # 真实 MV3 扩展冒烟测试
npm run quality          # Biome + 类型 + 覆盖率 + 依赖审计
npm run verify           # 完整门禁 + 构建 + 体积检查 + E2E
npm run zip              # 打包发布 ZIP
```

## 🗺️ 路线图

当前实现基线和后续方向见[产品路线图](docs/ROADMAP.md)。历史求职垂直方案仍保留在
[产品立项书](docs/PRODUCT_INITIATION.md)中，仅作为设计背景，不再代表当前产品边界。

## 🤝 参与贡献

欢迎 Issue 与 PR。提交前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、
[AGENTS.md](AGENTS.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 和
[NOTICE.md](NOTICE.md)。

## 📄 许可证与商业授权

当前源码按 [PolyForm Noncommercial License 1.0.0](LICENSE) 提供。默认许可不授予商业
使用权；商业使用必须事先取得版权所有者单独签发的书面商业许可。

早期随 MIT License 发布的版本继续适用其随附的 MIT 条款。许可切换说明、权利声明和
商业授权入口见 [NOTICE.md](NOTICE.md)。

> BossPilot 是独立实现，与 Boss 直聘、小红书及其运营主体不存在隶属、授权或背书关系。
