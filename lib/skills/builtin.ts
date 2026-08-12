import type { SkillDefinition } from '@/lib/skills/types';
import bossEvaluationReferenceUrl from '@/skills/boss-job-search/references/job-evaluation.md?url&no-inline';
import bossSearchReferenceUrl from '@/skills/boss-job-search/references/search-workflow.md?url&no-inline';
import bossSkillUrl from '@/skills/boss-job-search/SKILL.md?url&no-inline';

const BOSS_SKILL_VERSION = '1.0.0';

// 内置 Skill 在构建时随扩展发布；这里保留经过测试校验的索引，避免把 YAML 解析器带入 MV3 Background。
const BOSS_SKILL_DEFINITION: SkillDefinition = {
  name: 'boss-job-search',
  description:
    '在 Boss 直聘执行可验证的岗位搜索、岗位列表整理、职位详情分析和多岗位对比。用户提到 Boss 直聘、找工作、搜索职位、筛选岗位、比较 JD、评估岗位匹配度或求职条件时使用。',
  instructions: '',
  version: BOSS_SKILL_VERSION,
  builtIn: true,
  enabled: true,
  matchedOrigins: ['https://www.zhipin.com/*'],
  allowedTools: [
    'browser_action',
    'read_current_page',
    'observe_page',
    'observe_visual_page',
    'interact_page',
    'ask_user',
    'load_skill',
  ],
  references: [
    { path: 'references/search-workflow.md', label: 'search-workflow' },
    { path: 'references/job-evaluation.md', label: 'job-evaluation' },
  ],
};

export interface BuiltinSkillBundle {
  definition: SkillDefinition;
  instructions: SkillResource;
  references: Readonly<Record<string, SkillResource>>;
}

export type SkillResource = { kind: 'url'; value: string } | { kind: 'inline'; value: string };

export function loadBuiltinSkillBundles(): BuiltinSkillBundle[] {
  return [
    {
      definition: BOSS_SKILL_DEFINITION,
      instructions: { kind: 'url', value: bossSkillUrl },
      references: {
        'references/search-workflow.md': { kind: 'url', value: bossSearchReferenceUrl },
        'references/job-evaluation.md': { kind: 'url', value: bossEvaluationReferenceUrl },
      },
    },
  ];
}
