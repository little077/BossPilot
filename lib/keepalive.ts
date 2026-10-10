// ─── MV3 Service Worker 流式保活 ───
// MV3 后台空闲约 30s 被终止，流式对话期间必须续命。三层兜底：
// 1) sidepanel 打开即维持长连接 Port（活跃 Port 会重置空闲计时器）；
// 2) 流式期间用 chrome.alarms 周期触发 onAlarm 事件续命（setInterval 在 SW 空闲会被冻结，不可靠）；
// 3) 每个流式 token 的到达本身就是网络/事件活动，天然重置计时器。

const ALARM_NAME = 'bosspilot-stream-keepalive';
// Chrome 允许的最小闹钟周期为 30s。
const KEEP_ALIVE_PERIOD_MINUTES = 0.5;

/** 注册闹钟处理器：读到一次 storage 即产生事件、重置空闲计时器。需在 SW 启动时调用一次。 */
export function registerKeepAliveHandler(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void chrome.storage.local.get('_keepalive');
  });
}

/** 流式开始时启动保活闹钟。 */
export function startStreamKeepAlive(): void {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: KEEP_ALIVE_PERIOD_MINUTES });
}

/** 流式结束/取消后停止保活，避免空闲期无谓唤醒。 */
export function stopStreamKeepAlive(): void {
  void chrome.alarms.clear(ALARM_NAME);
}
