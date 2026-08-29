# BossPilot 架构设计

> 面向贡献者的当前技术总览。本文描述已经实现的通用浏览器 Agent 架构；早期以 Boss
> 直聘三段式流水线为中心的文档不再代表产品主路径。

## 1. 产品与架构定位

BossPilot 是运行在 Chromium Side Panel 中的本地优先 AI Agent。核心不是某个网站的
固定自动化，而是一套可扩展、可恢复、受策略约束的模型—工具循环：

- 模型负责理解目标、选择工具和组织结果；
- 工具执行器负责参数校验、权限、风险确认、页面操作和结果验证；
- Skills 负责按需注入专业工作流及受限脚本；
- MCP 负责连接用户主动配置的外部工具；
- 已知站点适配器为通用页面读取提供结构化增强。

Boss 直聘岗位分析与小红书内容调研是内置 Skill，不是 Agent 平台的能力边界。

## 2. Chrome MV3 运行时

```text
┌─────────────────────────────┐
│ Sidepanel · React 19        │
│ 对话 / 历史 / 产物 / 设置   │
└──────────────┬──────────────┘
               │ chrome.runtime Port
               │ 全量快照 + 可恢复暂停点
┌──────────────▼──────────────────────────────────────────┐
│ Background Module Service Worker                        │
│ AgentManager → ConversationAgent → ChatGenerationManager│
│                                                        │
│ ToolCatalog ─ PolicyEngine ─ TaskStateMachine           │
│    ├─ 页面 / 标签页 / 视觉工具                          │
│    ├─ Skills / Sandbox / Host Bridge                    │
│    ├─ MCP 动态工具                                      │
│    ├─ Memory                                            │
│    └─ Workspace                                         │
└───────┬─────────────┬──────────────┬───────────────────┘
        │             │              │
        ▼             ▼              ▼
  模型厂商端点      浏览器页面      本地持久化
  用户自行配置      tabs/scripting  IndexedDB/storage
```

| 运行时 | 入口 | 职责 | 明确不做 |
| --- | --- | --- | --- |
| Sidepanel | `entrypoints/sidepanel/` | 渲染状态、收集输入、展示授权卡与会话产物 | 不直接访问密钥、页面或模型 |
| Background | `entrypoints/background.ts` | Agent 编排、模型生成、工具与权限策略、持久化协调 | 不向 UI 暴露明文凭据 |
| Skill Host | `entrypoints/skill-host/` | 在受控桥上提供 Skill 声明过且获批的能力 | 不执行任意未声明能力 |
| Skill Sandbox | `entrypoints/skill-sandbox/` | 在无扩展 API 的隔离页运行 Skill JavaScript | 不直接访问 Chrome API、网络和宿主存储 |
| Content Script | `entrypoints/zhipin.content.ts` | Boss 直聘验证码状态上报 | 不承载通用业务逻辑 |

## 3. 模块地图

```text
entrypoints/sidepanel ──► lib/ipc/protocol ◄── entrypoints/background
        │                                              │
        ├─► providers/client                           ├─► agent/
        ├─► skills/client                              ├─► generation/
        ├─► mcp/client                                 ├─► tools/
        └─► storage/db                                 ├─► skills/ + mcp/
                                                       ├─► page/ + browser/
                                                       ├─► memory/ + workspace/
                                                       └─► adapter/ + diagnostics/

lib/domain/chat.ts + lib/domain/types.ts
  └─ 跨运行时实体与状态的底层事实源
```

目录职责：

| 目录 | 职责 |
| --- | --- |
| `lib/agent/` | 多会话 Agent、工具目录、策略引擎、任务状态机、工具台账与保活 |
| `lib/generation/` | 多协议流式生成、工具循环、上下文压缩、错误与模型解析 |
| `lib/tools/` | 模型可见的受约束工具定义和确定性执行器 |
| `lib/page/` | 页面快照、统一抽取、来源授权和暂停恢复 |
| `lib/browser/` | 标签页路由、资源锁、语义搜索和视觉页面标记 |
| `lib/skills/` | Skill 包解析、存储、渐进加载、权限和沙箱执行 |
| `lib/mcp/` | Streamable HTTP MCP 配置、工具发现和调用 |
| `lib/memory/` | 用户指令和可编辑本地长期记忆 |
| `lib/workspace/` | 会话私有文件、目录、搜索和版本记录 |
| `lib/adapter/` | Boss 直聘、小红书等已知站点的结构化增强 |
| `lib/diagnostics/` | 脱敏日志、运行健康检查和页面结构诊断 |

`lib/ipc/protocol.ts` 是 Sidepanel 与 Background 消息协议的单一事实源；跨运行时实体不得在
入口文件中重复声明。

## 4. 会话与 Agent 生命周期

`AgentManager` 为每个会话维护独立的 `ConversationAgent` 和 `ToolContext`，允许多个会话
排队或并行运行，但页面焦点、标签页导航等共享资源仍由资源锁协调。

一次对话执行的主路径：

```text
用户消息
  → 捕获消息发送瞬间的页面上下文
  → 解析会话固定模型与运行参数
  → 模型生成文本或一批工具调用
  → ToolCatalog 查找定义
  → PolicyEngine 判断 safe / confirm / blocked
  → 执行工具并写入 ToolLedger
  → 结果返回模型，继续下一轮
  → 得到最终回复或进入可恢复暂停点
```

关键约束：

- 单次 Agent 运行有模型轮次上限和连续重复工具调用上限；
- 取消信号贯穿模型、页面、Skill、MCP 与工作区执行器；
- 任务 checkpoint 与待处理暂停点写入本地存储，SW 重启后不会静默伪装为完成；
- 对话上下文达到窗口阈值时可压缩旧消息，但保留系统规则和关键工具结果；
- 工具批次从同一页面起点解析，避免第一个导航污染同批次其他调用。

## 5. 工具系统与风险策略

工具定义、风险声明和执行器集中注册在 `ToolCatalog`，避免“模型看得到但后台不能执行”或
“后台可执行但模型契约中不存在”的分裂。

| 工具组 | 代表工具 | 风险与边界 |
| --- | --- | --- |
| 页面读取 | `read_current_page` | 只读统一语义快照；Boss 页面附加结构化岗位数据 |
| 页面观察 | `inspect_page`、`observe_visual_page` | 返回短生命周期引用；视觉截图需单独同意并遮盖输入内容 |
| 页面交互 | `interact_page` | 只接受观察结果中的 `observationId/ref`；动作后引用失效并验证结果 |
| 导航搜索 | `tab`、`browser_action` | 只管理普通 HTTP(S) 标签页；网址必须来自用户或可信工具结果 |
| Skills | `load_skill`、`run_skill` | 先读工作流再执行；脚本只能使用声明并获批的能力 |
| 记忆 | `search_memory`、`save_memory` | 用户主动开启；只有明确要求时保存，拒绝敏感信息 |
| 工作区 | `workspace_*` | 读取只限当前会话；创建、编辑、重命名、删除等写操作需确认 |
| MCP | `mcp__*` | 动态工具结果按不可信外部数据处理；非只读调用逐次确认 |
| 人机协同 | `ask_user` | 只在缺少会显著改变后续结果的关键信息时暂停询问 |

提交、发送、投递、发布、删除、支付、登录等高影响页面动作由执行器强制暂停确认；密码、
文件输入和验证码始终交给用户本人。

## 6. 页面读取与操作模型

### 6.1 统一语义快照

`read_current_page` 读取用户发送消息时绑定的页面，输出可读正文、标题层级、区域、链接和
控件数量摘要，不返回完整 HTML。传入 `tab.open` 或 `tab.list` 返回的可信 `tabId` 时可以
读取其他已登记标签页。

页面内容被包裹为不可信工具数据，不能触发 Skill、修改系统规则或提供额外权限。

### 6.2 短生命周期元素引用

`inspect_page` 根据可访问名称、可见文字和语义角色返回 `observationId/ref`。模型不能提交
CSS selector 或任意脚本。每次 `interact_page` 后旧引用失效，后续动作必须使用工具返回的
最新观察。

执行器对动作前后指纹、目标状态、导航和元素变化进行验证；没有明确成功证据时返回
`VERIFICATION_FAILED`，上层不得改写成成功。

### 6.3 已知站点增强

- `lib/adapter/zhipin.ts` 维护 Boss 直聘 URL、选择器和岗位抽取契约；
- `lib/adapter/xhs.ts` 维护小红书页面结构辅助能力；
- 站点知识只能放入对应适配器或 Skill 脚本，通用 Agent 模块不得散落站点选择器。

## 7. Skills 平台

启动时模型只看到已启用 Skill 的名称、版本和描述。任务与描述明确匹配或用户点名后，
`load_skill` 才读取完整 `SKILL.md`，并按正文指示加载一层 `references/*.md`。

Skill 包可以包含：

- `SKILL.md`：触发条件、工作流、允许工具和能力声明；
- `references/*.md`：按需读取的领域参考；
- `scripts/*.js`：在 Sandbox 中运行的受限脚本。

用户可创建、复制、编辑、导入和导出 Skill。导入包经过路径、大小、文件类型、元数据和能力
校验；脚本不能访问扩展 API，只能经 Host Bridge 使用已声明且用户批准的能力。持续授权可在
设置页撤销。

## 8. MCP

用户可以配置最多受上限约束的 Streamable HTTP MCP 服务。服务地址按精确 origin 请求网络
权限，Bearer Token 仅存本机，不进入 UI 快照、备份和诊断。

MCP 工具以 `mcp__` 前缀加入动态目录。服务器声明的只读性用于风险判断；未声明只读的调用
在执行前逐次确认。当前浏览器扩展不启动 stdio 本机进程。

## 9. 模型与上下文

`lib/providers/` 管理厂商目录、端点权限、密钥和活动模型；`lib/generation/` 把不同生成协议
收敛为统一流式事件与工具调用结构。

约束：

- 一轮会话固定使用解析后的模型，不在失败时偷偷切换；
- 模型端点必须与用户授权 origin 一致；
- API Key 只存在于 Background 可信上下文；
- 图片输入能力由模型元数据和用户选择共同决定；
- 用户指令、Skill 目录和本地记忆按独立边界组装进系统上下文。

早期 `lib/pipeline/` 与 `lib/llm/` 中的 Boss 直聘三段式流水线仍作为兼容代码保留，但不再是
README 或架构文档描述的通用主路径。

## 10. 持久化与兼容标识

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| Provider、MCP、页面来源与用户设置 | `chrome.storage.local` | 存储键沿用 `bosspilot:*` 作为稳定兼容标识 |
| 对话、消息、运行 checkpoint | IndexedDB / Dexie | 数据库名 `bosspilot`；升级只追加版本迁移 |
| Skills 与持续授权 | IndexedDB + `chrome.storage.local` | 内置包随版本同步，本地包独立保存 |
| 会话工作区与历史版本 | IndexedDB | 按 `conversationId` 隔离，不能跨会话访问 |
| 用户指令与长期记忆 | `chrome.storage.local` | 用户可查看、编辑、删除和关闭 |
| 诊断 | Background 内存 → 下载文件 | 导出前统一脱敏 |

产品文案或图标变更不应直接重命名这些内部标识，否则会让既有用户表现为数据丢失。需要
更名时必须先实现双读、迁移和回滚测试。

## 11. 权限与安全

- 常驻站点权限只覆盖内置 Skill 当前需要的 `zhipin.com` 与 `xiaohongshu.com`；
- 通用页面和模型/MCP 端点通过 `optional_host_permissions` 按精确 origin 申请；
- `chrome.storage.local` 限制为可信扩展上下文；
- 普通网页、截图像素、Skill 输入和 MCP 返回值均视为不可信数据；
- 截图前需要用户同意，并遮盖已填写字段；
- 工具台账记录策略决策、耗时和结果，但不记录密钥；
- 备份不包含 API Key、MCP Token 或网站权限；
- 无遥测、无项目方服务器、无账号体系；
- 不绕过登录、验证码、访问频率限制或站点安全机制。

更完整的权限分层见 [permission-risk-design.md](permission-risk-design.md)，消息时序见
[PROTOCOL.md](PROTOCOL.md)，Boss 直聘适配器契约见 [ADAPTER.md](ADAPTER.md)。
