# BossPilot 多模型接入：二期实施报告

更新日期：2026-07-30

## 1. 本期结果

二期已经把一期的“配置并选择模型”接到了普通聊天链路：

> 用户在设置页选择一个已配置模型后，回到对话页发送消息，BossPilot 会固定使用
> 该模型生成回复；回复可流式展示、可停止、可在失败时保留现场，并可在侧边栏重连后恢复。

本期交付：

1. 活动模型、密钥、端点与生成协议的严格解析。
2. 五类模型 API 的统一流式适配。
3. Background 内的单轮生成状态机。
4. Sidepanel 全量消息快照、停止、错误和断线重连交互。
5. 消息持久化、稳定错误码、密钥脱敏和输入上限。
6. 单元、组件、协议、覆盖率、真实 MV3 扩展和构建体积门禁。

本期明确没有实现：

- OAuth Provider；
- 岗位意图解析、岗位评估等旧任务流水线的多模型迁移；
- 自动换模型、故障切换或隐式重试；
- Agent 工具循环、函数调用、图片输入和语音输入；
- 云端会话、账号体系或遥测。

## 2. 外部项目调研结论与独立实现声明

调研 Cebian 只用于理解其公开可观察的架构分工，不使用其任何源代码、类型、
测试、注释或兼容层。BossPilot 采用的是相同层次的工程思路，而不是复制实现：

```text
模型身份
  → 可信运行时解析
  → Provider / API 适配
  → 统一流式事件
  → Background 会话状态机
  → UI 全量快照
```

调研发现，多厂商接入不应手写几十套相似请求，而应让模型元数据携带 API 类型，
再由统一适配层分派协议。BossPilot 因此直接依赖公开、MIT 许可的
`@earendil-works/pi-ai@0.80.6`，并在自己的安全边界、领域类型、状态机和 IPC 之上
封装它。

实现只使用 `pi-ai` 的现代公共入口：

- `api/*`：五个非 lazy 协议流在构建期静态链接，避免 MV3 Service Worker
  不支持运行时 `import()` 的限制；
- `providers/*.models`：使用公开模型元数据；精确命中时保留模型自己的 API、
  请求头、兼容参数、上下文窗口和输出上限；
- `@earendil-works/pi-ai`：只导入跨协议公共类型。

没有使用：

- `@earendil-works/pi-ai/compat`；
- `providers/all`；
- `pi-agent-core`；
- Cebian 的任何代码或内部数据。

选择该方案的原因是普通聊天只需要统一模型流，不需要完整 Agent loop。
这样既能覆盖厂商差异，又避免把工具循环、OAuth 或外部项目的业务架构提前引入。

官方参考：

- [pi-ai npm 包说明](https://www.npmjs.com/package/%40earendil-works/pi-ai)
- [pi-ai 官方仓库](https://github.com/earendil-works/pi)

## 3. 支持范围

### 3.1 配置入口

一期已有的 27 个入口继续保留：

- 国内与区域厂商：DeepSeek、Kimi / Moonshot CN、智谱、通义千问、
  MiniMax CN、Moonshot、Kimi Coding Plan、Xiaomi MiMo、zAI、Ant Ling；
- 国际厂商：OpenAI、Anthropic、Google Gemini、Mistral、Groq、Cerebras、
  Fireworks、Hugging Face、MiniMax、NVIDIA NIM、Together AI、xAI；
- 聚合网关：OpenRouter、Vercel AI Gateway；
- 本地与自定义：Ollama、自定义 OpenAI-compatible 端点。

### 3.2 生成协议

内部使用五个明确的生成协议标识：

| 协议 | 典型用途 |
| --- | --- |
| `openai-completions` | DeepSeek、通义、智谱、OpenRouter、Ollama、自定义端点等 |
| `openai-responses` | OpenAI 新模型 |
| `anthropic-messages` | Anthropic、Kimi Coding、MiniMax 及部分网关模型 |
| `google-generative-ai` | Gemini |
| `mistral-conversations` | Mistral |

对 `pi-ai` 已知的 23 个厂商，适配器在构建期链接其公共模型元数据，并按选中模型
自身的 `api` 字段分派。因此同一厂商中不同模型使用不同 API 的情况也能正确处理。

如果是刚发布、SDK 目录尚未收录的模型，或者智谱、通义、自定义端点、Ollama
这类通用兼容入口，则使用 BossPilot 注册表声明的协议构造运行时模型，不因为
静态目录暂未更新而阻断用户。

## 4. 运行时架构

```text
Sidepanel
  ├─ IndexedDB 加载会话
  ├─ requestId + 完整历史
  └─ 全量 assistant 快照渲染
          │ Port
          ▼
Background
  └─ ChatGenerationManager
       ├─ resolveActiveGenerationTarget
       │    ├─ ProviderStateStore
       │    ├─ 活动模型与实时目录校验
       │    └─ 精确 Host Permission 校验
       └─ PiGenerationAdapter
            ├─ 同源的精确厂商模型
            └─ 五协议通用兜底
                    │ fetch / SSE
                    ▼
                 模型厂商
```

主要模块：

| 模块 | 职责 |
| --- | --- |
| `lib/providers/registry.ts` | 分离目录发现协议与生成协议，维护受信任的内置端点 |
| `lib/generation/resolve.ts` | 把活动模型指针解析为仅 Background 可见的运行时目标 |
| `lib/generation/pi-adapter.ts` | 把聊天历史转换为统一上下文，并适配厂商流 |
| `lib/generation/manager.ts` | 单轮互斥、取消、完整快照、唯一终态、密钥内容抑制 |
| `lib/generation/errors.ts` | 稳定错误码、HTTP 分类、超时识别和公开错误脱敏 |
| `lib/ipc/protocol.ts` | Sidepanel 与 Background 的消息契约及运行时校验 |
| `entrypoints/sidepanel/usePort.ts` | 持久化、重连、快照覆盖、发送锁与停止 |
| `entrypoints/background.ts` | 可信发送方校验、广播、诊断和任务/聊天边界 |

## 5. 一轮聊天的时序

```text
用户发送
  → Sidepanel 立即保存 user 消息并设置同步发送锁
  → Background 校验消息数量、长度和 requestId
  → Manager 在“解析模型”阶段就占用全局单轮锁
  → Resolver 固定本轮 provider + model + endpoint + key
  → 创建 streaming assistant 快照
  → Adapter 逐段产出文本，Manager 每次广播完整消息快照
  → 完成 / 停止 / 错误三种终态之一
  → Sidepanel 按 message.id 覆盖并持久化终态
```

关键规则：

- 同一时刻只允许一轮普通聊天生成，防止重复点击和多侧边栏竞态。
- 模型在一轮开始时固定；用户之后切换模型只影响下一轮。
- 失败不会偷偷换模型，也不会由 SDK 自动重试；`maxRetries` 固定为 0。
- 每轮最长等待 120 秒，默认输出上限为
  `min(8192, model.maxTokens)`。
- 停止操作按 `requestId` 精确匹配，重复停止不会产生第二个终态。
- 已生成的部分正文会保留；错误说明与正文分开显示。
- 流式消息始终发送全量快照，不依赖 UI 收齐每一个 delta。

## 6. MV3 断线恢复

Chrome 可以随时回收 Manifest V3 Service Worker，Sidepanel 也可能被关闭后重开。
本期使用两级恢复：

1. Sidepanel 在 IndexedDB 中保存 user 消息和 assistant 终态。
2. 活跃的 Background 在内存中保留当前或最近一条完整生成快照。

Port 断开后，Sidepanel 500ms 后重连并重新订阅。Background 按顺序发送：

1. 任务流水线快照；
2. 最新聊天快照；
3. `chat_state`。

如果 Background 仍在运行，UI 用相同 `message.id` 覆盖恢复；如果整个 Service
Worker 已在生成中途丢失，UI 会明确追加“生成连接已中断，请重试”，不会误报完成。

多侧边栏同时打开时，恢复握手以 Background 的 `requestId` 为权威：若旧窗口的
部分回复 A 已被后台新请求 B 取代，A 会保留正文并原地转为错误终态，再接管 B，
不会遗留永久流式光标。模型还在解析配置、尚未产生 `stream_start` 就失败时，
Background 会向全部订阅 Port 广播带 requestId 的错误；客户端只处理与自身活动请求
精确匹配的错误，既能解锁重连窗口，也不会污染空闲窗口或误终结随后启动的新请求。

## 7. 安全边界

### 7.1 凭据与端点

- API Key 只从设置页单向发送到 Background，Provider 快照只返回
  `hasApiKey` 和末四位。
- Background 启动时立即把 `chrome.storage.local` 访问级别限制为 `TRUSTED_CONTEXTS`；如果浏览器无法建立该隔离，Provider 配置与模型调用会失败关闭，不会在内容脚本可读取密钥的降级状态下继续运行。
- 正式常驻 Host Permission 仍只有 Boss 直聘；模型端点在用户点击开通时按 origin
  请求可选权限。
- 内置厂商的生成地址只信任 BossPilot 注册表；自定义厂商只使用经过 URL 规范化的
  用户配置。
- 远程端点必须为 HTTPS；HTTP 只允许本机回环地址。
- 生成前再次调用 `chrome.permissions.contains`，旧迁移数据不能绕过授权。
- Ollama 固定调用其 OpenAI-compatible `/v1` 地址，并且永不附带 API Key。
- `pi-ai` 的 OpenAI 客户端初始化要求非空字符串；仅对注册表明确标记为
  `keyOptional` 的 OpenAI-compatible 端点，适配器使用不会出进程的初始化标记，
  同时用公开 `headers: { Authorization: null }` 能力删除默认认证头。默认运行时测试
  在最终 `fetch` 层确认请求不含 `Authorization`，任何请求头也不含该初始化标记。

### 7.2 防止密钥外发与回显

- SDK 目录中的精确模型只有在其 Base URL 与已授权目标同源时才可采用。
  即使模型 ID 相同，也不会把用户密钥发给另一个 origin。
- 上游错误、Provider 错误、诊断日志和 IPC 错误在公开前统一脱敏并限制长度。
- 流式正文如果回显完整密钥会替换为 `[REDACTED]`。
- 为防止密钥被拆成多个 delta 后短暂出现在 UI，Manager 会暂存可能构成密钥前缀的
  尾部片段，直到下一段到来后再决定释放或擦除。
- 诊断记录只接收模型 ID 和端点主机，不接收完整 Provider 配置或 API Key。

### 7.3 IPC 与资源上限

- Provider 命令和 Agent Port 只接受本扩展的可信 Sidepanel 发送方。
- 验证码消息只接受本扩展注入到 `zhipin.com` 标签页的内容脚本。
- 单次聊天最多 200 条消息、每条最多 100,000 字符、总计最多 500,000 字符。
- Provider ID、模型 ID、Base URL、API Key 和 requestId 都有运行时长度上限。
- 目录读取继续受页数、模型数、响应体大小、游标和超时约束。

需要如实说明：`chrome.storage.local` 不是操作系统密钥链。本期提供的是本地优先、
扩展上下文隔离、不回显和不上传保证，不宣称硬件级加密。

## 8. 错误与用户能力

| 错误码 | 用户看到的能力 |
| --- | --- |
| `NO_ACTIVE_MODEL` | 引导先去设置页选模型 |
| `PROVIDER_NOT_CONFIGURED` | 识别厂商卡或端点已失效 |
| `MODEL_NOT_FOUND` | 识别目录刷新后模型消失或选择不一致 |
| `AUTH_REQUIRED` / `AUTH_ERROR` | 区分未配置密钥与厂商拒绝凭据 |
| `PERMISSION_REQUIRED` | 要求返回设置页重新授权端点 |
| `RATE_LIMITED` | 明确限流或额度不足，可稍后重试 |
| `TIMEOUT` | 明确响应超时，可重试 |
| `OUTPUT_LIMIT_EXCEEDED` | 上游忽略输出参数并超过 100,000 字符安全上限时主动停止 |
| `UPSTREAM_ERROR` | 厂商异常或其流返回错误 |
| `NETWORK_ERROR` | 网络或无法分类的传输错误 |
| `INVALID_RESPONSE` | 厂商提前断流或缺少完成事件 |
| `BUSY` | 阻止同一时刻开启第二轮 |

401/403、408、429 和 5xx 会映射为稳定错误码；普通错误仍保留经过脱敏和截断的
可读说明。失败消息包含 `retryable`，为后续“重试”交互保留了明确依据。

## 9. 工程质量与验证

### 9.1 自动化覆盖

二期核心模块已显式纳入 Vitest 覆盖率白名单：

- `lib/generation/errors.ts`
- `lib/generation/manager.ts`
- `lib/generation/pi-adapter.ts`
- `lib/generation/resolve.ts`
- `lib/ipc/protocol.ts`
- `entrypoints/sidepanel/usePort.ts`

当前全量单元/组件测试为 21 个测试文件、184 项测试全通过，覆盖率为：

| 指标 | 覆盖率 |
| --- | ---: |
| Statements | 95.25% |
| Branches | 89.35% |
| Functions | 95.54% |
| Lines | 97.63% |

对应硬门槛已提高到 95% / 89% / 95% / 97%，后续新增核心代码如果没有同步测试，
会直接阻断质量链。

测试覆盖活动模型解析、精确权限、五协议分派、同源限制、混合协议模型、历史映射、
usage、错误分类、密钥脱敏、取消竞态、唯一终态、重连恢复、IPC 输入上限、
IndexedDB 持久化和 UI 状态。

流式正文在 Background 中还受 100,000 个 UTF-16 字符硬上限保护；中间的全量消息
快照最多每 50ms 广播一次，首段与终态仍立即发送，避免异常端点用大量微小 delta
造成无界内存增长或累计平方级跨进程复制。

Playwright 使用生产构建后的真实 MV3 扩展，串行验证：

- Manifest 常驻/可选权限边界；
- Sidepanel 启动、导航、新会话和主题；
- 自定义端点目录、模型选择和刷新后恢复；
- 真实 Port → Background → mock 模型端点 → UI → IndexedDB 的聊天闭环；
- 请求模型、Authorization 以及 DOM 不回显密钥。

### 9.2 质量门禁

项目继续以以下命令作为合并前硬门禁：

```text
Biome → TypeScript strict → Vitest coverage → npm audit
      → WXT production build → bundle budget → Playwright MV3 E2E
```

Node.js 最低版本同步提高到 `22.19.0`，与 `pi-ai@0.80.6` 的运行时要求一致。
依赖锁定为精确版本，避免厂商模型元数据或协议实现未经评审自动漂移。

### 9.3 MV3 构建与体积预算

Background 改为 module Service Worker，使构建器可以把静态依赖拆成合法的
ES module chunks。Chrome MV3 Service Worker 不允许运行时 `import()`，因此五个协议
实现和 23 个厂商的模型元数据全部在构建期静态链接；Vite 的 DOM module-preload
注入也被关闭。`pi-ai` 中仅用于 Bun 环境探测的 `node:fs` 分支由浏览器显式 shim
隔离，生产构建不含未解析的 Node 内置模块。

本期把旧的“完整未压缩产物不超过 950 KiB”改为四层预算：

| 预算 | 上限 | 当前结果 |
| --- | ---: | ---: |
| Background 启动入口 | 100 KiB | 约 50.2 KiB |
| 单个 JavaScript chunk | 850 KiB | 约 823.7 KiB |
| 完整未压缩扩展 | 3 MiB | 约 2525.7 KiB |
| 全文件 gzip 估算 | 950 KiB | 约 573.8 KiB |

实际 `wxt zip` 产物为 588.30 kB（约 574 KiB）。预算变更不是取消约束，而是区分：

- 启动性能风险；
- 单块解析风险；
- 解压安装体积；
- 实际分发体积。

`mv3:check` 还会解析 Background 的完整静态 ESM 依赖闭包；当前共 8 个文件，
必须保持零 `ImportExpression`，防止将运行时 `import()` 再次带回 Service Worker。

## 10. OAuth Provider 独立安全里程碑

OAuth Provider 不在本期代码、UI、IPC、权限和存储模型中预留“半成品入口”。
后续必须单独立项，并至少完成以下安全评审与验收：

1. 为每家 Provider 单独确认官方授权方式、scope 和服务条款。
2. 授权码流程必须使用 PKCE、随机 `state` 和一次性 verifier。
3. 回调必须严格校验扩展 ID、origin、路径、state、授权窗口和超时。
4. 设备码流程必须限制轮询频率、总时长并支持用户主动取消。
5. Access token、refresh token、API Key 使用不同的可辨识存储模型。
6. 刷新必须并发去重，支持过期前刷新、refresh token rotation 和失败失效。
7. 必须提供撤销授权、退出登录和本地令牌彻底删除。
8. 令牌不得进入 UI 快照、日志、诊断、备份、错误正文或遥测。
9. 新增 `chrome.identity`、tabs、回调 Host Permission 前必须重新做最小权限评审。
10. 覆盖 state/PKCE、回调伪造、重放、刷新竞态、撤销、断网和扩展重启测试。

完成上述里程碑前，BossPilot 只支持 API Key、本地 Ollama和自定义兼容端点，
不会把 OAuth token 当作 API Key 保存，也不会声称支持 Codex 或 GitHub Copilot 登录。

## 11. 已知限制与下一步

- 岗位意图解析、岗位评估和报告摘要仍走旧的 `lib/llm` 配置；本期只迁移普通聊天。
- 多厂商自动化验证使用协议 mock 和真实 MV3 扩展，不会在 CI 中消耗用户付费 Key；
  发布前仍应对重点厂商做人工冒烟测试。
- `pi-ai` 的精确模型目录随锁定版本更新；SDK 未收录的新模型会使用注册表协议兜底，
  升级依赖时必须重新跑协议、构建、体积和 E2E 门禁。
- 当前只处理文本消息，不传输图片、音频、工具调用或隐藏思维链。
- Background 的活跃流快照仍是内存状态；Service Worker 在生成中被系统终止时，
  能明确恢复为错误现场，但不能从上游断点续传。

下一期如果继续主线，应优先评审“岗位任务流水线迁移到同一活动模型解析器”，
而不是在普通聊天上提前叠加 OAuth、自动路由或完整 Agent loop。
