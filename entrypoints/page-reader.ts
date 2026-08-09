// ─── 一次性通用页面读取脚本 ───
// 由 Background 通过 chrome.scripting 注入 ISOLATED world；不注册常驻监听器。

import { extractCurrentDocument } from '@/lib/page/extractor';

export default defineUnlistedScript({
  globalName: false,
  main() {
    return extractCurrentDocument(document);
  },
});
