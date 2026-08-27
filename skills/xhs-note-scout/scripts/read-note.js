// read-note：读取当前打开弹窗中的笔记详情。
//
// input: 无（可忽略）
// 先等待弹窗内容渲染，再抽取标题、正文、作者与互动数据。

if (!(await api.request('page.read', { fn: 'xhs.isNoteOpen' })).open) {
  return { selectorMiss: true, title: '', desc: '', author: '', likedCount: '', collectedCount: '', commentCount: '', mediaKind: 'unknown', reason: '笔记弹窗未打开，先运行 open-note.js' };
}

await new Promise((resolve) => setTimeout(resolve, 500));
const detail = await api.request('page.read', { fn: 'xhs.extractNoteDetail' });
return { ...detail, reason: detail.selectorMiss ? '关键选择器失配，站点可能改版' : '' };
