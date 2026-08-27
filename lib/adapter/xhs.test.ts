import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeXhsNote,
  extractXhsComments,
  extractXhsNoteDetail,
  extractXhsNoteList,
  extractXhsProfile,
  isXhsNoteDetailUrl,
  isXhsUrl,
  isXhsUserPageUrl,
  openXhsNote,
  scrollXhsComments,
  scrollXhsFeeds,
  XHS_ORIGIN,
} from './xhs';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('小红书 URL 规则', () => {
  it('只接受小红书站内 URL', () => {
    expect(isXhsUrl('https://www.xiaohongshu.com/user/profile/abc')).toBe(true);
    expect(isXhsUrl('https://www.xiaohongshu.com/explore/123')).toBe(true);
    expect(isXhsUrl('https://www.xiaohongshu.com.evil.example/user/profile/abc')).toBe(false);
    expect(isXhsUrl('https://example.com')).toBe(false);
    expect(isXhsUrl('not-a-url')).toBe(false);
    expect(isXhsUrl(undefined)).toBe(false);
  });

  it('识别博主主页与帖子详情路径', () => {
    expect(isXhsUserPageUrl(`${XHS_ORIGIN}/user/profile/5f1c`)).toBe(true);
    expect(isXhsUserPageUrl(`${XHS_ORIGIN}/user/profile/5f1c/`)).toBe(true);
    expect(isXhsUserPageUrl(`${XHS_ORIGIN}/explore/123`)).toBe(false);
    expect(isXhsUserPageUrl(`${XHS_ORIGIN}/user/profile`)).toBe(false);
    expect(isXhsNoteDetailUrl(`${XHS_ORIGIN}/explore/64abc`)).toBe(true);
    expect(isXhsNoteDetailUrl(`${XHS_ORIGIN}/explore/64abc/`)).toBe(true);
    expect(isXhsNoteDetailUrl(`${XHS_ORIGIN}/user/profile/5f1c`)).toBe(false);
    expect(isXhsNoteDetailUrl('https://example.com/explore/64abc')).toBe(false);
  });
});

describe('博主主页抽取', () => {
  it('抽取头像资料与互动数据', () => {
    document.body.innerHTML = `
      <div class="user-basic">
        <div class="user-name">测试博主</div>
        <div class="user-redId">xiaohongshu：abc123</div>
        <div class="user-IP">IP属地：陕西</div>
      </div>
      <div class="user-desc">这是一个简介</div>
      <div class="user-interactions">
        <div><span class="count">12</span><span class="shows">关注</span></div>
        <div><span class="count">345</span><span class="shows">粉丝</span></div>
        <div><span class="count">1.2万</span><span class="shows">获赞与收藏</span></div>
        <div><span class="count">88</span><span class="shows">笔记</span></div>
      </div>`;
    expect(extractXhsProfile()).toMatchObject({
      selectorMiss: false,
      nickname: '测试博主',
      redId: 'xiaohongshu：abc123',
      ip: 'IP属地：陕西',
      desc: '这是一个简介',
      follows: '12',
      fans: '345',
      likes: '1.2万',
      notes: '88',
    });
  });

  it('主页结构失配时返回 selectorMiss', () => {
    document.body.innerHTML = '<div>空白页</div>';
    expect(extractXhsProfile().selectorMiss).toBe(true);
  });

  it('抽取笔记卡片并识别视频标记', () => {
    document.body.innerHTML = `
      <section class="note-item">
        <a href="/explore/note001?xsec_token=abc"><img src="cover.jpg"></a>
        <div class="cover"><span class="play-icon"></span></div>
        <div class="footer"><a class="title" href="/explore/note001">第一篇笔记</a></div>
        <div class="author-wrapper"><div class="like-wrapper"><span class="count">100</span></div></div>
      </section>
      <section class="note-item">
        <a href="/explore/note002"><img src="cover2.jpg"></a>
        <div class="footer"><a class="title" href="/explore/note002">第二篇笔记</a></div>
        <div class="author-wrapper"><div class="like-wrapper"><span class="count">1.5万</span></div></div>
      </section>`;
    expect(extractXhsNoteList()).toMatchObject({
      selectorMiss: false,
      captcha: false,
      items: [
        { noteId: 'note001', title: '第一篇笔记', likes: '100', hasVideo: true },
        { noteId: 'note002', title: '第二篇笔记', likes: '1.5万', hasVideo: false },
      ],
    });
  });

  it('检测验证码页面', () => {
    document.body.innerHTML = '<div>安全验证：请完成验证</div>';
    expect(extractXhsNoteList()).toMatchObject({ captcha: true, selectorMiss: false });
  });

  it('卡片全失配时返回 selectorMiss', () => {
    document.body.innerHTML = '<div>没有笔记</div>';
    expect(extractXhsNoteList().selectorMiss).toBe(true);
  });
});

describe('帖子弹窗', () => {
  it('点击匹配 noteId 的卡片并确认弹窗', () => {
    document.body.innerHTML = `
      <section class="note-item">
        <a href="/explore/target01"><span class="title">目标笔记</span></a>
      </section>
      <section class="note-item">
        <a href="/explore/other02"><span class="title">其他笔记</span></a>
      </section>`;
    expect(openXhsNote('target01')).toMatchObject({ opened: true, selectorMiss: false });
    expect(openXhsNote('missing')).toMatchObject({ opened: false, selectorMiss: true });
  });

  it('抽取弹窗内的详情与媒体类型', () => {
    document.body.innerHTML = `
      <div class="note-container">
        <h1 id="detail-title">标题在这里</h1>
        <div id="detail-desc">正文内容</div>
        <div class="author-wrapper"><a class="name"><span class="username">作者名</span></a></div>
        <div class="interact-container">
          <div class="like-wrapper"><span class="count">2.1万</span></div>
          <div class="collect-wrapper"><span class="count">3000</span></div>
          <div class="chat-wrapper"><span class="count">456</span></div>
        </div>
        <div class="media-container video-player-media"></div>
      </div>`;
    expect(extractXhsNoteDetail()).toMatchObject({
      selectorMiss: false,
      title: '标题在这里',
      desc: '正文内容',
      author: '作者名',
      likedCount: '2.1万',
      collectedCount: '3000',
      commentCount: '456',
      mediaKind: 'video',
    });
  });

  it('弹窗未打开时详情抽取返回 selectorMiss', () => {
    document.body.innerHTML = '<div>主页内容</div>';
    expect(extractXhsNoteDetail().selectorMiss).toBe(true);
  });

  it('抽取评论列表与总数', () => {
    document.body.innerHTML = `
      <div class="comments-container">
        <div class="total">共 3 条评论</div>
        <div class="list-container">
          <div class="comment-item" id="comment-aaa">
            <div class="author"><a class="name">评论者A</a></div>
            <div class="content"><span class="note-text">写得不错</span></div>
            <div class="info"><span class="date">08-25</span><span class="location">广东</span></div>
            <div class="interactions"><span class="like"><span class="count">5</span></span></div>
          </div>
          <div class="comment-item" id="comment-bbb">
            <div class="author"><a class="name">评论者B</a></div>
            <div class="content"><span class="note-text">学习了</span></div>
            <div class="info"><span class="date">08-26</span></div>
            <div class="interactions"><span class="like"><span class="count">1</span></span></div>
          </div>
        </div>
      </div>`;
    expect(extractXhsComments()).toMatchObject({
      selectorMiss: false,
      total: '共 3 条评论',
      comments: [
        {
          commentId: 'aaa',
          author: '评论者A',
          content: '写得不错',
          date: '08-25',
          location: '广东',
          likes: '5',
        },
        {
          commentId: 'bbb',
          author: '评论者B',
          content: '学习了',
          date: '08-26',
          location: '',
          likes: '1',
        },
      ],
    });
  });

  it('关闭按钮点击后弹窗消失', () => {
    document.body.innerHTML = `
      <div class="note-container">弹窗</div>
      <div class="close-circle"><div class="close close-mask-dark"></div></div>`;
    expect(closeXhsNote()).toMatchObject({ selectorMiss: false });
  });

  it('关闭按钮失配时返回 selectorMiss', () => {
    document.body.innerHTML = '<div class="note-container">弹窗</div>';
    expect(closeXhsNote().selectorMiss).toBe(true);
  });
});

describe('滚动', () => {
  it('存在滚动容器时在容器内滚动', () => {
    // jsdom 中 document.scrollingElement 恒为 null（真实浏览器为 html 元素），
    // 因此只验证容器滚动路径，window 回退分支依赖真实浏览器行为。
    document.body.innerHTML = '<div class="tab-content-item"><div>内容</div></div>';
    const container = document.querySelector<HTMLElement>('.tab-content-item');
    // jsdom 不计算布局，手动声明容器可滚动（scrollHeight > clientHeight）。
    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true });
    const result = scrollXhsFeeds(600);
    expect(result.selectorMiss).toBe(false);
    expect(typeof result.scrollTop).toBe('number');
  });

  it('弹窗滚动容器缺失时同样回退', () => {
    document.body.innerHTML = '<div class="note-container"><div class="note-scroller"></div></div>';
    expect(scrollXhsComments(400).selectorMiss).toBe(false);
  });
});
