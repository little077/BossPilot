// ─── 领域实体模型 ───
// BossPilot 的核心数据结构：搜索任务参数、岗位实体、打分结果。
// 所有跨运行时（sidepanel / background / content）传输的数据都以这里为准。

/** 用户自然语言意图解析后的结构化任务参数。 */
export interface SearchTaskParams {
  /** 搜索关键词，如「前端开发」。 */
  keyword: string;
  /** 城市名（中文），如「西安」。由适配层映射为 Boss 城市码。 */
  city: string;
  /** 薪资下限（K/月），可空。 */
  salaryMinK?: number;
  /** 薪资上限（K/月），可空。 */
  salaryMaxK?: number;
  /** 经验要求（自然语言原样保留，作为软条件参与语义过滤）。 */
  experience?: string;
  /**
   * 软条件：Boss 原生筛选器表达不了、需要 LLM 对 JD 全文判断的条件。
   * 例如「排除外包」「排除驻场」「要求双休」「不要频繁加班」。
   */
  softConditions: string[];
  /** 本次任务最多采集的岗位数（风控上限，默认 20，硬上限 40）。 */
  maxJobs: number;
  /** 是否逐个进详情页抓完整 JD（更准但更慢、风控风险更高）。 */
  fetchDetails: boolean;
}

/** 从列表页 / 详情页采集到的岗位实体。 */
export interface JobPosting {
  /** Boss 侧的职位加密 id（从链接提取），用于去重与详情页定位。 */
  id: string;
  title: string;
  /** 原始薪资文本，如「15-25K·14薪」。 */
  salaryText: string;
  salaryMinK?: number;
  salaryMaxK?: number;
  companyName: string;
  /** 公司规模文本，如「100-499人」。 */
  companySize?: string;
  /** 融资阶段/行业等标签。 */
  companyTags: string[];
  /** 经验/学历等职位标签。 */
  jobTags: string[];
  city?: string;
  /** 商圈/区域，如「雁塔区 小寨」。 */
  area?: string;
  /** 招聘者名称与职务，如「张女士·HR」。 */
  recruiter?: string;
  /** 详情页 URL（站内相对或绝对）。 */
  url: string;
  /** 完整 JD 文本（仅 fetchDetails 时有）。 */
  description?: string;
  /** 详情页公司介绍（可选）。 */
  companyIntro?: string;
}

/** LLM 对单个岗位的语义评估结果。 */
export interface JobAssessment {
  jobId: string;
  /** 软条件过滤结论：true = 通过（保留）。 */
  passed: boolean;
  /** 未通过时命中的排除原因，如「疑似外包公司」。 */
  excludeReason?: string;
  /** 匹配度 0-100（结合用户档案；无档案时基于任务参数）。 */
  matchScore: number;
  /** 匹配亮点（1-3 条短句）。 */
  highlights: string[];
  /** 风险/差距点（0-3 条短句）。 */
  risks: string[];
}

/** 评估后合并的展示行。 */
export interface AssessedJob extends JobPosting {
  assessment: JobAssessment;
}

/** 任务执行的阶段。 */
export type TaskPhase =
  | 'idle'
  | 'parsing' // LLM 意图解析
  | 'searching' // 打开/导航搜索页
  | 'collecting' // 列表翻页采集
  | 'detailing' // 详情页抓取
  | 'assessing' // LLM 批量评估
  | 'paused_captcha' // 遇验证码暂停，等用户手动通过
  | 'done'
  | 'error'
  | 'cancelled';

/** 任务运行时快照（广播给 UI）。 */
export interface TaskSnapshot {
  taskId: string;
  phase: TaskPhase;
  /** 人类可读的当前进度描述。 */
  statusText: string;
  params?: SearchTaskParams;
  collected: number;
  assessed: number;
  jobs: AssessedJob[];
  error?: string;
}

/** 用户简历/求职偏好档案（本地存储，参与匹配打分）。 */
export interface UserProfile {
  /** 简历要点/技能栈自述（自由文本，用户在设置页维护）。 */
  resumeText: string;
  /** 长期偏好，如「只考虑双休」「倾向中大厂」。 */
  preferences: string;
}

/** LLM Provider 配置（OpenAI 兼容端点，BYOK）。 */
export interface LlmConfig {
  /** 形如 https://api.deepseek.com/v1 的 OpenAI 兼容 base URL。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 评估批量大小（一次请求评估几个岗位），默认 10。 */
  batchSize?: number;
}

/** 模型的轻量身份；一期只负责配置与选择，消息调用在后续版本接入。 */
export interface ModelIdentity {
  providerId: string;
  modelId: string;
}

/** 厂商模型目录中的一项。 */
export interface ProviderModel {
  id: string;
  name: string;
}

/** 返回给侧边栏的脱敏厂商连接状态，不包含 API Key 明文。 */
export interface ProviderConnectionView {
  providerId: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyLastFour: string;
  models: ProviderModel[];
  selectedModelId?: string;
  configuredAt?: number;
}

/** 多模型配置的脱敏快照。 */
export interface ProviderStateView {
  version: 1;
  connections: ProviderConnectionView[];
  activeModel?: ModelIdentity;
}

/** 一轮用户消息固定绑定的标签页；完整 URL 只在扩展本地用于防止读错页面。 */
export interface PageTurnSnapshot {
  tabId: number;
  windowId: number;
  url: string;
  safeUrl: string;
  origin: string;
  title: string;
  scheme: string;
  isHttp: boolean;
  isBoss: boolean;
  capturedAt: number;
}

export type PageExtractionMode = 'selection' | 'article' | 'main' | 'body-fallback';

/** 固定页面脚本返回的纯文本结果；任何网页 HTML 都不得跨越该边界。 */
export interface PageScriptExtraction {
  version: 1;
  executionUrl: string;
  title: string;
  language: string;
  mode: PageExtractionMode;
  text: string;
  originalChars: number;
  returnedChars: number;
  truncated: boolean;
  scannedElements: number;
  untrusted: true;
}

export type PageReadErrorCode =
  | 'permission_denied'
  | 'permission_required'
  | 'unsupported_scheme'
  | 'page_changed'
  | 'script_injection_failed'
  | 'invalid_page_result'
  | 'empty_page'
  | 'read_timeout'
  | 'cancelled'
  | 'unknown_read_error';

export type BrowserDestination = 'current' | 'baidu' | 'bing' | 'google' | 'boss';

export type BrowserActionErrorCode =
  | 'INVALID_BROWSER_ACTION'
  | 'UNGROUNDED_URL'
  | 'TAB_NOT_FOUND'
  | 'TAB_LOAD_TIMEOUT'
  | 'NO_SEARCH_CONTROL'
  | 'AMBIGUOUS_SEARCH_CONTROL'
  | 'INTERACTION_FAILED'
  | 'VERIFICATION_FAILED';

export type PageInteractionErrorCode =
  | 'INVALID_PAGE_INTERACTION'
  | 'OBSERVATION_REQUIRED'
  | 'STALE_ELEMENT_REFERENCE'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_INTERACTABLE'
  | 'SENSITIVE_INPUT_BLOCKED'
  | 'INTERACTION_FAILED'
  | 'VERIFICATION_FAILED';

export type PageInteractionRisk = 'safe' | 'confirm' | 'blocked';

export type PageInteractionVerificationEvidence =
  | 'click_dispatched'
  | 'input_value_matches'
  | 'selected_option_matches'
  | 'checked_state_matches'
  | 'viewport_changed';

/** 页面上下文脚本返回的候选元素；path 仅保存在扩展本地，不发送给模型。 */
export interface PageInteractiveElementCandidate {
  path: number[];
  tag: string;
  role: string;
  name: string;
  type: string;
  disabled: boolean;
  checked?: boolean;
  selectedText?: string;
  hasValue?: boolean;
  destinationOrigin?: string;
  risk: PageInteractionRisk;
  riskReason?: string;
}

export interface PageViewportSnapshot {
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
  documentWidth: number;
  documentHeight: number;
}

/** 自包含观察脚本的跨运行时返回值。 */
export interface PageInteractionObservationResult {
  version: 1;
  executionUrl: string;
  title: string;
  elements: PageInteractiveElementCandidate[];
  viewport: PageViewportSnapshot;
  truncated: boolean;
}

/** 自包含动作脚本的跨运行时返回值。 */
export interface PageInteractionScriptResult {
  version: 1;
  ok: boolean;
  executionUrl: string;
  action: 'click' | 'fill' | 'select' | 'check' | 'scroll';
  risk: PageInteractionRisk;
  riskReason?: string;
  error?: PageInteractionErrorCode;
  detail: string;
  stateVerified: boolean;
  verificationEvidence?: PageInteractionVerificationEvidence;
}

/** 延迟一个渲染周期后复核表单状态，防止受控组件把刚写入的值回滚。 */
export interface PageElementVerificationResult {
  version: 1;
  ok: boolean;
  executionUrl: string;
  action: 'fill' | 'select' | 'check';
  detail: string;
  evidence?: PageInteractionVerificationEvidence;
  error?: PageInteractionErrorCode;
}

/** 页面脚本只返回交互元数据，不跨运行时传输页面正文或表单中的其他值。 */
export interface BrowserSearchControlSnapshot {
  tag: 'input' | 'textarea' | 'contenteditable';
  role: string;
  label: string;
  placeholder: string;
  type: string;
  score: number;
}

export interface BrowserPageFingerprint {
  url: string;
  title: string;
  textHash: string;
  textLength: number;
  childCount: number;
}

export interface BrowserSearchScriptResult {
  version: 1;
  ok: boolean;
  executionUrl: string;
  control?: BrowserSearchControlSnapshot;
  candidates: BrowserSearchControlSnapshot[];
  ambiguous: boolean;
  typed: boolean;
  submitted: boolean;
  submissionMethod?: 'form' | 'button' | 'keypress';
  fingerprint: BrowserPageFingerprint;
  error?: string;
}

/** 单轮对话里可见的安全思考状态；只描述阶段，不暴露模型内部推理原文。 */
export interface ReasoningActivity {
  status: 'running' | 'completed' | 'cancelled' | 'error';
  summary: string;
  startedAt: number;
  finishedAt?: number;
}

/** Ask User 的预设答案；由模型提出，但进入 UI 前会经过长度、数量与重复项校验。 */
export interface AskUserOption {
  id: string;
  label: string;
}

/**
 * Agent 等待用户补充信息时的跨运行时快照。
 * 它属于任务控制面，不是聊天正文，因此 UI 必须固定渲染在输入框上方。
 */
export interface PendingUserQuestion {
  requestId: string;
  callId: string;
  question: string;
  options: AskUserOption[];
  allowCustom: boolean;
  customPlaceholder?: string;
}

/** 一次浏览器工具的 UI/IPC 快照；状态元数据不携带抓取到的网页正文。 */
export type DomainToolName =
  | 'read_current_page'
  | 'browser_action'
  | 'observe_page'
  | 'interact_page'
  | 'read_current_job'
  | 'read_visible_jobs'
  | 'ask_user';

export interface ToolActivity {
  /** 所属生成轮次，用于权限等待卡片把用户决定精确路由回 Background。 */
  requestId?: string;
  callId: string;
  name: DomainToolName;
  label: string;
  status: 'waiting_permission' | 'waiting_user' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  statusText: string;
  startedAt: number;
  finishedAt?: number;
  detail?: string;
  sourceOrigin?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  permissionPattern?: string;
  permissionKind?: 'read' | 'interact';
  extractionMode?: PageExtractionMode;
  returnedChars?: number;
  truncated?: boolean;
  enrichmentStatus?: 'success' | 'failed' | 'not_applicable';
  errorCode?:
    | 'NOT_ON_JOB_PAGE'
    | 'NO_JOB_SELECTED'
    | 'NO_JOB_LIST'
    | 'CAPTCHA_DETECTED'
    | 'SELECTOR_MISS'
    | 'NO_PERMISSION'
    | 'EXTRACTION_FAILED'
    | 'CANCELLED'
    | BrowserActionErrorCode
    | PageInteractionErrorCode
    | PageReadErrorCode;
}

/** 当前网页结构诊断中的单个选择器命中结果。 */
export interface DiagnosticSelectorProbe {
  group: string;
  selector: string;
  matches: number;
  visibleMatches: number;
}

/** 通过固定页面文案定位到的脱敏 DOM 祖先路径，不包含链接、id 或表单值。 */
export interface DiagnosticPageLandmark {
  label: string;
  path: string;
}

/**
 * 下载诊断日志时即时采集的页面结构快照。
 * captured 只可能来自 www.zhipin.com；skipped/failed 仍允许生成执行日志。
 */
export interface DiagnosticPageStructureSnapshot {
  status: 'captured' | 'skipped' | 'failed';
  capturedAt: number;
  pageUrl?: string;
  pageKind?: 'standalone_detail' | 'embedded_detail' | 'job_list' | 'unknown';
  readyState?: 'loading' | 'interactive' | 'complete';
  viewport?: { width: number; height: number };
  nodeCount?: number;
  truncated?: boolean;
  selectorProbes?: DiagnosticSelectorProbe[];
  landmarks?: DiagnosticPageLandmark[];
  outline?: string;
  reason?: string;
}
