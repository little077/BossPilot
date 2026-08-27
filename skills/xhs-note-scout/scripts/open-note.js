// open-note：打开指定笔记的详情弹窗并轮询确认。
//
// input: { noteId: string, href?: string, waitBeforeOpenMs?: number }
// 节奏策略：
// - 打开前默认等待 900ms，避免连续高频点击触发站点风控。
// - 只调用适配层的安全打开函数，适配层会优先点击标题/封面，不碰互动区。
// - 未打开时返回 reason，由 SKILL.md 指导 LLM 跳过/询问，不在脚本里猛重试。

const noteId = String(input.noteId || '').trim();
if (!noteId) return { opened: false, open: false, selectorMiss: true, reason: 'noteId 缺失' };

const href = String(input.href || input.openHref || '').trim();
const waitBeforeOpenMs = Math.max(500, Math.min(Number(input.waitBeforeOpenMs) || 900, 1800));
await new Promise((resolve) => setTimeout(resolve, waitBeforeOpenMs));

const clicked = await api.request('page.script', { fn: 'xhs.openNote', args: [noteId, href] });
if (clicked.captcha) {
  return { ...clicked, opened: false, open: false, reason: clicked.reason || '页面出现安全验证或访问异常' };
}
if (clicked.selectorMiss || !clicked.opened) {
  return {
    opened: false,
    open: Boolean(clicked.open),
    selectorMiss: clicked.selectorMiss,
    reason: clicked.reason || '未找到安全可点击的笔记入口',
    targetKind: clicked.targetKind || '',
    targetHref: clicked.targetHref || '',
  };
}

let open = false;
let title = '';
for (let attempt = 0; attempt < 8; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 700));
  const state = await api.request('page.read', { fn: 'xhs.isNoteOpen' });
  open = Boolean(state.open);
  title = String(state.title || '');
  if (open) break;
}

return {
  opened: true,
  open,
  title,
  selectorMiss: false,
  reason: open ? '' : '点击后未检测到笔记弹窗，建议跳过该篇或让用户手动确认页面状态',
  targetKind: clicked.targetKind || '',
  targetHref: clicked.targetHref || '',
};
