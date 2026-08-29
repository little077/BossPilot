import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechErrorKind, SpeechMode } from '@/lib/speech/recognition';
import { useSpeechRecognition } from './useSpeechRecognition';

interface FakeResultEvent {
  resultIndex: number;
  results: Array<{ isFinal: boolean; 0: { transcript: string } }>;
}

/** 可控假 SpeechRecognition（与 lib/speech/recognition.test.ts 同一套约定）。 */
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

const instance = () => {
  const inst = FakeRecognition.instances[0];
  if (!inst) throw new Error('expected a SpeechRecognition instance');
  return inst;
};

function Harness({
  mode,
  onInterim,
  onFinal,
  onError,
}: {
  mode?: SpeechMode;
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (kind: SpeechErrorKind) => void;
}) {
  const speech = useSpeechRecognition({
    mode,
    onInterim: onInterim ?? (() => {}),
    onFinal: onFinal ?? (() => {}),
    onError,
  });
  return (
    <div>
      <span data-testid="state">{speech.state}</span>
      <span data-testid="supported">{String(speech.supported)}</span>
      <button type="button" onClick={() => void speech.start()}>
        start
      </button>
      <button type="button" onClick={speech.stop}>
        stop
      </button>
    </div>
  );
}

const renderHarness = (props: Parameters<typeof Harness>[0] = {}) => render(<Harness {...props} />);

beforeEach(() => {
  FakeRecognition.reset();
  vi.stubGlobal('SpeechRecognition', FakeRecognition);
  vi.stubGlobal('webkitSpeechRecognition', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSpeechRecognition', () => {
  it('supported：无构造函数时 false', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    renderHarness();
    expect(screen.getByTestId('supported').textContent).toBe('false');
  });

  it('supported：auto 模式有构造函数时 true', () => {
    renderHarness();
    expect(screen.getByTestId('supported').textContent).toBe('true');
  });

  it('云端兜底路径：点击 start 进入 listening 并创建会话', async () => {
    // available 未设置 → getLanguageStatus 返回 unavailable → 走云端
    renderHarness();
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await act(async () => {});
    expect(screen.getByTestId('state').textContent).toBe('listening');
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(instance().processLocally).toBe(false);
  });

  it('interim 实时回调，final 经 cleanTranscript 清洗后回调', async () => {
    const onInterim = vi.fn();
    const onFinal = vi.fn();
    renderHarness({ onInterim, onFinal });
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await act(async () => {});
    const inst = instance();

    act(() => {
      inst.onresult?.({
        resultIndex: 0,
        results: [{ isFinal: false, 0: { transcript: '帮我' } }],
      });
    });
    await act(async () => {});
    expect(onInterim).toHaveBeenCalledWith('帮我');

    act(() => {
      inst.onresult?.({
        resultIndex: 0,
        results: [{ isFinal: true, 0: { transcript: '今 天 天 气' } }],
      });
    });
    await act(async () => {});
    expect(onFinal).toHaveBeenCalledWith('今天天气');
  });

  it('stop：立即复位 idle 并停止会话，迟到的结果回调被作废', async () => {
    const onInterim = vi.fn();
    const onFinal = vi.fn();
    renderHarness({ onInterim, onFinal });
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await act(async () => {});
    const inst = instance();

    fireEvent.click(screen.getByRole('button', { name: 'stop' }));
    expect(screen.getByTestId('state').textContent).toBe('idle');
    expect(inst.stop).toHaveBeenCalled();

    // 迟到的引擎回调不再上抛（会话序号已前进）
    act(() => {
      inst.onresult?.({
        resultIndex: 0,
        results: [{ isFinal: false, 0: { transcript: '迟到' } }],
      });
    });
    await act(async () => {});
    expect(onInterim).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
  });

  it('onEnd：正常结束回 idle，可再次 start', async () => {
    renderHarness();
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await act(async () => {});
    act(() => instance().onend?.());
    await act(async () => {});
    expect(screen.getByTestId('state').textContent).toBe('idle');

    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await act(async () => {});
    expect(FakeRecognition.instances).toHaveLength(2);
  });

  it('onError：置 error 态并上报归一化错误；onEnd 后保持 error', async () => {
    const onError = vi.fn();
    renderHarness({ onError });
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await act(async () => {});
    const inst = instance();

    act(() => inst.onerror?.({ error: 'no-speech' }));
    await act(async () => {});
    expect(screen.getByTestId('state').textContent).toBe('error');
    expect(onError).toHaveBeenCalledWith('no-speech');

    act(() => inst.onend?.());
    await act(async () => {});
    expect(screen.getByTestId('state').textContent).toBe('error');
  });

  it('not-allowed 错误同样上报', async () => {
    const onError = vi.fn();
    renderHarness({ onError });
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await act(async () => {});
    act(() => instance().onerror?.({ error: 'not-allowed' }));
    await act(async () => {});
    expect(onError).toHaveBeenCalledWith('not-allowed');
  });

  it('语言包下载中：preparing 态，装好后自动进入本地听写（processLocally=true）', async () => {
    let resolveInstall!: (value: boolean) => void;
    FakeRecognition.available = vi
      .fn()
      .mockResolvedValueOnce('downloadable')
      .mockResolvedValueOnce('available');
    FakeRecognition.install = vi.fn(
      () => new Promise<boolean>((resolve) => (resolveInstall = resolve)),
    );

    renderHarness();
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await act(async () => {});
    expect(screen.getByTestId('state').textContent).toBe('preparing');
    expect(FakeRecognition.instances).toHaveLength(0);

    act(() => resolveInstall(true));
    await act(async () => {});
    expect(screen.getByTestId('state').textContent).toBe('listening');
    expect(instance().processLocally).toBe(true);
  });

  it('preparing 期间重复 start 被忽略（防重入）', async () => {
    let resolveInstall!: (value: boolean) => void;
    FakeRecognition.available = vi
      .fn()
      .mockResolvedValueOnce('downloadable')
      .mockResolvedValueOnce('available');
    FakeRecognition.install = vi.fn(
      () => new Promise<boolean>((resolve) => (resolveInstall = resolve)),
    );

    renderHarness();
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await act(async () => {});
    expect(FakeRecognition.install).toHaveBeenCalledTimes(1);

    act(() => resolveInstall(true));
    await act(async () => {});
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it('下载失败退云端兜底', async () => {
    FakeRecognition.available = vi
      .fn()
      .mockResolvedValueOnce('downloadable')
      .mockResolvedValueOnce('unavailable');
    FakeRecognition.install = vi.fn().mockResolvedValue(true);

    renderHarness();
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await act(async () => {});
    expect(screen.getByTestId('state').textContent).toBe('listening');
    expect(instance().processLocally).toBe(false);
  });

  it('强制 on-device 且本地不可用：报 language-unavailable 且不退云端', async () => {
    const onError = vi.fn();
    renderHarness({ mode: 'on-device', onError });
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await act(async () => {});
    expect(screen.getByTestId('state').textContent).toBe('error');
    expect(onError).toHaveBeenCalledWith('language-unavailable');
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it('启动失败（start 抛错）：error + unknown', async () => {
    const onError = vi.fn();
    FakeRecognition.startError = new Error('not allowed');
    renderHarness({ onError });
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await act(async () => {});
    expect(screen.getByTestId('state').textContent).toBe('error');
    expect(onError).toHaveBeenCalledWith('unknown');
  });

  it('卸载：中止进行中的会话，不再 setState', async () => {
    const { unmount } = renderHarness();
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await act(async () => {});
    const inst = instance();
    unmount();
    expect(inst.abort).toHaveBeenCalled();
  });
});
