# Boss 直聘内置 Skill：站点适配层契约（SiteAdapter）

> 本文是 `boss-job-search` 内置 Skill 的站点契约，不代表 BossPilot 只能用于 Boss 直聘。
> `lib/adapter/zhipin.ts` 是所有与 zhipin.com 页面结构耦合知识的**单一事实源**。本文档描述其契约与维护流程。

## 1. 契约版本

| 版本 | 观察日期 | 说明 |
| --- | --- | --- |
| v1 | 2026-07 | 初始版本：web 搜索页 + 职位详情页 |
| v2 | 2026-07 | 当前岗位读取支持独立详情页与列表页内展开的详情面板，并补齐岗位核心字段 |
| v3 | 2026-07 | 增加推荐岗位列表滚动采集，并兼容右侧详情的 `p.desc` 正文与 `job-address-desc` 地址 |

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

`extractJobList()`、`scrollJobListStep()` 与 `extractJobDetail()` 通过
`chrome.scripting.executeScript({ func })` 注入页面执行。函数会被**序列化**后传输，因此：

1. **必须自包含**：函数体内不能引用任何外部变量、import、闭包——所有选择器、正则、辅助函数都要内联在函数体里。
2. **返回值必须可结构化克隆**：纯 JSON 数据，不含 DOM 节点/函数。
3. `extractJobList()` 与 `extractJobDetail()` **必须无副作用**：只读取 DOM，不修改页面、不发请求。
4. `scrollJobListStep()` 只能移动已识别岗位列表的滚动位置，不得点击、导航、修改 DOM
   或主动发请求；懒加载请求由页面自身的滚动行为触发。

## 4. 返回结构与语义

两个抽取函数统一携带诊断字段：

| 字段 | 语义 | 上层处理 |
| --- | --- | --- |
| `captcha: true` | 命中验证码/安全拦截页 | 编排器挂起 `paused_captcha`，等用户手动通过 |
| `selectorMiss: true` | 关键选择器全部失配 | 提示「站点可能改版」，终止翻页 |

验证码检测特征（与 content script 保持一致）：URL 含 `security-check`/`captcha`，或页面前 2000 字符命中 `/安全验证|请完成验证|异常访问/`。

## 5. 选择器契约（v3）

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

### 列表滚动 `scrollJobListStep`

- 使用与 `extractJobList()` 完全相同的职位卡片候选选择器定位列表。
- 从首张卡片向上寻找第一个 `overflow-y: auto/scroll/overlay` 且实际可滚动的祖先；
  没有内部滚动容器时才回退到 `document.scrollingElement`。
- 每次最多滚动当前视口高度的 85%（且至少 480px），由上层等待页面渲染后再次抽取。
- 到达当前底部不等于懒加载结束；上层连续两次确认底部未移动后才视为加载完成。
- 单次工具调用最多采集 40 个岗位、执行 12 次滚动探测，不点击卡片也不翻页。

### 详情页 `extractJobDetail`

| 目标 | 候选选择器 |
| --- | --- |
| 详情面板根节点 | `.job-detail-container`, `.job-detail-box`, `.job-detail-content`, `.job-detail-wrapper`, `.job-detail` |
| JD 全文 | `.job-detail-box .job-detail-body > p.desc`, `.job-detail-body > p.desc`, `.job-detail-body p.desc`, `.job-detail-section .job-sec-text`, `.job-detail-content .job-sec-text`, `.job-detail-box .job-sec-text`, `.job-description-content`, `.job-description`, `.job-sec-text` |
| 标题 | `.job-primary .name h1`, `.job-primary .job-name`, `.job-detail-header .job-name`, `.job-detail-info .job-name`, `.job-name`, `h1` |
| 薪资 | `.job-primary .salary`, `.info-primary .salary`, `.job-detail-header .salary`, `.job-detail-info .salary`, `.job-salary`, `.salary` |
| 公司名 | `.job-primary .company-name`, `.job-detail-header .company-name`, `.job-detail-info .company-name`, `.company-name a`, `.company-name` |
| 公司介绍 | `.company-info-box .job-sec-text`, `.company-detail .text`, `.job-sec.company-info .text`, `.company-intro .text`, `.company-intro` |
| 城市/地址 | `.job-primary .text-city`, `.job-detail-header .text-city`, `.job-detail-info .text-city`, `.job-address .job-address-desc`, `.job-address-desc`, `.job-address .location-address`, `.text-city`, `.job-area` |
| 职位标签 | `.job-primary .tag-list li`, `.job-detail-header .tag-list li`, `.job-detail-info .tag-list li`, `.job-tags li`, `.job-tags span` |

`extractJobDetail()` 先定位可见的 JD，再将字段读取范围收敛到包含该 JD 的详情面板。隐藏的旧面板不会被当作当前选中岗位；非 `/job_detail/*.html` 页面在存在可见 JD 时标记为 `embedded_detail`。

## 6. 页面结构诊断（`captureZhipinPageStructure`）

用户点击「下载诊断日志」时，Background 会即时检查当前活动标签页。仅当页面属于
`https://www.zhipin.com` 时注入 `captureZhipinPageStructure()`，并把以下内容加入 Markdown：

- 当前适配器每个候选选择器的全部命中数与可见命中数；
- 「职位描述 / 工作地址 / 立即沟通」等固定文案对应的脱敏 DOM 祖先路径；
- 最多 600 个可见节点、10 层、50,000 字的 DOM 骨架；
- 根据列表、详情根节点、正文命中关系自动生成的适配器改进建议。

结构诊断不会读取或导出表单值、链接地址、图片地址、Cookie、Storage、查询参数或完整
HTML。文本叶子仅保留最多 48 字，并在页面内先擦除手机号、邮箱、证件号和长标识；报告
生成时再统一执行密钥脱敏。采集失败不会阻止原执行日志下载。

## 7. 薪资解析规则（`parseSalary`）

| 输入示例 | 解析结果（K/月） |
| --- | --- |
| `15-25K` / `15-25K·14薪` | min=15, max=25 |
| `20K` | min=20, max=20 |
| `300-500元/天` | ×21.75/1000（日薪按 21.75 天/月折算） |
| `8-12万/年` | ×10/12（年薪按 12 月折算） |
| `面议` 等 | 空对象（不参与本地薪资过滤，保留给语义层） |

## 8. 站点改版时的维护流程

1. 打开失效页面，DevTools 检查新 DOM 结构。
2. 把新选择器**追加**到对应候选数组（保留旧选择器兜底，宽容匹配是设计原则）。
3. 若字段语义/返回结构变化 → 递增 `ADAPTER_VERSION` 并更新本文档第 1、5 节。
4. 自动测试：为新增选择器补充脱敏 DOM fixture；手动验证一次「采集 → 评估 → 结果」全流程。
5. PR 附脱敏的 DOM 片段截图与验证说明。
