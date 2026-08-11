import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureBrowserPageFingerprint, performSemanticSearch } from './semantic-search';

const visibleRect = {
  x: 0,
  y: 0,
  width: 240,
  height: 32,
  top: 0,
  right: 240,
  bottom: 32,
  left: 0,
  toJSON: () => ({}),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(visibleRect);
});

afterEach(() => vi.useRealTimers());

describe('performSemanticSearch', () => {
  it('discovers a visible search field, uses the native setter, and submits its form', async () => {
    document.body.innerHTML = `
      <form role="search">
        <label for="query">搜索职位</label>
        <input id="query" type="search" placeholder="职位关键词" />
      </form>
    `;
    const form = document.querySelector('form');
    const input = document.querySelector('input');
    if (!form || !input) throw new Error('test DOM missing');
    const submit = vi.spyOn(form, 'requestSubmit').mockImplementation(() => void 0);
    const onInput = vi.fn();
    input.addEventListener('input', onInput);

    const result = performSemanticSearch('AI Agent');

    expect(result).toMatchObject({
      ok: true,
      typed: true,
      submitted: true,
      submissionMethod: 'form',
      control: { tag: 'input', type: 'search' },
    });
    expect(input.value).toBe('AI Agent');
    expect(onInput).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30);
    expect(submit).toHaveBeenCalledOnce();
  });

  it('clicks a nearby semantic search button when no form exists', async () => {
    document.body.innerHTML = `
      <main>
        <input aria-label="搜索全站" />
        <button type="button">搜索</button>
      </main>
    `;
    const button = document.querySelector('button');
    const input = document.querySelector('input');
    if (!button || !input) throw new Error('test DOM missing');
    const click = vi.spyOn(button, 'click').mockImplementation(() => void 0);

    expect(performSemanticSearch('浏览器 Agent')).toMatchObject({
      ok: true,
      submissionMethod: 'button',
    });
    expect(input.value).toBe('浏览器 Agent');
    await vi.advanceTimersByTimeAsync(30);
    expect(click).toHaveBeenCalledOnce();
  });

  it('recognizes a dynamic-placeholder textarea from its nearby search action', async () => {
    document.body.innerHTML = `
      <div class="dynamic-input-shell">
        <div><textarea placeholder="众多球迷造访梅西老家"></textarea></div>
        <button type="button">百度一下</button>
      </div>
    `;
    const textarea = document.querySelector('textarea');
    const button = document.querySelector('button');
    if (!textarea || !button) throw new Error('test DOM missing');
    const click = vi.spyOn(button, 'click').mockImplementation(() => void 0);

    expect(performSemanticSearch('AI Agent')).toMatchObject({
      ok: true,
      control: { tag: 'textarea', placeholder: '众多球迷造访梅西老家' },
      submissionMethod: 'button',
    });
    expect(textarea.value).toBe('AI Agent');
    await vi.advanceTimersByTimeAsync(30);
    expect(click).toHaveBeenCalledOnce();
  });

  it('recognizes an input-style button and a broader semantic button label', async () => {
    document.body.innerHTML = `
      <input id="query" role="searchbox" />
      <input id="submit" type="button" value="搜索" />
    `;
    const submit = document.querySelector<HTMLInputElement>('#submit');
    if (!submit) throw new Error('test DOM missing');
    const click = vi.spyOn(submit, 'click').mockImplementation(() => void 0);
    expect(performSemanticSearch('Agent')).toMatchObject({ submissionMethod: 'button' });
    await vi.advanceTimersByTimeAsync(30);
    expect(click).toHaveBeenCalledOnce();

    document.body.innerHTML = `
      <input role="searchbox" />
      <div role="button" aria-label="开始搜索内容"></div>
    `;
    expect(performSemanticSearch('Agent')).toMatchObject({ submissionMethod: 'button' });
  });

  it('falls back to Enter and supports labelled contenteditable searchboxes', async () => {
    document.body.innerHTML = `
      <span id="search-label">查找知识库</span>
      <div role="searchbox" aria-labelledby="search-label" contenteditable="plaintext-only"></div>
    `;
    const control = document.querySelector<HTMLElement>('[role="searchbox"]');
    if (!control) throw new Error('test DOM missing');
    const keys: string[] = [];
    control.addEventListener('keydown', (event) => keys.push((event as KeyboardEvent).key));

    const result = performSemanticSearch('权限模型');
    expect(result).toMatchObject({
      ok: true,
      submissionMethod: 'keypress',
      control: { tag: 'contenteditable', label: expect.stringContaining('查找知识库') },
    });
    expect(control.textContent).toBe('权限模型');
    await vi.advanceTimersByTimeAsync(30);
    expect(keys).toEqual(['Enter']);
  });

  it('stops before typing when equally credible search fields are ambiguous', () => {
    document.body.innerHTML = `
      <input type="search" aria-label="搜索职位" />
      <input type="search" aria-label="搜索公司" />
    `;
    const result = performSemanticSearch('前端');
    expect(result).toMatchObject({
      ok: false,
      error: 'AMBIGUOUS_SEARCH_CONTROL',
      ambiguous: true,
      typed: false,
      submitted: false,
    });
    expect(result.candidates).toHaveLength(2);
    expect(Array.from(document.querySelectorAll('input')).every((input) => !input.value)).toBe(
      true,
    );
  });

  it('ignores invisible, disabled, read-only, password, and semantically weak inputs', () => {
    document.body.innerHTML = `
      <input type="search" style="display:none" />
      <input type="search" disabled />
      <input type="search" readonly />
      <input type="password" aria-label="搜索" />
      <div><input type="email" /><button>搜索</button></div>
      <textarea name="comment"></textarea>
    `;
    expect(performSemanticSearch('不会输入')).toMatchObject({
      ok: false,
      error: 'NO_SEARCH_CONTROL',
      candidates: [],
    });
  });

  it('treats near-transparent and zero-size controls as invisible', () => {
    document.body.innerHTML = `
      <input id="transparent" type="search" style="opacity:0.01" />
      <input id="zero" type="search" />
    `;
    const zero = document.querySelector<HTMLElement>('#zero');
    if (!zero) throw new Error('test DOM missing');
    vi.spyOn(zero, 'getBoundingClientRect').mockReturnValue({ ...visibleRect, width: 0 });
    expect(performSemanticSearch('不会输入')).toMatchObject({ error: 'NO_SEARCH_CONTROL' });
  });

  it('uses textarea controls and reports a failed native setter without submitting', () => {
    document.body.innerHTML = '<textarea role="searchbox" aria-label="搜索内容"></textarea>';
    expect(performSemanticSearch('text')).toMatchObject({
      ok: true,
      control: { tag: 'textarea' },
    });

    document.body.innerHTML = '<input type="search" />';
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (!descriptor) throw new Error('value descriptor missing');
    vi.spyOn(Object, 'getOwnPropertyDescriptor').mockReturnValueOnce({
      configurable: true,
      enumerable: true,
    });
    expect(performSemanticSearch('text')).toMatchObject({
      ok: false,
      error: 'INTERACTION_FAILED',
      typed: false,
      submitted: false,
    });
  });

  it('fails safely if a contenteditable candidate changes before the value is written', () => {
    document.body.innerHTML = '<div role="searchbox" contenteditable="true"></div>';
    const control = document.querySelector<HTMLElement>('[role="searchbox"]');
    if (!control) throw new Error('test DOM missing');
    const originalGetAttribute = control.getAttribute.bind(control);
    let contentEditableReads = 0;
    vi.spyOn(control, 'getAttribute').mockImplementation((name) => {
      if (name !== 'contenteditable') return originalGetAttribute(name);
      contentEditableReads += 1;
      return contentEditableReads === 1 ? 'true' : null;
    });
    expect(performSemanticSearch('Agent')).toMatchObject({
      ok: false,
      error: 'INTERACTION_FAILED',
      typed: false,
    });
  });
});

describe('captureBrowserPageFingerprint', () => {
  it('returns bounded metadata that changes with meaningful page content', () => {
    document.title = '  Search   page ';
    document.body.innerHTML = '<main>第一版内容</main>';
    const before = captureBrowserPageFingerprint();
    document.body.innerHTML = '<main>第二版内容更多</main><aside>结果</aside>';
    const after = captureBrowserPageFingerprint();

    expect(before).toMatchObject({
      url: 'https://www.zhipin.com/web/geek/job',
      title: 'Search page',
      childCount: 1,
    });
    expect(after.textHash).not.toBe(before.textHash);
    expect(after.textLength).toBeGreaterThan(before.textLength);
    expect(after.childCount).toBe(2);
  });

  it('bounds a long title and tolerates a document without a body', () => {
    document.title = `  ${'x'.repeat(400)}  `;
    expect(captureBrowserPageFingerprint().title).toHaveLength(300);

    document.body.remove();
    expect(captureBrowserPageFingerprint()).toMatchObject({
      textLength: 0,
      childCount: 0,
    });
    document.documentElement.append(document.createElement('body'));
  });

  it('detects changes near the end of a long visible page', () => {
    document.body.innerText = `${'前部内容'.repeat(2_000)}尾部版本一`;
    const before = captureBrowserPageFingerprint();
    document.body.innerText = `${'前部内容'.repeat(2_000)}尾部版本二`;

    expect(captureBrowserPageFingerprint().textHash).not.toBe(before.textHash);
  });
});
