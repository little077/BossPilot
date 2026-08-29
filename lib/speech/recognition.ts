// 语音识别核心（无 React、无 DOM 组件依赖）。
//
// 在 sidepanel（chrome-extension:// origin）直接调用浏览器 Web Speech API 的
// `SpeechRecognition`——云端路径在扩展 sidepanel 环境可正常转写，无需再向
// 页面注入 content script（Chrome 139+ 还支持本地 on-device 引擎）。
//
// 识别路径由 `processLocally` 区分：
//  - 本地（`processLocally = true`）：Chrome 139+ 的 SODA 引擎，首次需下载
//    语言包（`install()`），装好后完全离线、免费、有实时中间结果。
//  - 云端（`processLocally = false`）：浏览器默认（多为云端）识别，无需下载。
//
// 上层默认「本地优先、云端兜底」：本地可用走本地，本地不可用再退到云端。
// 注意国内网络下云端可能被墙而回 `network`，所以本地优先覆盖最广。
//
// 这一层只做「与浏览器 API 打交道」的纯逻辑：特性检测、locale→BCP-47、
// 语言包可用性查询 / 下载、启动一次识别会话。React 状态机在
// `entrypoints/sidepanel/useSpeechRecognition.ts`，文本清洗在 `transcript.ts`。

/** 识别模式选择（供上层决定走哪条路径）：
 *  - `auto`：本地优先、云端兜底（默认）。
 *  - `on-device`：强制本地，本地不可用即报错、不退云端。
 *  - `cloud`：强制云端，跳过本地语言包检查。 */
export type SpeechMode = 'auto' | 'on-device' | 'cloud';

/** on-device 语言包可用性。对应 `SpeechRecognition.available()` 的返回。 */
export type SpeechAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

/** 归一化后的识别错误类型，供上层做文案/降级判断。 */
export type SpeechErrorKind =
  // 麦克风未授权
  | 'not-allowed'
  // 没听到语音
  | 'no-speech'
  // 拿不到音频输入设备
  | 'audio-capture'
  // 走了云端且网络失败
  | 'network'
  // 该语言本地不可用
  | 'language-unavailable'
  // 主动 abort，正常停止，非真错误
  | 'aborted'
  | 'unknown';

/** 一次识别会话的回调集合。 */
export interface SpeechSessionCallbacks {
  /** 实时中间结果（临时、会被后续覆盖）。 */
  onInterim: (text: string) => void;
  /** 一段最终结果（原始文本，未清洗）。 */
  onFinal: (text: string) => void;
  /** 归一化后的错误。`aborted` 不会经此上报（视为正常停止）。 */
  onError: (kind: SpeechErrorKind) => void;
  /** 会话结束（无论正常停止、abort 还是出错后）。 */
  onEnd: () => void;
}

/** 控制一次进行中的识别会话。 */
export interface SpeechSessionHandle {
  /** 优雅停止：flush 最后一段结果后结束。 */
  stop: () => void;
  /** 立即终止：丢弃挂起结果。用于切换会话/卸载时兜底。 */
  abort: () => void;
}

function getRecognitionCtor(): SpeechRecognitionStatic | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

/** 把浏览器 UI 语言（如 "zh-CN" / "en-US"）映射成 SODA 本地引擎认的
 *  BCP-47 完整标签。本地引擎按完整标签注册语言包，简写（"zh" / "cmn"）
 *  会匹配不到，必须用 `cmn-Hans-CN` / `cmn-Hant-TW` / `en-US` 这类全标签。 */
function mapUiLangToRecognitionLang(uiLang: string): string {
  const lang = uiLang.toLowerCase();
  if (lang.startsWith('zh') || lang.startsWith('cmn')) {
    // 繁体（台湾 / 香港 / 显式 Hant）走 Hant-TW，其余中文走 Hans-CN。
    if (lang.includes('tw') || lang.includes('hk') || lang.includes('hant')) {
      return 'cmn-Hant-TW';
    }
    return 'cmn-Hans-CN';
  }
  return 'en-US';
}

function normalizeSpeechError(error: string): SpeechErrorKind {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'not-allowed';
    case 'no-speech':
      return 'no-speech';
    case 'audio-capture':
      return 'audio-capture';
    case 'network':
      return 'network';
    case 'language-not-supported':
      return 'language-unavailable';
    case 'aborted':
      return 'aborted';
    default:
      return 'unknown';
  }
}

// ─── 公开 API ─────────────────────────────────────────────────────

/** 浏览器是否提供 `SpeechRecognition`。不支持时上层应直接隐藏语音按钮。 */
export function isSpeechRecognitionSupported(): boolean {
  return getRecognitionCtor() !== undefined;
}

/** 是否支持 on-device 本地识别（存在 `available`/`install` 静态方法）。
 *  仅表征「本地路径」的能力——注意方法存在不代表真能用（Edge 上方法都在，
 *  但对所有语言都 `unavailable`）。允许云端兜底时，语音功能的真正前提是
 *  `isSpeechRecognitionSupported()`。 */
export function isOnDeviceSupported(): boolean {
  const Ctor = getRecognitionCtor();
  return typeof Ctor?.available === 'function' && typeof Ctor?.install === 'function';
}

/** 当前应使用的识别语言（BCP-47 全标签）。默认取扩展 UI 语言，可显式覆盖。 */
export function resolveRecognitionLang(uiLang?: string): string {
  const source =
    uiLang ??
    (typeof chrome !== 'undefined' ? chrome.i18n?.getUILanguage?.() : undefined) ??
    'en-US';
  return mapUiLangToRecognitionLang(source);
}

/** 查询某语言的本地语言包状态。不支持 on-device 时返回 `unavailable`。 */
export async function getLanguageStatus(lang: string): Promise<SpeechAvailability> {
  const Ctor = getRecognitionCtor();
  if (!Ctor?.available) return 'unavailable';
  try {
    return await Ctor.available({ langs: [lang], processLocally: true });
  } catch {
    return 'unavailable';
  }
}

/** 下载某语言的本地语言包（首次使用前）。返回是否成功。 */
export async function installLanguage(lang: string): Promise<boolean> {
  const Ctor = getRecognitionCtor();
  if (!Ctor?.install) return false;
  try {
    return await Ctor.install({ langs: [lang], processLocally: true });
  } catch {
    return false;
  }
}

/** 启动一次识别会话。调用前应确保语言包 `available`（本地路径）且麦克风已
 *  授权。`mode` 决定走本地 on-device（`'on-device'`）还是云端（`'cloud'`）；
 *  `'auto'` 是上层策略，到这一层时已被决议成具体的两者之一。
 *
 *  返回 handle 用 `abort()` 兜底停止（实测 `abort()` 能可靠触发 `onend`，
 *  而 continuous 模式下 `stop()` 有时迟迟不结束）。`stop()` 仍保留用于
 *  「说完这句再停」的优雅路径。
 *
 *  启动失败（无构造函数 / `start()` 抛错）时返回 `null` —— 不会触发任何
 *  回调，由调用方据此判定失败。 */
export function startSpeechSession(
  lang: string,
  cb: SpeechSessionCallbacks,
  mode: Exclude<SpeechMode, 'auto'>,
): SpeechSessionHandle | null {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;

  const rec = new Ctor();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = true;
  try {
    rec.processLocally = mode === 'on-device';
  } catch {
    // 不支持该属性的环境：忽略，靠上层的模式决策与 on-device 检测拦截。
  }

  rec.onresult = (ev: SpeechRecognitionEvent) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const result = ev.results[i];
      if (!result) continue;
      const transcript = result[0]?.transcript ?? '';
      if (result.isFinal) {
        cb.onFinal(transcript);
      } else {
        interim += transcript;
      }
    }
    if (interim) cb.onInterim(interim);
  };

  rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
    const kind = normalizeSpeechError(ev.error);
    // abort 是主动停止，不当作错误上报（onend 仍会触发做清理）。
    if (kind !== 'aborted') cb.onError(kind);
  };

  rec.onend = () => cb.onEnd();

  try {
    rec.start();
  } catch {
    return null;
  }

  return {
    stop: () => {
      try {
        rec.stop();
      } catch {
        /* 已停止 */
      }
    },
    abort: () => {
      try {
        rec.abort();
      } catch {
        /* 已停止 */
      }
    },
  };
}
