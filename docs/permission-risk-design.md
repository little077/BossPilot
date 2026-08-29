# 授权机制优化设计：从「逐站弹窗」到「风险分级自动放行」

更新日期：2026-08-29
关联分支：fix/interrupt-permission

## 1. 背景与问题

当前用户每次让 Agent 访问一个**尚未授权过的网站**（如百度、知乎等），都会先看到一次
「允许/不允许操作」的确认流程：Agent 暂停 → 侧边栏出现授权卡片 → 点击「允许」→
Chrome 弹原生权限框 → 恢复执行。站点一多，体验非常繁琐；而像「观察页面」「滚动页面」
这类低风险动作也被迫走完整套授权，与「默认允许常规网站访问行为，仅高风险动作二次确认」
的产品预期不符。

本文梳理现有授权唤醒场景（Policy Engine / Tool Catalog / 页面交互执行器），给出风险
分级标准与改造方案。方案目标：

1. **站点访问**（读取、观察、滚动、普通点击）：默认放行，不再逐站弹窗；
2. **高风险动作**（写文件、提交表单、支付、发布、删除、发送截图等）：保留显式二次确认；
3. 分级标准可解释、可审计（复用 ToolLedger 台账），且随时可撤销。

## 2. 现状梳理：授权唤醒场景全景

现有授权分为**三条独立链路**，分别由不同组件触发：

| 链路 | 触发组件 | 暂停类型 | 用户确认 UI | 现状覆盖范围 |
| --- | --- | --- | --- | --- |
| A. Chrome 站点访问授权 | 页面交互/浏览器动作执行器 | `page_permission` | 授权卡片「允许/不允许」→ `chrome.permissions.request` 原生框 | observe_page、inspect_page、interact_page、browser_action(search) |
| B. Policy Engine 工具级确认 | `PolicyEngine.evaluate` | `user_input`（policyConfirm） | 「确认执行 / 取消」 | 仅 workspace 写工具 |
| C. 交互动作级风险 | `performPageInteraction` 内部 | `user_input` | 「确认执行 / 不执行」 | 提交表单、高影响按钮（发送/支付/删除/发布/登录等） |

### 2.1 链路 A：Chrome 站点访问授权（page_permission）——主要痛点

**触发位置（工具注册均为 `safe`，风险判定在执行器内部）：**

- `observe_page` / `inspect_page` → `captureObservation`（[lib/tools/page-interaction.ts]）：
  `chrome.scripting.executeScript` 抛权限错误且当前站点未授权时，返回
  `{ deferred: true, kind: 'page_permission', permissionKind: 'interact' }`（「等待网站交互权限」）。
- `interact_page`：交互前置观察同样走 `captureObservation`，未授权站点首次交互即暂停。
- `browser_action`（search）：`hasExactPageOriginAccess` 与 activeTab 兜底均失败时，
  返回 `page_permission`（「等待网站操作权限」）。
- `observe_visual_page`：截图权限缺失时**不暂停**，直接返回错误并提示「点击扩展图标后重试」。

**授权粒度**：`lib/page/access.ts` 的 `requestPageOriginAccess` 只允许**精确 origin**
（如 `https://www.baidu.com/*`），并写入可撤销清单 `bosspilot_page_origins_v1`。
Manifest 中 `optional_host_permissions: ['https://*/*', 'http://*/*']` 已允许全网，
但 Chrome 对 `permissions.request` 的**每次精确授权都会弹原生确认框**，这正是
「每访问一个新网站就弹一次」的直接原因。

**链路 A 的完整流程：**

```text
Agent 调 observe/inspect/interact/browser_action
  → 执行器检查 hasExactPageOriginAccess(pattern)
  → 未授权 → 返回 page_permission 暂停点
  → ChatGenerationManager.onToolDeferred → savePendingPageTurn（IndexedDB/session）
  → UI 授权卡片 → 用户点「允许」（保留 user gesture）
  → resolvePagePermission → requestPageOriginAccess（chrome.permissions.request）
  → resumePagePermission → resumeDeferred 继续执行
```

### 2.2 链路 B：Policy Engine 工具级确认

- 工具目录 `ToolCatalog` 强制每个工具声明 `risk: 'safe' | 'confirm' | 'blocked'`
  （[lib/agent/tool-catalog.ts]）；未知工具默认 `deny`。
- `PolicyEngine.evaluate`（[lib/agent/policy-engine.ts]）按「参数级规则（先匹配先生效）→
  工具风险声明 → 默认拒绝」输出 `allow / confirm / deny`。
- 目前只有 workspace 写工具（create/mkdir/edit/rename/delete/save_url）注册为 `confirm`；
  页面类工具全部是 `safe`，风险判断完全下沉到执行器内部（链路 A/C），
  造成「同一个动作，两套判定、两套文案」。

### 2.3 链路 C：交互动作级风险

`performPageInteraction` 在注入脚本内对目标控件二次判定（[lib/tools/page-interaction.ts]）：

- `type=password / file` → `blocked`（Agent 不允许操作）；
- 表单提交（非搜索）或按钮名命中
  `发送|提交|投递|申请|报名|购买|支付|付款|删除|移除|清空|发布|保存|确认|授权|登录|注册|下单|订阅…`
  → `confirm`（未获 `approved` 时返回高风险确认暂停点）；
- 其余（click / scroll / focus / fill 普通字段）→ `safe` 直接执行。

### 2.4 台账与诊断

`ToolLedger` 已记录每次调用的 `decision`（allow/confirm/deny）、`risk`、耗时与脱敏参数
摘要，诊断报告可回放。分级标准升级后台账字段无需改动，直接复用。

## 3. 根因分析

1. **站点访问与动作风险没有分层**：`safe` 工具只要目标站点未授权就会暂停，
   把「能不能碰这个网站」和「这个动作危不危险」混为一谈。
2. **授权粒度过细且无升级通道**：精确 origin 授权每次都要 Chrome 原生确认，
   没有「信任所有站点」的一次性升级，也没有对低风险站点的静默授权机制。
3. **activeTab 兜底不完整**：`browser_action` 有 `canInject(activeTab)` 兜底，
   但 `captureObservation`（observe/inspect/interact 的公共前置）没有，
   导致点击扩展图标激活的标签页仍会走暂停流程。
4. **风险判定分散**：Policy Engine（工具级）与执行器内部（动作级）两套判定并存，
   文案、台账口径不完全一致，后续维护容易失配。

## 4. 风险分级标准（L0–L3）

授权决策拆成**两个正交维度**：站点信任（能否访问）与动作风险（访问后做什么）。
两个维度分别判定后合成最终决策：

```text
最终决策 = 站点信任（通过?）× 动作风险（L0-L3）
```

| 等级 | 定义 | 典型动作 | 处理方式 |
| --- | --- | --- | --- |
| L0 只读 | 无副作用、可逆、不产生外部影响 | read_current_page、observe_page、inspect_page、tab 查询/切换、scroll、focus、memory 读取、workspace 读取、ask_user | 站点已信任 → 直接执行；站点未信任 → 走站点授权（见 §5.1） |
| L1 低风险写 | 对页面有影响但低危、可逆、符合用户当前意图 | 普通按钮 click、表单字段 fill/clear、browser_action search、workspace_create/mkdir、mcp 只读调用 | 站点已信任 → 自动执行（不再每次确认）；站点未信任 → 站点授权 |
| L2 高风险写 | 不可逆、敏感或外部副作用明显 | 提交/发送/发布/支付/删除/登录类表单提交、workspace_edit/rename/delete/save_url、observe_visual_page 截图发送 | **每次显式确认**（与站点信任无关） |
| L3 禁用 | 敏感数据或未开放能力 | 密码/文件输入、未知工具、blocked 工具、mcp 未声明只读的写调用 | 直接拒绝，不弹窗 |

分级原则：

- **只读与低风险写不逐次打扰用户**；首次访问新站点时一次性授权，之后该站点 L0/L1 自动放行；
- **高风险写永远确认**，即使站点已信任（站点信任只豁免 L0/L1）；
- **未知能力默认拒绝**（延续 Policy Engine 的 deny-by-default）。

## 5. 目标架构：分层门禁

```text
模型工具调用
  │
  ▼
① Policy Engine（工具级决策）
  │  L0/L1 + 站点已信任 → allow（自动放行）
  │  L0/L1 + 站点未信任 → 站点授权暂停（page_permission，一次性）
  │  L2 → 动作确认暂停（user_input，每次）
  │  L3 / 未知 → deny（直接拒绝）
  ▼
② 执行器内部防御（纵深，保留现状）
  │  密码/文件 blocked；提交/高影响 confirm；结果验证
  ▼
③ ToolLedger 台账（decision/risk/耗时/脱敏摘要）
```

关键变化：**动作级风险判定从执行器内部上提到 Policy Engine 的「参数级规则」**，
执行器保留防御性复查（纵深防御，不删）。

## 6. 代码层面实现逻辑（分阶段改造）

### 阶段 1：站点信任模式（根治逐站弹窗）

**目标**：低风险动作默认放行；新站点首次访问只授权一次；可一键升级为全网信任。

1. **新增信任模式配置**（`lib/storage/config.ts`）：
   ```ts
   type PagePermissionMode = 'ask-each-site' | 'trust-all';
   // 默认 ask-each-site（精确授权，安全）；用户可在设置页升级为 trust-all
   ```
2. **新增「信任所有站点」升级入口**（设置页）：
   - 调用 `chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] })`，
     manifest 已声明 `optional_host_permissions`，一次请求、用户一次确认；
   - 成功后写 `trust-all` 模式并**立即把当前会话用到的站点补记入已授权清单**；
   - `hasExactPageOriginAccess` 增加 trust-all 短路：模式为 trust-all 时视为已授权
     （不逐站请求、不弹框）。
3. **activeTab 兜底补全**（`lib/tools/page-interaction.ts` `captureObservation`）：
   - 参考 `browser_action` 的 `canInject` 逻辑，注入前先查 `chrome.permissions.contains`
     与 activeTab 激活态；用户点击过扩展图标的当前标签页直接注入，不再暂停。
4. **站点管理 UI**：设置页展示 `listGrantedPageOrigins()` 已授权站点，
   支持一键 `removePageOriginAccess` 撤销（代码已具备，仅缺 UI 入口）。
5. **授权卡片文案区分**：首次访问站点时说明「允许后此站点的常规操作不再询问」；
   L2 动作确认说明具体动作内容（现状已接近，补文案即可）。

### 阶段 2：Policy Engine 允许规则与风险上提

**目标**：动作级风险判定统一收口到 Policy Engine，台账与文案口径一致。

1. **`PolicyRule.decision` 放开 allow**（`lib/agent/policy-engine.ts`）：
   - 现规则只允许 confirm/deny；放开 allow 后可用「白名单规则」表达
     `interact_page.action ∈ {scroll, focus, click} → allow` 这类低风险动作；
   - 规则语义变为：先命中先生效，且允许规则可覆盖工具级 confirm（用于
     workspace 读工具、页面低风险动作等显式豁免）。
2. **注册动作级风险规则**（`entrypoints/background.ts` 初始化段）：
   ```ts
   policyEngine.addRule({
     id: 'interact-scroll-focus',
     description: '滚动与聚焦不产生外部影响，站点已信任时自动放行',
     match: (call) =>
       call.name === 'interact_page' &&
       ['scroll', 'focus'].includes(String(call.arguments?.action)),
     decision: 'allow',
     reason: '滚动/聚焦为低风险页面操作。',
   });
   policyEngine.addRule({
     id: 'interact-submit-confirm',
     description: '提交类表单与高影响按钮需要用户确认',
     match: (call) =>
       call.name === 'interact_page' &&
       (call.arguments?.action === 'click' || call.arguments?.action === 'keypress'),
     decision: 'confirm',
     reason: '点击控件可能提交表单或产生外部影响，需确认后执行。',
   });
   ```
   - 执行器内部 `performPageInteraction` 的同类判定**保留**为纵深防御；
   - `interact_page` 的注册风险维持 `safe`，由参数规则细化；
   - `observe_visual_page` 注册风险改为 `confirm`（截图发送给模型提供商属隐私敏感），
     与 `resumeAskUser` 的「仅本次允许」语义合并，统一走 Policy 确认。
3. **站点信任与动作风险合成**（`executeTool` 门禁，`entrypoints/background.ts`）：
   ```ts
   const decision = policyEngine.evaluate(call);
   // L0/L1 自动放行；L2 确认；L3 拒绝
   // 站点未信任且调用涉及页面注入（observe/inspect/interact/browser_action）时，
   // 在执行器返回 page_permission 暂停点之前，先由执行器 activeTab/信任模式短路
   ```
   - 合成逻辑放在 Policy 门禁处：`allow + 页面类工具 + 站点未信任` → 仍放行到执行器，
     由执行器在注入失败时返回 page_permission（现状链路不变，避免 Policy 感知 tab 状态）；
   - `confirm` 决策仍走 `policyConfirm`（user_input 暂停，复用现有恢复链路）。

### 阶段 3：确认链路一致性

1. **文案统一**：Policy 确认与动作级确认统一为「确认执行 / 不执行」；
   `resumeAskUser` 对 `interact_page` 与 `observe_visual_page` 的特判分支保留
   （`approveToolCall` 语义），只统一展示层文案。
2. **台账增强**：`ToolLedger` 的 `decision` 增加记录「豁免来源」
   （rule id / trust-all / activeTab），诊断报告可解释每次放行原因。
3. **确认上下文**：AskUserPanel 的确认卡片展示动作摘要（目标站点、动作、目标控件名），
   高风险动作红色警示，低风险授权蓝色提示（纯 UI 改动）。

### 阶段 4：设置与管理

- 设置页新增「网站访问」分组：
  - 信任模式单选（逐站询问 / 信任所有站点）；
  - 已授权站点列表（展示、移除）；
  - 「信任所有站点」升级按钮（带风险提示文案）；
- 数据持久化：`bosspilot_page_origins_v1`（已有）+ 新增 `bosspilot_permission_mode_v1`
  （chrome.storage.local）。

## 7. 测试与验证

| 层 | 用例 |
| --- | --- |
| 单测（policy-engine） | 允许规则先命中先生效；confirm 被 allow 规则豁免；未知工具仍 deny |
| 单测（access） | trust-all 短路；精确 origin 校验不变；撤销清单 |
| 单测（page-interaction） | activeTab 兜底后不再返回 page_permission；动作级确认仍生效 |
| 组件测试 | 设置页信任模式切换、站点列表移除、升级按钮 |
| E2E | 已信任站点执行 observe→scroll→click 全自动；未信任站点只弹一次授权；提交按钮仍确认 |
| 回归 | 全量单测 → tsc → wxt build → Playwright |

## 8. 兼容性与回滚

- **向后兼容**：新增配置均有默认值（`ask-each-site`），旧用户行为不变；
  已授权站点清单格式不变，直接复用；
- **降级路径**：trust-all 仅豁免 L0/L1；L2/L3 始终确认，任何站点授权可一键撤销；
- **回滚**：删除配置项即可回到逐站询问；manifest 权限声明（optional_host_permissions
  全网）已存在，无需改 manifest，避免扩展重审。

## 附：涉及文件清单

| 文件 | 改动 |
| --- | --- |
| `wxt.config.ts` | 无需改动（optional_host_permissions 已含全网） |
| `lib/storage/config.ts` | 新增 `PagePermissionMode` 配置读写 |
| `lib/page/access.ts` | `hasExactPageOriginAccess` trust-all 短路；新增模式查询 |
| `lib/tools/page-interaction.ts` | `captureObservation` activeTab 兜底 |
| `lib/agent/policy-engine.ts` | `PolicyRule.decision` 放开 allow；决策来源记录 |
| `entrypoints/background.ts` | 注册动作级规则；executeTool 合成逻辑；台账豁免来源 |
| `entrypoints/sidepanel/SettingsView.tsx` | 网站访问分组（模式/站点列表/升级按钮） |
| `lib/agent/tool-ledger.ts` | 决策豁免来源字段 |
| `docs/` | 本设计文档 |
