import type { SkillDefinition } from '@/lib/skills/types';
import bossEvaluationReferenceUrl from '@/skills/boss-job-search/references/job-evaluation.md?url&no-inline';
import bossSearchReferenceUrl from '@/skills/boss-job-search/references/search-workflow.md?url&no-inline';
import bossSkillUrl from '@/skills/boss-job-search/SKILL.md?url&no-inline';
import xhsCollectModeUrl from '@/skills/xhs-note-scout/references/collect-mode.md?url&no-inline';
import xhsExploreModeUrl from '@/skills/xhs-note-scout/references/explore-mode.md?url&no-inline';
import xhsSummaryGuideUrl from '@/skills/xhs-note-scout/references/summary-guide.md?url&no-inline';
import xhsSkillUrl from '@/skills/xhs-note-scout/SKILL.md?url&no-inline';
import xhsCloseNoteUrl from '@/skills/xhs-note-scout/scripts/close-note.js?url&no-inline';
import xhsCollectPageUrl from '@/skills/xhs-note-scout/scripts/collect-page.js?url&no-inline';
import xhsOpenNoteUrl from '@/skills/xhs-note-scout/scripts/open-note.js?url&no-inline';
import xhsReadCommentsUrl from '@/skills/xhs-note-scout/scripts/read-comments.js?url&no-inline';
import xhsReadNoteUrl from '@/skills/xhs-note-scout/scripts/read-note.js?url&no-inline';
import xhsReadProfileUrl from '@/skills/xhs-note-scout/scripts/read-profile.js?url&no-inline';
import xhsSaveResultsUrl from '@/skills/xhs-note-scout/scripts/save-results.js?url&no-inline';

const BOSS_SKILL_VERSION = '1.0.0';
const XHS_SKILL_VERSION = '1.0.0';

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
  capabilities: ['page.read'],
  references: [
    { path: 'references/search-workflow.md', label: 'search-workflow' },
    { path: 'references/job-evaluation.md', label: 'job-evaluation' },
  ],
};

const XHS_SKILL_DEFINITION: SkillDefinition = {
  name: 'xhs-note-scout',
  description:
    '在小红书博主主页采集笔记列表，逐篇读取笔记详情与评论区，并汇总成内容调研报告。用户提到小红书、博主主页、笔记采集、评论分析、内容调研或竞品分析时使用。',
  instructions: '',
  version: XHS_SKILL_VERSION,
  builtIn: true,
  enabled: true,
  matchedOrigins: ['https://www.xiaohongshu.com/*'],
  allowedTools: ['run_skill', 'ask_user', 'load_skill'],
  capabilities: ['page.read', 'page.script', 'workspace.write'],
  references: [
    { path: 'references/collect-mode.md', label: 'collect-mode' },
    { path: 'references/explore-mode.md', label: 'explore-mode' },
    { path: 'references/summary-guide.md', label: 'summary-guide' },
  ],
};

export interface BuiltinSkillBundle {
  definition: SkillDefinition;
  instructions: SkillResource;
  references: Readonly<Record<string, SkillResource>>;
  scripts: Readonly<Record<string, SkillResource>>;
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
      scripts: {},
    },
    {
      definition: XHS_SKILL_DEFINITION,
      instructions: { kind: 'url', value: xhsSkillUrl },
      references: {
        'references/collect-mode.md': { kind: 'url', value: xhsCollectModeUrl },
        'references/explore-mode.md': { kind: 'url', value: xhsExploreModeUrl },
        'references/summary-guide.md': { kind: 'url', value: xhsSummaryGuideUrl },
      },
      scripts: {
        'scripts/read-profile.js': { kind: 'url', value: xhsReadProfileUrl },
        'scripts/collect-page.js': { kind: 'url', value: xhsCollectPageUrl },
        'scripts/open-note.js': { kind: 'url', value: xhsOpenNoteUrl },
        'scripts/read-note.js': { kind: 'url', value: xhsReadNoteUrl },
        'scripts/read-comments.js': { kind: 'url', value: xhsReadCommentsUrl },
        'scripts/close-note.js': { kind: 'url', value: xhsCloseNoteUrl },
        'scripts/save-results.js': { kind: 'url', value: xhsSaveResultsUrl },
      },
    },
  ];
}
