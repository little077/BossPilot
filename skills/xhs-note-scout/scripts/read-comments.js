// read-comments：滚动评论区并抽取当前已渲染的评论。
//
// input: { maxScrolls?: number } 单轮滚动次数（默认 1，上限 2）
// 与 collect-page 相同的小步策略：多轮调用累积结果，每轮由 LLM 去重合并。

const maxScrolls = Math.max(0, Math.min(Number(input.maxScrolls) || 1, 2));
const waitMs = 1000;

let selectorMiss = false;
let scrollCount = 0;
let comments = [];
let total = '';

for (let step = 0; step <= maxScrolls; step += 1) {
  const batch = await api.request('page.read', { fn: 'xhs.extractComments' });
  if (batch.selectorMiss) {
    selectorMiss = true;
    break;
  }
  comments = batch.comments;
  total = String(batch.total || total);
  if (step === maxScrolls) break;
  const scroll = await api.request('page.script', {
    fn: 'xhs.scrollComments',
    args: [520],
  });
  scrollCount += 1;
  if (scroll.selectorMiss || scroll.atBottom || !scroll.moved) break;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

return { comments, total, scrollCount, selectorMiss };
