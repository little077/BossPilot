// ─── 诊断记录：脱敏 ───
// 导出前对任何可能含密钥/凭据的文本做擦除。宁可多擦，也不泄漏。

const REDACTIONS: Array<[RegExp, string]> = [
  // OpenAI 风格密钥 sk-xxxx / sk-proj-xxxx
  [/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  // Authorization: Bearer xxxxx
  [/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***'],
  // apiKey / api_key / token / secret 后紧跟的值（引号或冒号赋值）
  [/("?(?:api[_-]?key|token|secret|password)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1***'],
];

/** 擦除文本中的密钥/凭据。传入非字符串按空串处理。 */
export function redact(text: string | undefined | null): string {
  if (!text) return '';
  let out = String(text);
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

/** 从 URL 取主机名；解析失败时返回原串（已脱敏）。避免把完整端点/查询参数写进日志。 */
export function hostOf(url: string | undefined | null): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return redact(url).replace(/\/.*$/, '');
  }
}
