// read-profile：读取博主主页头部资料（昵称/小红书号/简介/互动数据）。
//
// input: 无（可忽略）

const profile = await api.request('page.read', { fn: 'xhs.extractProfile' });
return { ...profile, reason: profile.selectorMiss ? '关键选择器失配，站点可能改版' : '' };
