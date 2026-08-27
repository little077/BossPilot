// collect-page：单轮滚动采集主页已渲染的笔记卡片。
//
// 沙箱每次运行有 5 秒预算，所以本脚本只做「小步滚动 + 等待懒加载 + 抽取」的小循环，
// 由 SKILL.md 指导 LLM 多轮调用累积结果。页面选择器全部封装在适配层函数里，
// 脚本不接触任何 CSS 选择器。

const maxScrolls = Math.max(0, Math.min(Number(input.maxScrolls) || 1, 2));
const maxNotes = Math.max(0, Number(input.maxNotes) || 0);
const waitMs = Math.max(900, Math.min(Number(input.waitMs) || 1200, 1800));

const seen = new Map();
let captcha = false;
let selectorMiss = false;
let atBottom = false;
let scrollCount = 0;

for (let step = 0; step <= maxScrolls; step += 1) {
  const list = await api.request('page.read', { fn: 'xhs.extractNoteList' });
  if (list.captcha) {
    captcha = true;
    break;
  }
  if (list.selectorMiss) {
    selectorMiss = true;
    break;
  }
  for (const item of list.items) {
    if (!seen.has(item.noteId)) seen.set(item.noteId, item);
  }
  if (maxNotes > 0 && seen.size >= maxNotes) break;
  if (step === maxScrolls) break;
  const scroll = await api.request('page.script', {
    fn: 'xhs.scrollFeeds',
    args: [760],
  });
  scrollCount += 1;
  if (scroll.selectorMiss) {
    selectorMiss = true;
    break;
  }
  if (scroll.atBottom || !scroll.moved) {
    atBottom = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

return {
  notes: [...seen.values()],
  collected: seen.size,
  scrollCount,
  atBottom,
  captcha,
  selectorMiss,
};
