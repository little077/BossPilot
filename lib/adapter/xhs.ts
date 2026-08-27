// ─── 站点适配层（SiteAdapter）：小红书 ───
//
// 本文件是小红书页面选择器与 URL 规则的「单一事实源」——所有与
// xiaohongshu.com 页面结构耦合的知识都集中在这里，站点改版时只修此文件。
//
// 设计要点：
// 1. 注入函数必须自包含（chrome.scripting.executeScript 序列化后在页面执行，
//    不能引用闭包变量），因此每个抽取/滚动函数内联全部选择器。
// 2. 每个注入函数都带多组候选选择器做「宽容匹配」，关键选择器全部失配时
//    返回 selectorMiss 标记，供上层提示「站点可能改版」。
// 3. 注入函数保持同步、短小：节奏控制（等待懒加载、重试）由 Skill 脚本在
//    沙箱侧负责，避免长时间占住页面上下文。
// 4. 选择器契约 v1（2026-08 观察）：PC 版博主主页 /user/profile/{id}，
//    卡片 section.note-item，弹窗 div.note-container，评论 div.comments-container。

export const XHS_ORIGIN = 'https://www.xiaohongshu.com';

/** 适配层版本号——选择器契约变更时递增，用于诊断与缓存失效。 */
export const XHS_ADAPTER_VERSION = 1;

// ─── URL 规则 ───

/** 判断一个 URL 是否属于小红书站点。 */
export function isXhsUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).origin === XHS_ORIGIN;
  } catch {
    return false;
  }
}

/** 判断当前页是否是小红书博主主页（/user/profile/{id}）。 */
export function isXhsUserPageUrl(url: string | undefined): boolean {
  if (!isXhsUrl(url)) return false;
  try {
    return /^\/user\/profile\/[^/]+\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** 判断当前页是否处于帖子详情弹窗状态（首页 SPA 弹窗或独立详情页）。 */
export function isXhsNoteDetailUrl(url: string | undefined): boolean {
  if (!isXhsUrl(url)) return false;
  try {
    return /^\/explore\/[^/]+\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// ─── 注入结果类型 ───

/** 所有注入函数的通用失败标记：关键选择器全部失配 → 疑似改版或页面未加载完。 */
export interface XhsInjectResult {
  selectorMiss: boolean;
}

export interface XhsProfileResult extends XhsInjectResult {
  nickname: string;
  redId: string;
  ip: string;
  desc: string;
  follows: string;
  fans: string;
  likes: string;
  notes: string;
}

export interface XhsNoteItem {
  noteId: string;
  href: string;
  openHref: string;
  title: string;
  likes: string;
  hasVideo: boolean;
}

export interface XhsNoteListResult extends XhsInjectResult {
  captcha: boolean;
  items: XhsNoteItem[];
}

export interface XhsScrollResult extends XhsInjectResult {
  moved: boolean;
  atBottom: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  loading: boolean;
}

export interface XhsOpenNoteResult extends XhsInjectResult {
  opened: boolean;
  open: boolean;
  captcha: boolean;
  reason: string;
  targetKind: string;
  targetHref: string;
}

export interface XhsNoteDetailResult extends XhsInjectResult {
  title: string;
  desc: string;
  author: string;
  likedCount: string;
  collectedCount: string;
  commentCount: string;
  mediaKind: 'video' | 'image' | 'unknown';
}

export interface XhsCommentItem {
  commentId: string;
  author: string;
  content: string;
  date: string;
  location: string;
  likes: string;
}

export interface XhsCommentsResult extends XhsInjectResult {
  total: string;
  comments: XhsCommentItem[];
}

export interface XhsCloseNoteResult extends XhsInjectResult {
  closed: boolean;
  open: boolean;
}

// ─── 注入函数（自包含，禁止引用模块级常量以外的任何闭包） ───

/**
 * 抽取博主主页头部资料。
 * 选择器契约（v1，2026-08 观察）：
 *   - 昵称: .user-basic .user-name；小红书号: .user-redId；IP: .user-IP
 *   - 简介: .user-desc；数据: .user-interactions 内 .count + .shows 成对出现
 */
export function extractXhsProfile(): XhsProfileResult {
  const text = (el: Element | null | undefined): string =>
    (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const countLabel = (label: string): string => {
    const groups = Array.from(document.querySelectorAll('.user-interactions > div'));
    for (const group of groups) {
      if (text(group.querySelector('.shows')) === label) {
        return text(group.querySelector('.count'));
      }
    }
    return '';
  };
  const nickname = text(document.querySelector('.user-basic .user-name'));
  const redId = text(document.querySelector('.user-basic .user-redId'));
  const ip = text(document.querySelector('.user-basic .user-IP'));
  const desc = text(document.querySelector('.user-desc'));
  const result: XhsProfileResult = {
    selectorMiss: !nickname && !desc,
    nickname,
    redId,
    ip,
    desc,
    follows: countLabel('关注'),
    fans: countLabel('粉丝'),
    likes: countLabel('获赞与收藏'),
    notes: countLabel('笔记'),
  };
  return result;
}

/**
 * 抽取主页当前已渲染的帖子卡片。
 * 选择器契约（v1，2026-08 观察）：
 *   - 卡片: section.note-item；链接: 卡片内首个 a[href^="/explore/"]
 *   - 标题: .footer a.title；点赞: .author-wrapper .like-wrapper .count
 *   - 视频标记: .cover .play-icon
 */
export function extractXhsNoteList(): XhsNoteListResult {
  const result: XhsNoteListResult = { selectorMiss: false, captcha: false, items: [] };

  const bodyText = document.body?.innerText ?? '';
  if (/安全验证|请完成验证|异常访问|机器人|访问频繁/.test(bodyText.slice(0, 3000))) {
    result.captcha = true;
    return result;
  }

  const text = (el: Element | null | undefined): string =>
    (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const noteIdFromHref = (href: string): string => {
    try {
      const url = new URL(href, location.origin);
      const path = url.pathname;
      return (
        /^\/explore\/([^/?#]+)/.exec(path)?.[1] ??
        /^\/user\/profile\/[^/?#]+\/([^/?#]+)/.exec(path)?.[1] ??
        ''
      );
    } catch {
      return (
        /^\/explore\/([^/?#]+)/.exec(href)?.[1] ??
        /^\/user\/profile\/[^/?#]+\/([^/?#]+)/.exec(href)?.[1] ??
        ''
      );
    }
  };
  const absoluteHref = (href: string): string => {
    try {
      return new URL(href, location.origin).toString();
    } catch {
      return href;
    }
  };
  const cards = Array.from(document.querySelectorAll('section.note-item'));
  if (cards.length === 0) {
    result.selectorMiss = true;
    return result;
  }
  for (const card of cards) {
    const links = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const titleLink = card.querySelector<HTMLAnchorElement>('a.title[href]');
    const coverLink = card.querySelector<HTMLAnchorElement>('a.cover[href], a.mask[href]');
    const exploreLink = links.find((candidate) =>
      noteIdFromHref(candidate.getAttribute('href') ?? ''),
    );
    const primaryLink = titleLink ?? coverLink ?? exploreLink;
    const href = primaryLink?.getAttribute('href') ?? '';
    const noteId =
      noteIdFromHref(href) ||
      links
        .map((candidate) => noteIdFromHref(candidate.getAttribute('href') ?? ''))
        .find(Boolean) ||
      '';
    if (!noteId) continue;
    const openHref = absoluteHref(href || `/explore/${noteId}`);
    result.items.push({
      noteId,
      href: absoluteHref(`/explore/${noteId}`),
      openHref,
      title: text(card.querySelector('.footer a.title')),
      likes: text(card.querySelector('.author-wrapper .like-wrapper .count')),
      hasVideo: Boolean(card.querySelector('.cover .play-icon')),
    });
  }
  return result;
}

/**
 * 滚动主页帖子流容器，触发懒加载。
 * 选择器契约（v1，2026-08 观察）：
 *   - 滚动容器: .tab-content-item（overflow:scroll）/ #userPostedFeeds / window
 *   - 加载指示器: .feeds-loading / .loading
 */
export function scrollXhsFeeds(deltaY = 1200): XhsScrollResult {
  const candidates = [
    document.querySelector<HTMLElement>('.tab-content-item'),
    document.querySelector<HTMLElement>('#userPostedFeeds'),
    document.querySelector<HTMLElement>('.feeds-container'),
    document.scrollingElement as HTMLElement | null,
  ].filter(Boolean) as HTMLElement[];
  const target =
    candidates.find((candidate) => candidate.scrollHeight > candidate.clientHeight + 24) ??
    (document.scrollingElement as HTMLElement | null);
  if (!target)
    return {
      selectorMiss: true,
      moved: false,
      atBottom: true,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      loading: false,
    };
  const before = target.scrollTop;
  const scrollBy = Math.max(320, Math.min(Number(deltaY) || 760, 1200));
  target.scrollBy?.({ top: scrollBy, behavior: 'auto' });
  if (target.scrollTop === before) {
    target.scrollTop += scrollBy;
  }
  if (target.scrollTop === before && target === document.scrollingElement) {
    window.scrollBy(0, scrollBy);
  }
  const loading = Boolean(document.querySelector('.feeds-loading, .feeds-container .loading'));
  return {
    selectorMiss: false,
    moved: target.scrollTop !== before,
    atBottom: target.scrollTop + target.clientHeight >= target.scrollHeight - 4,
    scrollTop: target.scrollTop,
    scrollHeight: target.scrollHeight,
    clientHeight: target.clientHeight,
    loading,
  };
}

/**
 * 点击主页卡片打开帖子详情弹窗。
 * 选择器契约（v1.1，2026-08 观察）：
 *   - 卡片: section.note-item
 *   - 安全入口优先级: 标题链接 a.title → 封面链接 a.cover/.mask → 可见详情链接
 *
 * 重要：不要点击卡片内「第一个 /explore/ 链接」。小红书 DOM 中存在文本为空的
 * 隐藏/辅助链接，直接 click 容易命中非用户预期区域；也不要触碰作者、点赞、关注、
 * 评论等互动区。这个函数只负责打开详情，不做任何互动行为。
 */
export function openXhsNote(noteId: string, preferredHref = ''): XhsOpenNoteResult {
  const empty = (reason: string, selectorMiss = true): XhsOpenNoteResult => ({
    selectorMiss,
    opened: false,
    open: false,
    captcha: false,
    reason,
    targetKind: '',
    targetHref: '',
  });
  const normalizedNoteId = String(noteId || '').trim();
  if (!normalizedNoteId) return empty('noteId 缺失');

  const bodyText = document.body?.innerText ?? '';
  if (/安全验证|请完成验证|异常访问|机器人|访问频繁/.test(bodyText.slice(0, 3000))) {
    return { ...empty('页面出现安全验证或访问异常', false), captcha: true };
  }

  const currentMask = document.querySelector('.note-detail-mask');
  const currentContainer = document.querySelector('.note-container');
  const currentNoteId = currentMask?.getAttribute('note-id') ?? '';
  if (currentContainer && currentNoteId === normalizedNoteId) {
    return {
      selectorMiss: false,
      opened: false,
      open: true,
      captcha: false,
      reason: '目标笔记已经打开',
      targetKind: 'already-open',
      targetHref: '',
    };
  }
  if (currentContainer) {
    return {
      selectorMiss: false,
      opened: false,
      open: true,
      captcha: false,
      reason: '已有其他笔记弹窗打开，请先关闭后再打开下一篇',
      targetKind: 'blocked-by-open-note',
      targetHref: '',
    };
  }

  const noteIdFromHref = (href: string): string => {
    try {
      const url = new URL(href, location.origin);
      return (
        /^\/explore\/([^/?#]+)/.exec(url.pathname)?.[1] ??
        /^\/user\/profile\/[^/?#]+\/([^/?#]+)/.exec(url.pathname)?.[1] ??
        ''
      );
    } catch {
      return (
        /^\/explore\/([^/?#]+)/.exec(href)?.[1] ??
        /^\/user\/profile\/[^/?#]+\/([^/?#]+)/.exec(href)?.[1] ??
        ''
      );
    }
  };
  const hrefMatches = (href: string | null): boolean =>
    noteIdFromHref(href ?? '') === normalizedNoteId;
  const isUnsafeArea = (el: Element): boolean =>
    Boolean(
      el.closest(
        '.author-wrapper, .like-wrapper, .interact-container, .interactions, .follow, .comment-item, .comments-container, .note-detail-follow-btn',
      ),
    );
  const isVisible = (el: HTMLElement): boolean => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const absoluteHref = (href: string): string => {
    try {
      return new URL(href, location.origin).toString();
    } catch {
      return href;
    }
  };

  const cards = Array.from(document.querySelectorAll<HTMLElement>('section.note-item'));
  const card =
    cards.find((candidate) =>
      Array.from(candidate.querySelectorAll<HTMLAnchorElement>('a[href]')).some((link) =>
        hrefMatches(link.getAttribute('href')),
      ),
    ) ?? null;
  if (!card) return empty('未找到匹配 noteId 的笔记卡片');

  const anchors = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((link) =>
    hrefMatches(link.getAttribute('href')),
  );
  const preferred = anchors.find(
    (link) => absoluteHref(link.getAttribute('href') ?? '') === preferredHref,
  );
  const candidates = [
    preferred,
    ...anchors.filter((link) => link.classList.contains('title')),
    ...anchors.filter(
      (link) => link.classList.contains('cover') || link.classList.contains('mask'),
    ),
    ...anchors,
  ].filter(Boolean) as HTMLAnchorElement[];

  const safeTargets = candidates.filter((link) => !isUnsafeArea(link));
  const target = safeTargets.find(isVisible) ?? safeTargets[0];
  if (!target) return empty('未找到安全可点击的标题或封面入口');

  const targetHref = target.getAttribute('href') ?? '';
  const targetKind = target.classList.contains('title')
    ? 'title'
    : target.classList.contains('cover') || target.classList.contains('mask')
      ? 'cover'
      : 'detail-link';

  card.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  if (target.target && target.target !== '_self') {
    target.target = '_self';
  }
  target.click();
  return {
    selectorMiss: false,
    opened: true,
    open: Boolean(document.querySelector('.note-container')),
    captcha: false,
    reason: '',
    targetKind,
    targetHref: absoluteHref(targetHref),
  };
}

/**
 * 检查帖子详情弹窗是否已打开（用于点击后的轮询确认）。
 * 选择器契约（v1，2026-08 观察）：弹窗容器 div.note-container，遮罩 .note-detail-mask。
 */
export function isXhsNoteOpen(): { open: boolean; title: string } {
  const container = document.querySelector('.note-container');
  return {
    open: Boolean(container),
    title: (container?.querySelector('#detail-title')?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

/**
 * 抽取弹窗内帖子详情（标题/正文/作者/互动数/媒体类型）。
 * 选择器契约（v1，2026-08 观察）：
 *   - 标题: h1#detail-title；正文: #detail-desc；作者: .author-wrapper a.name .username
 *   - 互动: .interact-container 内 .like-wrapper/.collect-wrapper/.chat-wrapper 的 .count
 *   - 媒体类型: .media-container.video-player-media 为视频
 */
export function extractXhsNoteDetail(): XhsNoteDetailResult {
  const container = document.querySelector('.note-container');
  const text = (el: Element | null | undefined): string =>
    (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const count = (selector: string): string => text(container?.querySelector(selector));
  const title = text(container?.querySelector('#detail-title'));
  const desc = text(container?.querySelector('#detail-desc'));
  const result: XhsNoteDetailResult = {
    selectorMiss: !container || (!title && !desc),
    title,
    desc,
    author: text(container?.querySelector('.author-wrapper a.name .username')),
    likedCount: count('.interact-container .like-wrapper .count'),
    collectedCount: count('.interact-container .collect-wrapper .count'),
    commentCount: count('.interact-container .chat-wrapper .count'),
    mediaKind: container?.querySelector('.media-container.video-player-media')
      ? 'video'
      : container?.querySelector('.media-container img')
        ? 'image'
        : 'unknown',
  };
  return result;
}

/**
 * 滚动弹窗右侧内容区，触发评论区懒加载。
 * 选择器契约（v1，2026-08 观察）：滚动容器 div.note-scroller。
 */
export function scrollXhsComments(deltaY = 800): XhsScrollResult {
  const scroller = document.querySelector<HTMLElement>('.note-scroller');
  const fallbackWindow = !scroller;
  const target = scroller ?? document.scrollingElement;
  if (!target)
    return {
      selectorMiss: true,
      moved: false,
      atBottom: true,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      loading: false,
    };
  const before = target.scrollTop;
  const scrollBy = Math.max(260, Math.min(Number(deltaY) || 520, 900));
  if (fallbackWindow) {
    window.scrollBy(0, scrollBy);
  } else {
    target.scrollBy?.({ top: scrollBy, behavior: 'auto' });
    if (target.scrollTop === before) {
      target.scrollTop += scrollBy;
    }
  }
  return {
    selectorMiss: false,
    moved: target.scrollTop !== before,
    atBottom: target.scrollTop + target.clientHeight >= target.scrollHeight - 4,
    scrollTop: target.scrollTop,
    scrollHeight: target.scrollHeight,
    clientHeight: target.clientHeight,
    loading: false,
  };
}

/**
 * 抽取弹窗内当前已渲染的评论。
 * 选择器契约（v1，2026-08 观察）：
 *   - 总数: .comments-container .total；列表: .list-container .parent-comment .comment-item
 *   - 昵称: .author a.name；内容: .content span.note-text；时间: .info .date
 *   - IP: .info .location；点赞: .interactions .like .count
 */
export function extractXhsComments(): XhsCommentsResult {
  const container = document.querySelector('.comments-container');
  const text = (el: Element | null | undefined): string =>
    (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const result: XhsCommentsResult = {
    selectorMiss: !container,
    total: text(container?.querySelector('.total')),
    comments: [],
  };
  if (!container) return result;
  const items = Array.from(container.querySelectorAll('.list-container .comment-item'));
  for (const item of items) {
    const commentId = /^comment-(.+)$/.exec(item.id)?.[1] ?? '';
    result.comments.push({
      commentId,
      author: text(item.querySelector('.author a.name')),
      content: text(item.querySelector('.content span.note-text')),
      date: text(item.querySelector('.info .date')),
      location: text(item.querySelector('.info .location')),
      likes: text(item.querySelector('.interactions .like .count')),
    });
  }
  return result;
}

/**
 * 关闭帖子详情弹窗，回到主页列表。
 * 选择器契约（v1，2026-08 观察）：关闭按钮 .close-circle .close.close-mask-dark。
 */
export function closeXhsNote(): XhsCloseNoteResult {
  const container = document.querySelector('.note-container');
  if (!container) return { selectorMiss: false, closed: true, open: false };
  const closeButton =
    document.querySelector<HTMLElement>('.note-detail-mask .close-circle .close') ??
    document.querySelector<HTMLElement>('.close-box .close') ??
    document.querySelector<HTMLElement>('.close-circle .close.close-mask-dark');
  if (!closeButton) return { selectorMiss: true, closed: false, open: true };
  closeButton.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'auto' });
  closeButton.click();
  const open = Boolean(document.querySelector('.note-container'));
  return { selectorMiss: false, closed: !open, open };
}
