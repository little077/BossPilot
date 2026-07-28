// ─── 领域 Prompt：意图解析 / 批量评估 / 报告生成 ───
// 三段式流水线中所有 LLM 调用的提示词集中于此，便于迭代与评测。

import type {
  AssessedJob,
  JobAssessment,
  JobPosting,
  SearchTaskParams,
  UserProfile,
} from '@/lib/domain/types';
import { chat, extractJson } from './client';
import type { LlmConfig } from '@/lib/domain/types';
import { knownCities } from '@/lib/adapter/city-codes';

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
  const raw = await chat(
    config,
    [
      { role: 'system', content: PARSE_SYSTEM },
      { role: 'user', content: `已收录可精确筛选的城市：${knownCities().join('、')}\n\n用户需求：${text}` },
    ],
    { responseFormatJson: true, signal },
  );
  const parsed = extractJson<Partial<SearchTaskParams> & { salaryMinK?: number | null; salaryMaxK?: number | null }>(raw);
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
  userParts.push(`待评估岗位（共${jobs.length}个）：\n\n${jobs.map(jobToPromptBlock).join('\n\n---\n\n')}`);

  const raw = await chat(
    config,
    [
      { role: 'system', content: ASSESS_SYSTEM },
      { role: 'user', content: userParts.join('\n\n') },
    ],
    { responseFormatJson: true, signal },
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

// ─── ③ 报告总结（报告主体由确定性代码生成，LLM 只写「总评与建议」段） ───

const SUMMARY_SYSTEM = `你是资深职业顾问。基于筛选结果，为用户写一段简明的「总评与建议」（Markdown，200-400字）：
- 先一句话总结本次搜索的整体供给情况（数量、薪资带、公司类型分布）。
- 给出 2-3 条具体行动建议（优先投哪几家、注意什么风险）。
- 直接输出 Markdown 正文，不要标题、不要代码块。`;

export async function summarizeReport(
  config: LlmConfig,
  params: SearchTaskParams,
  jobs: AssessedJob[],
  signal?: AbortSignal,
): Promise<string> {
  const brief = jobs
    .slice(0, 30)
    .map(
      (j) =>
        `${j.title}|${j.companyName}|${j.salaryText}|匹配${j.assessment.matchScore}|${j.assessment.passed ? '通过' : `排除:${j.assessment.excludeReason ?? ''}`}`,
    )
    .join('\n');
  try {
    return await chat(
      config,
      [
        { role: 'system', content: SUMMARY_SYSTEM },
        {
          role: 'user',
          content: `搜索需求：${params.keyword} @ ${params.city}；软条件：${params.softConditions.join('；') || '无'}\n\n结果概览（职位|公司|薪资|匹配分|结论）：\n${brief}`,
        },
      ],
      { signal },
    );
  } catch {
    // 总评失败不阻塞报告主体
    return '（总评生成失败，以下为结构化结果。）';
  }
}
