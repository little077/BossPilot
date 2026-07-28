# 站点适配层契约（SiteAdapter）

> `lib/adapter/zhipin.ts` 是所有与 zhipin.com 页面结构耦合知识的**单一事实源**。本文档描述其契约与维护流程。

## 1. 契约版本

| 版本 | 观察日期 | 说明 |
| --- | --- | --- |
| v1 | 2026-07 | 初始版本：web 搜索页 + 职位详情页 |

代码中的 `ADAPTER_VERSION` 常量与本表保持同步；**不兼容变更**（字段语义变化、返回结构变化）必须递增版本号。

## 2. URL 规则

### 搜索页

```
https://www.zhipin.com/web/geek/job?query={关键词}&city={城市码}&page={页码}
```

- 只用 `query` / `city` / `page` 三个最稳定的参数。薪资等筛选的 URL 编码枚举随版本变动大，**刻意不用**——薪资过滤在采集后本地做（`passesSalaryFilter`）。
- 城市码表在 `lib/adapter/city-codes.ts`（40 城 + 全国）。未收录城市降级为「城市名并入关键词」全国搜。

### 详情页

```
https://www.zhipin.com/job_detail/{加密id}.html
```

职位加密 id 从列表卡片链接中以 `/job_detail/([^.]+)\.html/` 提取，作为岗位去重主键。

## 3. 注入函数契约（重要）

`extractJobList()` 与 `extractJobDetail()` 通过 `chrome.scripting.executeScript({ func })` 注入页面执行。函数会被**序列化**后传输，因此：

1. **必须自包含**：函数体内不能引用任何外部变量、import、闭包——所有选择器、正则、辅助函数都要内联在函数体里。
2. **返回值必须可结构化克隆**：纯 JSON 数据，不含 DOM 节点/函数。
3. **必须无副作用**：只读取 DOM，不修改页面、不发请求。

## 4. 返回结构与语义

两个抽取函数统一携带诊断字段：

| 字段 | 语义 | 上层处理 |
| --- | --- | --- |
| `captcha: true` | 命中验证码/安全拦截页 | 编排器挂起 `paused_captcha`，等用户手动通过 |
| `selectorMiss: true` | 关键选择器全部失配 | 提示「站点可能改版」，终止翻页 |

验证码检测特征（与 content script 保持一致）：URL 含 `security-check`/`captcha`，或页面前 2000 字符命中 `/安全验证|请完成验证|异常访问/`。

## 5. 选择器契约（v1）

### 列表页 `extractJobList`

| 目标 | 候选选择器（按序尝试） |
| --- | --- |
| 职位卡片 | `li.job-card-wrapper` → `li.job-card-box` → `div.job-card-wrapper` → `ul.job-list-box > li` |
| 详情链接 | `a.job-card-left`, `a.job-card-body`, `a[href*="/job_detail/"]` |
| 标题 | `.job-name`, `.job-title .job-name`, `.job-title` |
| 薪资 | `.salary`, `.job-salary` |
| 公司名 | `.company-name a`, `.company-name`, `.boss-name` |
| 区域 | `.job-area`, `.company-location` |
| 职位标签 | `.job-info .tag-list li`, `ul.tag-list li` |
| 公司标签 | `.company-tag-list li`, `.company-info .tag-list li` |
| 下一页 | `.options-pages a:last-child:not(.disabled)`, `.pagination-area a.next:not(.disabled)` |

### 详情页 `extractJobDetail`

| 目标 | 候选选择器 |
| --- | --- |
| JD 全文 | `.job-sec-text`, `.job-detail-section .job-sec-text`, `.job-detail .text` |
| 公司介绍 | `.company-info-box .job-sec-text`, `.company-detail .text`, `.job-sec.company-info .text` |
| 城市 | `.text-city`, `.job-primary .text-city` |

## 6. 薪资解析规则（`parseSalary`）

| 输入示例 | 解析结果（K/月） |
| --- | --- |
| `15-25K` / `15-25K·14薪` | min=15, max=25 |
| `20K` | min=20, max=20 |
| `300-500元/天` | ×21.75/1000（日薪按 21.75 天/月折算） |
| `8-12万/年` | ×10/12（年薪按 12 月折算） |
| `面议` 等 | 空对象（不参与本地薪资过滤，保留给语义层） |

## 7. 站点改版时的维护流程

1. 打开失效页面，DevTools 检查新 DOM 结构。
2. 把新选择器**追加**到对应候选数组（保留旧选择器兜底，宽容匹配是设计原则）。
3. 若字段语义/返回结构变化 → 递增 `ADAPTER_VERSION` 并更新本文档第 1、5 节。
4. 手动验证：真实执行一次「采集 → 评估 → 报告」全流程。
5. PR 附脱敏的 DOM 片段截图与验证说明。
