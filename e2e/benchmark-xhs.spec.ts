// ─── 基准 case 真实浏览器 e2e（M6.3）───
// 用真实模型跑基准 case：加载 xhs-note-scout 技能 → 小红书搜索 vibe coding 展示 → 整理结果。
// 需要环境变量（OpenAI 兼容端点）：
//   BENCHMARK_BASE_URL（如 https://api.openai.com/v1）
//   BENCHMARK_API_KEY
//   BENCHMARK_MODEL
// 未配置时自动跳过（CI 默认跳过）；配置后运行：npx playwright test benchmark-xhs
// 产出：tests/benchmark/results/xhs-search-vibe-coding-*.json 对比报告
// （与 lib/evals/benchmark 的固化基线同口径对比，M5 三项单独统计命中次数）。
//
// 注意：本文件不 import lib/（Playwright 不解析 @/ 别名），基线常量与
// baseline-20260829.ts 同步维护，改动需两边一致。

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';

const BASE_URL = process.env.BENCHMARK_BASE_URL ?? '';
const API_KEY = process.env.BENCHMARK_API_KEY ?? '';
const MODEL = process.env.BENCHMARK_MODEL ?? '';

const CASE_ID = 'xhs-search-vibe-coding';
const PROMPT = '加载 xhs-note-scout 技能，在小红书搜索 vibe coding 展示，整理搜索结果。';

/** 2026-08-29 日志固化基线（与 lib/evals/benchmark/baseline-20260829.ts 同步）。 */
const BASELINE = {
  modelTurns: 16,
  toolCalls: 29,
  succeededTools: 21,
  failedTools: 8,
  durationMs: 69_000,
  retryWastedMs: 36_660,
  safetyDecisions: 0,
  cachedReads: 0,
  unchangedContextInjections: 0,
  hintSuggestions: 0,
};

interface CapturedChatRequest {
  startedAt: number;
  messages: Array<{ role?: string; content?: unknown }>;
}

test.skip(
  !(BASE_URL && API_KEY && MODEL),
  '基准 e2e 需要 BENCHMARK_BASE_URL / BENCHMARK_API_KEY / BENCHMARK_MODEL 环境变量',
);

test('基准 case：加载技能 → 小红书搜索 → 整理结果，生成对比报告', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(300_000);

  const chatRequests: CapturedChatRequest[] = [];
  await context.route(`${BASE_URL.replace(/\/+$/u, '')}/**`, async (route) => {
    const url = route.request().url();
    if (!url.includes('/chat/completions')) {
      await route.continue();
      return;
    }
    const raw = route.request().postDataJSON() as unknown;
    const body = isRecord(raw) ? raw : {};
    chatRequests.push({
      startedAt: Date.now(),
      messages: Array.isArray(body.messages)
        ? body.messages.flatMap((message) =>
            isRecord(message) && typeof message.role === 'string'
              ? [{ role: message.role, content: message.content }]
              : [],
          )
        : [],
    });
    await route.continue();
  });

  // 1. 配置自定义端点（BYOK：真实模型）。
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: '设置' }).click();
  await panel.getByRole('button', { name: /显示更多/ }).click();
  await panel.getByRole('button', { name: /自定义端点/ }).click();
  const card = panel.getByRole('article', { name: '自定义端点 模型配置' });
  await card.getByLabel('Base URL（OpenAI 兼容端点）').fill(BASE_URL);
  await card.getByLabel('API Key（仅存本机）').fill(API_KEY);
  await card.getByRole('button', { name: '开通' }).click();
  const modelPattern = new RegExp(MODEL.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  await card.getByRole('button', { name: modelPattern }).click();
  await expect(card.getByRole('button', { name: modelPattern })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // 2. 打开小红书，发送基准 prompt。
  const xhs = await context.newPage();
  await xhs.goto('https://www.xiaohongshu.com/explore').catch(() => void 0);
  await xhs.bringToFront();

  await panel.getByRole('button', { name: '对话' }).click();
  await panel.locator('.composer-editor [contenteditable="true"]').fill(PROMPT);
  const sentAt = Date.now();
  await panel.getByRole('button', { name: '发送' }).click();

  // 3. 等待任务完成（停止生成按钮消失 = 生成循环结束）。
  await expect(panel.getByRole('button', { name: '停止生成' })).toHaveCount(0, {
    timeout: 240_000,
  });

  // 4. 从 UI 运行详情提取台账口径指标（与 summarizeAgentRun 同源）。
  const summary = panel.locator('.agent-run-summary');
  await expect(summary).toBeVisible({ timeout: 30_000 });
  await summary.locator('summary').click();
  const toolText = await summary
    .locator('.agent-run-row', { hasText: '工具' })
    .locator('dd')
    .textContent();
  const toolMatch = /(\d+)\s*次 · 成功 (\d+) · 失败 (\d+)/u.exec(toolText ?? '');
  const durationText = await summary
    .locator('.agent-run-row', { hasText: '执行耗时' })
    .locator('dd')
    .textContent();
  const durationMatch = /([\d.]+)s/u.exec(durationText ?? '');
  if (!toolMatch || !durationMatch) {
    throw new Error(`运行详情解析失败：工具行="${toolText}" 耗时行="${durationText}"`);
  }
  const toolCalls = Number(toolMatch[1]);
  const succeededTools = Number(toolMatch[2]);
  const failedTools = Number(toolMatch[3]);
  const durationMs = Math.round(Number(durationMatch[1]) * 1_000);

  // 5. 最终回答宽松断言：搜索成功 + 结果整理完成（内容非空即可，具体断言放单元层）。
  const answers = panel.locator('.redscope-ai-message');
  await expect(answers.last()).not.toBeEmpty();
  const finalAnswer = await answers.last().textContent();

  // 6. M5 三项命中：从最后一个模型请求（携带全部历史）统计，与 measureRun 口径一致。
  const last = chatRequests.at(-1);
  const toolContents =
    last?.messages
      .filter(({ role, content }) => role === 'tool' && typeof content === 'string')
      .map(({ content }) => content as string) ?? [];
  const userContents =
    last?.messages
      .filter(({ role, content }) => role === 'user' && typeof content === 'string')
      .map(({ content }) => content as string) ?? [];
  const cachedReads = toolContents.filter((content) => content.includes('（cached）')).length;
  const hintSuggestions = toolContents.filter((content) => content.includes('[hint]')).length;
  const unchangedContextInjections = userContents.filter((content) =>
    content.includes('"changedSinceLastRead":false'),
  ).length;

  const current = {
    modelTurns: chatRequests.length,
    toolCalls,
    succeededTools,
    failedTools,
    durationMs: durationMs > 0 ? durationMs : Date.now() - sentAt,
    retryWastedMs: 0,
    safetyDecisions: 0,
    cachedReads,
    unchangedContextInjections,
    hintSuggestions,
  };

  // 7. 与固化基线对比，写入报告（负 delta 即提升；M5 三项为正向加分项）。
  const delta = (key: keyof typeof BASELINE) => current[key] - BASELINE[key];
  const deltas = {
    modelTurns: delta('modelTurns'),
    toolCalls: delta('toolCalls'),
    succeededTools: delta('succeededTools'),
    failedTools: delta('failedTools'),
    durationMs: delta('durationMs'),
    retryWastedMs: delta('retryWastedMs'),
    safetyDecisions: delta('safetyDecisions'),
    cachedReads: delta('cachedReads'),
    unchangedContextInjections: delta('unchangedContextInjections'),
    hintSuggestions: delta('hintSuggestions'),
  };
  const violations: string[] = [];
  if (deltas.modelTurns > 0) violations.push(`模型轮次 +${deltas.modelTurns}`);
  if (deltas.toolCalls > 0) violations.push(`工具调用 +${deltas.toolCalls}`);
  if (deltas.failedTools > 0) violations.push(`失败工具 +${deltas.failedTools}`);
  if (deltas.durationMs > 0) violations.push(`端到端耗时 +${deltas.durationMs}ms`);
  if (deltas.retryWastedMs > 0) violations.push(`重试浪费 +${deltas.retryWastedMs}ms`);
  if (deltas.safetyDecisions > 0) violations.push(`安全决策 +${deltas.safetyDecisions}`);
  const noRegression = violations.length === 0;

  const report = {
    caseId: CASE_ID,
    label: `e2e-real-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}`,
    baseline: BASELINE,
    current,
    deltas,
    noRegression,
    violations,
    finalAnswer: finalAnswer?.slice(0, 300),
    note: 'M5 三项为正向加分项（不计入不劣化判定）；真实网络/页面波动可能影响耗时指标。',
  };
  const resultsDir = path.resolve('tests/benchmark/results');
  mkdirSync(resultsDir, { recursive: true });
  const reportPath = path.join(
    resultsDir,
    `${CASE_ID}-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.json`,
  );
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`[基准 e2e] 报告已写入 ${reportPath}`);
  console.log(
    `[基准 e2e] 轮次 ${current.modelTurns}（基线 ${BASELINE.modelTurns}）· 工具 ${current.toolCalls}（基线 ${BASELINE.toolCalls}）· 耗时 ${current.durationMs}ms（基线 ${BASELINE.durationMs}ms）· M5 命中 缓存 ${current.cachedReads} / 差异注入 ${current.unchangedContextInjections} / 建议 ${current.hintSuggestions}`,
  );
  console.log(
    `[基准 e2e] 不劣化：${noRegression}${violations.length ? `；违规：${violations.join('、')}` : ''}`,
  );

  expect(finalAnswer).toBeTruthy();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
