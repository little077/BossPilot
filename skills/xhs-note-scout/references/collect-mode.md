# 指定数量模式（collect-mode）

用户选择了固定数量（如 20 篇）时的循环节奏与终止条件。

## 参数

- 目标数量 `N` 来自 ask_user 的答案，缺省 20。
- 每轮 `scripts/collect-page.js` 的参数：`{ "maxNotes": N - 已收集, "maxScrolls": 1, "waitMs": 1200 }`。

## 循环节奏

1. 运行 collect-page，得到 `{ notes, collected, scrollCount, atBottom, captcha, selectorMiss }`。
2. 按 `noteId` 与上一轮合并去重，保留已有字段（同一卡片的数据以先到者为准）。
3. 未到 N 且无异常 → 继续下一轮；已到 N → 进入逐篇读取。不要为了加速把单轮滚动次数调大。
4. 每 3 轮向用户简短汇报一次进度（已收集/目标），不用 ask_user，直接在正文说明即可。

## 终止条件（任一满足即停）

- 去重后数量 ≥ N。
- `atBottom === true`：如实报告「列表已到底，实际收集 M/N」。
- `selectorMiss === true`：告知用户页面结构疑似改版，停止。
- `captcha === true`：立即停止滚动和点击，请用户手动验证后，用户确认再继续。
- 连续 3 轮 `collected` 无增长且未到底：请用户滚动一下页面或刷新后重试。

## 注意

- 采集到的 `notes` 数组要完整保留（noteId/href/title/likes/hasVideo），逐篇读取阶段需要 noteId 和 title。
- 不要用脚本以外的方式翻页或滚动。
