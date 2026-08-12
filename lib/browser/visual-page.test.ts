import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageTurnSnapshot } from '@/lib/domain/types';
import {
  captureMarkedPageScreenshot,
  installVisualOverlay,
  parseScreenshotDataUrl,
  removeVisualOverlay,
} from './visual-page';

const SNAPSHOT: PageTurnSnapshot = {
  tabId: 7,
  windowId: 3,
  url: 'https://www.zhipin.com/web/geek/job',
  safeUrl: 'https://www.zhipin.com/web/geek/job',
  origin: 'https://www.zhipin.com',
  title: '测试页面',
  scheme: 'https',
  isHttp: true,
  isBoss: true,
  capturedAt: 1,
};

const query = vi.fn();
const update = vi.fn();
const captureVisibleTab = vi.fn();
const executeScript = vi.fn();

beforeEach(() => {
  document.body.innerHTML = `
    <label>关键词 <input id="query" value="secret value"></label>
    <button id="filter" type="button">筛选</button>
  `;
  mockVisibleRects();
  query.mockReset().mockResolvedValue([{ id: 7, windowId: 3, active: true }]);
  update.mockReset().mockResolvedValue({});
  captureVisibleTab.mockReset().mockResolvedValue('data:image/jpeg;base64,YWJj');
  executeScript.mockReset().mockImplementation(async (details) => {
    const result = details.func(...(details.args ?? []));
    return [{ result, documentId: 'doc-1' }];
  });
  vi.stubGlobal('chrome', {
    tabs: { query, update, captureVisibleTab },
    scripting: { executeScript },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('temporary visual overlay', () => {
  it('marks grounded controls, masks existing field values, and removes cleanly', () => {
    const result = installVisualOverlay('token-1', SNAPSHOT.url, [
      { ref: 'e1', path: [1, 1], tag: 'button', risk: 'safe' },
    ]);

    expect(result).toMatchObject({ ok: true, markerCount: 1, maskedFieldCount: 1 });
    const root = document.getElementById('bosspilot-visual-token-1');
    expect(root).not.toBeNull();
    expect(root).toHaveTextContent('e1');
    expect(root).not.toHaveTextContent('secret value');
    expect((document.querySelector('#query') as HTMLInputElement).value).toBe('secret value');
    expect(removeVisualOverlay('token-1')).toBe(true);
    expect(removeVisualOverlay('token-1')).toBe(false);
  });

  it('rejects stale pages, duplicate roots, broken paths, hidden controls, and unsupported markers', () => {
    expect(installVisualOverlay('stale', 'https://other.example/', [])).toMatchObject({
      ok: false,
      error: 'STALE_VISUAL_OBSERVATION',
    });

    const first = installVisualOverlay('duplicate', SNAPSHOT.url, []);
    expect(first.ok).toBe(true);
    expect(installVisualOverlay('duplicate', SNAPSHOT.url, [])).toMatchObject({
      ok: false,
      error: 'VISUAL_CAPTURE_FAILED',
    });
    removeVisualOverlay('duplicate');

    const button = document.querySelector('#filter') as HTMLElement;
    button.style.display = 'none';
    expect(
      installVisualOverlay('invalid-markers', SNAPSHOT.url, [
        { ref: 'e1', path: [99], tag: 'button', risk: 'blocked' },
        { ref: 'e2', path: [1, 1], tag: 'button', risk: 'confirm' },
      ]),
    ).toMatchObject({ ok: true, markerCount: 0 });
    removeVisualOverlay('invalid-markers');
  });
});

describe('screenshot payload validation', () => {
  it('accepts bounded image formats and calculates decoded size', () => {
    expect(parseScreenshotDataUrl('data:image/jpeg;base64,YWJj')).toEqual({
      data: 'YWJj',
      mimeType: 'image/jpeg',
      approximateBytes: 3,
    });
    expect(parseScreenshotDataUrl('data:image/png;base64,YQ==').approximateBytes).toBe(1);
    expect(parseScreenshotDataUrl('data:image/webp;base64,YWI=').approximateBytes).toBe(2);
  });

  it('rejects malformed, unsupported, and oversized payloads', () => {
    expect(() => parseScreenshotDataUrl('not-a-data-url')).toThrow('无效');
    expect(() => parseScreenshotDataUrl('data:image/gif;base64,YWJj')).toThrow('无效');
    expect(() => parseScreenshotDataUrl(`data:image/jpeg;base64,${'a'.repeat(2_000_001)}`)).toThrow(
      '大小上限',
    );
  });
});

describe('marked page capture', () => {
  it('captures the bound active tab and always removes the overlay', async () => {
    const result = await captureMarkedPageScreenshot({
      snapshot: SNAPSHOT,
      documentId: 'doc-1',
      elements: [marker('e1')],
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      data: 'YWJj',
      mimeType: 'image/jpeg',
      markerCount: 1,
      maskedFieldCount: 1,
    });
    expect(captureVisibleTab).toHaveBeenCalledWith(3, { format: 'jpeg', quality: 72 });
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[id^="bosspilot-visual-"]')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('temporarily activates a background task tab and restores the previous tab', async () => {
    query
      .mockResolvedValueOnce([{ id: 9, windowId: 3, active: true }])
      .mockResolvedValueOnce([{ id: 7, windowId: 3, active: true }]);

    await captureMarkedPageScreenshot({
      snapshot: SNAPSHOT,
      documentId: 'doc-1',
      elements: [marker('e1')],
      signal: new AbortController().signal,
    });

    expect(update.mock.calls).toEqual([
      [7, { active: true }],
      [9, { active: true }],
    ]);
  });

  it('cleans up after capture failure without overriding a user tab switch', async () => {
    query
      .mockResolvedValueOnce([{ id: 9, windowId: 3, active: true }])
      .mockResolvedValueOnce([{ id: 10, windowId: 3, active: true }]);
    captureVisibleTab.mockRejectedValue(new Error('capture failed'));

    await expect(
      captureMarkedPageScreenshot({
        snapshot: SNAPSHOT,
        documentId: 'doc-1',
        elements: [marker('e1')],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('capture failed');
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed or failed overlay results before taking a screenshot', async () => {
    executeScript.mockResolvedValueOnce([{ result: { version: 1, ok: true } }]);
    await expect(
      captureMarkedPageScreenshot({
        snapshot: SNAPSHOT,
        documentId: 'doc-1',
        elements: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('建立视觉标记层');
    expect(captureVisibleTab).not.toHaveBeenCalled();

    executeScript.mockResolvedValueOnce([
      {
        result: {
          version: 1,
          ok: false,
          executionUrl: SNAPSHOT.url,
          token: 'x',
          markerCount: 0,
          maskedFieldCount: 0,
          detail: 'stale page',
        },
      },
    ]);
    await expect(
      captureMarkedPageScreenshot({
        snapshot: SNAPSHOT,
        documentId: 'doc-1',
        elements: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('stale page');
  });
});

function marker(ref: string) {
  return {
    ref,
    path: [1, 1],
    tag: 'button',
    role: 'button',
    name: '筛选',
    type: '',
    disabled: false,
    risk: 'safe' as const,
  };
}

function mockVisibleRects(): void {
  for (const element of Array.from(document.body.children).flatMap((child) => [
    child,
    ...Array.from(child.children),
  ])) {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      x: 20,
      y: 30,
      left: 20,
      top: 30,
      right: 180,
      bottom: 70,
      width: 160,
      height: 40,
      toJSON: () => ({}),
    });
  }
}
