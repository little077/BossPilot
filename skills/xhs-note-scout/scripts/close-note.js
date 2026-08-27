// close-note：关闭帖子详情弹窗，回到主页列表。
//
// input: 无（可忽略）

const result = await api.request('page.script', { fn: 'xhs.closeNote' });
await new Promise((resolve) => setTimeout(resolve, 600));
const state = await api.request('page.read', { fn: 'xhs.isNoteOpen' });
return {
  ...result,
  closed: !state.open,
  open: Boolean(state.open),
  reason: result.selectorMiss ? '关闭按钮失配，站点可能改版' : '',
};
