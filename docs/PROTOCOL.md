# 消息协议（IPC）

> 类型定义的单一事实源是 [`lib/ipc/protocol.ts`](../lib/ipc/protocol.ts)，本文档解释语义与时序。协议变更时必须同步更新两处。

## 1. 通道总览

| 通道 | 机制 | 用途 |
| --- | --- | --- |
| Sidepanel ↔ Background | `chrome.runtime.connect` 长连接 Port（名称 `bosspilot-agent`） | 指令下发 + 任务快照/日志流式广播 |
| Content Script → Background | `chrome.runtime.sendMessage` | 验证码检测上报（单向、无应答） |
| Background → 页面 | `chrome.scripting.executeScript` | 注入自包含抽取函数（非消息，见 [ADAPTER.md](ADAPTER.md)） |

## 2. Client → Background（`ClientMessage`）

| 消息 | 载荷 | 语义 |
| --- | --- | --- |
| `subscribe` | — | 连接后声明订阅；后台立即回放当前 `TaskSnapshot`（断线重连恢复现场的关键） |
| `parse_only` | `text` | 仅做意图解析不执行；结果以 `parsed` 返回，UI 渲染成可编辑任务卡片 |
| `run_params` | `params: SearchTaskParams` | 用确认后的结构化参数执行任务（**推荐路径**，人机协同） |
| `run_nl` | `text` | 自然语言直接跑（解析后不经确认立即执行） |
| `cancel` | — | 取消当前任务（AbortController 全链路生效） |
| `resume_captcha` | — | 用户宣布已手动通过验证码，释放验证码门 |
| `download_report` | — | 后台经 `chrome.downloads` 下载当前报告 |

## 3. Background → Client（`ServerMessage`）

| 消息 | 载荷 | 语义 |
| --- | --- | --- |
| `connected` | — | Port 建立成功的握手信号；客户端收到后应立刻发 `subscribe` |
| `snapshot` | `snapshot: TaskSnapshot` | 任务快照全量广播（phase/进度文本/已采集数/岗位数组/报告） |
| `parsed` | `params: SearchTaskParams` | `parse_only` 的解析结果 |
| `log` | `level, text` | 面向用户的日志（追加到对话流；warn=验证码/改版提示） |
| `error` | `text` | 指令处理失败（如未配置 API Key） |

## 4. 典型时序

### 标准任务（人机协同路径）

```
Sidepanel                          Background
   │ ── connect ──────────────────► │
   │ ◄────────────── connected ──── │
   │ ── subscribe ─────────────────► │
   │ ◄─────── snapshot(idle) ────── │
   │ ── parse_only("找西安前端…") ──► │ ①意图解析（1 次 LLM）
   │ ◄─────────────── parsed ────── │
   │   （用户编辑/确认任务卡片）        │
   │ ── run_params ────────────────► │ ②采集 → ③评估 → 报告
   │ ◄── snapshot(searching…) ───── │（每次状态变化都会广播）
   │ ◄── snapshot(collecting…) ──── │
   │ ◄── snapshot(assessing…) ───── │
   │ ◄── snapshot(done+report) ──── │
   │ ── download_report ───────────► │ chrome.downloads
```

### 验证码人机协同

```
   │ ◄── log(warn "遇到安全验证…") ── │
   │ ◄── snapshot(paused_captcha) ── │（流水线挂起在 captchaGate）
   │   （用户在页面手动通过验证）        │
   │ ── resume_captcha ────────────► │（resolve 门，恢复原 phase 重试）
   │ ◄── snapshot(collecting…) ───── │
```

### 断线重连（MV3 SW 休眠）

Port 断开 → 客户端 500ms 后自动重连 → 重新 `subscribe` → 后台回放最新快照。UI 不在本地维护任务状态，因此重连即恢复，无需增量补偿。

## 5. 协议演进规则

- 新增消息：向 union 类型追加成员即可（旧客户端忽略未知类型）。
- 修改载荷结构：属于破坏性变更，需同时更新收发两端与本文档，并在 PR 中注明。
- 快照始终**全量**发送（岗位数 ≤40，体量可控），刻意不做增量 diff 以换取实现简单与断线恢复能力。
