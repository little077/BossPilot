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
③ 批量语义评估 ─ 1~2 次 LLM ─► JobAssessment[]（软条件过滤 + 打分）+ 报告总评
     │
     ▼
Markdown 报告（主体由确定性代码渲染，LLM 只写总评段）
```

## 2. 运行时分层（Chrome MV3）

```
┌─────────────────┐   Port 长连接（流式快照广播）   ┌──────────────────────┐
│  Sidepanel (UI)  │ ◄──────────────────────────► │ Background SW (大脑)   │
│  React 19        │   ClientMessage/ServerMessage │  Orchestrator 单例     │
└─────────────────┘                               └──────┬───────────────┘
                                                          │ chrome.tabs（导航）
                                                          │ chrome.scripting（注入抽取函数）
                                                          ▼
                                              ┌──────────────────────┐
                                              │  zhipin.com 工作标签页  │
                                              │  Content Script       │──► runtime.sendMessage
                                              │ （仅验证码检测上报）      │    （验证码上报）
                                              └──────────────────────┘
```

| 运行时 | 入口 | 职责 | 明确不做 |
| --- | --- | --- | --- |
| Sidepanel | `entrypoints/sidepanel/` | 对话/任务卡片/结果/报告/设置 UI | 不直接碰页面、不调 LLM |
| Background | `entrypoints/background.ts` | Port 服务端；编排流水线；调 LLM；控制标签页 | 不持有 UI 状态以外的持久数据 |
| Content Script | `entrypoints/zhipin.content.ts` | 验证码检测上报（30s 后停止观察） | 不抽取数据、不注册长期监听 |

抽取逻辑为什么不放 content script？——`chrome.scripting.executeScript` 注入**自包含函数**按需执行，让抽取函数与适配层代码放在同一文件、同一次代码审查里，避免「常驻脚本 + 消息桥」的复杂度。代价是注入函数内不能引用闭包变量（契约见 [ADAPTER.md](ADAPTER.md)）。

## 3. 模块地图与依赖方向

```
entrypoints/sidepanel ──► lib/ipc/protocol ◄── entrypoints/background
        │                                              │
        ▼                                              ▼
  lib/storage/config                          lib/pipeline/orchestrator
  （设置页直读直写）                                   │
        │              ┌───────────────┬──────────────┼──────────────┐
        ▼              ▼               ▼              ▼              ▼
  lib/domain/types  lib/adapter/*  lib/llm/*   lib/pipeline/throttle  lib/report/markdown
  （所有模块的底座，不依赖任何其他模块）
```

规则：依赖只能**向下**；`lib/domain/types.ts` 是唯一的实体事实源；`lib/ipc/protocol.ts` 是唯一的消息事实源。

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
                             assessing → reporting → done
（任意阶段可 → error / cancelled）
```

关键实现点：

- **快照即协议**：UI 不维护自己的任务状态，只渲染 `TaskSnapshot`。SW 休眠断连后重连 `subscribe` 即可恢复现场。
- **验证码门**：检测到验证码 → 挂起一个 Promise（`captchaGate`），phase 置 `paused_captcha`；用户点「继续」resolve；取消任务 reject。
- **风控**：`MAX_PAGES=5`、`maxJobs≤40` 硬上限；翻页 2.5~5s、进详情 1.8~4s 随机延迟（`lib/pipeline/throttle.ts`）。

## 5. LLM 层

- `lib/llm/client.ts`：仅依赖标准 Chat Completions 协议（BYOK），运行在 Background（扩展 host 权限，无 CORS）。`extractJson` 容忍代码块围栏与前后杂文。
- `lib/llm/prompts.ts`：三段式的全部 Prompt。批量评估做了防御性合并——模型漏答的岗位补保守默认值（passed=true, score=50），保证「每个输入岗位都有输出」。
- 批量大小 `batchSize`（默认 10）可在设置页调整，兼容小上下文模型。

## 6. 存储分层

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| LLM 配置（BYOK） | `chrome.storage.local` | `lib/storage/config.ts`，key 前缀 `bosspilot:` |
| 用户简历档案 | `chrome.storage.local` | 参与匹配打分，可为空 |
| 任务快照 | Background 内存 | 会话级，SW 回收即失；报告可下载沉淀 |
| 报告产物 | `chrome.downloads` | UTF-8 → base64 data URL（规避 SW 中 Blob URL 生命周期问题） |

## 7. 安全与合规设计

- 权限最小化：`host_permissions` 仅 `https://www.zhipin.com/*`。
- 外发最小化：只把结构化岗位字段 + 用户档案发给用户自己配置的端点；JD 截 1500 字、公司介绍截 400 字。
- 合规红线：不自动投递/不自动发消息；验证码永远交给人。
- 无遥测、无云端、无账号体系。

## 8. 已知局限与演进方向

- 适配层选择器基于 2026-07 的页面观察（v1），改版需按 [ADAPTER.md](ADAPTER.md) 流程更新。
- 无自动化测试；纯函数（`parseSalary`/`buildSearchUrl`/`extractJson`/`buildReport`）是最适合先补单测的部分。
- 任务状态不持久化，SW 被强杀后任务丢失（报告除外）——P1 计划引入 Dexie 台账。
