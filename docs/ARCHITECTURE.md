# BossPilot 架构设计

> 面向贡献者的技术总览。阅读本文后你应该能回答：数据从哪来、往哪去、每个模块的边界在哪里。

## 1. 设计哲学：定制 Agent ≠ 通用 Agent

通用浏览器 Agent 的模式是「LLM 每一步读全页 → 猜选择器 → 决定点哪」，单次搜索需要 10~30 次 LLM 调用，慢、贵、易错。

BossPilot 的核心决策：**Boss 直聘的页面结构是已知的**。把选择器、URL 参数、翻页逻辑写死进站点适配层，LLM 只负责语义。由此得到三段式流水线：

```
用户自然语言
     │
     ▼
① 意图解析 ─── 1 次 LLM ───► SearchTaskParams（硬条件 + 软条件）
     │
     ▼
② 确定性采集 ── 0 次 LLM ───► JobPosting[]（适配层：搜索/翻页/详情抽取）
     │
     ▼
③ 批量语义评估 ─ 1~N 次 LLM ─► JobAssessment[]（软条件过滤 + 打分）
     │
     ▼
结构化结果页（通过/排除、匹配分、亮点与风险）
```

## 2. 运行时分层（Chrome MV3）

```
┌─────────────────┐   Port 长连接（全量快照）     ┌────────────────────────┐
│  Sidepanel (UI)  │ ◄────────────────────────► │ Background Module SW   │
│  React 19        │ ClientMessage/ServerMessage │ ├─ ChatGenerationManager│
│  IndexedDB       │                             │ └─ Orchestrator         │
└─────────────────┘                             └──────┬─────────┬───────┘
                                                      │         │
                                      五协议流式生成 ──┘         │ tabs/scripting
                                                      ▼         ▼
                                                模型厂商     zhipin.com 标签页
                                                               │
                                                    Content Script（仅验证码上报）
```

| 运行时 | 入口 | 职责 | 明确不做 |
| --- | --- | --- | --- |
| Sidepanel | `entrypoints/sidepanel/` | 对话/任务卡片/结果/设置 UI；会话 IndexedDB | 不直接碰页面、不直接调模型 |
| Background | `entrypoints/background.ts` | Port 服务端；聊天生成；编排流水线；控制标签页 | 不把凭据放进 IPC/诊断 |
| Content Script | `entrypoints/zhipin.content.ts` | 验证码检测上报（30s 后停止观察） | 不抽取数据、不注册长期监听 |

抽取逻辑为什么不放 content script？——`chrome.scripting.executeScript` 注入**自包含函数**按需执行，让抽取函数与适配层代码放在同一文件、同一次代码审查里，避免「常驻脚本 + 消息桥」的复杂度。代价是注入函数内不能引用闭包变量（契约见 [ADAPTER.md](ADAPTER.md)）。

## 3. 模块地图与依赖方向

```
entrypoints/sidepanel ──► lib/ipc/protocol ◄── entrypoints/background
        │                                              │
        ├─► lib/storage/db                             ├─► lib/generation/manager
        └─► lib/providers/client                       │      │
                                                       │      ├─► generation/resolve
                                                       │      └─► generation/pi-adapter
                                                       └─► lib/pipeline/orchestrator
                                                              ├─► lib/adapter/*
                                                              └─► lib/llm/*（旧任务链）

lib/domain/chat.ts + lib/domain/types.ts
  （跨运行时实体底座，不依赖入口）
```

规则：依赖只能**向下**；聊天实体归 `lib/domain/chat.ts`，任务与 Provider 视图实体归
`lib/domain/types.ts`；`lib/ipc/protocol.ts` 是唯一的跨运行时消息事实源。

## 4. 任务生命周期（Orchestrator）

`lib/pipeline/orchestrator.ts` 是单例状态机，对外暴露：

- `runNaturalLanguage(text)` / `runWithParams(params)` — 发起任务（同一时刻仅一个）
- `cancel()` — AbortController 贯穿所有 sleep / fetch / 循环检查点
- `resumeCaptcha()` — 释放验证码门（`captchaGate` Promise）
- `onSnapshot()` / `onLog()` — 状态订阅（Background 入口转发给 Port）

`TaskPhase` 状态流：

```
idle → parsing → searching → collecting ↔ paused_captcha
                                  │
                                  ▼
                             detailing ↔ paused_captcha
                                  │
                                  ▼
                             assessing → done
（任意阶段可 → error / cancelled）
```

关键实现点：

- **快照即协议**：UI 不维护自己的任务状态，只渲染 `TaskSnapshot`。SW 休眠断连后重连 `subscribe` 即可恢复现场。
- **验证码门**：检测到验证码 → 挂起一个 Promise（`captchaGate`），phase 置 `paused_captcha`；用户点「继续」resolve；取消任务 reject。
- **风控**：`MAX_PAGES=5`、`maxJobs≤40` 硬上限；翻页 2.5~5s、进详情 1.8~4s 随机延迟（`lib/pipeline/throttle.ts`）。

## 5. 模型生成层

普通聊天与旧任务流水线目前是两条明确分开的调用链。

### 5.1 普通聊天（v0.2）

```text
activeModel
  → resolveActiveGenerationTarget()
  → ResolvedGenerationTarget（仅 Background 含 Key）
  → createPiGenerationAdapter()
  → start / text-delta / finish
  → ChatGenerationManager 完整 ChatMessage 快照
```

- `lib/providers/registry.ts` 分开声明目录发现协议和生成协议。
- `lib/generation/resolve.ts` 校验活动模型、实时目录、密钥、URL 和精确 Host Permission。
- `lib/generation/pi-adapter.ts` 静态链接 `@earendil-works/pi-ai@0.80.6` 的五个公开
  非 lazy API 流和 `providers/*.models` 元数据，兼容 MV3 Service Worker 禁止运行时
  `import()` 的约束；支持 OpenAI Completions、OpenAI Responses、Anthropic Messages、
  Google Generative AI 与 Mistral Conversations。
- `lib/generation/manager.ts` 固定单轮模型、保证唯一终态、精确取消、全量快照和密钥脱敏；
  输出受 100,000 字符硬上限保护，中间快照按 50ms 最小间隔合并广播。
- 失败不自动换模型，SDK 自动重试关闭；当前模型的选择只影响下一轮。

完整设计、安全边界和验证结果见
[多模型二期实施报告](multi-model-phase-2-report.md)。

### 5.2 岗位任务流水线（待迁移）

- `lib/llm/client.ts` 仍依赖旧 `LlmConfig` 和 Chat Completions 协议。
- `lib/llm/prompts.ts` 提供意图解析与批量评估 Prompt。
- 该链路本期没有偷偷改用活动模型；后续迁移必须单独评审和测试。

## 6. 存储分层

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| Provider 连接、密钥、活动模型 | `chrome.storage.local` | `bosspilot:providers:v1`；UI 快照不含明文 Key |
| 旧任务 LLM 配置 | `chrome.storage.local` | `lib/storage/config.ts`；仅旧流水线仍使用 |
| 用户简历档案 | `chrome.storage.local` | 旧任务评估可读取，设置页当前不展示 |
| 任务快照 | Background 内存 | 会话级，SW 回收即失 |
| 活跃聊天快照 | Background 内存 | Port 重连回放当前或最近终态 |
| 对话历史 | IndexedDB（Dexie） | 侧边栏冷启动回放；发送时携带完整历史 |
| 诊断日志 | Background 内存 → `chrome.downloads` | 只记录脱敏端点主机和无凭据指标 |

## 7. 安全与合规设计

- 常驻权限最小化：`host_permissions` 仅 `https://www.zhipin.com/*`；模型端点使用
  `optional_host_permissions`，在用户点击开通时按具体 origin 申请。
- Background 启动时立即把 `chrome.storage.local` 限制为 `TRUSTED_CONTEXTS`；若浏览器无法建立该隔离，Provider 配置与模型调用会失败关闭，内容脚本不能在降级状态下读取模型密钥。
- 内置生成地址只信注册表；SDK 精确模型必须与已授权目标同源，防止密钥外发。
- Provider Runtime Message 和 Agent Port 都校验发送方扩展 ID 与扩展 URL；
  验证码上报只接受 zhipin.com 内容脚本。
- 外发最小化：只把结构化岗位字段 + 用户档案发给用户自己配置的端点；JD 截 1500 字、公司介绍截 400 字。
- 合规红线：不自动投递/不自动发消息；验证码永远交给人。
- 无遥测、无云端、无账号体系。
- OAuth Provider 不属于 API Key 流程，必须作为独立安全里程碑实现。

## 8. 已知局限与演进方向

- 适配层选择器基于 2026-07 的页面观察（v1），改版需按 [ADAPTER.md](ADAPTER.md) 流程更新。
- Vitest 覆盖模型解析、五协议适配、会话管理、IPC、Sidepanel 重连和 Provider 基座；
  Playwright 加载生产 MV3 扩展验证设置、聊天闭环、主题和 Manifest 权限。
- 精确厂商目录随锁定的 `pi-ai` 版本更新；升级依赖必须重新通过协议、覆盖率、
  构建体积和真实扩展 E2E。
- 普通聊天不支持工具调用、图片、语音和断点续传。
- 任务状态不持久化，SW 被强杀后搜索任务丢失——P1 计划引入 Dexie 台账。
