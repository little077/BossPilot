// ─── zhipin.com 内容脚本 ───
// 职责刻意保持极小：只做验证码/安全拦截页检测并上报给后台。
// 所有数据抽取都由后台通过 chrome.scripting 注入自包含函数完成，
// 不在常驻脚本里做，避免与页面框架产生耦合。

export default defineContentScript({
  matches: ['https://www.zhipin.com/*'],
  runAt: 'document_idle',

  main() {
    let reported = false;

    const check = () => {
      if (reported) return;
      const bodyText = document.body?.innerText ?? '';
      const hit =
        location.href.includes('security-check') ||
        location.href.includes('captcha') ||
        /安全验证|请完成验证|异常访问/.test(bodyText.slice(0, 2000));
      if (hit) {
        reported = true;
        void chrome.runtime.sendMessage({ type: 'zhipin_captcha_detected' }).catch(() => void 0);
      }
    };

    check();
    // SPA 场景下拦截页可能后挂载：轻量观察 body 变化，命中一次即停
    const observer = new MutationObserver(() => {
      check();
      if (reported) observer.disconnect();
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
    // 兜底：30 秒后不再观察，避免常驻开销
    setTimeout(() => observer.disconnect(), 30_000);
  },
});
