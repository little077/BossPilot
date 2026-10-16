// ─── 日志脱敏器（观测/诊断的唯一出口） ───
// 任何要写进日志、trace 预览或回传 UI 的错误文本，都必须先过这里：剥离密钥明文 →
// 折叠空白 → 按上限截断。AGENTS.md 隐私红线要求「日志导出前必须经 redaction 脱敏」，
// 本文件就是那个被承诺的 sanitizer——单一事实源，别处不得再各写一份剥离逻辑。
// 为什么参数化 secrets 数组而非单个 apiKey：错误文本里可能夹带多种敏感串（密钥、
// 内部编号），统一按「命中即替换为 [REDACTED]」处理，调用方只负责给出要屏蔽的清单。

/** 默认截断上限：与旧 background.safeErrorMessage 保持一致，避免行为漂移。 */
export const DEFAULT_MAX_LOG_CHARS = 300;

/** trace 预览列宽上限：单步预览只用于人眼定位，取更短的值以免轨迹文本膨胀。 */
export const TRACE_PREVIEW_CHARS = 200;

/**
 * 脱敏并归一化一段文本：
 * 1) 逐个把 secrets 中的非空明文替换为 [REDACTED]；
 * 2) 折叠所有连续空白为单个空格并 trim（错误堆栈里的换行/缩进不利于单行展示）；
 * 3) 截断到 maxLength。
 * 注意：只做「屏蔽 + 整形」，不补默认文案——空串仍返回空串，由调用方决定兜底文本。
 */
export function sanitizeForLog(
  text: string,
  secrets: readonly string[],
  maxLength: number = DEFAULT_MAX_LOG_CHARS,
): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join('[REDACTED]');
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
