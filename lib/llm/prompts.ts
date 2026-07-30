// ─── 领域 Prompt：意图解析 / 批量评估 ───
// 三段式流水线中所有 LLM 调用的提示词集中于此，便于迭代与评测。

import { knownCities } from '@/lib/adapter/city-codes';
import { recorder } from '@/lib/diagnostics/recorder';
import type {
  JobAssessment,
  JobPosting,
  LlmConfig,
  SearchTaskParams,
  UserProfile,
} from '@/lib/domain/types';
import { chat, extractJson } from './client';

/** 流水线 LLM 调用统一走这里：调用 + 往任务轨落一条含原文的诊断记录。 */
async function chatWithDiagnostics(
  config: LlmConfig,
  purpose: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  signal?: AbortSignal,
): Promise<string> {
  const startedAt = Date.now();
  const raw = await chat(config, messages, { responseFormatJson: true, signal });
  recorder.logLlm('task', {
    model: config.model,
    purpose,
    messageCount: messages.length,
    promptChars: messages.reduce((n, m) => n + m.content.length, 0),
    outputChars: raw.length,
    messages,
    outputText: raw,
    latencyMs: Date.now() - startedAt,
  });
  return raw;
}

// ─── ⓪ 对话助手（自由多轮咨询） ───

export const CHAT_SYSTEM = `你是 BossPilot——一个内置在浏览器侧边栏、专门服务 Boss 直聘求职者的 AI 助手。

你的定位：
- 面向求职者，围绕找工作、投递、简历、面试、行业与薪资行情等话题提供专业、务实、可执行的建议。
- 回答用中文，简洁直接、有条理；能用短列表就不写大段文字；给建议要具体到「怎么做」。
- 诚实：不清楚就说不清楚，不编造岗位数据或公司信息。

当前能力边界（据实告知用户，不要吹嘘）：
- 你目前处于纯对话阶段，还不能直接读取网页、搜索岗位或操作页面；这些能力会在后续版本里逐步开放。
- 如果用户希望你「读当前这个职位」「帮我搜岗位」，礼貌说明该能力尚在开发中，先用对话方式尽力帮他分析或给方法。`;

// ─── ① 意图解析 ───

const PARSE_SYSTEM = `你是求职搜索助手的意图解析器。把用户的自然语言需求解析为结构化 JSON，不要输出任何其他内容。

输出 JSON 格式：
{
  "keyword": "搜索关键词（岗位名，如：前端开发）",
  "city": "城市中文名（如：西安；未提及则填：全国）",
  "salaryMinK": 数字或 null（月薪下限，单位K），
  "salaryMaxK": 数字或 null（月薪上限，单位K），
  "experience": "经验要求原文或 null",
  "softConditions": ["硬筛选器表达不了、需要阅读JD判断的条件，如：排除外包公司、要求双休"],
  "maxJobs": 数字（用户要求的数量，未提及填 20，最大 40），
  "fetchDetails": 布尔（用户是否需要深入分析JD全文；涉及软条件判断或匹配打分时应为 true）
}

规则：
- 「排除外包/驻场/人力资源公司」「要求双休/远程」「不要996」等都属于 softConditions。
- 薪资「15k以上」→ salaryMinK=15, salaryMaxK=null；「1万5」= 15K。
- 用户只说「帮我找XX岗位」没有软条件时 softConditions 为空数组。`;

export async function parseIntent(
  config: LlmConfig,
  text: string,
  signal?: AbortSignal,
): Promise<SearchTaskParams> {
  const raw = await chatWithDiagnostics(
    config,
    '意图解析',
    [
      { role: 'system', content: PARSE_SYSTEM },
      {
        role: 'user',
        content: `已收录可精确筛选的城市：${knownCities().join('、')}\n\n用户需求：${text}`,
      },
    ],
    signal,
  );
  const parsed = extractJson<
    Partial<SearchTaskParams> & { salaryMinK?: number | null; salaryMaxK?: number | null }
  >(raw);
  // 归一化 + 防御性默认值 + 风控硬上限
  return {
    keyword: String(parsed.keyword ?? '').trim() || '前端开发',
    city: String(parsed.city ?? '全国').trim() || '全国',
    salaryMinK: parsed.salaryMinK ?? undefined,
    salaryMaxK: parsed.salaryMaxK ?? undefined,
    experience: parsed.experience ?? undefined,
    softConditions: Array.isArray(parsed.softConditions)
      ? parsed.softConditions.map(String).filter(Boolean)
      : [],
    maxJobs: Math.min(Math.max(Number(parsed.maxJobs) || 20, 1), 40),
    fetchDetails: parsed.fetchDetails !== false,
  };
}

// ─── ② 批量语义评估（软条件过滤 + 匹配打分） ───

const ASSESS_SYSTEM = `你是资深职业顾问。对给出的一批岗位逐个评估，输出 JSON，不要输出任何其他内容。

输出 JSON 格式：
{
  "assessments": [
    {
      "jobId": "岗位id（原样返回）",
      "passed": 布尔（是否通过用户的软条件；无软条件时恒为 true），
      "excludeReason": "未通过时的一句话原因，通过时为 null",
      "matchScore": 0到100整数（与用户档案/需求的匹配度），
      "highlights": ["匹配亮点，1-3条短句"],
      "risks": ["风险或差距点，0-3条短句，如：疑似外包、JD未提双休"]
    }
  ]
}

评估规则：
- 判断「外包」看公司名（含"外包/信息技术服务/人力资源"等）、JD 内容（驻场、甲方、派遣字样）、公司介绍。证据不足时不武断排除，改在 risks 里标注"疑似"。
- matchScore 结合用户简历档案（若有）与岗位要求：技能匹配 50%、经验年限 20%、薪资城市契合 15%、软条件契合 15%。
- 缺 JD 全文时按列表信息保守评估，并在 risks 注明"未读取JD全文"。
- 每个输入岗位都必须有对应输出，jobId 一一对应。`;

function jobToPromptBlock(job: JobPosting): string {
  const lines = [
    `id: ${job.id}`,
    `职位: ${job.title} | 薪资: ${job.salaryText || '未知'}`,
    `公司: ${job.companyName}${job.companySize ? `（${job.companySize}）` : ''}`,
    `公司标签: ${job.companyTags.join('/') || '无'} | 职位标签: ${job.jobTags.join('/') || '无'}`,
    `区域: ${job.area ?? '未知'}`,
  ];
  if (job.description) lines.push(`JD全文:\n${job.description.slice(0, 1500)}`);
  if (job.companyIntro) lines.push(`公司介绍: ${job.companyIntro.slice(0, 400)}`);
  return lines.join('\n');
}

export async function assessJobs(
  config: LlmConfig,
  jobs: JobPosting[],
  params: SearchTaskParams,
  profile: UserProfile | null,
  signal?: AbortSignal,
): Promise<JobAssessment[]> {
  const userParts = [
    `用户搜索需求：${params.keyword}（${params.city}）` +
      (params.salaryMinK || params.salaryMaxK
        ? `，期望薪资 ${params.salaryMinK ?? '?'}-${params.salaryMaxK ?? '?'}K`
        : ''),
    params.softConditions.length
      ? `软条件（必须逐条判断）：${params.softConditions.join('；')}`
      : '软条件：无（passed 恒为 true，仍需打分）',
  ];
  if (profile?.resumeText?.trim()) {
    userParts.push(`用户简历档案：\n${profile.resumeText.slice(0, 2000)}`);
  }
  if (profile?.preferences?.trim()) {
    userParts.push(`用户长期偏好：${profile.preferences.slice(0, 500)}`);
  }
  userParts.push(
    `待评估岗位（共${jobs.length}个）：\n\n${jobs.map(jobToPromptBlock).join('\n\n---\n\n')}`,
  );

  const raw = await chatWithDiagnostics(
    config,
    '岗位评估',
    [
      { role: 'system', content: ASSESS_SYSTEM },
      { role: 'user', content: userParts.join('\n\n') },
    ],
    signal,
  );
  const parsed = extractJson<{ assessments?: JobAssessment[] }>(raw);
  const list = Array.isArray(parsed.assessments) ? parsed.assessments : [];
  // 防御：确保每个岗位都有结果；缺失的补保守默认
  const byId = new Map(list.map((a) => [String(a.jobId), a]));
  return jobs.map((job) => {
    const a = byId.get(job.id);
    if (!a) {
      return {
        jobId: job.id,
        passed: true,
        matchScore: 50,
        highlights: [],
        risks: ['模型未返回该岗位评估，按默认保留'],
      };
    }
    return {
      jobId: job.id,
      passed: a.passed !== false,
      excludeReason: a.excludeReason ?? undefined,
      matchScore: Math.min(Math.max(Math.round(Number(a.matchScore) || 0), 0), 100),
      highlights: Array.isArray(a.highlights) ? a.highlights.map(String).slice(0, 3) : [],
      risks: Array.isArray(a.risks) ? a.risks.map(String).slice(0, 3) : [],
    };
  });
}
