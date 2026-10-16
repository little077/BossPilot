// ─── 领域实体模型 ───
// 极简 LangChain + DeepSeek 流式对话 Demo 的数据结构。
// 只保留跨运行时（sidepanel / background）传输所需的类型，无岗位/流水线等业务实体。

/** 单个模型配置（OpenAI 兼容端点，BYOK）。apiKey 落库前会被加密。 */
export interface ModelConfig {
  /** OpenAI 兼容 base URL，如 https://api.deepseek.com。 */
  baseUrl: string;
  /**
   * 用户选定的模型 id（来自拉取的模型目录）。
   * 空串表示「已填密钥但还没选模型」——此时对话页会引导用户回卡包完成选择。
   */
  model: string;
  /** 明文密钥仅存在于内存与单次发送；持久化时以密文形式落 IndexedDB。 */
  apiKey: string;
  /**
   * 长会话自动压缩开关（阶段 3 源①）。缺省视为 true（旧数据无此字段时保持默认开启），
   * 关闭后循环不再触发高水位摘要，仅靠循环内步进老化控制上下文膨胀。
   */
  compactEnabled?: boolean;
}

/** 返回给设置页的脱敏配置快照，不回传密钥明文。 */
export interface ModelConfigView {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyLastFour: string;
  /** 压缩开关当前状态（缺省按 true 呈现，与新用户默认一致）。 */
  compactEnabled?: boolean;
}

/** 从模型端点拉取回来的单个模型条目（跨 background → sidepanel 传输）。 */
export interface ModelCatalogEntry {
  /** 调用时实际传给模型的 id，如 deepseek-chat。 */
  id: string;
  /** 展示名，缺省与 id 相同。 */
  name: string;
}
