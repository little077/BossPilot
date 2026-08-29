# 消息协议（IPC）

> 类型定义的单一事实源是 [`lib/ipc/protocol.ts`](../lib/ipc/protocol.ts)，本文档解释语义与时序。协议变更时必须同步更新两处。
> 当前主路径是多会话 Agent 协议；`parse_only`、`run_params`、`run_nl`、任务 `snapshot`
> 等消息属于早期 Boss 三段式流水线兼容通道，不应用于新增通用能力。

## 1. 通道总览

| 通道 | 机制 | 用途 |
| --- | --- | --- |
| Sidepanel ↔ Background | `chrome.runtime.connect` 长连接 Port（名称 `bosspilot-agent`） | 对话流、任务指令、快照与日志 |
| Extension Page ↔ Background | `chrome.runtime.sendMessage` | Provider、Skills、MCP、记忆、备份与工作区命令 |
| Content Script → Background | `chrome.runtime.sendMessage` | Boss Skill 验证码检测上报（单向、无应答） |
| Background → 页面 | `chrome.scripting.executeScript` | 页面读取、观察与受约束交互；注入函数必须自包含 |

## 2. Client → Background（`ClientMessage`）

| 消息 | 载荷 | 语义 |
| --- | --- | --- |
| `subscribe` | — | 连接后声明订阅；后台回放任务快照、最新聊天快照和聊天运行状态 |
| `chat` | `requestId, conversationId, messages` | 兼容入口；新代码优先使用 `run:*` 会话协议 |
| `run:start` | `runId, conversationId, messages` | 启动一个会话 Agent 运行 |
| `run:steer` | `runId, conversationId, content` | 把用户补充指令送入仍在运行的会话 |
| `run:retry` | `runId, conversationId, messages` | 使用保存的会话上下文重试失败运行 |
| `run:cancel` | `runId, conversationId` | 精确取消指定运行 |
| `run:resume` | `runId, conversationId, messages` | 从可恢复 checkpoint 继续运行 |
| `page_permission_result` | 授权请求标识与选择 | 恢复等待页面读取、交互或视觉权限的工具调用 |
| `ask_user_result` | 运行、问题与答案标识 | 恢复等待用户澄清的 Agent 运行 |
| `parse_only` | `text` | 仅做意图解析不执行；结果以 `parsed` 返回，UI 渲染成可编辑任务卡片 |
| `run_params` | `params: SearchTaskParams` | 用确认后的结构化参数执行任务（**推荐路径**，人机协同） |
| `run_nl` | `text` | 自然语言直接跑（解析后不经确认立即执行） |
| `cancel` | `scope?, requestId?` | 精确取消聊天、任务或二者；聊天 requestId 不匹配时不产生副作用 |
| `clear_chat` | — | 清除 Background 中最近聊天回放；活动生成不会被清除 |
| `resume_captcha` | — | 用户宣布已手动通过验证码，释放验证码门 |
| `download_diagnostics` | — | 导出已脱敏的本地执行日志 |

## 3. Background → Client（`ServerMessage`）

| 消息 | 载荷 | 语义 |
| --- | --- | --- |
| `connected` | — | Port 建立成功的握手信号；客户端收到后应立刻发 `subscribe` |
| `chat_state` | `running, requestId?` | 声明 Background 是否仍持有活动聊天，用于识别 SW 中断 |
| `run_state` | `runs: AgentRunSnapshot[]` | 全量广播当前多会话运行、队列、暂停点和恢复状态 |
| `snapshot` | `snapshot: TaskSnapshot` | 任务快照全量广播（phase/进度文本/已采集数/岗位数组） |
| `parsed` | `params: SearchTaskParams` | `parse_only` 的解析结果 |
| `log` | `level, text` | 面向用户的日志（追加到对话流；warn=验证码/改版提示） |
| `stream_start` | `requestId, message` | 流式回复开始；message 是完整 assistant 快照 |
| `stream_update` | `requestId, message` | 正文更新；始终覆盖同一 message.id，不依赖 delta 完整到达 |
| `stream_end` | `requestId, message` | 正常完成或用户停止，持久化完整终态 |
| `stream_error` | `requestId, message` | 生成失败；正文、错误码和错误说明分离，保留部分内容 |
| `error` | `text, requestId?` | 指令或生成前解析失败（如未选择模型） |

## 4. 典型时序

### 流式对话

```
Sidepanel                          Background
   │ ── chat(requestId, history) ──► │
   │ ◄──── stream_start(snapshot) ── │
   │ ◄─── stream_update(snapshot) ── │（重复 0..N 次）
   │ ── cancel(chat, requestId) ───► │（可选）
   │ ◄───── stream_end(snapshot) ─── │（完成或取消）
   │   （assistant 终态写入 IndexedDB） │
```

### 搜索任务（人机协同路径）

```
Sidepanel                          Background
   │ ── connect ──────────────────► │
   │ ◄────────────── connected ──── │
   │ ── subscribe ─────────────────► │
   │ ◄─────── snapshot(idle) ────── │
   │ ── parse_only("找西安前端…") ──► │ ①意图解析（1 次 LLM）
   │ ◄─────────────── parsed ────── │
   │   （用户编辑/确认任务卡片）        │
   │ ── run_params ────────────────► │ ②采集 → ③评估
   │ ◄── snapshot(searching…) ───── │（每次状态变化都会广播）
   │ ◄── snapshot(collecting…) ──── │
   │ ◄── snapshot(assessing…) ───── │
   │ ◄──────── snapshot(done) ───── │（结果页读取 jobs）
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

Port 断开 → 客户端 500ms 后自动重连 → 重新 `subscribe` → 后台依次回放任务快照、
最新聊天快照和 `chat_state`。

- Background 仍持有活动轮次：UI 按相同 message.id 覆盖恢复。
- Background 已开始另一轮请求：旧窗口保留上一轮部分正文并将其终结为中断错误，
  再按后台权威 requestId 接管新请求，不遗留旧流式光标。
- 整个 SW 在生成中途丢失：`chat_state.running=false`，UI 明确记录“生成连接已中断”，
  不把部分内容伪装成完成。
- 模型解析阶段失败、尚无 `stream_start`：后台广播精确 requestId 的错误，
  所有已绑定该请求的重连窗口都能解除运行状态，且不会误终结随后启动的新请求。
- 最近终态已在 IndexedDB：回放仍按相同 ID 覆盖，不产生重复消息。

## 5. 运行时校验与安全上限

- Provider Runtime Message 和 Agent Port 只接受本扩展页面。
- `chat` 最多 200 条消息；单条最多 100,000 字符；总正文最多 500,000 字符。
- assistant 生成正文最多 100,000 个 UTF-16 字符；超过后立即停止并返回
  `OUTPUT_LIMIT_EXCEEDED`，即使上游忽略 `maxTokens` 也不能绕过。
- requestId 最多 128 字符，模型 ID 最多 256 字符，Provider ID 最多 64 字符。
- API Key 最多 16,384 字符，Base URL 最多 2,048 字符。
- 任何响应和状态快照都不能携带明文 API Key。

## 6. 协议演进规则

- 新增消息：向 union 类型追加成员，并同步更新 `isClientMessage`、收发两端、测试和本文档。
- 修改载荷结构：属于破坏性变更，需同时更新收发两端与本文档，并在 PR 中注明。
- 任务快照和 assistant 消息始终**全量**发送，刻意不做增量 diff，以换取幂等覆盖和
  断线恢复能力；流式中间快照最多每 50ms 广播一次，首段和终态立即发送。
