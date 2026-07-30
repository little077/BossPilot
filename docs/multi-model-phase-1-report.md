# BossPilot 多模型接入：一期实施报告

更新日期：2026-07-29

> 本文记录一期交付时的配置基座。普通聊天已在二期接入活动模型与多协议流式生成，
> 当前实现和安全边界见 [`multi-model-phase-2-report.md`](multi-model-phase-2-report.md)。

## 1. 一期目标与边界

一期只交付模型配置能力：

1. 从发卡台领取厂商卡。
2. 填写 API Key；自定义端点额外填写 Base URL。
3. 在用户点击“开通”后申请该端点的精确主机权限。
4. 由扩展 Background 请求厂商模型目录。
5. 展示真实返回的模型列表，并由用户显式选择默认模型。
6. 在本机持久化厂商、密钥、模型目录和当前模型。

本期不把新模型接入消息发送、任务评估或流式输出。原有聊天调用链保持不变，
避免在“配置接入”和“生成协议适配”两个风险面之间产生隐式耦合。第二期再按
Provider 协议接入生成与流式输出。

外部项目只用于了解产品能力范围和交互思路。本实现的领域模型、Provider
注册表、目录解析、存储、权限、IPC、UI 和测试均在 BossPilot 内独立设计，
未复制或引用外部项目代码。

## 2. 一期支持范围

设置页提供以下 27 个入口：

| 类别 | 厂商或端点 |
| --- | --- |
| 国内及区域端点 | DeepSeek、Kimi / Moonshot CN、智谱 BigModel、通义千问、MiniMax CN、Moonshot、Kimi Coding Plan、Xiaomi MiMo、Xiaomi MiMo Plan CN、zAI、Ant Ling |
| 国际厂商 | OpenAI、Anthropic、Google Gemini、Mistral、Groq、Cerebras、Fireworks、Hugging Face、MiniMax、NVIDIA NIM、Together AI、xAI |
| 聚合网关 | OpenRouter、Vercel AI Gateway |
| 本地及自定义 | Ollama、自定义 OpenAI 兼容端点 |

目录发现实现四种协议适配：

- OpenAI-compatible：`GET {baseUrl}/models`，Bearer 鉴权，解析 `data[]`。
- Anthropic：`GET /v1/models`，`x-api-key` 和 `anthropic-version`，支持
  `after_id` 游标分页。
- Gemini：`GET /v1beta/models`，`x-goog-api-key`，支持 `pageToken`
  分页，并过滤不支持内容生成的模型。
- Ollama：`GET /api/tags`，本机访问无需密钥。

对没有目录接口、目录接口未开放或租户网关不兼容 `/models` 的厂商，开通错误
会保留在卡片内，并显示手动模型 ID 兜底；自定义端点始终提供手动入口。

Codex、GitHub Copilot 等 OAuth 接入不属于本期 API Key 流程。它们需要独立的
授权码或设备码、PKCE、令牌刷新、撤销和权限测试，应作为后续专门迭代实现，
不能伪装成 API Key 厂商。

## 3. 技术实现

### 3.1 分层

```text
entrypoints/sidepanel/ProviderSettings.tsx
  ├─ 发卡台、卡包、密钥草稿、模型选择与错误恢复
  ├─ chrome.permissions.request（用户点击内）
  └─ lib/providers/client.ts（一次性 IPC）

entrypoints/background.ts
  └─ ProviderService
      ├─ registry.ts     厂商元数据与目录协议
      ├─ discovery.ts    网络请求、分页、解析与响应收敛
      ├─ store.ts        版本化本地存储与旧配置迁移
      └─ service.ts      领卡、开通、选择、手工模型、销毁状态机
```

跨运行时类型位于 `lib/domain/types.ts`，IPC 协议位于
`lib/ipc/protocol.ts`，符合现有项目的单一事实源约束。

### 3.2 状态与存储

存储键为 `bosspilot:providers:v1`，结构包含：

- 多个厂商连接；
- 每个连接的 Base URL、API Key、模型列表、已选模型和配置时间；
- 全局 `activeModel: { providerId, modelId }`。

Sidepanel 获取的快照不包含 API Key，只包含：

- `hasApiKey`；
- `apiKeyLastFour`；
- 模型列表与已选模型。

首次读取时，如果旧 `bosspilot:llm` 同时包含有效 Base URL、Key 和模型，
会迁移为匹配的内置厂商或自定义卡；旧数据不会在新数据写入前被删除。
空的默认旧配置不会生成伪连接。

### 3.3 权限与密钥边界

- 正式 Manifest 的常驻 `host_permissions` 仍只有 Boss 直聘。
- 模型地址声明为 `optional_host_permissions`，开通时只请求
  `scheme + hostname` 对应的具体来源。
- 权限请求直接发生在按钮事件内，保留 Chrome 所要求的 user gesture。
- 远程端点必须使用 HTTPS；HTTP 只允许 localhost、127.0.0.1 和 `[::1]`。
- Base URL 拒绝非 HTTP(S) 协议以及 URL 内嵌用户名/密码，并移除查询与片段。
- API Key 只从 Sidepanel 单向发往 Background；响应、错误和状态快照均脱敏。
- `chrome.storage.local` 被限制为 `TRUSTED_CONTEXTS`，阻止内容脚本读取密钥。
- 本地存储不是操作系统级加密保险箱；本期保证的是不上传、不云同步、扩展上下文
  隔离和不回显，而不是声称密钥经过硬件加密。

### 3.4 不可信响应防护

- 单次完整目录读取最多 10 页、1000 个模型和 1,000,000 个字符。
- 模型 ID 最大 256 字符。
- 模型列表去空、去重并收敛名称。
- 目录请求统一 10 秒超时并使用 AbortSignal 中止。
- 拒绝重复、缺失或超长分页游标。
- HTTP、JSON、空目录和网络错误统一转为用户可理解的错误。
- 即使上游错误正文包含 Key，也会在进入 IPC 前替换为 `[REDACTED]`。
- 同一厂商忙碌期间禁用重复操作；Background 串行执行配置写入，避免竞态覆盖。

## 4. 原型交互落地

实现保留原型的核心状态转换：

```text
空卡包
  → 领取厂商卡
  → 填写 Key / Base URL
  → 开通并读取模型目录
  → 展示模型列表
  → 用户选择模型
  → 卡片标记“配置完成”并成为当前模型
```

目录刷新时，原模型仍存在则保留选择；原模型消失则清除该选择和对应的
active model。销毁当前卡后直接清空 active model，由用户重新明确选择，
不会在用户不知情时自动切换到其他厂商。

“配置完成”只表示目录已成功读取且用户已选择模型，不等价于完成一次生成调用。
界面没有使用“密钥验证成功”等超出本期证据范围的表述。

## 5. 全局 UI 统一

应用整体按 `bosspilot-redscope-home.html` 统一为 RedScope 蓝灰视觉，而不是只给
首页做局部换肤：

- `assets/app.css` 定义全局语义设计令牌，顶部、首页、会话、结果与设置共用
  同一套背景、文本、边框、品牌色、状态色、圆角和阴影；
- 顶部品牌区、运行状态、三个导航入口和“新对话”操作统一为 RedScope 样式；
- 首页保留蓝灰衬线标题、大输入框和示例卡的原型视觉；
- 会话气泡、Markdown、工具条、底部输入区和任务进度统一为同一主题；
- 岗位结果的空状态、卡片、匹配分与风险状态统一为同一主题；
- 设置页只保留模型卡包、厂商配置表单和发卡台，并统一为同一主题；厂商横幅
  只保留用于辨识不同厂商的克制色调；
- 所有视图使用同一个 `.redscope-app` 外壳和 `.redscope-view` 页面基线，
  并针对 320、384、480 像素侧边栏宽度设置回归约束；
- 小字号辅助文字和状态色满足普通文本对比度要求；长 URL、内联代码、代码块和
  GFM 表格不会撑宽侧边栏，必要时只在内容块内部横向滚动；
- 浏览器扩展 SVG/PNG 图标同步改为 RedScope 蓝灰品牌色。

主题改造保留原 Composer、中文输入法处理、示例回填、520ms 沉底动画、消息与
任务逻辑、模型配置状态机及数据位置。“新对话”仍位于顶部，已移除的“报告”
入口和逻辑不会恢复。

一期设置页不提供发卡台之后的其他业务配置。评估批量大小、个人档案、保存按钮、
隐私说明和第二期流程提示均不再展示或维护对应的 React 状态；页面在发卡台结束。

## 6. 自动化质量门禁

新增测试覆盖：

- Provider 注册表 ID、入口完整性和 Key 可选规则；
- URL 安全校验与精确 Host Permission；
- OpenAI、Anthropic、Gemini、Ollama 目录解析与鉴权；
- 分页、超时、响应上限、去重、空目录和密钥脱敏；
- 版本化存储、旧配置迁移和非法数据收敛；
- Provider 状态机、失败不落盘、刷新选择、手工模型和销毁回退；
- Sidepanel IPC 成功、错误和非法响应；
- React 完整交互：领卡、开通、授权、选模型、权限拒绝、手动兜底；
- 全局 RedScope 外壳、跨页主题、窄宽度及长内容防溢出、导航、新对话和
  “报告不存在”回归；
- 构建 Manifest 的常驻/可选权限边界。

项目继续使用 Biome、TypeScript strict、Vitest + RTL、Playwright MV3 E2E、
依赖安全审计和构建体积预算。新增 Provider 核心模块已纳入 Vitest 覆盖率门禁。

## 7. 第二期：流式对话的通俗说明与实施边界

### 7.1 为什么一期选好模型后还不能直接聊天

一期完成的是“办卡和选卡”：

- BossPilot 知道用户配置了哪家厂商；
- 能安全保存 API Key；
- 能向厂商读取模型目录；
- 能记住用户选中的模型。

但真正发送消息时，各厂商的请求地址、鉴权请求头、消息格式和流式返回格式并不
相同。当前的 `activeModel` 只相当于“用户选中了哪张卡”，还没有完成“拿这张卡
去对应厂商发起对话”的执行链路。第二期就是把这条链路接通，并让回复边生成边
显示。

### 7.2 原七项建议分别是什么意思

#### 1. Provider generation adapter

大白话：做一个“模型配置翻译器”。

用户选中的是“DeepSeek + deepseek-chat”这样的业务信息；真正请求时还需要找出
Base URL、密钥、鉴权方式和协议类型。翻译器负责把选中的模型转换成一份可以直接
调用的运行时配置。

- 解决的问题：设置页选中的模型与聊天发送链路目前没有连接。
- 做完的能力：聊天发送时能准确使用当前选中的厂商、密钥和模型。
- 性质：第二期必做的底层基建，用户看不到，但没有它就无法接通聊天。

#### 2. 四类生成协议适配

大白话：给不同“插头”准备四种转换头。

大多数厂商兼容 OpenAI 协议，但 Anthropic、Gemini 和 Ollama 的请求与流式响应
都有自己的格式。因此需要实现：

- OpenAI-compatible；
- Anthropic Messages；
- Gemini generateContent；
- Ollama chat/generate。

27 个厂商入口不等于编写 27 套聊天代码；它们会归入这四类协议，共用适配器。

- 解决的问题：不能拿 OpenAI 的请求格式直接调用所有厂商。
- 做完的能力：同一个聊天界面可以使用一期支持范围内的不同厂商模型。
- 性质：第二期必做的协议基建，也是多模型真正“可用”的核心。

#### 3. 统一流式事件

大白话：不管厂商怎么说，进入 BossPilot 后都翻译成同一种语言。

有的厂商返回 SSE，有的返回 JSON 行；有的把文本叫 `delta`，有的拆成多个事件。
内部统一为“新增文字、使用量、正常结束、错误”几种事件后，界面只处理一套逻辑。

- 解决的问题：如果页面直接理解每家厂商的格式，代码会重复且容易出错。
- 做完的能力：文字逐字出现、停止生成、错误提示和 Token 使用量都能统一处理。
- 性质：直接支撑流式体验的核心基建，第二期必做。

#### 4. 模型选择与失败回退规则

大白话：明确“什么任务用哪个模型，失败后怎么办”。

BossPilot 后续可能有普通聊天、需求解析、岗位评估等不同任务。如果同时配置多个
模型，需要决定它们是全部使用当前模型，还是分别指定模型，以及失败时是否自动
切换。

第二期首版不需要一次做复杂：建议只让“普通聊天”使用当前选中的模型；不做自动
切换，失败时明确报错并允许重试。任务解析和岗位评估暂时保持原链路。

- 解决的问题：避免系统在用户不知道的情况下换模型，或不同功能行为不确定。
- 做完最低能力：用户选哪个模型，普通聊天就明确使用哪个模型。
- 性质：一部分是必须明确的产品规则；多模型路由和自动回退属于后续增强基建，
  不必塞进第二期首版。

#### 5. Mock Server 契约、取消和重连测试

大白话：搭建“假的厂商服务器”，把各种正常和异常情况提前演练。

自动化测试不能每次都调用真实付费 API，也不能依赖外网稳定性。Mock Server 会
模拟四类厂商的分段回复、错误、慢响应和中途断线。

- 解决的问题：避免只在真实用户使用时才发现格式不兼容、停止按钮无效或重连丢消息。
- 做完的能力：每次改代码都能自动验证流式输出、取消、错误和重连。
- 性质：严格工程质量基建，第二期必做，不是用户直接看到的功能。

#### 6. 是否引入统一 AI SDK

大白话：决定“自己做四个轻量转换器”，还是引入一个现成工具箱。

AI SDK 可能减少协议适配代码，但也会增加扩展包体积，并且要验证对 Chrome MV3
Background、流式读取和取消操作是否完全兼容。

- 解决的问题：控制长期维护成本与当前包体积之间的取舍。
- 做完的能力：它本身不会增加用户功能，只影响开发速度和维护方式。
- 性质：技术选型，不是第二期功能。建议先做小型适配器验证；只有确认 SDK 在
  协议覆盖、包体积和扩展环境上更合适时再引入。

#### 7. OAuth Provider

大白话：支持“登录账号授权”，而不只是粘贴 API Key。

Codex、GitHub Copilot 等服务可能需要跳转登录、授权码、Token 刷新和撤销授权，
安全模型与 API Key 完全不同。

- 解决的问题：接入只能通过账号登录授权的模型服务。
- 做完的能力：用户可以通过官方登录授权使用这类服务。
- 性质：独立的安全与账号体系工程，和流式输出不是一回事；不应纳入第二期首版，
  建议作为后续单独里程碑。

### 7.3 建议的第二期实际范围

第二期首版只承诺一个清晰结果：

> 用户在设置页选中一个已配置模型后，回到对话页发送消息，BossPilot 使用该模型
> 返回可停止、可报错恢复的流式回复。

必做范围：

1. 把当前选中模型解析为可调用配置；
2. 实现 OpenAI-compatible、Anthropic、Gemini、Ollama 四类流式适配；
3. 统一内部流式事件；
4. 普通聊天固定使用当前模型，失败不偷偷切换；
5. 支持停止生成、明确错误和会话历史；
6. 完成四类协议的 Mock Server 契约测试、取消测试、重连测试和真实扩展 E2E。

明确不放进第二期首版：

- 岗位解析和岗位评估的多模型迁移；
- 自动选择模型、模型编排和故障自动切换；
- OAuth 登录型 Provider；
- 用量计费面板；
- 发送消息以外的新业务功能。

因此，原七项不是七个都要在第二期交付的用户功能：第 1、2、3、5 是流式对话
必须打好的基建；第 4 在第二期只做最小规则；第 6 是开发实现方式的选择；第 7
应当移到后续独立阶段。

## 8. 主要官方依据

- OpenAI Models API：<https://platform.openai.com/docs/api-reference/models>
- Claude Models API：<https://platform.claude.com/docs/en/api/models/list>
- Gemini Models API：<https://ai.google.dev/api/models>
- Ollama List Models：<https://docs.ollama.com/api/tags>
- Chrome optional permissions：<https://developer.chrome.com/docs/extensions/reference/api/permissions>
- Chrome Storage access level：<https://developer.chrome.com/docs/extensions/reference/api/storage>
