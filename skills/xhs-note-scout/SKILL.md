---
name: xhs-note-scout
description: 在小红书博主主页采集笔记列表，逐篇读取笔记详情与评论区，并汇总成内容调研报告。用户提到小红书、博主主页、笔记采集、评论分析、内容调研或竞品分析时使用。
metadata:
  bosspilot-origins: https://www.xiaohongshu.com/*
  bosspilot-permissions: page.read page.script workspace.write
allowed-tools: run_skill ask_user load_skill
---

# 小红书笔记调研

把小红书博主主页当作当前页面，把本 Skill 的 scripts 当作唯一执行能力。
你负责决策、提问与总结，不负责「边猜边点」。

## 三层分工

- **不确定的决策** → `ask_user` 问用户：采集模式与数量、是否继续、异常怎么处理。
- **确定性的重复操作** → `run_skill` 跑脚本：滚动、开弹窗、抽取、关弹窗、存文件。
- **复杂总结** → 你来写：主题归纳、数据汇总、洞察与缺口。

**每个回合只调用一个工具**。不要并行请求多个脚本或工具，等上一个返回后再决定下一步。

## 工作流

1. 确认当前标签页是小红书博主主页（`/user/profile/{id}`）。不是时请用户打开对应主页，**不猜测 URL**。
2. 运行 `scripts/read-profile.js` 读取博主画像（昵称/互动数据），报告里要用。
3. `ask_user` 询问采集模式：指定数量（默认 20 篇）或自由探索（逐篇确认）。
4. 循环运行 `scripts/collect-page.js` 累积卡片（去重合并 noteId），直到达到目标数量或返回 `atBottom`。每轮默认只小步滚动，不要提高滚动次数来“加速”。
5. 对每一篇笔记：`scripts/open-note.js` → `scripts/read-note.js` → `scripts/read-comments.js` → `scripts/close-note.js`。
   - 调用 `open-note.js` 时把卡片里的 `noteId` 与 `openHref`/`href` 一起传入。
   - `open-note.js` 返回 `open: false` 时不要连续点击；直接询问用户是跳过、手动打开后继续，还是停止。
   - 进入下一篇前必须确认 `close-note.js` 返回 `open: false`。
6. 需要留档时运行 `scripts/save-results.js` 把汇总数据写入工作区 `reports/` 目录。
7. 全部结束后按总结模板输出调研报告。

## 异常处理（脚本结果驱动，不靠猜）

- `selectorMiss: true` → 站点可能改版：停止采集，告知用户「页面结构已变化」，不要换方式硬试。
- `captcha: true` → 停下请用户手动完成验证，用户确认后继续；不要继续滚动、点击或读取。
- `open-note.js` 返回 `open: false` → 不要自动重试；问用户是否跳过该篇、手动打开后继续，或停止任务。
- `open-note.js` 返回 `reason` 包含“已有其他笔记弹窗打开” → 先运行 `close-note.js`，确认关闭后再继续。
- `atBottom: true` → 列表已到末尾，结束采集并如实报告已收集数量。

## 约束

- 不猜测小红书的选择器、URL、接口或页面内容；脚本结果里缺失的字段就是缺失。
- 不得用通用浏览器工具观察小红书页面来代替脚本——这是本 Skill 的边界。
- 不点赞、不关注、不评论、不发送私信，不点击作者、互动、评论、关注等区域；本 Skill 只读页面内容。
- 采集数量、继续/停止、异常处置必须尊重 ask_user 的答案。
- 报告必须区分事实（脚本返回）与推断（你的分析）。

## 按需参考

- 指定数量模式的循环节奏与终止条件：`references/collect-mode.md`
- 自由探索模式的逐篇确认流程：`references/explore-mode.md`
- 调研报告模板与写作规范：`references/summary-guide.md`
