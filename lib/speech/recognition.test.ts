import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLanguageStatus,
  installLanguage,
  isOnDeviceSupported,
  isSpeechRecognitionSupported,
  resolveRecognitionLang,
  startSpeechSession,
} from './recognition';

interface FakeResultEvent {
  resultIndex: number;
  results: Array<{ isFinal: boolean; 0: { transcript: string } }>;
}

/** 可控的假 SpeechRecognition：实例经 start 时收集，行为由静态开关控制。 */
class FakeRecognition {
  lang = '';
  interimResults = false;
  continuous = false;
  processLocally = false;
  onresult: ((event: FakeResultEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => {
    if (FakeRecognition.startError) throw FakeRecognition.startError;
    FakeRecognition.instances.push(this);
  });
  stop = vi.fn();
  abort = vi.fn();

  static instances: FakeRecognition[] = [];
  static startError: Error | null = null;
  static available: ((opts: unknown) => Promise<unknown>) | null = null;
  static install: ((opts: unknown) => Promise<unknown>) | null = null;

  static reset() {
    FakeRecognition.instances = [];
    FakeRecognition.startError = null;
    FakeRecognition.available = null;
    FakeRecognition.install = null;
  }
}

/** 触发一次 result 事件并 flush 回调链（recognition 的 onresult 同步执行）。 */
function emitResult(
  inst: FakeRecognition,
  resultIndex: number,
  results: FakeResultEvent['results'],
) {
  inst.onresult?.({ resultIndex, results });
}

const instance = () => {
  const inst = FakeRecognition.instances[0];
  if (!inst) throw new Error('expected a SpeechRecognition instance');
  return inst;
};

beforeEach(() => {
  FakeRecognition.reset();
  vi.stubGlobal('SpeechRecognition', FakeRecognition);
  vi.stubGlobal('webkitSpeechRecognition', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isSpeechRecognitionSupported', () => {
  it('存在构造函数时返回 true', () => {
    expect(isSpeechRecognitionSupported()).toBe(true);
  });

  it('不存在构造函数时返回 false', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    expect(isSpeechRecognitionSupported()).toBe(false);
  });

  it('webkit 前缀兜底', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    expect(isSpeechRecognitionSupported()).toBe(true);
  });
});

describe('isOnDeviceSupported', () => {
  it('available / install 均为函数时支持本地引擎', () => {
    FakeRecognition.available = vi.fn();
    FakeRecognition.install = vi.fn();
    expect(isOnDeviceSupported()).toBe(true);
  });

  it('静态方法缺失时不支持', () => {
    expect(isOnDeviceSupported()).toBe(false);
  });
});

describe('resolveRecognitionLang', () => {
  it('中文简体 → cmn-Hans-CN（SODA 全标签）', () => {
    expect(resolveRecognitionLang('zh-CN')).toBe('cmn-Hans-CN');
    expect(resolveRecognitionLang('zh')).toBe('cmn-Hans-CN');
  });

  it('繁体（台湾/香港/显式 Hant）→ cmn-Hant-TW', () => {
    expect(resolveRecognitionLang('zh-TW')).toBe('cmn-Hant-TW');
    expect(resolveRecognitionLang('zh-HK')).toBe('cmn-Hant-TW');
    expect(resolveRecognitionLang('zh-Hant')).toBe('cmn-Hant-TW');
  });

  it('非中文回退 en-US', () => {
    expect(resolveRecognitionLang('en-US')).toBe('en-US');
    expect(resolveRecognitionLang('ja')).toBe('en-US');
  });

  it('默认取扩展 UI 语言', () => {
    vi.stubGlobal('chrome', { i18n: { getUILanguage: () => 'zh-TW' } });
    expect(resolveRecognitionLang()).toBe('cmn-Hant-TW');
  });

  it('chrome.i18n 缺失时回退 en-US', () => {
    vi.stubGlobal('chrome', {});
    expect(resolveRecognitionLang()).toBe('en-US');
  });
});

describe('getLanguageStatus', () => {
  it('available 的结果原样透传', async () => {
    FakeRecognition.available = vi.fn().mockResolvedValue('available');
    await expect(getLanguageStatus('cmn-Hans-CN')).resolves.toBe('available');
    expect(FakeRecognition.available).toHaveBeenCalledWith({
      langs: ['cmn-Hans-CN'],
      processLocally: true,
    });
  });

  it('不支持本地引擎 / 查询抛错：unavailable', async () => {
    await expect(getLanguageStatus('cmn-Hans-CN')).resolves.toBe('unavailable');
    FakeRecognition.available = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(getLanguageStatus('cmn-Hans-CN')).resolves.toBe('unavailable');
  });
});

describe('installLanguage', () => {
  it('下载成功返回 true', async () => {
    FakeRecognition.install = vi.fn().mockResolvedValue(true);
    await expect(installLanguage('cmn-Hans-CN')).resolves.toBe(true);
    expect(FakeRecognition.install).toHaveBeenCalledWith({
      langs: ['cmn-Hans-CN'],
      processLocally: true,
    });
  });

  it('不支持 / 下载失败 / 抛错：false', async () => {
    await expect(installLanguage('cmn-Hans-CN')).resolves.toBe(false);
    FakeRecognition.install = vi.fn().mockResolvedValue(false);
    await expect(installLanguage('cmn-Hans-CN')).resolves.toBe(false);
    FakeRecognition.install = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(installLanguage('cmn-Hans-CN')).resolves.toBe(false);
  });
});

describe('startSpeechSession', () => {
  const callbacks = () => ({
    onInterim: vi.fn(),
    onFinal: vi.fn(),
    onError: vi.fn(),
    onEnd: vi.fn(),
  });

  it('无构造函数：返回 null 且不触发任何回调', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    const cb = callbacks();
    expect(startSpeechSession('cmn-Hans-CN', cb, 'cloud')).toBeNull();
    expect(cb.onInterim).not.toHaveBeenCalled();
  });

  it('start() 抛错：返回 null', () => {
    FakeRecognition.startError = new Error('not allowed');
    const cb = callbacks();
    expect(startSpeechSession('cmn-Hans-CN', cb, 'cloud')).toBeNull();
  });

  it('云端模式：配置语言/中间结果/持续识别，processLocally=false', () => {
    const cb = callbacks();
    const handle = startSpeechSession('cmn-Hans-CN', cb, 'cloud');
    expect(handle).not.toBeNull();
    const inst = instance();
    expect(inst.lang).toBe('cmn-Hans-CN');
    expect(inst.interimResults).toBe(true);
    expect(inst.continuous).toBe(true);
    expect(inst.processLocally).toBe(false);
  });

  it('本地模式：processLocally=true', () => {
    const handle = startSpeechSession('cmn-Hans-CN', callbacks(), 'on-device');
    expect(handle).not.toBeNull();
    expect(instance().processLocally).toBe(true);
  });

  it('onresult：interim 累积合并上报，final 逐段上报', () => {
    const cb = callbacks();
    startSpeechSession('cmn-Hans-CN', cb, 'cloud');
    const inst = instance();
    emitResult(inst, 0, [
      { isFinal: false, 0: { transcript: '今天' } },
      { isFinal: false, 0: { transcript: '天气' } },
    ]);
    expect(cb.onInterim).toHaveBeenCalledWith('今天天气');
    expect(cb.onFinal).not.toHaveBeenCalled();

    emitResult(inst, 0, [{ isFinal: true, 0: { transcript: '今天天气不错' } }]);
    expect(cb.onFinal).toHaveBeenCalledWith('今天天气不错');
  });

  it('onerror：归一化错误类型', () => {
    const cb = callbacks();
    startSpeechSession('cmn-Hans-CN', cb, 'cloud');
    instance().onerror?.({ error: 'not-allowed' });
    expect(cb.onError).toHaveBeenCalledWith('not-allowed');
  });

  it('onerror：aborted 视为正常停止，不上报', () => {
    const cb = callbacks();
    startSpeechSession('cmn-Hans-CN', cb, 'cloud');
    instance().onerror?.({ error: 'aborted' });
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('handle.stop / handle.abort 转发到实例方法', () => {
    const handle = startSpeechSession('cmn-Hans-CN', callbacks(), 'cloud');
    const inst = instance();
    handle?.stop();
    expect(inst.stop).toHaveBeenCalled();
    handle?.abort();
    expect(inst.abort).toHaveBeenCalled();
  });

  it('onend 触发', () => {
    const cb = callbacks();
    startSpeechSession('cmn-Hans-CN', cb, 'cloud');
    instance().onend?.();
    expect(cb.onEnd).toHaveBeenCalled();
  });
});
