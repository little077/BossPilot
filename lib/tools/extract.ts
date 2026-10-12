// ─── 页面抽取与归一化 ───
// extractPageContent 会被 chrome.scripting.executeScript 序列化后在页面上下文执行：
// 红线是「自包含」——函数体内不得引用任何模块作用域变量、import 或闭包，所有依赖必须内联，
// 因此函数内与模块常量重复的字面量（200 / 100000）是有意为之，不可合并。
// buildPageReading 是纯函数：双形态结果组装集中在这里，可在 jsdom 下单测。
// 阶段 2 决策：旧的 8000 字符模型侧截断已删除——「截断是丢数据，落地+引用不丢数据」，
// 模型可见长度的控制收口到工件关口（lib/artifacts/gate.ts 的引用卡预览）。

/** 结构化 data 中保留的正文上限（UI 展示用；模型侧全文在档案柜里）。 */
export const DATA_CONTENT_LIMIT = 20_000;
/** 正文短于该长度视为「没有可读内容」。 */
export const MIN_CONTENT_CHARS = 24;

export interface PageExtraction {
  url: string;
  title: string;
  description: string;
  /** 归一化后的正文文本（已按 10 万字符安全天花板截断）。 */
  content: string;
}

/**
 * 注入页面的自包含抽取函数（不得引用模块作用域任何东西）。
 * 优先 main/article 语义容器，回退 body；空白归一化；超大正文截断保护序列化。
 */
export function extractPageContent(): PageExtraction {
  const normalize = (text: string): string =>
    text
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  const readText = (node: Element | null): string => {
    if (!node) return '';
    const inner = (node as HTMLElement).innerText;
    return typeof inner === 'string' ? inner : (node.textContent ?? '');
  };

  // 语义容器优先：main/article 内容足够长才采用，避免拿到小预览块取代真正文。
  let root: Element | null = null;
  for (const selector of ['main', 'article']) {
    const candidate = document.querySelector(selector);
    if (candidate && normalize(readText(candidate)).length >= 200) {
      root = candidate;
      break;
    }
  }
  if (!root) root = document.body;

  let content = normalize(readText(root));
  // 安全天花板：与注释中的说明一致，此处必须内联字面量（注入函数须自包含）。
  if (content.length > 100_000) content = content.slice(0, 100_000);

  const description =
    document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ?? '';

  return {
    url: location.href,
    title: document.title.trim(),
    description,
    content,
  };
}

/** 结构化读取结果（data 形态，UI 渲染与未来功能使用）。 */
export interface PageReadingData {
  url: string;
  title: string;
  description?: string;
  content: string;
  /** data 自身保留的正文是否触到 DATA_CONTENT_LIMIT（与模型可见性无关，全文在档案柜）。 */
  truncated: boolean;
  charCount: number;
}

export interface PageReading {
  data: PageReadingData;
  llmText: string;
  summary: string;
}

/**
 * 组装双形态读取结果（纯函数）：llmText 输出全文，落地与预览截断由工件关口负责；
 * data 保留元信息与自身截断标记；summary 供工具卡片展示。
 */
export function buildPageReading(extraction: PageExtraction): PageReading {
  const charCount = extraction.content.length;
  const truncated = charCount > DATA_CONTENT_LIMIT;

  const headerLines = [`标题：${extraction.title || '（无标题）'}`, `网址：${extraction.url}`];
  if (extraction.description) {
    headerLines.push(`简介：${truncateText(extraction.description, 300)}`);
  }
  const llmText = `${headerLines.join('\n')}\n正文：\n${extraction.content}`;

  const displayTitle = truncateText(extraction.title || '（无标题）', 40);
  const summary = `已读取《${displayTitle}》· ${charCount} 字`;

  const data: PageReadingData = {
    url: extraction.url,
    title: extraction.title,
    content:
      charCount > DATA_CONTENT_LIMIT
        ? extraction.content.slice(0, DATA_CONTENT_LIMIT)
        : extraction.content,
    truncated,
    charCount,
    ...(extraction.description ? { description: extraction.description } : {}),
  };

  return { data, llmText, summary };
}

/** 超长文本截断（加省略号），用于简介与卡片标题。 */
function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
