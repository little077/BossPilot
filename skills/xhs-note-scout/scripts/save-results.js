// save-results：把采集结果写入工作区文件。
//
// input: { path: string, data: 可序列化对象 }
// path 必须位于 reports/ 目录下（如 reports/xhs-notes.json），防止脚本乱写工作区。
// 沙箱禁止脚本覆盖已有文件：文件已存在时会报错，由 LLM 改用工作区工具确认后处理。

const rawPath = String(input.path || '').trim();
const path = rawPath.startsWith('reports/') ? rawPath : `reports/${rawPath}`;
if (!/^reports\/[a-zA-Z0-9._-]+$/.test(path)) {
  return { ok: false, reason: '路径只能位于 reports/ 下且仅含字母数字、点、横线、下划线' };
}
const data = input.data;
if (data === undefined || data === null) {
  return { ok: false, reason: 'data 缺失' };
}

const result = await api.request('workspace.write', {
  operation: 'write',
  path,
  content: JSON.stringify(data, null, 2),
  mimeType: 'application/json',
});
return { ok: true, path: result?.path ?? path };
