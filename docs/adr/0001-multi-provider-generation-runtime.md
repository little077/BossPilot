# ADR-0001：多 Provider 生成运行时

- 状态：Accepted
- 日期：2026-07-30
- 决策者：BossPilot maintainers

## 背景

一期可以配置 27 个模型厂商或端点，但普通聊天仍使用旧的单一
OpenAI-compatible 配置。要接通活动模型，需要同时处理：

- OpenAI Completions 与 Responses；
- Anthropic Messages；
- Google Generative AI；
- Mistral Conversations；
- 同一厂商内按模型变化的 API 和兼容参数；
- Chrome MV3 Service Worker 的取消、权限与生命周期限制。

外部项目仅用于只读架构调研，许可证和独立实现边界不允许复制其业务代码。

## 备选方案

### A. BossPilot 手写五套协议客户端

优点：包体积和行为完全可控。

缺点：需要长期跟踪五套流事件、错误、usage、兼容字段和新模型差异，协议维护面过大。

### B. 只支持 OpenAI-compatible

优点：实现最小。

缺点：无法兑现一期厂商范围，Anthropic、Gemini、Mistral 和 OpenAI Responses
会被错误降级，模型目录与真实可调用能力不一致。

### C. 使用公开 `@earendil-works/pi-ai` 的 API 与模型元数据

优点：统一类型和流事件，模型元数据携带 API、兼容参数、上下文窗口和输出上限；
MIT 许可；可由 BossPilot 自己控制凭据、权限、状态机与 IPC。

缺点：依赖体积增加；升级会改变模型目录和协议实现；浏览器扩展需要单独处理
Node 环境探测与 MV3 Service Worker 构建约束。

## 决策

选择方案 C，并加入以下约束：

1. 精确锁定 `@earendil-works/pi-ai@0.80.6`。
2. 只使用公开 API，不使用 `compat`、`providers/all` 或 `pi-agent-core`。
3. BossPilot 自己拥有 Provider 注册表、活动模型解析、安全校验、错误码、
   会话状态机、IPC、持久化和 UI。
4. 五个非 lazy API 实现在构建期静态链接；MV3 Service Worker 不使用运行时
   `import()`。
5. 精确模型元数据只在其 Base URL 与已授权生成目标同源时采用。
6. SDK 自动重试关闭；失败不自动换模型。
7. 新模型未命中静态元数据时，用 BossPilot 注册表协议构造保守运行时模型。
8. 依赖升级必须重新通过协议测试、真实 MV3 E2E、安全审计和四层体积预算。

## 结果

正面结果：

- 普通聊天可以使用一期支持的多厂商活动模型。
- UI 只处理一种完整消息快照。
- 厂商协议变化集中在适配层，不进入 React 或 IPC。
- 后续可单独迁移岗位任务，不需要改写聊天状态机。

成本与风险：

- 生产包和 Background 静态依赖增大，需要持续监控冷启动与体积。
- CI mock 不能替代重点厂商的发布前人工冒烟。
- 精确模型目录随锁定依赖版本更新，不会自动追随上游。

## 不在本决策内

- OAuth Provider；
- 完整 Agent loop 与工具调用；
- 自动模型路由、故障切换和付费重试；
- 岗位任务流水线迁移。

OAuth 的令牌、权限、回调和刷新模型与 API Key 不同，必须另立 ADR 和安全评审。
