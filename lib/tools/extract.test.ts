import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPageReading,
  DATA_CONTENT_LIMIT,
  extractPageContent,
  type PageExtraction,
} from './extract';

const makeExtraction = (overrides: Partial<PageExtraction> = {}): PageExtraction => ({
  url: 'https://example.com/article',
  title: '示例标题',
  description: '',
  content: '正文内容'.repeat(10),
  ...overrides,
});

afterEach(() => {
  // setup.ts 只清理 body；title 与 meta 会跨用例残留，这里显式复位。
  document.title = '';
  document.head.innerHTML = '';
});

describe('extractPageContent', () => {
  it('优先取 main 语义容器（长度足够时），排除外围头部/页脚', () => {
    document.body.innerHTML = `
      <header>页眉导航链接</header>
      <main>${'主内容段落。'.repeat(50)}</main>
      <footer>页脚版权信息</footer>
    `;
    const result = extractPageContent();
    expect(result.content).toContain('主内容段落。');
    expect(result.content).not.toContain('页眉导航链接');
    expect(result.content).not.toContain('页脚版权信息');
  });

  it('main 过短时回退到足够长的 article', () => {
    document.body.innerHTML = `
      <main>短</main>
      <article>${'文章正文段落。'.repeat(50)}</article>
    `;
    expect(extractPageContent().content).toContain('文章正文段落。');
  });

  it('无合格语义容器时回退 body', () => {
    document.body.innerHTML = '<div>只有一点点内容</div>';
    expect(extractPageContent().content).toBe('只有一点点内容');
  });

  it('空白归一化：NBSP/制表符折叠为单空格，多空行折叠为两行', () => {
    document.body.innerText = '第一行\u00a0\u00a0\t文本\n\n\n\n第二行   ';
    expect(extractPageContent().content).toBe('第一行 文本\n\n第二行');
  });

  it('提取 title（trim）、meta description 与当前页 url', () => {
    // 先写 meta 再设 title：直接替换 head.innerHTML 会抹掉 title 元素。
    document.head.innerHTML = '<meta name="description" content="一段页面简介">';
    document.title = '页面标题';
    const result = extractPageContent();
    expect(result.title).toBe('页面标题');
    expect(result.description).toBe('一段页面简介');
    expect(result.url).toBe('http://localhost/');
  });

  it('无 meta description 时返回空串', () => {
    expect(extractPageContent().description).toBe('');
  });

  it('正文超过 10 万字符时截断保护序列化体积', () => {
    document.body.textContent = 'a'.repeat(100_500);
    expect(extractPageContent().content).toHaveLength(100_000);
  });
});

describe('buildPageReading', () => {
  it('正常组装：data 元信息 + 带标题/网址的 llmText + 摘要', () => {
    const reading = buildPageReading(makeExtraction({ content: '正文'.repeat(50) }));
    expect(reading.data.title).toBe('示例标题');
    expect(reading.data.truncated).toBe(false);
    expect(reading.data.charCount).toBe(100);
    expect(reading.llmText).toContain('标题：示例标题');
    expect(reading.llmText).toContain('网址：https://example.com/article');
    expect(reading.llmText).toContain('正文：');
    expect(reading.summary).toBe('已读取《示例标题》· 100 字');
  });

  it('长正文：llmText 输出全文（预览截断由工件关口负责），不再出现截断提示', () => {
    const content = `开头${'x'.repeat(DATA_CONTENT_LIMIT)}结尾`;
    const reading = buildPageReading(makeExtraction({ content }));

    expect(reading.llmText).toContain(content);
    expect(reading.llmText).not.toContain('仅保留前');
    expect(reading.summary).not.toContain('（已截断）');
    // truncated 改为描述 data 自身保留上限的触顶情况，与模型可见性无关
    expect(reading.data.truncated).toBe(true);
  });

  it('data.content 超 20000 字符截断到上限，charCount 保留真实长度', () => {
    const reading = buildPageReading(
      makeExtraction({ content: 'y'.repeat(DATA_CONTENT_LIMIT + 500) }),
    );
    expect(reading.data.content).toHaveLength(DATA_CONTENT_LIMIT);
    expect(reading.data.charCount).toBe(DATA_CONTENT_LIMIT + 500);
  });

  it('description 为空时 data 不携带该字段、llmText 不出现简介行', () => {
    const reading = buildPageReading(makeExtraction({ description: '' }));
    expect(reading.data.description).toBeUndefined();
    expect(reading.llmText).not.toContain('简介：');
  });

  it('description 超 300 字符在 llmText 中截断', () => {
    const reading = buildPageReading(makeExtraction({ description: 'z'.repeat(400) }));
    expect(reading.llmText).toContain(`简介：${'z'.repeat(300)}…`);
    expect(reading.data.description).toBe('z'.repeat(400));
  });

  it('无标题用占位文案，超长标题在摘要中截断', () => {
    expect(buildPageReading(makeExtraction({ title: '' })).summary).toContain('《（无标题）》');
    const longTitle = '标'.repeat(50);
    expect(buildPageReading(makeExtraction({ title: longTitle })).summary).toContain(
      `《${'标'.repeat(40)}…》`,
    );
  });
});
