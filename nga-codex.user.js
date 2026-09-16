// ==UserScript==
// @name         NGA · Codex 外观
// @namespace    https://bbs.nga.cn/
// @version      1.0.0
// @description  把 NGA 换成 Codex 桌面 app 风格（左 rail + 主区 + 右侧代码面板，明暗双模式），带上班摸鱼用的应急伪装。只改外观，原生 DOM 和站点自己的 JS 全部保留。
// @author       link（V2EX 版作者）· NGA 移植
// @match        https://bbs.nga.cn/*
// @match        https://ngabbs.com/*
// @match        https://nga.178.com/*
// @match        https://bbs.ngacn.cc/*
// @icon         https://bbs.nga.cn/favicon.ico
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * 这是 reference/v2ex-codex.user.js（V2EX 版，作者 link）的 NGA 移植。
 * 外观设计系统（CSS token、rail / 主区 / 代码面板的视觉）和「假 agent 会话」
 * 那套装饰思路直接复用；所有跟站点数据结构相关的部分（解析、路由、回复、
 * 图片、伪装目标）全部按 NGA 重写了。
 *
 * ── 与 V2EX 版（v2ex-codex.user.js）的核心差异 ─────────────────────────────
 *
 * 1. 同样是服务端渲染的 MPA，但 NGA 的「页面数据」比 V2EX 复杂一个数量级：
 *    标题、作者名、头像、表情、附件、支持/反对数**都不是服务端写死在 HTML 里的**，
 *    而是页面内联脚本在解析期间调 commonui.postArg.proc() / ubbcode.* 现填的。
 *    例如 <a id='postauthor0'></a> 在源码里是空的，作者名来自
 *    commonui.userInfo.users[uid].username（同一页内联的 setAll(JSON) 提供）。
 *    所以本脚本一律「读原生 JS 处理完之后的 DOM」，并且顺手把 commonui 里
 *    的权威数据（postArg.data / userInfo.users / __ALL_FORUM_DATA）当作首选数据源。
 *
 * 2. 附件（[img]./mon_202609/...[/img]）由 attach 模块**异步**渲染 —— 页面
 *    可能已经可读，图还没挂上来。所以这里比 V2EX 版多一个 MutationObserver：
 *    原生内容变了就重算一次「页面签名」，签名变了才重渲染（避免无意义地
 *    把用户的滚动位置和折叠状态冲掉）。
 *
 * 3. 原生 DOM 用 display:none 藏起来（V2EX 版也是）。这里额外确认过安全性：
 *    NGA 决定楼层显示粒度的 commonui.postDispCalcContentLength() 只数文本
 *    节点字符数、不做几何测量，所以隐藏后原生逻辑不会走岔；反过来，
 *    把原生 DOM 移出视口（left:-99999px）反而危险 —— NGA 的「跳转到指定楼层」
 *    会 scrollIntoView 到那个元素，视口会被拖到 -99999px 去。
 *
 * 4. 回复语法是 **BBSCode 不是 Markdown**（[b] / [quote] / [s:ac:哭笑] / [img]），
 *    所以工具条插的是 BBSCode，预览用的也是 BBSCode 渲染器。同一个渲染器
 *    还兼作正文兜底：万一某个附件/表情原生没渲染出来，脚本自己补上。
 *
 * 5. V2EX 版的「楼层操作」是猜的（@某人）；NGA 有正规的引用格式
 *    [quote][pid=xxx]Reply[/pid] [b]Post by [uid=xxx]名字[/uid] (时间):[/b]…[/quote]，
 *    这里按 NGA 自己的 commonui.quoteTo.procText() 生成，粘贴出去和原生一致。
 *    支持/反对/收藏也直接调原生 commonui.postScoreAdd / commonui.favor，
 *    不自己造请求（省掉校验位、权限位、弹窗这些坑）。
 * ──────────────────────────────────────────────────────────────────────────
 */

(function () {
  "use strict";

  /* ============================== 设置 ==============================
   *
   * 默认值全在 DEFAULTS 里；用户改过的项统一存成一个 JSON
   * （localStorage 的 ngax:settings），读走 cfg()、写走 setCfg()。
   * 键名故意和 V2EX 版不同（v2cx: → ngax:），两个脚本可以并存不打架。
   * ============================================================== */

  const DEFAULTS = {
    /* —— 外观 —— */
    /** "auto" 跟随 NGA 自己的明暗 | "dark" | "light" */
    theme: "auto",
    /** 左 rail 宽度（Codex 原版约 20% 窗宽，306 是按截图校准的） */
    railWidth: 306,
    /** 右侧代码面板宽度 */
    panelWidth: 460,
    /** 正文最大宽度 */
    threadMaxWidth: 780,
    /** 是否显示右侧代码面板（纯氛围装饰） */
    codePanel: true,
    /** 代码面板语言：rust / python / typescript / go / java */
    lang: "rust",
    /** 代码面板视图："code" | "diff" */
    codeMode: "code",

    /* —— 伪装 —— */
    /**
     * 伪装模式。上班摸鱼用：
     *   - 左栏品牌名 → "Codex"（brandName 留空时）
     *   - 标签页标题 → 源码文件名（不再出现 "NGA" / 版面名 / 帖子标题）
     *   - 启用应急伪装键
     *
     * 注意：NGA 的帖子标题会直接出现在 <title> 上，这是最容易暴露的地方，
     * 所以 stealth 默认开。
     */
    stealth: true,
    /**
     * 应急伪装键：按下后整个视口变成「代码编辑器 + 构建日志」，再按一次恢复。
     *   "esc2"          连按两下 Esc（默认，最好按）
     *   "f2"            单键
     *   "ctrl+shift+h"  组合键
     * 无论配成什么，Ctrl+Shift+H 始终有效。
     */
    stealthKey: "esc2",
    /** 左栏品牌名。空字符串 = 由 stealth 决定（Codex / NGA） */
    brandName: "",
    /**
     * 代码面板 / 面包屑 / 标签页标题里显示的项目名。
     * 默认取一个不含站点痕迹的通用名：标签页标题会变成
     * "forum_cache.rs — platform"，扫一眼就是普通工程目录。
     */
    projectName: "platform",
    /** favicon："codex" = Codex 风格圆角图标 | "site" = 保留 NGA 原图标 */
    favicon: "codex",

    /* —— agent 装饰（内容全是假的，纯装饰）—— */
    /** 总开关：思考块 + 工具调用行 */
    decorations: true,
    /** 列表里穿插痕迹的比例（%）。0 = 列表里不插 */
    listTraceRate: 46,
    /** 列表里的思考块是否默认展开（关掉只占一行 ✻ Worked for Ns ▸） */
    listThinkingOpen: false,
    /** 详情页的思考块是否默认展开 */
    detailThinkingOpen: true,

    /* —— 引用（NGA 的楼中楼就是 [quote]）—— */
    /** 把正文里的 [quote] 渲染成引用卡片（可折叠、可跳转） */
    quoteCard: true,
    /** 引用卡片的正文默认展开 */
    quoteOpen: true,

    /* —— 正文图片 —— */
    /** 缩略图尺寸上限 */
    thumbWidth: 260,
    thumbHeight: 170,
    /** 鼠标悬停时浮出大图预览 */
    thumbPreview: true,

    /* —— 楼层信息 —— */
    /** 显示头像（NGA 原生在左侧栏显示，这里改成行内小头像） */
    avatars: true,
    /** 显示「来自客户端」（8 Android 之类）—— 原生也是显示的 */
    showClient: false
  };

  const SETTINGS_KEY = "ngax:settings";

  let SETTINGS = null;

  function loadSettings() {
    const out = Object.assign({}, DEFAULTS);
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        for (const k of Object.keys(DEFAULTS)) {
          // 类型不符就忽略，避免手工改坏 localStorage 后整个面板崩掉
          if (obj[k] !== undefined && typeof obj[k] === typeof DEFAULTS[k]) out[k] = obj[k];
        }
      }
    } catch { /* 坏了就用默认值 */ }
    return out;
  }

  function cfg(key) {
    if (!SETTINGS) SETTINGS = loadSettings();
    return SETTINGS[key] !== undefined ? SETTINGS[key] : DEFAULTS[key];
  }

  /** 写设置。visualOnly = 只刷新 CSS 变量，不重渲染（拖滑块时用） */
  function setCfg(key, value, opts) {
    if (!SETTINGS) SETTINGS = loadSettings();
    SETTINGS[key] = value;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch { /* 隐私模式等 */ }
    if (opts && opts.visualOnly) applyVisualSettings();
    else applySettings();
  }

  function resetSettings() {
    SETTINGS = Object.assign({}, DEFAULTS);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch { /* ignore */ }
    applySettings();
  }

  function brandName() {
    const custom = cfg("brandName");
    return custom || (cfg("stealth") ? "Codex" : "NGA");
  }

  /**
   * 只改 CSS 变量 / class —— 不重渲染。
   * 拖宽度滑块时走这条，否则每动一格都重排整个列表会很卡。
   */
  function applyVisualSettings() {
    const root = document.documentElement;
    root.style.setProperty("--cx-rail-w", cfg("railWidth") + "px");
    root.style.setProperty("--ngax-panel-w", cfg("panelWidth") + "px");
    root.style.setProperty("--ngax-thread-max", cfg("threadMaxWidth") + "px");
    root.style.setProperty("--ngax-thumb-w", cfg("thumbWidth") + "px");
    root.style.setProperty("--ngax-thumb-h", cfg("thumbHeight") + "px");
    root.classList.toggle("ngax-no-avatar", !cfg("avatars"));
    syncMode();
    applyFavicon();
    syncTitle();
    setPanelHidden(!cfg("codePanel"), false);
  }

  /** 完整的应用：视觉 + 重渲染 rail / 列表 / 详情 / 代码面板 */
  function applySettings() {
    applyVisualSettings();
    renderCodePanel();
    render();
    if (bossOn()) renderBoss();
  }

  /* ============================== 常量 ============================== */

  const STYLE_ID = "nga-codex-theme";
  const FAVICON_ID = "nga-codex-favicon";
  const ROOT_CLASS = "ngax";            // <html> 上的激活标记
  const LIGHT_CLASS = "ngax-light";     // 浅色模式
  const LOCK_CLASS = "ngax-locked";     // 隐藏原生页面

  // 「默认宽度」——双击拖拽把手是重置回这两个值，不是重置回当前设置
  const RAIL_W = DEFAULTS.railWidth;
  const PANEL_DEFAULT_W = DEFAULTS.panelWidth;

  /** 表情图床（NGA 自己的 __IMGPATH，实测 https://img4.nga.cn/ngabbs/post/smile/ac15.png 可用） */
  const SMILE_BASE = "https://img4.nga.cn/ngabbs/post/smile/";
  /** 附件图床。正文里 ./mon_YYMMDD/DD/xxx.jpg 形式的相对路径要拼在这里 */
  const ATTACH_BASE = "https://img.nga.cn/attachments/";

  /* ============================== 内联 SVG 图标 ============================== */

  const ICONS = {
    sidebar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="3"/><line x1="9.5" y1="4" x2="9.5" y2="20"/></svg>`,
    chevronDown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 9 12 14 17 9"/></svg>`,
    chevronUp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 15 12 10 17 15"/></svg>`,
    chevronRightSm: `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`,
    search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`,
    bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/></svg>`,
    mail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/></svg>`,
    pencil: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
    layers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>`,
    clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>`,
    fire: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2s5 5 5 9a5 5 0 0 1-10 0c0-1.5.7-2.8 1.5-3.8C8 9 9 9.5 9 8c0-2 3-6 3-6Z"/><path d="M12 22a5 5 0 0 0 5-5c0-3-2-5-5-8-3 3-5 5-5 8a5 5 0 0 0 5 5Z"/></svg>`,
    home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5"/></svg>`,
    gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z"/></svg>`,
    folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`,
    forum: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
    external: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>`,
    dots: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`,
    terminal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><polyline points="7 9 10 12 7 15"/><path d="M12.5 15H17"/></svg>`,
    globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.7 2.6 4 5.7 4 9s-1.3 6.4-4 9c-2.7-2.6-4-5.7-4-9s1.3-6.4 4-9Z"/></svg>`,
    user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="7.5" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/></svg>`,
    tag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.05 12.35 2a1.4 1.4 0 0 0-1-.4H3a1 1 0 0 0-1 1v8.35a1.4 1.4 0 0 0 .4 1l9.1 9.05a1.4 1.4 0 0 0 2 0l7.9-7.9a1.4 1.4 0 0 0 0-2Z"/><circle cx="7.5" cy="7.5" r="1"/></svg>`,
    reply: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>`,
    menu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
    send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg>`,
    panel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="3"/><line x1="14.5" y1="4" x2="14.5" y2="20"/></svg>`,
    expand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7.5 7.5"/><path d="M3 21l7.5-7.5"/></svg>`,
    file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/></svg>`,
    sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
    moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a7.5 7.5 0 1 0 11 11Z"/></svg>`,
    filter: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8v5.5L10 21v-8Z"/></svg>`,
    link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>`,
    eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
    branch: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.5" cy="6" r="2.4"/><circle cx="6.5" cy="18" r="2.4"/><circle cx="17.5" cy="8.5" r="2.4"/><path d="M6.5 8.4v7.2"/><path d="M17.5 10.9c0 3.4-3.6 3.3-6.3 4.1"/></svg>`,
    quote: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.6 6.2C6.6 7.6 5 10 5 13.3V18h5.3v-5.3H7.9c0-2 .9-3.4 2.7-4.3L9.6 6.2Zm9 0C15.6 7.6 14 10 14 13.3V18h5.3v-5.3h-2.4c0-2 .9-3.4 2.7-4.3L18.6 6.2Z"/></svg>`,
    sparkle: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.2l1.9 5.6 5.6 1.9-5.6 1.9L12 17.2l-1.9-5.6L4.5 9.7l5.6-1.9L12 2.2Z"/><path d="M18.4 15.6l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/><path d="M5.6 14.4l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z"/></svg>`,
    heart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 5.6a5.4 5.4 0 0 0-7.7 0L12 6.7l-1.1-1.1a5.4 5.4 0 0 0-7.7 7.7l1.1 1.1L12 21.6l7.7-7.7 1.1-1.1a5.4 5.4 0 0 0 0-7.7Z"/></svg>`,
    thumbsUp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21V10.5l4.2-7.2a1.6 1.6 0 0 1 2.9 1.2L13.2 9H19a2 2 0 0 1 2 2.3l-1.2 7.2A2 2 0 0 1 17.8 21Z"/><path d="M7 10.5H4a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h3"/></svg>`,
    thumbsDown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3v10.5l-4.2 7.2a1.6 1.6 0 0 1-2.9-1.2L10.8 15H5a2 2 0 0 1-2-2.3l1.2-7.2A2 2 0 0 1 6.2 3Z"/><path d="M17 13.5h3a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-3"/></svg>`,
    star: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.9L12 3.6Z"/></svg>`,
    smile: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8.6"/><path d="M8.6 14.2a4.2 4.2 0 0 0 6.8 0"/><circle cx="9.2" cy="9.8" r=".95" fill="currentColor" stroke="none"/><circle cx="14.8" cy="9.8" r=".95" fill="currentColor" stroke="none"/></svg>`
  };

  /* ============================== favicon（Codex 风：圆角深底 + Codex 花） ============================== */

  // Codex / OpenAI 花朵 path（simple-icons openai，CC0）
  const CX_OPENAI_PATH =
    "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

  let faviconUriCache = null;
  let faviconModeCache = null;

  function makeFaviconUri() {
    if (cfg("favicon") === "site") return null;
    const light = !isDarkMode();
    const mode = light ? "light" : "dark";
    if (faviconUriCache && faviconModeCache === mode) return faviconUriCache;
    const bg = light ? "#f2f2f3" : "#171717";
    const fg = light ? "#0f0f0f" : "#ffffff";
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
      `<rect width="24" height="24" rx="5.5" fill="${bg}"/>` +
      `<path fill="${fg}" d="${CX_OPENAI_PATH}"/></svg>`;
    faviconUriCache = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    faviconModeCache = mode;
    return faviconUriCache;
  }

  /* ============================== 工具函数 ============================== */

  /**
   * 安全取图标。
   * 自建图标集少了任何一个 key，模板拼接就会写出字面 "undefined"。
   * 所有图标引用一律走这里，丢掉图标总比页面上出现 "undefined" 好。
   */
  function ic(name) {
    return ICONS[name] || "";
  }

  /**
   * 解 HTML 实体。
   * 为什么需要：__ALL_FORUM_DATA 里的版面名是**转义过的**
   * （实测有 King&#39;s Raid、A&amp;B、攻略合集&amp;求助合集），
   * 而我在 rail / 版面大全里是用 textContent/escapeHtml 输出的，
   * 不解的话界面上就直接显示成 &amp; 这种字面量。
   * 只覆盖这几个够用的实体：版面名里不会出现更冷门的。
   */
  function decodeEntities(text) {
    const s = String(text == null ? "" : text);
    if (s.indexOf("&") < 0) return s;
    return s
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function txt(el) {
    return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  function attr(el, name) {
    return el ? String(el.getAttribute(name) || "") : "";
  }

  /** 从 nuke.php?func=ucp&uid=123 里取 uid */
  function uidFromHref(href) {
    const m = String(href || "").match(/[?&]uid=(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  /**
   * NGA 的时间有两种形态：
   *   - 原生 JS 还没跑：<span class='postdate'>1748251672</span>（unix 秒）
   *   - 原生 JS 跑完：  "26-09-16 10:05" / "2026-09-16 10:05"
   * 两种都吃，统一吐 ISO（拿不到就吐空串）。
   */
  function ngaTime(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return "";
    if (/^\d{9,}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
    const m = s.match(/^(\d{2}|\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})/);
    if (m) {
      const y = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
      const d = new Date(y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
      return Number.isNaN(d.getTime()) ? "" : d.toISOString();
    }
    return "";
  }

  function formatTime(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const now = Date.now();
    const diff = now - date.getTime();
    const minute = 60e3, hour = 3600e3, day = 86400e3;
    // 论坛里「未来时间」不算罕见（发帖机 / 时区），别显示成 -3 分钟前
    if (diff < -60e3) return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")}`;
    if (diff < minute) return "刚刚";
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day && date.getDate() === new Date().getDate()) {
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }
    if (diff < 2 * day) return "昨天";
    if (diff < 365 * day) return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")}`;
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }

  /** 只取数字（"547" / "1,774" → 数字） */
  function num(s) {
    const m = String(s == null ? "" : s).replace(/,/g, "").match(/-?\d+/);
    return m ? Number(m[0]) : 0;
  }

  /** 把 1234 / 12.3万 这类回复数压成短形式 */
  function shortNum(n) {
    const v = Number(n) || 0;
    if (v < 1000) return String(v);
    if (v < 10000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return (v / 10000).toFixed(1).replace(/\.0$/, "") + "w";
  }

  /**
   * 从 text[i]（必须是 '[' 或 '{'）开始，取出一个括号配平的字面量。
   * 字符串里的括号不计入层级，所以 `["[url]x[/url] [img]y[/img]"]` 不会被
   * 内层的 ] 提前截断 —— 用非贪婪正则干这事一定会错，因为这正是它翻过的坑。
   */
  function balancedSlice(text, i) {
    const open = text[i];
    if (open !== "[" && open !== "{") return null;
    const close = open === "[" ? "]" : "}";
    let depth = 0, quote = null, esc = false;
    for (let k = i; k < text.length; k++) {
      const c = text[k];
      if (quote) {
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (!depth) return text.slice(i, k + 1);
      }
    }
    return null;
  }

  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch { return fallback; }
  }

  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  }

  function domReady() {
    if (document.readyState === "loading") {
      return new Promise((r) => document.addEventListener("DOMContentLoaded", r, { once: true }));
    }
    return Promise.resolve();
  }

  function copyText(text) {
    const done = () => toastNow("已复制");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => toastNow("复制失败"));
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch { toastNow("复制失败"); }
    ta.remove();
  }

  function toastNow(msg) {
    let el = document.querySelector(".ngax-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "ngax-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("on");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("on"), 1800);
  }

  /**
   * requestAnimationFrame 的兜底。
   * 浏览器里一定有，但如果脚本跑在没有渲染循环的环境里（无头测试、
   * 老 WebView、某些精简浏览器），直接调用会抛 ReferenceError ——
   * 而这条链路上挂着「渲染」和「失败就回退原生页面」两个关键动作，
   * 不能因为少一个 rAF 就整页不工作。
   */
  function nextFrame(fn) {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
    else setTimeout(fn, 16);
  }

  /** 种子随机（同一个楼层每次刷新长得一样） */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ============================== 站内数据桥（window.commonui） ==============================
   *
   * NGA 把页面上所有需要的东西都挂在 window 上，而且**比 DOM 更权威**：
   *   __CURRENT_UID / __CURRENT_UNAME / __CURRENT_FID / __CURRENT_TID
   *   __ALL_FORUM_DATA      { fid: [fid, 版面名, 副标题, ?, bit] }（注意是隐式全局，没有 var）
   *   __PAGE                { 0:baseUrl, 1:总页数, 2:当前页, 3:每页条数 }
   *   commonui.userInfo.users[uid]  { username, avatar, postnum, rvrc, regdate, ... }
   *   commonui.postArg.data[i]      楼层 i 的原始参数（tid/pid/pAid/postTime/type/…）
   *
   * 这些名字都是 NGA 内部的，改版就可能变 —— 所以每个取值都带兜底，
   * 取不到就退回解析 DOM，绝不因为一个字段拿不到就整页渲染失败。
   * ======================================================================= */

  function com() {
    return (typeof window !== "undefined" && window.commonui) || null;
  }

  /** uid → { username, avatar, postnum, rvrc, ... }，永远返回对象（不返回 null） */
  function userInfo(uid) {
    const c = com();
    const users = c && c.userInfo && c.userInfo.users;
    const u = users && uid ? users[uid] : null;
    return u || {};
  }

  /** 楼层索引 → commonui.postArg 的原始参数对象 */
  function postArg(i) {
    const c = com();
    const d = c && c.postArg && c.postArg.data;
    return (d && d[i]) || null;
  }

  /** 版面列表行索引 → commonui.topicArg 的原始 arguments */
  function topicArg(i) {
    const c = com();
    const d = c && c.topicArg && c.topicArg.data;
    const a = d && d[i];
    if (!a) return null;
    // topicArg 存的是 add() 的 arguments：
    // [0]=replies [1]=topic [2]=author [3]=postdate [4]=replier [5]=replytime
    // [6]=pagelinks [7]=fid [8]=tid [9]=pid [10]=quoteTid [11]=quoteFrom
    // [12]=postdate(unix) [13]=lastpost(unix) [14]=replies [15]=type [16]=topicMisc
    // [17]=font [18]=avatar [19]=admin [20]=attath
    return {
      fid: Number(a[7]) || 0,
      tid: Number(a[8]) || 0,
      postTime: Number(a[12]) || 0,
      lastPost: Number(a[13]) || 0,
      replies: Number(a[14]) || 0,
      type: Number(a[15]) || 0
    };
  }

  /** 登录用户；未登录返回 null */
  function currentUser() {
    const uid = Number(window.__CURRENT_UID) || 0;
    if (!uid) return null;
    const u = userInfo(uid);
    const name = window.__CURRENT_UNAME || u.username || String(uid);
    return { uid, name, avatar: u.avatar || "", postnum: u.postnum || 0, rvrc: u.rvrc || 0 };
  }

  /** fid → { name, subtitle }；名字优先问 __ALL_FORUM_DATA，其次问本地版面表 */
  function forumInfo(fid) {
    const key = String(fid);
    const all = window.__ALL_FORUM_DATA;
    if (all && all[key] && all[key][1]) {
      return { fid: key, name: decodeEntities(all[key][1]), subtitle: decodeEntities(all[key][2] || "") };
    }
    const f = allForums().get(key);
    if (f) return { fid: key, name: f.name, subtitle: f.sub || "" };
    return { fid: key, name: "", subtitle: "" };
  }

  /** 面包屑：NGA玩家社区 » 版面 » 标题 */
  function breadcrumb() {
    const nav = document.querySelector("#m_nav .nav") || document.querySelector("#b_nav .nav");
    if (!nav) return { root: "", forum: "", title: "" };
    const root = txt(nav.querySelector("a.nav_root"));
    const links = Array.from(nav.querySelectorAll("a.nav_link"));
    const h1 = nav.querySelector("h1 a");
    const forum = links.length && links[0] !== h1 ? txt(links[0]) : "";
    const title = h1 ? txt(h1) : "";
    return { root, forum, title };
  }

  /** 页面里的第一行「标题」（帖子页是标题，列表页是版面名） */
  function pageTitle() {
    const h1 = document.querySelector("#currentTopicName");
    const h2 = document.querySelector("#currentForumName");
    const bc = breadcrumb();
    return {
      topic: txt(h1) || bc.title,
      forum: txt(h2) || bc.forum
    };
  }

  /** 分页：优先读 NGA 的 __PAGE（0 基址 / 总页数 / 当前页 / 每页条数），退回解析 DOM */
  function pager() {
    const p = window.__PAGE;
    if (p && p[0]) {
      return {
        base: String(p[0]),
        total: Math.max(1, Number(p[1]) || 1),
        current: Math.max(1, Number(p[2]) || 1),
        perPage: Number(p[3]) || 20
      };
    }
    // 兜底：从服务端渲染的分页区里把「下一页」的链接抠出来
    const box = document.getElementById("pagebtop") || document.getElementById("pagebbtm");
    if (!box) return { base: location.pathname + location.search.replace(/[?&]page=\d+/, ""), total: 1, current: 1, perPage: 20 };
    const next = box.querySelector("a.pager_spacer");
    const cur = Math.max(1, num((location.search.match(/[?&]page=(\d+)/) || [])[1]) || 1);
    const nextPage = next ? num((attr(next, "href").match(/[?&]page=(\d+)/) || [])[1]) : 0;
    return {
      base: attr(next, "href").replace(/[?&]page=\d+/, "") || location.pathname,
      total: nextPage ? nextPage : cur,
      current: cur,
      perPage: 20
    };
  }

  /** 拼分页链接：NGA 第 1 页不带 page= 参数 */
  function pageUrl(base, n) {
    if (n <= 1) return base;
    return base + (base.indexOf("?") >= 0 ? "&" : "?") + "page=" + n;
  }

  /* ============================== 版面表 ==============================
   *
   * 下面这张表由 .build/crawl-forums.py 从 NGA 各版面页的 __ALL_FORUM_DATA 合并而来，
   * 共 361 个版面，名字全部是站点自己的，没有手抄。
   *
   * 为什么要爬：NGA **没有一个「全部版面」页面** —— 首页只有头条，顶部菜单是用户菜单，
   * 真正的版面关系分散在每个版面页里（本版 + 子版 + 联合版）。
   *
   * 覆盖率的上限在哪：综合侧和游戏侧不在同一棵联合树里，所以从所爬的种子出发
   * BFS 完也只能拿到 361 个 —— 像「原神」这种不在该图里的专版仍然可能缺。
   * 所以下面还有第二层：**运行时自动补全** —— 任何页面渲染时都把该页的
   * __ALL_FORUM_DATA 合进 localStorage，用户逛到哪儿，这张表就长到哪儿。
   * ================================================================= */

  // 由 .build/crawl-forums.py 生成（三条路子合并）：
  //   ① 从各版面页 __ALL_FORUM_DATA 做 BFS；
  //   ② 拿 __UFICON / __UFIMGS 资源表里的 fid 当种子（游戏侧不在同一棵联合树里）；
  //   ③ --search 模式：按关键词搜帖子 → 读帖子属于哪个版面（补没图标的专版）。
  // 共 973 个版面；名字全部来自站点自己（已解 HTML 实体），没有手抄
  const FORUMS = [
    { fid: 43458922, name: "2025年中国家电及消费电子博览会(AWE)" },
    { fid: 32438497, name: "408环境讨论" },
    { fid: 33844263, name: "AI创作讨论合集" },
    { fid: 640, name: "Apex 英雄" },
    { fid: 35946069, name: "BLG战队合集" },
    { fid: 664, name: "BanG Dream!", sub: "邦邦" },
    { fid: 510483, name: "BanG Dream!Our Notes" },
    { fid: 552, name: "Battlefield系列" },
    { fid: -21175563, name: "CRPG综合讨论" },
    { fid: 482, name: "CS:GO" },
    { fid: 360, name: "CTM副本讨论区(存档)" },
    { fid: 510387, name: "D4杂谈区" },
    { fid: 23259601, name: "DIY卡牌合集" },
    { fid: 321, name: "DOTA2" },
    { fid: 521, name: "DOTA2杂谈" },
    { fid: 318, name: "Diablo3 讨论区" },
    { fid: 443, name: "EAFC系列", sub: "EAFC / FIFA系列" },
    { fid: 25441105, name: "EDG战队合集" },
    { fid: 32845891, name: "FGO版120级从者纪念合集" },
    { fid: 23033391, name: "FPX战队合集" },
    { fid: -534617, name: "Falcom游戏讨论" },
    { fid: 34375277, name: "Falcom系列" },
    { fid: 540, name: "Fate/Grand Order" },
    { fid: 17963192, name: "Fire Emblem 系列" },
    { fid: 510435, name: "GBF Relink(动作角色扮演)" },
    { fid: 18061643, name: "GBF Versus(格斗)" },
    { fid: 13043110, name: "Grаnd Thеft Autо V" },
    { fid: -63418579, name: "HPMA藏宝阁", sub: "《哈利波特·魔法觉醒》藏宝阁专版" },
    { fid: -187628, name: "Home, sweet home" },
    { fid: 23033299, name: "IG战队合集" },
    { fid: 576, name: "IT新闻合集" },
    { fid: 23033937, name: "JDG战队合集" },
    { fid: 557, name: "King's Raid" },
    { fid: 510458, name: "LG UltraGear电竞专区" },
    { fid: 660, name: "LOL云顶之弈" },
    { fid: 510416, name: "LoveLive！系列" },
    { fid: 25124476, name: "MDI-史诗钥石地下城锦标赛" },
    { fid: 18084108, name: "MOD/修改工具/优化/相关讨论" },
    { fid: 15381677, name: "MOD发布区" },
    { fid: 475, name: "MOP副本讨论区(存档)" },
    { fid: 481, name: "Minecraft" },
    { fid: 716, name: "NGATOYS", sub: "NGATOYS模玩手办" },
    { fid: 335, name: "NGA开发" },
    { fid: 12643851, name: "NGA游戏档案馆" },
    { fid: -20691707, name: "NGA菠菜中心" },
    { fid: -2371813, name: "NGA驻吉他海四办公室" },
    { fid: 616, name: "Nintendo游戏综合讨论", sub: "百年老店任天堂" },
    { fid: 334, name: "PC软硬件" },
    { fid: 614, name: "PS游戏综合讨论" },
    { fid: 599, name: "PUBG 和平精英" },
    { fid: 687, name: "PVE/活动讨论" },
    { fid: 19588125, name: "PVP讨论专区" },
    { fid: 661, name: "Paradox游戏综合讨论" },
    { fid: 529, name: "Pokemon Go", sub: "口袋妖怪 上！" },
    { fid: 18343564, name: "Pokemon Masters" },
    { fid: 510507, name: "Pokemon Sleep" },
    { fid: 23033324, name: "RNG战队合集" },
    { fid: 510431, name: "ROG掌机" },
    { fid: 27891529, name: "ROLL贴合集" },
    { fid: 510466, name: "Random Play", sub: "图画创作" },
    { fid: 510441, name: "Snowbreak: Containment Zone" },
    { fid: 724, name: "Splatoon" },
    { fid: 510383, name: "Steam Deck" },
    { fid: 36398600, name: "TCG环境讨论" },
    { fid: 23033927, name: "TES战队合集" },
    { fid: 38799202, name: "THE FINALS" },
    { fid: 36699169, name: "VCT赛事讨论" },
    { fid: -40639972, name: "VOCALOID" },
    { fid: 499, name: "VR设备与游戏应用" },
    { fid: -60204499, name: "Vtuber综合讨论区" },
    { fid: 359, name: "WLK副本讨论区(存档)" },
    { fid: 615, name: "XBOX游戏综合讨论" },
    { fid: 33759583, name: "XBOX讨论区HOME组队合集" },
    { fid: 45335239, name: "YCS赛事相关讨论" },
    { fid: 36959650, name: "[不按格式会被删除] 二手交易集中求购/收购/询价版(请在这里发帖)" },
    { fid: 19687837, name: "[圣域铁匠铺]装备合集-配装求助/晒传家宝/强化讨论专区" },
    { fid: 32871539, name: "[安科]八重堂" },
    { fid: 11656499, name: "[手游]战舰猎手" },
    { fid: 14967952, name: "[招募] 公会招募与王者副本组队合集(注意同区服才能组队)" },
    { fid: 16623881, name: "[招募酒馆]公会招募/求职/远征交友 合集" },
    { fid: 46575044, name: "[攻略]怪谈社" },
    { fid: 17695074, name: "[新手区] 启蒙殿堂" },
    { fid: 34562470, name: "[正式服] 订单互助合集" },
    { fid: 14083223, name: "[电台]NGA bar 合集" },
    { fid: 12968037, name: "[电视游戏主机/掌机] 二手主机掌机及游戏相关交易" },
    { fid: 47383454, name: "[纯吐槽] TI2027赛季 电竞经理临时合集" },
    { fid: 34592153, name: "[考据]拾枝杂谈" },
    { fid: 46575060, name: "[联机交友]月兔酒馆" },
    { fid: 47206901, name: "[股市]技术分析" },
    { fid: 47300668, name: "[论坛活动]  从者强化第20弹&11周年特辑 菠菜合集" },
    { fid: 42906882, name: "[长期合集] ELO 37 搏击俱乐部" },
    { fid: 42683698, name: "[集中贴] 低保咨询合集" },
    { fid: 38460689, name: "[雷茵格尔大图书馆]同人创作专区" },
    { fid: 25105882, name: "from ARGONAVIS - アルゴナビス -キミが見たステージへ-" },
    { fid: 33422730, name: "roll帖专区" },
    { fid: -2342912, name: "tempuser50 的个人版面" },
    { fid: 12839732, name: "“每周一歌”活动合集" },
    { fid: 29336898, name: "《双城之战》剧情相关讨论合集" },
    { fid: 12435228, name: "《命运2》公会招募 合集" },
    { fid: 12427093, name: "《命运2》组队交流 合集" },
    { fid: 45179519, name: "《怪物猎人：旅人》" },
    { fid: 45686999, name: "《歧路旅人0》/《八方旅人0》讨论合集" },
    { fid: 47554235, name: "《黑暗帝国的统治》前瞻" },
    { fid: -202020, name: "一只IT喵的自我修养" },
    { fid: 510374, name: "七圣召唤" },
    { fid: 350, name: "七彩映画" },
    { fid: 536, name: "七雄战记" },
    { fid: 809, name: "万文集舍" },
    { fid: 617, name: "万王之王3D" },
    { fid: -103330, name: "万象物语" },
    { fid: 510393, name: "三余书肆" },
    { fid: 510344, name: "三国杀 我们的游戏正在蒸蒸日上哦！" },
    { fid: 435, name: "上古卷轴Online" },
    { fid: 823, name: "上线游戏讨论区" },
    { fid: 27641546, name: "不舟滩(杂谈、水区)" },
    { fid: 409, name: "专家模式" },
    { fid: 36711414, name: "专家模式" },
    { fid: -40530437, name: "东方Project", sub: "幻想乡国家地理" },
    { fid: 18855745, name: "东方大战争" },
    { fid: 18739125, name: "东方大炮弹" },
    { fid: 27919511, name: "东方弹幕神乐" },
    { fid: 23730348, name: "东方归言录" },
    { fid: 12962101, name: "中国版内容合集" },
    { fid: -63708427, name: "中庭的枯树洞(怪文书专版)" },
    { fid: 711, name: "为美好的世界献上祝福！" },
    { fid: 598, name: "为谁而炼金" },
    { fid: 596, name: "主播/直播/赛事/战队讨论" },
    { fid: 510496, name: "主机游戏资讯" },
    { fid: 37691038, name: "主题赛事" },
    { fid: 47344543, name: "乌拉特克的诅咒：烈毒之渊首杀合集" },
    { fid: 45318016, name: "书海拾轶" },
    { fid: 782, name: "买断制手游" },
    { fid: 19402350, name: "乱斗与冒险模式" },
    { fid: 17263554, name: "乱羽科技" },
    { fid: 586, name: "争霸艾泽拉斯 最新信息汇集" },
    { fid: 498, name: "二手交易", sub: "信息互助" },
    { fid: 40105173, name: "二手配件及整车交易区" },
    { fid: 38863615, name: "二次元同人创作" },
    { fid: 572, name: "二次元国家合集" },
    { fid: -447601, name: "二次元国家地理" },
    { fid: 784, name: "二次元跑团综合", sub: "安科 文字TRPG" },
    { fid: 36297903, name: "云顶赛事" },
    { fid: 45616464, name: "互助互点合集活动合集" },
    { fid: 21842096, name: "互助招募合集" },
    { fid: 390, name: "五晨寺" },
    { fid: 45062458, name: "五晨寺 低保合集" },
    { fid: 542, name: "五晨寺 问答区" },
    { fid: 44834121, name: "交友合集" },
    { fid: 40172472, name: "交友招募" },
    { fid: 725, name: "交换/组队" },
    { fid: 713, name: "交易互助" },
    { fid: 36751806, name: "交易合集" },
    { fid: -34490385, name: "人生不过三万天 能摸一天是一天" },
    { fid: -8492846, name: "人生态度" },
    { fid: 558, name: "仁王" },
    { fid: 35955841, name: "代号：鸢" },
    { fid: 705, name: "任天堂明星大乱斗", sub: "Super Smash Bros" },
    { fid: 703, name: "伊吹茶馆" },
    { fid: 570, name: "优惠信息 购物指南" },
    { fid: 27353749, name: "优质攻略" },
    { fid: 42452292, name: "低保合集" },
    { fid: 27822292, name: "低保合集 黑锋要塞" },
    { fid: -522474, name: "体育综合讨论", sub: "2024年巴黎夏季奥运会" },
    { fid: -41398941, name: "体验服交流区" },
    { fid: 813, name: "佣兵战纪" },
    { fid: 19659084, name: "使命召唤手游" },
    { fid: 636, name: "使命召唤系列" },
    { fid: 24227796, name: "使命召唤：冷战" },
    { fid: -4760591, name: "侠客风云传" },
    { fid: 837, name: "侠盗营地-水区/问答区" },
    { fid: 183, name: "信仰神殿 - Temple of Faith" },
    { fid: 16106649, name: "信仰神殿幻化合集" },
    { fid: 19724237, name: "健身环大冒险" },
    { fid: 24128991, name: "偶像梦幻祭2" },
    { fid: 469, name: "像素骑士团" },
    { fid: 26150366, name: "光与夜之恋" },
    { fid: 43933756, name: "光与影：33号远征队" },
    { fid: 495, name: "光荣策略游戏" },
    { fid: -40063163, name: "免费公益区（魔兽世界）" },
    { fid: 32889111, name: "入坑指南" },
    { fid: 523, name: "全境封锁" },
    { fid: 630, name: "全面战争系列 / Total War" },
    { fid: 44669762, name: "公 会 招 募" },
    { fid: -10308342, name: "公主连结Re:Dive" },
    { fid: 728, name: "公主连结风纪区" },
    { fid: 31297645, name: "公主连结！棋牌大师" },
    { fid: 16409702, name: "公会/团队招募" },
    { fid: 721, name: "公会招募" },
    { fid: 39826573, name: "公会招募" },
    { fid: 37535582, name: "公会招募(合集外禁止群宣)" },
    { fid: 41528268, name: "公会招募/组队" },
    { fid: 26058606, name: "公会招募合集" },
    { fid: 40916996, name: "公会招募合集" },
    { fid: 43624283, name: "公会招募合集" },
    { fid: 41174837, name: "公益制造专区" },
    { fid: 41174821, name: "公益活动专区" },
    { fid: 510376, name: "兰德索尔广场", sub: "同人作品" },
    { fid: 793, name: "冒险家协会", sub: "联机与好友" },
    { fid: 707, name: "冒险岛", sub: "MapleStory" },
    { fid: 515, name: "冒险岛2" },
    { fid: 620, name: "军团 招募/求职与组队" },
    { fid: 718, name: "军团招募/求职与组队" },
    { fid: 21441791, name: "军团招募专区" },
    { fid: 30577620, name: "军团漫游-法师塔合集" },
    { fid: 593, name: "决战！平安京 专版", sub: "阴阳师MOBA" },
    { fid: 510446, name: "出发吧麦芬" },
    { fid: 10990054, name: "刀剑乱舞合集" },
    { fid: 622, name: "刀塔卡牌 Artifact" },
    { fid: 40146107, name: "刀塔档案馆" },
    { fid: 659, name: "刀塔霸业" },
    { fid: 272, name: "刀锋山竞技场" },
    { fid: 613, name: "分享活动 买家互助" },
    { fid: 39236550, name: "分享链接/活动组队" },
    { fid: 15166097, name: "创意工坊-DIY" },
    { fid: 23588623, name: "初音未来:缤纷舞台" },
    { fid: 627, name: "刺客信条系列" },
    { fid: 13749795, name: "前方电报" },
    { fid: 21795096, name: "前瞻合集 黑锋要塞" },
    { fid: 701, name: "剑与远征" },
    { fid: 40187486, name: "剑士职业讨论" },
    { fid: 835, name: "剑斗绮谭" },
    { fid: 44390834, name: "剑星/Stellar Blade" },
    { fid: -65653, name: "剑灵" },
    { fid: -7861121, name: "剑网3", sub: "J3客户端版" },
    { fid: 25659800, name: "剧场布告栏" },
    { fid: 762, name: "剧情(透)讨论", sub: "Cyberpunk 2077" },
    { fid: 9370479, name: "剧情/设定讨论" },
    { fid: 510473, name: "剧情讨论" },
    { fid: 767, name: "剧本杀(谋杀之谜)" },
    { fid: 577, name: "剧透讨论" },
    { fid: 218, name: "副本讨论区" },
    { fid: 102, name: "加基森作家协会" },
    { fid: 23591465, name: "动森百科" },
    { fid: 22743480, name: "动物森友会 口袋露营广场" },
    { fid: 710, name: "动物森友会系列" },
    { fid: 18763697, name: "动画/漫画专楼合集" },
    { fid: 21051903, name: "十三机兵防卫圈" },
    { fid: 44967500, name: "千星奇域" },
    { fid: 16638186, name: "华盛顿人事部" },
    { fid: 510417, name: "博德之门系列" },
    { fid: 38967488, name: "博物学会(问答合集)" },
    { fid: 584, name: "卡 组 分 享" },
    { fid: 510560, name: "卡厄思梦境" },
    { fid: 510412, name: "卡拉彼丘" },
    { fid: 847, name: "历史研究" },
    { fid: 650, name: "原神" },
    { fid: 43465716, name: "双影奇境" },
    { fid: 844, name: "反恐行动" },
    { fid: 14810369, name: "古剑OL问答版" },
    { fid: 14494685, name: "古剑奇谭OL招募合集" },
    { fid: 634, name: "古剑奇谭单机版", sub: "单机版" },
    { fid: 618, name: "古剑奇谭网络版" },
    { fid: 28434386, name: "古灵阁 [ROLL/抽奖]" },
    { fid: 644, name: "只狼 影逝二度", sub: "Sekiro" },
    { fid: 739, name: "台服讨论" },
    { fid: 781, name: "合集事务" },
    { fid: 35574879, name: "同 人 创 作" },
    { fid: 38967440, name: "同人二创" },
    { fid: 46832162, name: "同人二创" },
    { fid: 457, name: "同人创作" },
    { fid: 38211529, name: "同人创作" },
    { fid: 28504958, name: "同人创作合集" },
    { fid: 20312873, name: "吐槽意见专区" },
    { fid: 563, name: "命运" },
    { fid: 842, name: "命运方舟" },
    { fid: 714, name: "命运神界:梦境链接" },
    { fid: 510391, name: "和裕茶馆", sub: "杂谈" },
    { fid: 758, name: "和裕茶馆(里)", sub: "杂谈" },
    { fid: 812, name: "哈利波特：魔法觉醒" },
    { fid: 46265028, name: "喵喵的结合" },
    { fid: -41232751, name: "四叶草剧场" },
    { fid: 35765778, name: "四格漫画" },
    { fid: 40279348, name: "回忆/支援卡分享" },
    { fid: 255, name: "团队管理经验交流", sub: "管理经验交流" },
    { fid: 683, name: "围城", sub: "公务员及公考相关" },
    { fid: 34331638, name: "国服以外服战友招募合集" },
    { fid: 323, name: "国服以外讨论" },
    { fid: 740, name: "国服讨论" },
    { fid: 35830387, name: "国服讨论合集" },
    { fid: 28419235, name: "国王十字车站 [互助/招募]" },
    { fid: 843, name: "国际新闻" },
    { fid: 510429, name: "国际新闻杂谈" },
    { fid: 37031651, name: "国际服往期午夜电波合集" },
    { fid: 44830307, name: "国际服讨论合集" },
    { fid: 510568, name: "图灵茶馆" },
    { fid: 184, name: "圣光广场 - Might of The Light" },
    { fid: 820, name: "圣光杂谈", sub: "低保/心情/幻化/留念/文创" },
    { fid: 39509883, name: "圣兽之王" },
    { fid: 446, name: "圣教军" },
    { fid: 27620727, name: "圣教军-萨卡兰姆之盾" },
    { fid: 625, name: "圣斗士星矢" },
    { fid: 639, name: "圣歌/Anthem" },
    { fid: 510, name: "圣骑士" },
    { fid: 510540, name: "圣骑士" },
    { fid: 510456, name: "圣骑士(大地的裂变)" },
    { fid: 783, name: "圣骑士(巫妖王之怒)" },
    { fid: 510534, name: "圣骑士(时光服)" },
    { fid: 510516, name: "圣骑士(熊猫人之谜)" },
    { fid: 510549, name: "圣骑士(燃烧的远征)" },
    { fid: 675, name: "圣骑士(经典旧世)" },
    { fid: 510468, name: "地下城与勇士M" },
    { fid: 12138627, name: "地域鬼王合集" },
    { fid: 841, name: "地平线 西之绝境" },
    { fid: 510427, name: "地心之战" },
    { fid: 191, name: "地精商会" },
    { fid: 22943853, name: "地精商会：经典旧世" },
    { fid: 510557, name: "场外杂谈" },
    { fid: 729, name: "坦克世界插件" },
    { fid: 423, name: "坦克世界游戏录像(关闭)" },
    { fid: 16353277, name: "坦克手游讨论-闪击战" },
    { fid: 108, name: "垃圾处理" },
    { fid: 609, name: "堡垒之夜" },
    { fid: 510462, name: "塔瑞斯世界" },
    { fid: 510397, name: "塞尔达传说系列" },
    { fid: 18140490, name: "墨水湾写作圆桌" },
    { fid: 421, name: "壁画竞技场" },
    { fid: 554, name: "外服区招募/求职", sub: "外服区招募/求职" },
    { fid: 40363879, name: "外服讨论合集" },
    { fid: 29393090, name: "外观改装/美图 分享专区" },
    { fid: 773, name: "外设硬件" },
    { fid: 641, name: "多多自走棋" },
    { fid: 17263440, name: "大图书馆" },
    { fid: 510426, name: "大地的裂变 (归档)" },
    { fid: 510447, name: "大地的裂变插件讨论区" },
    { fid: 46019748, name: "大巴扎The Bazaar" },
    { fid: 832, name: "大方小方" },
    { fid: 706, name: "大时代", sub: "股市讨论" },
    { fid: 533, name: "大秘境集合石" },
    { fid: 537, name: "大航海时代6" },
    { fid: 11709914, name: "大舰队招募 (禁止宣传QQ/微信群)" },
    { fid: 15985900, name: "大赛讨论合集" },
    { fid: 24253900, name: "大过滤器" },
    { fid: 510436, name: "大都绘" },
    { fid: 27641613, name: "天人城(攻略区)" },
    { fid: 23673143, name: "天命既定" },
    { fid: 43216662, name: "天国：拯救2" },
    { fid: 771, name: "天地劫手游" },
    { fid: 25868546, name: "天地际会" },
    { fid: 452, name: "天涯明月刀" },
    { fid: -47218, name: "天界的卡勒特" },
    { fid: 626, name: "太吾绘卷", sub: "The Scroll Of Taiwu" },
    { fid: 35386578, name: "失效攻略/玩家精华内容合集" },
    { fid: 623, name: "失落的龙约" },
    { fid: 116, name: "奇迹之泉 Fountain of Wonders", sub: "所有可以让WoW更有趣的创意都可以发表在这里以供讨论。" },
    { fid: 750, name: "女性向游戏专区" },
    { fid: 11291877, name: "女神异闻录系列" },
    { fid: 510471, name: "女神异闻录：夜幕魅影" },
    { fid: 29534981, name: "好友/战队招募" },
    { fid: 46693905, name: "好友互助" },
    { fid: 46342358, name: "好友招募" },
    { fid: 39879445, name: "好友招募/互助" },
    { fid: 22043948, name: "好友招募互助" },
    { fid: 32173164, name: "威斯特玛酒馆[互助/招募]" },
    { fid: -39223361, name: "娱乐吃瓜区" },
    { fid: 510445, name: "学园偶像大师" },
    { fid: 40187530, name: "学者职业讨论" },
    { fid: 459, name: "守望先锋" },
    { fid: 510555, name: "守望先锋Rush" },
    { fid: 9527783, name: "守望先锋同人" },
    { fid: 510360, name: "守望先锋杂谈" },
    { fid: 587, name: "守望先锋赛事" },
    { fid: 42524182, name: "守竞奇谭" },
    { fid: 12107113, name: "完结动画评分" },
    { fid: 29994224, name: "官方公告/蓝贴" },
    { fid: 37306223, name: "官方公告搬运" },
    { fid: 510379, name: "宝可梦TCG" },
    { fid: 42360383, name: "宝可梦TCG Live" },
    { fid: 510485, name: "宝可梦TCG Pocket" },
    { fid: 42360364, name: "宝可梦TCG 简中" },
    { fid: 26787624, name: "宝可梦大探险" },
    { fid: 22407158, name: "宝可梦大集结(Pokemon Unite)" },
    { fid: 678, name: "家国梦" },
    { fid: 510539, name: "家宅讨论" },
    { fid: 752, name: "对决模式讨论" },
    { fid: 467, name: "寻求组队" },
    { fid: 13888618, name: "寻求组队/军团招募信息合集" },
    { fid: 13882333, name: "寻求组队/氏族招募" },
    { fid: -8725919, name: "小窗视界", sub: "旅游，摄影" },
    { fid: 19315503, name: "小说评分" },
    { fid: -195362, name: "少前2：追放" },
    { fid: -60157311, name: "少前:云图计划" },
    { fid: -547859, name: "少女前线-16LAB研究院" },
    { fid: 26396824, name: "少女的王座" },
    { fid: 561, name: "尼尔系列", sub: "NieR" },
    { fid: 717, name: "山海镜花" },
    { fid: 549, name: "崩坏3" },
    { fid: 12889980, name: "崩坏3师徒招募合集" },
    { fid: -2068947, name: "崩坏学园2" },
    { fid: 818, name: "崩坏：星穹铁道" },
    { fid: 17049757, name: "工坊/自定游戏" },
    { fid: 398, name: "巫医" },
    { fid: 850, name: "巫妖王之怒" },
    { fid: 510400, name: "巫师" },
    { fid: 514, name: "巫师/猎魔人" },
    { fid: -15219445, name: "巫师之昆特牌" },
    { fid: 44714263, name: "布法利亚图书馆" },
    { fid: 23479470, name: "平安京体验服" },
    { fid: 743, name: "平安京茶楼", sub: "游戏风纪/杂谈" },
    { fid: 17084707, name: "平安京麻将棋" },
    { fid: 760, name: "幻书启世录" },
    { fid: 510434, name: "幻兽帕鲁" },
    { fid: 25944158, name: "幽城秘辛——剧情同人区" },
    { fid: 32815104, name: "庇护之地风纪区" },
    { fid: 24059524, name: "开发日志翻译合集" },
    { fid: 44714678, name: "开拓者招募" },
    { fid: 20507739, name: "开拓者系列" },
    { fid: 595, name: "异度神剑系列" },
    { fid: 510491, name: "异次元空间(情绪宣泄区)" },
    { fid: 510559, name: "异环" },
    { fid: 34337255, name: "弈仙牌合集" },
    { fid: 40974444, name: "式神评分和讨论区" },
    { fid: 600, name: "彩虹六号" },
    { fid: 39174006, name: "影 之 幻 境" },
    { fid: -8180483, name: "影之诗", sub: "Shadowverse" },
    { fid: 510500, name: "影之诗  超凡世界" },
    { fid: 34145619, name: "影之诗进化对决" },
    { fid: 40187562, name: "影袭职业讨论" },
    { fid: 12993058, name: "影音区悬赏、任务合集" },
    { fid: -576177, name: "影音讨论区" },
    { fid: 30165859, name: "往期新闻/公告合集" },
    { fid: 22455312, name: "德曼修会藏书馆(历史剧情)" },
    { fid: 508, name: "德鲁伊" },
    { fid: 510402, name: "德鲁伊" },
    { fid: 510452, name: "德鲁伊(大地的裂变)" },
    { fid: 788, name: "德鲁伊(巫妖王之怒)" },
    { fid: 510532, name: "德鲁伊(时光服)" },
    { fid: 510514, name: "德鲁伊(熊猫人之谜)" },
    { fid: 510547, name: "德鲁伊(燃烧的远征)" },
    { fid: 673, name: "德鲁伊(经典旧世)" },
    { fid: 18140378, name: "心情散文/回忆纪实" },
    { fid: 772, name: "忘川风华录" },
    { fid: 697, name: "怀旧服PVP" },
    { fid: 666, name: "怀旧服公会招募" },
    { fid: 18213784, name: "怀旧服招募合集" },
    { fid: 575, name: "怪物弹珠" },
    { fid: 12208024, name: "怪物弹珠初始鉴定合集" },
    { fid: 12275213, name: "怪物弹珠微信协力群合集" },
    { fid: 427, name: "怪物猎人" },
    { fid: 489, name: "怪物猎人(Capcom)" },
    { fid: 27335147, name: "怪猎物语系列" },
    { fid: 39030511, name: "恋与深空" },
    { fid: -608808, name: "恩基爱厨艺美食交流" },
    { fid: 188, name: "恶魔深渊 - Abyss of Demons" },
    { fid: 14688787, name: "恶魔深渊低保/幻化合集" },
    { fid: -41374941, name: "悠久之树" },
    { fid: 34417878, name: "意见与建议合集" },
    { fid: 15813886, name: "意见反馈合集" },
    { fid: 470, name: "成就与收集" },
    { fid: 327, name: "成就讨论区" },
    { fid: 696, name: "战双帕弥什" },
    { fid: 381, name: "战场与竞技场招募" },
    { fid: 258, name: "战场讨论区", sub: "战场战略战术研究以及相关话题" },
    { fid: 504, name: "战士" },
    { fid: 510448, name: "战士(大地的裂变)" },
    { fid: 786, name: "战士(巫妖王之怒)" },
    { fid: 510528, name: "战士(时光服)" },
    { fid: 510510, name: "战士(熊猫人之谜)" },
    { fid: 510543, name: "战士(燃烧的远征)" },
    { fid: 669, name: "战士(经典旧世" },
    { fid: 432, name: "战机世界" },
    { fid: 13899987, name: "战神：诸神黄昏" },
    { fid: 441, name: "战舰世界" },
    { fid: 483, name: "战舰世界插件" },
    { fid: 16353309, name: "战舰世界：闪击战 WoWS: Blitz" },
    { fid: 44456908, name: "战锤40K系列(CRPG)" },
    { fid: 594, name: "战队大厅" },
    { fid: 839, name: "戴森球计划" },
    { fid: 428, name: "手机 网页游戏综合讨论" },
    { fid: 863, name: "手机游戏快讯" },
    { fid: 722, name: "手机研究所" },
    { fid: 29093552, name: "手游招募专区" },
    { fid: -61285727, name: "手游瓜事件", sub: "圈内八卦" },
    { fid: 571, name: "手游评分版" },
    { fid: 11920043, name: "手游问答合集(第二代)" },
    { fid: 35574880, name: "技战术探讨" },
    { fid: 21644331, name: "技术交流/视频分享" },
    { fid: 811, name: "技术讨论" },
    { fid: 562, name: "招募/战队管理" },
    { fid: 589, name: "招募区" },
    { fid: 26937253, name: "招募求组" },
    { fid: 14883783, name: "招募求职合集" },
    { fid: 16636729, name: "招募组队" },
    { fid: 36320099, name: "拼车专区" },
    { fid: 451, name: "指挥官纲领" },
    { fid: 20626473, name: "指挥官讨论" },
    { fid: 510428, name: "探索赛季" },
    { fid: 32793934, name: "提车作业合集" },
    { fid: 741, name: "提问合集&超得咨询合集MKII" },
    { fid: 748, name: "提问求助专用" },
    { fid: 21305748, name: "提问求助合集" },
    { fid: 21710374, name: "提问求助合集" },
    { fid: 510405, name: "搏击俱乐部" },
    { fid: 807, name: "支配剧场" },
    { fid: 29378502, name: "攻略/心得专区" },
    { fid: 33839513, name: "攻略心得" },
    { fid: 43467897, name: "攻略心得专区" },
    { fid: 40172486, name: "攻略指南" },
    { fid: 33422701, name: "攻略资讯" },
    { fid: 15828450, name: "数据解析" },
    { fid: -60252908, name: "文字冒险游戏综合讨论" },
    { fid: -5951001, name: "文明6 Sid Meier's Civilization VI" },
    { fid: 22557897, name: "新人求助区" },
    { fid: 32047557, name: "新卡分享" },
    { fid: 21170821, name: "新卡预览合集" },
    { fid: 46858220, name: "新手问答" },
    { fid: 26217002, name: "新手问答/晒护石去专楼" },
    { fid: 510486, name: "新月同行" },
    { fid: 719, name: "新闻资讯" },
    { fid: 15794693, name: "旅团协力招募合集" },
    { fid: 17263494, name: "旅者之诗" },
    { fid: 754, name: "旅行者指引广场", sub: "提问专区" },
    { fid: 510475, name: "旋涡观影指数合集" },
    { fid: 679, name: "无主之地系列" },
    { fid: 35404194, name: "无尽战区" },
    { fid: 510354, name: "无期迷途" },
    { fid: 510508, name: "无烬战争" },
    { fid: 708, name: "无畏契约" },
    { fid: 510373, name: "无限暖暖" },
    { fid: 633, name: "无限法则" },
    { fid: 27884686, name: "日服剧情讨论合集" },
    { fid: 821, name: "日服讨论" },
    { fid: 510351, name: "日服讨论区" },
    { fid: 757, name: "时空中的绘旅人" },
    { fid: -34587507, name: "明日方舟-罗德岛驻艾泽拉斯大使馆" },
    { fid: 44682097, name: "明末：渊虚之羽" },
    { fid: 27641642, name: "明镜台(捏脸、装扮)" },
    { fid: 22944341, name: "星战前夜：无烬星河" },
    { fid: 510503, name: "星痕共鸣" },
    { fid: 406, name: "星际争霸" },
    { fid: 764, name: "星际公民" },
    { fid: 603, name: "星际战甲/Warframe" },
    { fid: 604, name: "星露谷/StardewValley" },
    { fid: 15740396, name: "晒闪/蹭仙气合集(主版面开贴删除" },
    { fid: 601, name: "晓之轨迹" },
    { fid: -7955747, name: "晴风村" },
    { fid: 43864526, name: "暖暖巴士" },
    { fid: 42013070, name: "暗喻幻想：ReFantazio" },
    { fid: 688, name: "暗影国度" },
    { fid: 37102913, name: "暗黑IV公益区" },
    { fid: 769, name: "暗黑破坏神2 重制版" },
    { fid: 685, name: "暗黑破坏神4" },
    { fid: 631, name: "暗黑破坏神:不朽" },
    { fid: 632, name: "暴雪游戏综合讨论" },
    { fid: 610, name: "曝光代打刷分外挂bug…" },
    { fid: 15828162, name: "更新资讯" },
    { fid: 22090017, name: "最后生还者 第二部" },
    { fid: 39410495, name: "最后纪元" },
    { fid: 10436564, name: "最终幻想单机系列" },
    { fid: 40187506, name: "服事职业讨论" },
    { fid: 44618580, name: "期货交易" },
    { fid: 751, name: "未定事件簿" },
    { fid: 511, name: "术士" },
    { fid: 510556, name: "术士" },
    { fid: 510454, name: "术士(大地的裂变)" },
    { fid: 787, name: "术士(巫妖王之怒)" },
    { fid: 510535, name: "术士(时光服)" },
    { fid: 510517, name: "术士(熊猫人之谜)" },
    { fid: 510550, name: "术士(燃烧的远征)" },
    { fid: 676, name: "术士(经典旧世)" },
    { fid: 25865968, name: "机制分析/游戏攻略专区" },
    { fid: 37491306, name: "机战佣兵VI：境界天火" },
    { fid: -2122, name: "机车俱乐部" },
    { fid: 510442, name: "杀戮尖塔" },
    { fid: -219610, name: "杨超越" },
    { fid: 42689828, name: "杯赛合集[试行]" },
    { fid: 830, name: "极限竞速:地平线系列" },
    { fid: 429, name: "标准模式讨论" },
    { fid: 29452552, name: "树洞档案室" },
    { fid: 29751397, name: "树版问答区" },
    { fid: 591, name: "格斗游戏综合" },
    { fid: 761, name: "桌游讨论" },
    { fid: 510375, name: "桓那兰那" },
    { fid: -373173, name: "梦幻模拟战手游" },
    { fid: 510349, name: "梦幻西游" },
    { fid: 510566, name: "梦战：剑之海" },
    { fid: 42650014, name: "棒棒糖机修店(情绪宣泄区)" },
    { fid: 510487, name: "棕色尘埃2" },
    { fid: 39361920, name: "森罗密事(剧情讨论)" },
    { fid: 20285309, name: "榭洛酱の私密酒馆(水区)" },
    { fid: -84, name: "模玩之魂", sub: "模玩进阶讨论" },
    { fid: 24129100, name: "橙光游戏" },
    { fid: 510489, name: "欢迎来到三角洲行动专区", sub: "Delta Force" },
    { fid: 36963255, name: "欢迎来到梦乐园" },
    { fid: 629, name: "武侠/仙侠游戏综合讨论" },
    { fid: 397, name: "武僧" },
    { fid: 510520, name: "武僧(熊猫人之谜)" },
    { fid: 27620449, name: "武僧-隐世守望" },
    { fid: 19595894, name: "武器评分" },
    { fid: 33191904, name: "武装档案" },
    { fid: 510460, name: "歧路旅人：大陆的霸者" },
    { fid: 686, name: "死亡搁浅" },
    { fid: 510457, name: "死亡骑士(大地的裂变)" },
    { fid: 510362, name: "死亡骑士(巫妖王之怒)" },
    { fid: 510537, name: "死亡骑士(时光服)" },
    { fid: 510519, name: "死亡骑士(熊猫人之谜)" },
    { fid: -12509501, name: "死斗竞技场" },
    { fid: 547, name: "死灵法师" },
    { fid: 510403, name: "死灵法师" },
    { fid: 32042989, name: "死灵法师-生死守恒" },
    { fid: 41717381, name: "每周低保咨询合集" },
    { fid: 17207947, name: "比拉谢尔" },
    { fid: 796, name: "永劫无间" },
    { fid: 27274062, name: "永劫无间 拼车/组队/互助活动合集 (非官方组队开黑QQ群：925256371)" },
    { fid: 29476236, name: "永劫无间世界冠军赛" },
    { fid: 39735775, name: "永劫无间手游" },
    { fid: 45333400, name: "永恒之塔2" },
    { fid: 20507790, name: "永恒之柱系列" },
    { fid: 510501, name: "永恒轮回" },
    { fid: 510346, name: "永歌森林" },
    { fid: 8799483, name: "求职与招募" },
    { fid: 31288033, name: "汉化发布" },
    { fid: 732, name: "江南百景图" },
    { fid: -343809, name: "汽车俱乐部" },
    { fid: 15437981, name: "河洛群侠传" },
    { fid: 505, name: "法师" },
    { fid: 510449, name: "法师(大地的裂变)" },
    { fid: 790, name: "法师(巫妖王之怒)" },
    { fid: 510529, name: "法师(时光服)" },
    { fid: 510511, name: "法师(熊猫人之谜)" },
    { fid: 510544, name: "法师(燃烧的远征)" },
    { fid: 670, name: "法师(经典旧世)" },
    { fid: 27620771, name: "法师-奥术风暴" },
    { fid: 10606409, name: "法师区木桩合集(新发在版面的木桩帖有极大几率触发禁言debuff)" },
    { fid: 510558, name: "洛克王国：世界" },
    { fid: 47494660, name: "洛奇Mobile" },
    { fid: -46468, name: "洛拉斯的战争世界" },
    { fid: 41378066, name: "活动分享" },
    { fid: 34772837, name: "活动招募" },
    { fid: 545, name: "活动队友招募" },
    { fid: 25869762, name: "流云客栈" },
    { fid: 510396, name: "流光忆庭" },
    { fid: -5080470, name: "流放之路" },
    { fid: 510481, name: "流放之路2" },
    { fid: 46786163, name: "流放之路公益/互助区" },
    { fid: 34749606, name: "测评专区" },
    { fid: 822, name: "测试阶段游戏讨论区" },
    { fid: 824, name: "海外游戏讨论区" },
    { fid: 510494, name: "海马云电脑" },
    { fid: 39383996, name: "涂装讨论" },
    { fid: 436, name: "消费电子 IT新闻" },
    { fid: 510490, name: "消费踩坑避雷" },
    { fid: 17263522, name: "温暖小火" },
    { fid: 745, name: "港区问询处" },
    { fid: 473, name: "游 戏 产 业" },
    { fid: 510404, name: "游侠" },
    { fid: 40187541, name: "游侠职业讨论" },
    { fid: 541, name: "游戏专版/合集" },
    { fid: 565, name: "游戏专版索引" },
    { fid: 510505, name: "游戏业界新闻" },
    { fid: 730, name: "游戏主播与UP主杂谈" },
    { fid: 12002550, name: "游戏促销信息" },
    { fid: 15751646, name: "游戏建议与杂谈专区" },
    { fid: 15845051, name: "游戏建议相关合集" },
    { fid: 15360532, name: "游戏心得交流合集" },
    { fid: -2081117, name: "游戏王" },
    { fid: 765, name: "游戏王:决斗链接" },
    { fid: 840, name: "游戏王：大师决斗", sub: "Yu-Gi-Oh! Master Duel" },
    { fid: 597, name: "游戏索引" },
    { fid: 414, name: "游戏综合讨论" },
    { fid: 573, name: "游戏评分合集" },
    { fid: 32101124, name: "游戏评测/评分区" },
    { fid: 524, name: "漩涡书院" },
    { fid: 42663692, name: "漫威争锋" },
    { fid: 510488, name: "漫威终极逆转" },
    { fid: 42593240, name: "潜行者2：切尔诺贝利之心" },
    { fid: -235147, name: "激战2" },
    { fid: 416, name: "火炬之光2" },
    { fid: 556, name: "火焰之纹章Heroes" },
    { fid: 510469, name: "灵巫" },
    { fid: 814, name: "灵魂潮汐" },
    { fid: 422, name: "炉石传说", sub: "炉石传说版" },
    { fid: 502, name: "炉石传说问答/水区" },
    { fid: 17263542, name: "炫彩穹顶" },
    { fid: -38122457, name: "炼金工房系列" },
    { fid: 41474824, name: "热血喧闹大感谢祭！" },
    { fid: 510493, name: "热门事件/车型讨论" },
    { fid: -42872216, name: "無良模玩测评组" },
    { fid: 770, name: "燃烧的远征" },
    { fid: 776, name: "燃烧的远征插件讨论区" },
    { fid: 510527, name: "燕云十六声" },
    { fid: 859, name: "爱与家庭" },
    { fid: 18067119, name: "爱蕾塔新闻台" },
    { fid: 29182315, name: "版内活动" },
    { fid: 391, name: "版衫设计活动" },
    { fid: 635, name: "版面镜像" },
    { fid: 506, name: "牧师" },
    { fid: 510450, name: "牧师(大地的裂变)" },
    { fid: 785, name: "牧师(巫妖王之怒)" },
    { fid: 510530, name: "牧师(时光服)" },
    { fid: 510512, name: "牧师(熊猫人之谜)" },
    { fid: 510545, name: "牧师(燃烧的远征)" },
    { fid: 671, name: "牧师(经典旧世)" },
    { fid: 510480, name: "物华弥新" },
    { fid: 819, name: "物品交易区" },
    { fid: 780, name: "特雷森学园活动室", sub: "同人创作/周边讨论" },
    { fid: 621, name: "狂野模式讨论" },
    { fid: 37015468, name: "狂骑士-猩红长枪" },
    { fid: 35925536, name: "独立游戏" },
    { fid: 16588625, name: "狮子拱门广场(闲聊吐槽)" },
    { fid: -4567100, name: "狼人杀" },
    { fid: 509, name: "猎人" },
    { fid: 510453, name: "猎人(大地的裂变)" },
    { fid: 789, name: "猎人(巫妖王之怒)" },
    { fid: 510533, name: "猎人(时光服)" },
    { fid: 510515, name: "猎人(熊猫人之谜)" },
    { fid: 510548, name: "猎人(燃烧的远征)" },
    { fid: 674, name: "猎人(经典旧世)" },
    { fid: 187, name: "猎手大厅 - Hunters Hall" },
    { fid: 396, name: "猎魔人" },
    { fid: 27620744, name: "猎魔人-百发百中" },
    { fid: 37768728, name: "猛兽派对" },
    { fid: 510357, name: "猫之城" },
    { fid: 26640400, name: "玉扉尘歌" },
    { fid: 665, name: "王者万象棋" },
    { fid: 510358, name: "玛娜希斯回响" },
    { fid: 46693938, name: "玩法攻略" },
    { fid: 28411963, name: "瑟塔布罗广场" },
    { fid: 29029276, name: "瓦尔奇诺武斗会(武斗会相关请点这里查看)" },
    { fid: -1534666, name: "瓦斯琪尓水族馆" },
    { fid: 638, name: "生化危机系列" },
    { fid: -81981, name: "生命之杯" },
    { fid: 704, name: "生活万象" },
    { fid: 510352, name: "画外旅照" },
    { fid: 42637945, name: "界外狂潮" },
    { fid: 35459017, name: "疑难杂症" },
    { fid: 17263483, name: "白塔档案" },
    { fid: 510432, name: "白荆回廊" },
    { fid: 38967398, name: "白荆穹顶(攻略内容)" },
    { fid: 480, name: "百万亚瑟王" },
    { fid: 27641628, name: "百炼洞(赛事/直播)" },
    { fid: 46003763, name: "百鬼棋局合集" },
    { fid: 746, name: "皇家茶会" },
    { fid: 14639105, name: "皮肤评分合集" },
    { fid: 21230387, name: "皮肤评分合集" },
    { fid: 512, name: "盗贼" },
    { fid: 510455, name: "盗贼(大地的裂变)" },
    { fid: 510551, name: "盗贼(燃烧的远征)" },
    { fid: 677, name: "盗贼(经典旧世)" },
    { fid: 510361, name: "直播/主播讨论" },
    { fid: 43098103, name: "真·三国无双 起源" },
    { fid: 28433346, name: "破釜酒吧 [风纪/杂谈]" },
    { fid: 560, name: "碧蓝幻想" },
    { fid: 775, name: "碧蓝版共斗/副本/好友招募合集" },
    { fid: 564, name: "碧蓝航线" },
    { fid: 18337690, name: "碧蓝航线Crosswave" },
    { fid: 20057474, name: "社团招募" },
    { fid: 454, name: "神之浩劫" },
    { fid: 20507771, name: "神界原罪系列" },
    { fid: 519, name: "神秘海域" },
    { fid: 738, name: "福袋提问&特殊需求好友募集/阵容分享合集" },
    { fid: 46369094, name: "私人广场活动合集" },
    { fid: 30188580, name: "种子分享" },
    { fid: 46342364, name: "种子分享" },
    { fid: 37551614, name: "种马/ssr卡分享区" },
    { fid: 510345, name: "科幻星球" },
    { fid: 45016859, name: "空洞骑士：丝之歌" },
    { fid: 510492, name: "竞技场模式" },
    { fid: 27641558, name: "竹林涧(前瞻信息)" },
    { fid: 642, name: "第七史诗" },
    { fid: 607, name: "第五人格" },
    { fid: 21542292, name: "第五人格藏宝阁" },
    { fid: 485, name: "篮球" },
    { fid: 574, name: "精华区" },
    { fid: 13765271, name: "精华攻略" },
    { fid: -452227, name: "精灵宝可梦系列游戏讨论区" },
    { fid: 310, name: "精英议会", sub: "前瞻高阶讨论" },
    { fid: 36416045, name: "索拉斯塔：法师之冠讨论合集" },
    { fid: 856, name: "繁中服讨论区", sub: "Umamusume Project" },
    { fid: 46536869, name: "红色沙漠" },
    { fid: -131429, name: "红茶馆——小说馆" },
    { fid: 33422705, name: "组队开黑" },
    { fid: 190, name: "组队招募" },
    { fid: 510398, name: "组队招募" },
    { fid: 39934517, name: "组队招募" },
    { fid: 16979579, name: "组队招募合集" },
    { fid: 20507779, name: "经典CRPG合集" },
    { fid: 624, name: "经典旧世 (怀旧服讨论)", sub: "魔兽世界怀旧服讨论" },
    { fid: 744, name: "经典旧世-副本讨论" },
    { fid: 737, name: "经典旧世-问答区" },
    { fid: 18106697, name: "经典旧世剧情讨论合集" },
    { fid: 19750200, name: "经典旧世求职区" },
    { fid: 853, name: "绝区零" },
    { fid: 568, name: "绝地求生" },
    { fid: 39802263, name: "绝地潜兵2" },
    { fid: 742, name: "综合答疑求助" },
    { fid: 749, name: "综合问答合集" },
    { fid: -7, name: "网事杂谈" },
    { fid: 440, name: "网站功能" },
    { fid: 275, name: "网站开发A" },
    { fid: 553, name: "网站开发B" },
    { fid: 300, name: "网络游戏综合" },
    { fid: 735, name: "罗德岛问答室" },
    { fid: 18140445, name: "羊皮卷馆藏目录" },
    { fid: 510392, name: "美丽狐仙在线聊天" },
    { fid: 825, name: "美妆种草" },
    { fid: 29852647, name: "美食探店/攻略" },
    { fid: 186, name: "翡翠梦境 - The Emerald Dream" },
    { fid: 845, name: "老贴存档" },
    { fid: -1459709, name: "职场人生" },
    { fid: 479, name: "联盟赛事" },
    { fid: 40279387, name: "育成思路/机制分析" },
    { fid: 30917193, name: "背景 故事 剧情讨论" },
    { fid: 393, name: "背景故事与文艺作品" },
    { fid: -444012, name: "自行车：我们的骑迹" },
    { fid: 510509, name: "至暗之夜" },
    { fid: 12835193, name: "舰团合集-02" },
    { fid: 831, name: "艾尔登法环", sub: "Elden Ring" },
    { fid: -362960, name: "艾欧泽亚", sub: "幻想，此刻成真" },
    { fid: 7, name: "艾泽拉斯议事厅 - Hall of Azeroth" },
    { fid: 230, name: "艾泽拉斯风纪委员会" },
    { fid: 34228027, name: "艾泽拉斯风纪委员会 怀旧服合集" },
    { fid: -7678526, name: "艾泽拉斯麻将科学院", sub: "majsoul" },
    { fid: 46572631, name: "苍之追想——碧蓝幻想纪念合集 试运行" },
    { fid: 510438, name: "苍翼：混沌效应" },
    { fid: -152678, name: "英雄联盟 Let′s Gank" },
    { fid: 681, name: "英雄联盟手游" },
    { fid: 27586399, name: "英雄联盟电竞经理" },
    { fid: 680, name: "英雄联盟策略卡牌" },
    { fid: 726, name: "荒野乱斗" },
    { fid: 628, name: "荒野大镖客2" },
    { fid: 17263510, name: "荣耀之旅" },
    { fid: 124, name: "莫高雷壁画洞穴" },
    { fid: 11147428, name: "萌宠求主/征婚交友" },
    { fid: 35488462, name: "萌战临时合集" },
    { fid: -353371, name: "萌萌宠物" },
    { fid: 507, name: "萨满" },
    { fid: 510451, name: "萨满祭司(大地的裂变)" },
    { fid: 792, name: "萨满祭司(巫妖王之怒)" },
    { fid: 510531, name: "萨满祭司(时光服)" },
    { fid: 510513, name: "萨满祭司(熊猫人之谜)" },
    { fid: 510546, name: "萨满祭司(燃烧的远征)" },
    { fid: 672, name: "萨满祭司(经典旧世)" },
    { fid: 32323696, name: "蒸汽鸟报" },
    { fid: 29392968, name: "蓝图/调校 分享专区" },
    { fid: 30188821, name: "蓝图分享" },
    { fid: 510406, name: "蓝色协议" },
    { fid: 39640915, name: "蓝色星原：旅谣" },
    { fid: 47558375, name: "蓝贴&内容更新专区" },
    { fid: 38410751, name: "蕾斯莱莉娅娜的炼金工房" },
    { fid: 31858702, name: "血染钟楼" },
    { fid: 513, name: "血源/黑暗之魂" },
    { fid: 16860830, name: "行业/职业专楼(发帖前必看)" },
    { fid: 425, name: "行星边际2" },
    { fid: 723, name: "街头篮球" },
    { fid: 43458828, name: "裂变活动互助(点击右侧对号可以取消勾选)" },
    { fid: 510399, name: "装备交易" },
    { fid: 463, name: "要塞讨论" },
    { fid: 37317382, name: "观景车厢" },
    { fid: 548, name: "视频/直播讨论" },
    { fid: 510418, name: "视频与主播讨论" },
    { fid: 264, name: "视频与音乐讨论区" },
    { fid: 418, name: "视频直播讨论" },
    { fid: 43954481, name: "角斗领域" },
    { fid: 755, name: "解神者：X2" },
    { fid: 38632827, name: "解限机Mechabreak" },
    { fid: 47558390, name: "许愿/还愿/建议类 合集" },
    { fid: 590, name: "许愿区" },
    { fid: 307, name: "论坛公告" },
    { fid: 29182350, name: "评测/安利" },
    { fid: 32889143, name: "试驾报告" },
    { fid: 855, name: "诛仙世界" },
    { fid: 651, name: "话题占用版" },
    { fid: 510415, name: "诡秘之主" },
    { fid: 23465809, name: "豹晒区，这里都是欧皇" },
    { fid: 33947917, name: "赛事信息/上位分享讨论" },
    { fid: 45602398, name: "赛事讨论" },
    { fid: 759, name: "赛博朋克2077" },
    { fid: 510343, name: "赛车俱乐部" },
    { fid: -349066, name: "赛里斯文化交流" },
    { fid: -40743354, name: "赛马娘 PrettyDerby" },
    { fid: 39986480, name: "超时空方舟" },
    { fid: 17743136, name: "超级马力欧创作家" },
    { fid: 510423, name: "超级马力欧系列" },
    { fid: 709, name: "足球经理2020" },
    { fid: 24923331, name: "跑团相关" },
    { fid: 602, name: "车评相关讨论" },
    { fid: 201, name: "软硬件系统问题" },
    { fid: 33422713, name: "软硬件配置" },
    { fid: 486, name: "辐射" },
    { fid: 605, name: "边缘世界/RimWorld" },
    { fid: 567, name: "迦勒底新人接待" },
    { fid: 606, name: "迦勒底杂谈" },
    { fid: 566, name: "迦勒底档案馆" },
    { fid: 20348331, name: "逃离塔科夫" },
    { fid: 45408392, name: "逃离鸭科夫" },
    { fid: 39637406, name: "逆向坍塌：面包房行动" },
    { fid: 442, name: "逆战" },
    { fid: 611, name: "逆水寒" },
    { fid: 510407, name: "逆水寒 手游" },
    { fid: 38960392, name: "邀请码组队" },
    { fid: 7313104, name: "部落  招募" },
    { fid: -51095, name: "部落冲突" },
    { fid: 690, name: "酒馆战棋" },
    { fid: 662, name: "重装战姬" },
    { fid: 510389, name: "重返未来：1999" },
    { fid: 395, name: "野蛮人" },
    { fid: 510401, name: "野蛮人" },
    { fid: 27620404, name: "野蛮人-亚瑞特之力" },
    { fid: 23359458, name: "野队吐槽专区" },
    { fid: 510482, name: "金庸群侠传" },
    { fid: 649, name: "金色平原" },
    { fid: 510461, name: "金铲铲之战" },
    { fid: 862, name: "钢岚Mecharashi" },
    { fid: 181, name: "铁血沙场 - Warriors Arena" },
    { fid: 510395, name: "铁道问讯处" },
    { fid: 10, name: "银色黎明裁判所 - Judicatory of Argent Dawn" },
    { fid: 254, name: "镶金玫瑰旅店" },
    { fid: 23599311, name: "长期更新帖合集" },
    { fid: 18079631, name: "闪耀暖暖" },
    { fid: 510414, name: "闪耀！优俊少女" },
    { fid: 580, name: "问答区" },
    { fid: 510430, name: "问答区" },
    { fid: 368, name: "问答区 信仰神殿" },
    { fid: 363, name: "问答区 恶魔深渊" },
    { fid: 372, name: "问答区 猎手大厅" },
    { fid: 535, name: "问答区 翡翠梦境" },
    { fid: 373, name: "问答区 铁血沙场" },
    { fid: 370, name: "问答区 风暴祭坛" },
    { fid: 365, name: "问答区 魔法圣堂" },
    { fid: 369, name: "问答区 黑锋要塞" },
    { fid: 366, name: "问答区(已关闭)" },
    { fid: 720, name: "问答咨询" },
    { fid: 33422721, name: "问题求助" },
    { fid: 525, name: "队友招募" },
    { fid: 13454875, name: "阴阳寮招募合集" },
    { fid: 538, name: "阴阳师" },
    { fid: 582, name: "阴阳师互助招募" },
    { fid: 753, name: "阴阳师妖怪屋" },
    { fid: 702, name: "阴阳师藏宝阁" },
    { fid: 471, name: "附魔咨询" },
    { fid: -38213667, name: "陶拉里亚西境学院" },
    { fid: 16543122, name: "集会所(求带|组队|禁群招募,VX)" },
    { fid: 43500376, name: "雾刃-佩尔盖恩" },
    { fid: 28434609, name: "霍格莫德邮局 [意见反馈]" },
    { fid: -1742851, name: "青玉巫婆的小屋" },
    { fid: 23033861, name: "非LPL战队" },
    { fid: 860, name: "音乐类游戏讨论" },
    { fid: -2671, name: "音频讨论及音乐共享" },
    { fid: 41059728, name: "风暴之门" },
    { fid: 185, name: "风暴祭坛 - Altar of Storm" },
    { fid: 376, name: "风暴祭坛 研究区" },
    { fid: 431, name: "风暴英雄" },
    { fid: -60374520, name: "食物语玩家收容处", sub: "讨论食物语的各项话题" },
    { fid: 21904311, name: "饰品交易/勇士令状组队/公会" },
    { fid: 17103903, name: "饰品讨论" },
    { fid: 34913622, name: "马拉德庄园(组队交流区)" },
    { fid: 32724950, name: "骁龙电竞先锋赛" },
    { fid: 32724971, name: "骁龙电竞先锋赛" },
    { fid: 778, name: "骑空团事务(求职/招募)" },
    { fid: 712, name: "骑马与砍杀2: 霸主" },
    { fid: 455, name: "鬼武者 魂" },
    { fid: 689, name: "魂器学院" },
    { fid: 497, name: "魔兽世界电影" },
    { fid: 518, name: "魔兽世界观影组队" },
    { fid: 510569, name: "魔兽世界：无限" },
    { fid: 490, name: "魔兽争霸" },
    { fid: 852, name: "魔兽大作战" },
    { fid: 453, name: "魔力宝贝" },
    { fid: 182, name: "魔法圣堂 - Arcane Sanctuary" },
    { fid: 28492870, name: "魔法宮 [同人/二创]" },
    { fid: 399, name: "魔法师" },
    { fid: -37550969, name: "魔法纪录" },
    { fid: 854, name: "鸣潮" },
    { fid: 510378, name: "鹅鸭杀" },
    { fid: 35256755, name: "黑天鹅(网红信息讨论区)" },
    { fid: 40087341, name: "黑帝斯系列" },
    { fid: 510472, name: "黑神话：悟空" },
    { fid: 18067173, name: "黑色方舟问答中心" },
    { fid: 27239592, name: "黑蚀之地" },
    { fid: 320, name: "黑锋要塞 - Ebon Hold" },
    { fid: 39619405, name: "龙之信条2" },
    { fid: 39618675, name: "龙腾世纪系列" },
    { fid: 355, name: "龟岩兄弟会" },
  ];

    // 由 .build/extract-cats.py 从 NGA 首页那份 CDN 版面目录生成
  // 结构：分类 → 分组(可空) → 版面 [fid, 名字, 简介]，顺序就是站点自己的顺序
  // 共 7 个分类 / 659 个版面
  const INDEX_CATS = [
    { name: "网事杂谈", groups: [
      { name: "", boards: [
        [-7, 0, "网事杂谈", ""],
        [-7955747, 0, "晴风村", "情感生活"],
        [-343809, 0, "寂寞的车", "车迷俱乐部"],
        [843, 0, "国际新闻", ""],
        [524, 0, "漩涡书院", "网络文学"],
        [-576177, 0, "音乐影视", ""],
        [-81981, 0, "生命之杯", "足球"],
        [-1459709, 0, "职场人生", ""],
        [485, 0, "篮球", ""],
        [-187628, 0, "家居装修", ""],
        [-608808, 0, "厨艺美食交流", ""],
        [716, 0, "模型手办", "模玩手办 动漫周边"],
        [847, 0, "历史研究", ""],
        [-522474, 0, "运动与奥运", "Sport and Olympic"],
        [-8725919, 0, "小窗视界", "摄影旅游"],
        [-39223361, 0, "娱乐吃瓜区", "综艺娱乐明星八卦"],
        [-353371, 0, "萌萌宠物", "宠物养成交流"],
        [-444012, 0, "我们的骑迹", "自行车"],
        [-7678526, 0, "麻将", "majsoul"],
        [-2671, 0, "发烧友", "音频设备"],
        [-202020, 0, "程序员职业交流", "技术算法 业界新闻 职场经验"],
        [761, 0, "桌游讨论", ""],
        [-1534666, 0, "瓦斯琪尓水族馆", "观赏鱼两栖爬行动物"],
        [124, 0, "壁画洞窟", "原创艺术"],
        [859, 0, "爱与家庭", "母婴亲子"],
        [-7, 39827852, "考研讨论", ""],
        [102, 0, "作家协会", "原创文学"],
        [767, 0, "剧本杀(谋杀之谜)", ""],
        [-4567100, 0, "狼人杀", ""],
        [-349066, 0, "吟瑟梨茗", "曲艺"],
      ] },
      { name: "IT软硬件", boards: [
        [436, 0, "消费电子 IT新闻", ""],
        [334, 0, "PC硬件配置", "装机讨论"],
        [722, 0, "手机研究所", "软硬件讨论"],
        [773, 0, "外设硬件", ""],
        [498, 0, "二手交易", "信息互助"],
        [510490, 0, "消费踩坑避雷", ""],
      ] },
      { name: "二次元综合", boards: [
        [-447601, 0, "二次元国家地理", "二次元相关话题"],
        [-60204499, 0, "Vtuber综合讨论区", ""],
        [784, 0, "二次元跑团综合", "安科 文字TRPG"],
        [-2081117, 0, "游戏王", "遊☆戯☆王相关讨论"],
        [-40530437, 0, "东方Project", "幻想乡国家地理"],
        [-40639972, 0, "VOCALOID", "歌声合成软件"],
        [510418, 0, "视频与主播讨论", ""],
        [-60252908, 0, "Galgame", "Galgame"],
        [510370, 0, "日系TCG综合", ""],
        [510416, 0, "LoveLive！系列", ""],
      ] },
    ] },
    { name: "暴雪游戏", groups: [
      { name: "", boards: [
        [459, 0, "守望先锋", "Overwatch 2"],
        [422, 0, "炉石传说", "HearthStone"],
        [318, 0, "暗黑破坏神3", "D3综合讨论区"],
        [431, 0, "风暴英雄", "Heroes of the Storm"],
        [406, 0, "星际争霸2", "Starcraft Ⅱ"],
        [490, 0, "魔兽争霸", "WarCraft"],
        [685, 0, "暗黑破坏神4", ""],
        [769, 0, "暗黑破坏神2 重制版", ""],
        [631, 0, "暗黑破坏神:不朽", ""],
        [852, 0, "魔兽大作战", ""],
        [632, 0, "暴雪嘉年华", ""],
      ] },
    ] },
    { name: "魔兽世界", groups: [
      { name: "", boards: [
        [7, 0, "艾泽拉斯议事厅", "魔兽主讨论区"],
        [230, 0, "艾泽拉斯风纪委员会", "曝光违背公认准则的行为"],
        [310, 0, "前瞻资讯", "新版本与高阶讨论"],
        [510569, 0, "魔兽世界：无限", ""],
        [510502, 0, "熊猫人之谜", "怀旧服讨论"],
        [510521, 0, "泰坦重铸(时光)", "怀旧服讨论"],
        [624, 0, "经典旧世", "怀旧服讨论"],
        [770, 0, "燃烧的远征", "怀旧服讨论"],
        [323, 0, "国服以外", "国服以外综合讨论"],
      ] },
      { name: "职业讨论区", boards: [
        [390, 0, "五晨寺", "武僧"],
        [320, 0, "黑锋要塞", "死亡骑士"],
        [181, 0, "铁血沙场", "战士"],
        [182, 0, "魔法圣堂", "法师"],
        [183, 0, "信仰神殿", "牧师"],
        [185, 0, "风暴祭坛", "萨满"],
        [186, 0, "翡翠梦境", "德鲁伊"],
        [187, 0, "猎手大厅", "猎人"],
        [184, 0, "圣光之力", "圣骑士"],
        [188, 0, "恶魔深渊", "术士"],
        [189, 0, "暗影裂口", "盗贼"],
        [477, 0, "伊利达雷", "恶魔猎手"],
        [851, 0, "巨龙群岛", "唤魔师"],
      ] },
      { name: "冒险心得", boards: [
        [463, 0, "要塞讨论", "6.x要塞"],
        [327, 0, "任务/成就", ""],
        [218, 0, "副本专区", "攻略干货！"],
        [388, 0, "幻化讨论", ""],
        [411, 0, "宠物讨论", "魔兽宠物"],
        [191, 0, "地精商会", "游戏内商业"],
        [272, 0, "竞技场/战场", "刀锋山PVP"],
        [213, 0, "战争档案", "魔兽世界战报"],
        [255, 0, "公会管理", "管理经验交流"],
        [306, 0, "人员招募", "魔兽招募求职"],
        [200, 0, "插件研究", ""],
        [240, 0, "魔兽世界大脚", "官方合作辅助工具"],
      ] },
      { name: "历史背景 资料整理", boards: [
        [254, 0, "镶金玫瑰", "剧情讨论 历史研究"],
        [264, 0, "卡拉赞剧院", "影音制作讨论"],
      ] },
    ] },
    { name: "拳头游戏", groups: [
      { name: "", boards: [
        [-152678, 0, "英雄联盟", "League Of Legends"],
        [708, 0, "无畏契约", "Valorant"],
        [660, 0, "LOL云顶之弈", "Teamfight Tactics"],
        [681, 0, "英雄联盟手游", ""],
        [680, 0, "英雄联盟策略卡牌", "Legends of Runeterra"],
      ] },
    ] },
    { name: "Valve Games", groups: [
      { name: "", boards: [
        [482, 0, "CS:GO", "Counter-Strike: Global Offensive"],
        [321, 0, "DOTA2", "Defense of the Ancients"],
        [622, 0, "刀塔卡牌", "Artifact"],
        [659, 0, "刀塔霸业", "Dota Underlords"],
        [510478, 0, "Deadlock", ""],
      ] },
    ] },
    { name: "游戏专版", groups: [
      { name: "", boards: [
        [414, 0, "游戏综合讨论区", ""],
        [510505, 0, "游戏业界新闻", ""],
        [614, 0, "PS游戏综合讨论", ""],
        [615, 0, "XBOX游戏综合讨论", ""],
        [616, 0, "Nintendo游戏综合讨论", "百年老店任天堂"],
        [510431, 0, "ROG掌机", "尽掌控 超会玩"],
        [-21175563, 0, "传统RPG综合讨论", "类跑团游戏讨论"],
        [414, 35925536, "独立游戏", ""],
        [489, 0, "怪物猎人", ""],
        [414, 46265028, "喵喵的结合", ""],
        [414, 46019748, "大巴扎The Bazaar", ""],
        [510494, 0, "海马云电脑", "特效全开玩3A"],
        [510482, 0, "金庸群侠传", ""],
        [629, 0, "武侠/仙侠游戏综合", ""],
        [510383, 0, "Steam Deck", ""],
        [510481, 0, "流放之路 系列", "Path of Exile 2"],
        [591, 0, "格斗游戏综合", ""],
        [-452227, 0, "精灵宝可梦", "Pokemon"],
        [831, 0, "艾尔登法环", "Elden Ring"],
        [414, 17963192, "火焰之纹章系列", "Fire Emblem"],
        [510397, 0, "塞尔达传说", ""],
        [630, 0, "全面战争系列", "Total War"],
        [510472, 0, "黑神话: 悟空", "BLACK MYTH WUKONG"],
        [510368, 0, "火炬之光:无限", "Torchlight:Infinite"],
        [414, 18343564, "Pokemon Masters", ""],
        [510417, 0, "博德之门系列", "Baldur`s Gate"],
        [595, 0, "异度神剑", "Xenoblade"],
        [-38122457, 0, "炼金工房系列", "卡莉亚的炼金工房"],
        [558, 0, "仁王系列", "NIOH 1/2"],
        [332, 0, "战锤40K", "Warhammer"],
        [661, 0, "Paradox游戏综合讨论", "十字军之王 欧陆风云 皇帝:罗马 群星 维多利亚 BattleTech"],
        [414, 27335147, "怪猎物语系列", "Monster Hunter stories"],
        [510435, 0, "碧蓝幻想Relink", "Granblue Fantasy: Relink"],
        [510434, 0, "幻兽帕鲁", ""],
        [759, 0, "赛博朋克2077", "Cyberpunk 2077"],
        [626, 0, "太吾绘卷", "The Scroll Of Taiwu"],
        [414, 10436564, "最终幻想系列", ""],
        [839, 0, "戴森球计划", "Dyson Sphere Program"],
        [510442, 0, "杀戮尖塔", "Slay the spire"],
        [830, 0, "极限竞速:地平线 系列", "Forza Horizon"],
        [724, 0, "斯普拉遁", "Splatoon"],
        [636, 0, "使命召唤系列", "Call of Duty"],
        [679, 0, "无主之地系列", "BORDERLANDS"],
        [414, 34375277, "Falcom系列", ""],
        [414, 20507739, "开拓者系列", ""],
        [-5951001, 0, "文明", "策略游戏综合讨论"],
        [414, 13899987, "战神系列", "God of War"],
        [414, 11291877, "女神异闻录", "Persona"],
        [604, 0, "星露谷", "Stardew Valley"],
        [552, 0, "Battlefield系列", "Battlefield"],
        [455, 0, "鬼武者 魂", "oni-soul"],
        [709, 0, "足球经理2020", "Football Manager 2020"],
        [628, 0, "荒野大镖客2", "Red Dead Redemption 2"],
        [414, 13043110, "Grаnd Thеft Autо V", ""],
        [523, 0, "全境封锁", "Tom Clancy’s The Division"],
        [513, 0, "血源/黑暗之魂", "DARK SOULS"],
        [796, 0, "永劫无间", ""],
        [600, 0, "彩虹六号:围攻", "Rainbow Six:Siege"],
        [414, 22407158, "宝可梦大集结", "Pokemon Unite"],
        [510423, 0, "超级马力欧奥德赛", ""],
        [705, 0, "任天堂明星大乱斗", "Super Smash Bros"],
        [638, 0, "生化危机系列", "RESIDENT EVIL2"],
        [627, 0, "刺客信条", "Assassin"],
        [486, 0, "辐射", "Fallout"],
        [634, 0, "古剑奇谭", "单机版"],
        [510388, 0, "饥荒", "Don't Starve"],
        [644, 0, "只狼 影逝二度", "Sekiro"],
        [414, 39509883, "圣兽之王", "Unicorn Overlord"],
        [414, 35303274, "霍格沃茨之遗", "Hogwarts Legacy"],
        [414, 29147527, "帝国时代系列", ""],
        [414, 20507771, "神界原罪系列", "Divinity: Original Sin"],
        [414, 25327031, "鬼谷八荒", "Tale of Immortal"],
        [710, 0, "动物森友会", ""],
        [414, 25565083, "英灵神殿", "Valheim"],
        [514, 0, "巫师3", "The Witcher"],
        [510440, 0, "人魅", ""],
        [510439, 0, "三国志汉末霸业", ""],
        [510438, 0, "苍翼：混沌效应", "Blazblue: Entropy Effect"],
        [841, 0, "地平线 西之绝境", "Horizon Forbidden West"],
        [643, 0, "鬼泣5", "Devil May Cry"],
        [639, 0, "圣歌", "Anthem"],
        [605, 0, "边缘世界", "RimWorld"],
        [561, 0, "尼尔系列", "NieR"],
        [519, 0, "神秘海域", "Uncharted"],
        [495, 0, "光荣策略游戏", ""],
        [414, 39485540, "逆向坍塌:面包房行动", ""],
        [414, 39410495, "最后纪元", "Last Epoch"],
        [416, 0, "火炬之光2", "Torchlight"],
        [-4760591, 0, "侠客风云传", ""],
        [414, 36344518, "龙与地下城OL", ""],
        [414, 35809125, "如龙系列", ""],
        [414, 35449267, "原子之心", "Atomic Heart"],
        [414, 34337255, "弈仙牌合集", ""],
        [414, 30549226, "消逝的光芒2: 人与仁之战", "Dying Light 2 Stay Human"],
        [414, 29684154, "光环系列", "Halo"],
        [414, 29657842, "战意", "Conqueror`s Blade"],
        [414, 28937182, "仙剑奇侠传系列", "Chinese Paladin: Sword and Fairy"],
        [414, 28842347, "孤岛惊魂系列", "Far Cry"],
        [414, 28436135, "破晓传说", "Tales of Arise"],
        [414, 26859153, "植物大战僵尸", "Plants vs Zombies"],
        [414, 26149723, "先驱者", "Outriders"],
        [414, 26144509, "双人成行", "It Takes Two"],
        [414, 24454152, "渡神纪: 芬尼斯崛起", "Immortals: Fenyx Rising"],
        [414, 24227796, "使命召唤: 冷战", "Call of Duty: Black Ops Cold War"],
        [414, 23904706, "轩辕剑柒", "XuanYuan Sword 7"],
        [414, 23904632, "看门狗: 军团", "Watch Dogs: Legion"],
        [414, 22833687, "糖豆人: 终极淘汰赛", "Fall Guys: Ultimate Knockout"],
        [414, 22743480, "动物森友会 口袋露营广场", ""],
        [414, 22450886, "对马岛之魂", "Ghost of Tsushima"],
        [414, 22176633, "盗贼之海", "Sea of Thieves"],
        [414, 22090017, "最后生还者 第二部", "The Last of Us"],
        [510421, 0, "星空", "Starfield"],
        [414, 21051903, "十三机兵防卫圈", ""],
        [414, 20507790, "永恒之柱系列", "Pillars of Eternity"],
        [414, 20440715, "破坏领主", "Wolcen:Lords of Mayhem"],
        [414, 18855745, "东方大战争", ""],
        [414, 18352958, "异界锁链", "Astral Chain"],
        [414, 18061643, "碧蓝幻想 Versus", "Granblue Fantasy Versus"],
        [414, 17743136, "超级马力欧创作家", ""],
        [414, 17648142, "血污：夜之仪式", "Bloodstained: Ritual of the Night"],
        [414, 16534739, "隐形守护者", "The Invisible Guardian"],
        [414, 16265018, "生化危机系列", "Resident Evil"],
        [414, 16228100, "圣歌", "Anthem"],
        [414, 15437981, "河洛群侠传", ""],
        [414, 13699614, "战锤:末世鼠疫", ""],
        [510385, 0, "卧龙: 苍天陨落", "Wo Long: Fallen Dynasty"],
        [414, 10050613, "战争机器", "Gears of war 4"],
        [414, 8977716, "XCOM系列", ""],
        [414, 8961703, "古墓丽影", ""],
        [414, 8918060, "家园:卡拉克沙漠", "Homeworld:Deserts of Kharak"],
      ] },
      { name: "", boards: [
        [300, 0, "网络游戏综合", ""],
        [855, 0, "诛仙世界", ""],
        [-362960, 0, "最终幻想14", "幻想，此刻成真"],
        [842, 0, "命运方舟", "Lost ARK"],
        [-7861121, 0, "剑网3", "J3客户端版"],
        [840, 0, "游戏王：大师决斗", "Yu-Gi-Oh! Master Duel"],
        [510489, 0, "三角洲行动", "Delta Force"],
        [510508, 0, "无烬战争", ""],
        [510501, 0, "永恒轮回", ""],
        [300, 42663692, "漫威争锋", ""],
        [510527, 0, "燕云十六声", ""],
        [-46468, 0, "坦克世界", "World of Tanks"],
        [441, 0, "战舰世界", "WoWS"],
        [707, 0, "冒险岛", "MapleStory"],
        [510500, 0, "影之诗", "Shadowverse"],
        [510349, 0, "梦幻西游", ""],
        [603, 0, "星际战甲", "Warframe"],
        [844, 0, "反恐行动", "MAT"],
        [-47218, 0, "地下城与勇士", "DNF玩家聚集地"],
        [640, 0, "Apex英雄", "Apex Legends"],
        [-6194253, 0, "战争雷霆", "War Thunder"],
        [568, 0, "绝地求生", "PUBG"],
        [443, 0, "EAFC系列", "EAFC \\ FIFA"],
        [-235147, 0, "激战2:巨龙绝境", "Guild Wars 2"],
        [510412, 0, "卡拉彼丘", ""],
        [-2371813, 0, "星战前夜", "EVE"],
        [481, 0, "Minecraft", "Minecraft"],
        [300, 20348331, "逃离塔科夫", "Escape from Tarkov"],
        [-38213667, 0, "万智牌", "MTG"],
        [510503, 0, "星痕共鸣", ""],
        [611, 0, "逆水寒", ""],
        [563, 0, "命运", "Destiny"],
        [425, 0, "行星边际2", "Planetside"],
        [764, 0, "星际公民", ""],
        [618, 0, "古剑奇谭网络版", "网络版"],
        [723, 0, "街头篮球", ""],
        [641, 0, "多多自走棋", "AUTOCHESS"],
        [633, 0, "无限法则", "Ring of Elysium"],
        [609, 0, "堡垒之夜", "Fortnite"],
        [515, 0, "冒险岛2", "MapleStory2"],
        [454, 0, "神之浩劫", "SMITE"],
        [452, 0, "天涯明月刀", "Moonlight Blade"],
        [300, 38799202, "THE FINALS", ""],
        [442, 0, "逆战", ""],
        [435, 0, "上古卷轴Online", "ESO"],
        [-15219445, 0, "巫师之昆特牌", "少年不来把昆特牌吗？"],
        [432, 0, "战机世界", ""],
        [427, 0, "怪物猎人Online", ""],
        [510406, 0, "蓝色协议", "Blue Protocol"],
        [300, 38632827, "解限机Mechabreak", ""],
        [300, 34777022, "Paragon: The Overprime", ""],
        [300, 31190666, "黑色沙漠", "Black Desert"],
        [300, 30179445, "十三月", "Undecember"],
        [300, 28966105, "帝国神话", ""],
        [300, 28718283, "新世界", "New World"],
        [300, 28106137, "神佑释放", "Bless Unleashed"],
        [300, 17798179, "跑跑卡丁车", ""],
        [300, 11597730, "H1Z1:King of the Kill", ""],
        [353, 0, "纽沃斯英雄传", "Heroes of Newearth"],
        [300, 9079209, "恐怖黎明", "Grim Dawn"],
      ] },
      { name: "", boards: [
        [863, 0, "手机游戏快讯", ""],
        [571, 0, "手游评分版", ""],
        [823, 0, "上线游戏讨论区", ""],
        [822, 0, "测试阶段游戏讨论区", ""],
        [824, 0, "海外游戏讨论区", ""],
        [428, 29182350, "评测/安利", ""],
        [428, 29182315, "版内活动", ""],
        [428, 0, "手游综合讨论", "手游/页游综合讨论"],
        [428, 47494660, "洛奇Mobile", ""],
        [428, 39640915, "蓝色星原: 旅谣", ""],
        [782, 0, "买断制手游", ""],
        [750, 0, "女性向游戏讨论", ""],
        [-61285727, 0, "手游瓜事件", "圈内八卦"],
        [860, 0, "音乐类游戏", ""],
        [-34587507, 0, "明日方舟", "Arknights"],
        [650, 0, "原神", "Genshin"],
        [818, 0, "崩坏:星穹铁道", ""],
        [846, 0, "明日方舟终末地", ""],
        [510566, 0, "梦战：剑之海", ""],
        [538, 0, "阴阳师", "Onmyoji"],
        [540, 0, "Fate", "Grand Order"],
        [854, 0, "鸣潮", ""],
        [853, 0, "绝区零", ""],
        [510559, 0, "异环", ""],
        [516, 0, "王者荣耀", ""],
        [510558, 0, "洛克王国:世界", ""],
        [560, 0, "碧蓝幻想", "Granblue Fantasy"],
        [564, 0, "碧蓝航线", "Azur Lane"],
        [-40743354, 0, "赛马娘 Pretty Derby", "Umamusume Project"],
        [510414, 0, "闪耀！优俊少女", "简中服讨论区"],
        [-7202235, 0, "舰队collection", "舰C"],
        [664, 0, "BanG Dream!", "邦邦"],
        [510371, 0, "NIKKE:胜利女神", ""],
        [510389, 0, "重返未来: 1999", ""],
        [-195362, 0, "少女前线2：追放", ""],
        [-373173, 0, "梦幻模拟战", "Langrisser"],
        [696, 0, "战双帕弥什", "Gray Raven"],
        [834, 0, "蔚蓝档案", "Blue Archive"],
        [510560, 0, "卡厄思梦境", ""],
        [510487, 0, "棕色尘埃2", "BrownDust2"],
        [-149110, 0, "战舰少女", "Warship Girls R"],
        [642, 0, "第七史诗", "EPIC7"],
        [-10308342, 0, "公主连结Re:Dive", "幻想番剧手游"],
        [-547859, 0, "少女前线-16LAB研究院", "16LAB研究院"],
        [510523, 0, "二重螺旋", ""],
        [771, 0, "天地劫手游", ""],
        [510497, 0, "SD高达 G世代 永恒", ""],
        [510484, 0, "边狱巴士公司", "Limbus Company"],
        [862, 0, "钢岚", "Mecharashi"],
        [510522, 0, "星塔旅人", ""],
        [510354, 0, "无期迷途", "Path to Nowhere"],
        [428, 12882700, "偶像大师", ""],
        [549, 0, "崩坏3", "Honkai Impact 3"],
        [510381, 0, "HEAVEN BURNS RED", ""],
        [510443, 0, "尘白禁区", ""],
        [556, 0, "火焰之纹章Heroes", "Fire Emblem Heroes"],
        [428, 34032251, "赛尔号SEER", ""],
        [510445, 0, "学园偶像大师", ""],
        [510373, 0, "无限暖暖", ""],
        [510407, 0, "逆水寒 手游", ""],
        [428, 40681784, "异象回声", ""],
        [428, 23588623, "初音未来：缤纷舞台", "Project Sekai"],
        [428, 35591152, "ARCAEA合集", ""],
        [861, 0, "代号无限大", ""],
        [765, 0, "游戏王:决斗链接", ""],
        [593, 0, "决战！平安京", "阴阳师MOBA"],
        [693, 0, "弹射世界", "World Flipper"],
        [757, 0, "时空中的绘旅人", ""],
        [607, 0, "第五人格", "IDENTITY V"],
        [510471, 0, "女神异闻录: 夜幕魅影", ""],
        [510485, 0, "宝可梦TCG Pocket", ""],
        [812, 0, "哈利波特：魔法觉醒", ""],
        [-51095, 0, "部落冲突", "Clash of Clans"],
        [428, 20391982, "Counterside", ""],
        [695, 0, "阴阳师百闻牌", ""],
        [555, 0, "仙境传说", "RO手游版"],
        [-41232751, 0, "四叶草剧场", "Clover Theater"],
        [428, 38520225, "忘却前夜", ""],
        [428, 19317848, "火影忍者-疾风传", ""],
        [510460, 0, "八方旅人: 大陆的霸者", ""],
        [779, 0, "坎特伯雷公主与骑士", "Guardian Tales"],
        [492, 0, "部落冲突:皇室战争", "Clash Royale"],
        [428, 26418963, "航海王热血航线", ""],
        [510468, 0, "地下城与勇士M", ""],
        [510486, 0, "新月同行", ""],
        [510480, 0, "物华弥新", ""],
        [510374, 0, "七圣召唤", ""],
        [428, 10990054, "刀剑乱舞", ""],
        [599, 0, "和平精英", "PUBG"],
        [428, 16265595, "爱丽丝机甲", ""],
        [557, 0, "King's Raid", "King's Raid"],
        [428, 39735775, "永劫无间手游", ""],
        [575, 0, "怪物弹珠", ""],
        [-60157311, 0, "少女前线：云图计划", ""],
        [428, 41131245, "拂晓：胜利之刻", ""],
        [428, 35809083, "银河境界线", ""],
        [428, 13401426, "楚留香", ""],
        [428, 13309303, "旅行青蛙", ""],
        [510424, 0, "铃兰之剑：为这和平的世界", ""],
        [-41374941, 0, "悠久之树", ""],
        [623, 0, "失落的龙约", "Dragalia Lost"],
        [428, 22088087, "三国志战略版", ""],
        [848, 0, "深空之眼", "AETHER GAZER"],
        [428, 22944341, "星战前夜：无烬星河", ""],
        [494, 0, "魔龙之魂", "ChromaticSouls"],
        [428, 35935748, "苍雾残响", ""],
        [480, 0, "百万亚瑟王", ""],
        [510504, 0, "伊瑟", ""],
        [510488, 0, "漫威终极逆转", "MARVEL SNAP"],
        [510462, 0, "塔瑞斯世界", ""],
        [428, 39030511, "恋与深空", ""],
        [510432, 0, "白荆回廊", ""],
        [760, 0, "幻书启世录", ""],
        [428, 38854824, "雷索纳斯", ""],
        [510382, 0, "开罗游戏", ""],
        [755, 0, "解神者:X2", ""],
        [753, 0, "阴阳师妖怪屋", ""],
        [751, 0, "未定事件簿", ""],
        [732, 0, "江南百景图", ""],
        [726, 0, "荒野乱斗", "Brawl Stars"],
        [717, 0, "山海镜花", ""],
        [714, 0, "命运神界:梦境链接", ""],
        [711, 0, "为美好的世界献上祝福！", ""],
        [701, 0, "剑与远征", "AFK ARENA"],
        [692, 0, "天命之子", "Destinychild"],
        [691, 0, "双生视界", "少女咖啡枪2"],
        [689, 0, "魂器学院", "Horcrux college"],
        [678, 0, "家国梦", ""],
        [662, 0, "重装战姬", "FINALGEAR"],
        [647, 0, "一起来捉妖", ""],
        [625, 0, "圣斗士星矢", ""],
        [617, 0, "万王之王3D", ""],
        [598, 0, "为谁而炼金", ""],
        [569, 0, "死亡爱丽丝", ""],
        [559, 0, "光明大陆", ""],
        [551, 0, "克鲁赛德战记", "Crusaders Quest"],
        [550, 0, "不思议迷宫", "Gumballs"],
        [536, 0, "七雄战记", ""],
        [428, 39818214, "剑与骑士团", ""],
        [453, 0, "魔力宝贝", "魔力宝贝(手游)"],
        [447, 0, "锁链战记", ""],
        [428, 39695787, "射雕", ""],
        [444, 0, "刀塔传奇", ""],
        [428, 40972321, "晴空之下", ""],
        [428, 39485382, "锚点降临", ""],
        [428, 38888482, "交错战线", ""],
        [428, 38767221, "Trickcal Revive", ""],
        [426, 0, "智龙迷城", "Puzzle & Dragons"],
        [428, 38880815, "无尽梦回", ""],
        [-103330, 0, "万象物语", "Sdorica"],
        [-1513130, 0, "灰烬教会", "灰烬战线"],
        [-2068947, 0, "崩坏学园2", ""],
        [-60374520, 0, "食物语", "讨论食物语的各项话题"],
        [428, 38747499, "曙光英雄", ""],
        [428, 38747477, "决胜巅峰", ""],
        [428, 38727491, "元梦之星", ""],
        [428, 38528199, "元气骑士前传", ""],
        [428, 38391692, "掠影纷争", ""],
        [428, 36963255, "欢迎来到梦乐园", ""],
        [428, 36382926, "异域战记", "OuterPlane"],
        [428, 36344533, "宿命回响", ""],
        [428, 36339244, "赛尔计划", ""],
        [428, 36016012, "时序残响24", "36"],
        [428, 35955841, "代号: 鸢", ""],
        [428, 35809291, "归龙潮(原暗号瞳)", ""],
        [428, 35699751, "三国志·战棋版", ""],
        [428, 35591108, "Cytus II", ""],
        [428, 35587738, "大航海时代: 起源", ""],
        [428, 35514668, "晶核COA", ""],
        [428, 35513266, "野火流明", ""],
        [428, 35458584, "圣光之誓2", ""],
        [428, 35401737, "斯露德THRUD", ""],
        [428, 35369501, "黑色信标", ""],
        [428, 35216726, "蛋仔派对", ""],
        [428, 34857785, "空之要塞: 启航", ""],
        [428, 34847240, "Archeland", ""],
        [428, 34684044, "风色幻想: 命运传说", ""],
        [428, 34456121, "百面千相", ""],
        [428, 33949415, "非匿名指令", ""],
        [428, 33856028, "宝石研物语", ""],
        [428, 33028443, "七星传合集", ""],
        [428, 32828555, "Alice Fiction", ""],
        [428, 32764819, "雾境序列", ""],
        [428, 32482614, "核芯: 利希特", ""],
        [428, 32343742, "时空猎人3", ""],
        [428, 32028468, "纯白和弦", ""],
        [428, 31579356, "星球：重启", ""],
        [428, 31579227, "星之彼端合集", ""],
        [428, 31541949, "全民泡泡超人", ""],
        [428, 31171480, "真 锁链战记", ""],
        [428, 30610206, "众神派对", ""],
        [428, 30326649, "重返帝国", ""],
        [428, 30277511, "动物朋友: 王国", ""],
        [428, 30149683, "代号: 烛讨论合集", ""],
        [428, 29789762, "火环", "Prometheus"],
        [428, 29774134, "终焉誓约", ""],
        [428, 28967840, "爆裂魔女", ""],
        [428, 28515933, "来自星尘", ""],
        [428, 28229506, "诺弗兰物语", ""],
        [428, 28088764, "盾之勇者成名录: 浪潮", ""],
        [428, 27921038, "苍之骑士团2", ""],
        [428, 27836471, "APEX英雄手游", ""],
        [428, 27809443, "月神的迷宫", ""],
        [428, 27789543, "古剑奇谭: 木语人", ""],
        [428, 27613171, "漫威: 超级战争", ""],
        [428, 27517101, "空匣人型", ""],
        [428, 27506413, "复苏的魔女", ""],
        [428, 27437508, "二之国: 交错世界", ""],
        [428, 27334967, "雾境序列", ""],
        [428, 27193953, "鬼泣-巅峰之战", ""],
        [428, 26991223, "刀剑神域黑衣剑士: 王牌", ""],
        [428, 26984305, "摩尔庄园", ""],
        [428, 26915705, "战争怒吼", ""],
        [428, 26736690, "漫威超级战争", ""],
        [428, 26719549, "雏蜂: 深渊天使", ""],
        [428, 26690192, "终末阵线: 伊诺贝塔", ""],
        [428, 26396824, "少女的王座", ""],
        [428, 26243707, "狼人对决", ""],
        [428, 26150366, "光与夜之恋", ""],
        [428, 26135608, "学园偶像季: 群星闪耀", ""],
        [428, 25589310, "尼尔: Recarnation", ""],
        [428, 25296980, "影之刃3", ""],
        [428, 24903007, "最终幻想勇气启示录 幻影战争", ""],
        [428, 24301323, "街霸: 对决", ""],
        [428, 24270532, "映月城与电子姬", ""],
        [428, 24128991, "偶像梦幻祭2", ""],
        [428, 24102639, "群星守卫合集", ""],
        [428, 23791095, "密特拉之星", ""],
        [428, 23787458, "D4DJ Groovy Mix", ""],
        [428, 23726924, "黑潮之上", ""],
        [428, 23502906, "高能手办团", ""],
        [428, 23465764, "Gran Saga-格兰传说", ""],
        [428, 23439862, "sin 七大罪~魔王崇拜~", ""],
        [428, 23426622, "地城邂逅: 记忆憧憬", ""],
        [428, 23426173, "万国觉醒", ""],
        [428, 23350704, "不朽之旅", ""],
        [428, 22742346, "我的侠客", ""],
        [428, 22356402, "最强蜗牛", ""],
        [510419, 0, "千年之旅", ""],
        [428, 22684509, "深渊地平线合集", ""],
        [428, 22670766, "万灵启源合集", ""],
        [428, 22597494, "咔叽探险队", ""],
        [428, 22495125, "光·遇", ""],
        [428, 22293254, "三国志幻想大陆", ""],
        [428, 21991744, "Exos Heroes", ""],
        [428, 21891994, "一人之下", ""],
        [428, 21429935, "凹凸世界合集", ""],
        [428, 21185253, "人形觉醒", ""],
        [510422, 0, "月圆之夜", ""],
        [428, 20640743, "七大罪:光与暗的交战", ""],
        [428, 20566468, "仙境传说:我的战术", ""],
        [428, 20466883, "怪物猎人Riders", ""],
        [428, 20017618, "大王不高兴", ""],
        [428, 20017472, "从零开始的异世界生活-INFINITY", ""],
        [428, 19539190, "雷霆游戏", ""],
        [428, 19537132, "伊洛纳", ""],
        [428, 19456658, "启源女神", ""],
        [428, 18828908, "糖果缤纷乐", ""],
        [428, 18828824, "最终幻想: 勇气启示录", ""],
        [428, 18739125, "东方大炮弹", ""],
        [428, 18140344, "执剑之刻", ""],
        [428, 18133076, "王牌战士", ""],
        [428, 18079631, "闪耀暖暖", ""],
        [428, 17708666, "燃烧王座", ""],
        [428, 17612007, "苍蓝誓约", ""],
        [428, 17414247, "OVERHIT合集", ""],
        [428, 17340805, "云梦四时歌合集", ""],
        [428, 17233763, "剑网3:指尖江湖", ""],
        [428, 16710679, "跨越星弧", ""],
        [428, 15848894, "侍魂: 胧月传说合集", ""],
        [428, 15646294, "时之歌合集", ""],
        [428, 15579730, "明日之后合集", ""],
        [428, 15521348, "纯白魔女合集", ""],
        [428, 15507425, "少女歌剧-Re LIVE-合集", ""],
        [428, 15312764, "一零计划合集", ""],
        [428, 15173226, "神都夜行录", ""],
        [428, 14906309, "流星群侠传", ""],
        [428, 14428878, "苍青幻影合集", ""],
        [428, 14355027, "非人学园", ""],
        [428, 14274222, "链战", ""],
        [428, 14073850, "牧羊人之心", ""],
        [428, 13737106, "苍之纪元", ""],
        [428, 13702155, "召唤与合成", ""],
        [428, 13361173, "猎魂觉醒", ""],
        [428, 13225011, "魔卡领域", ""],
        [428, 13196199, "QQ飞车", ""],
        [428, 13086244, "Kirara Fantasia", ""],
        [428, 12990470, "永远的7日之都", ""],
        [428, 12858335, "苍蓝境界", ""],
        [428, 12776235, "荒野行动", ""],
        [428, 12679759, "想不想修真", ""],
        [428, 12480607, "水晶之心合集", ""],
        [428, 12466411, "questland", ""],
        [428, 12419343, "拉结尔", ""],
        [428, 12367942, "超进化物语", ""],
        [428, 12067303, "战舰联盟", ""],
        [816, 0, "无尽的拉格朗日", ""],
        [428, 12290633, "神代梦华谭", ""],
        [510390, 0, "环行旅舍", ""],
        [510384, 0, "奇点时代", ""],
        [510363, 0, "跃迁旅人", ""],
        [510357, 0, "猫之城", ""],
        [510353, 0, "环形战争", ""],
        [836, 0, "幻塔", ""],
        [817, 0, "漫威对决", ""],
        [814, 0, "灵魂潮汐", ""],
        [428, 11734486, "荣耀战棋", ""],
        [803, 0, "白夜极光", ""],
        [795, 0, "机动战姬：聚变", ""],
        [794, 0, "战争怒吼", ""],
        [808, 0, "伊甸园的骄傲", ""],
        [772, 0, "忘川风华录", ""],
        [-37550969, 0, "魔法纪录", ""],
        [428, 11489391, "喵星大作战", "CATS"],
        [428, 11200121, "三国志曹操传", ""],
        [428, 11105519, "龙之谷", ""],
        [428, 10457312, "剑与家园", ""],
        [428, 10140946, "率土之滨", ""],
        [428, 10126611, "另一个伊甸", ""],
        [428, 9957698, "召唤图板", "Summons Board"],
        [428, 9823651, "晓之轨迹", ""],
        [428, 9821244, "地下城堡2", ""],
        [428, 9605923, "英雄与冒险", "Heroes Quest"],
        [428, 9481457, "无尽远征", ""],
      ] },
      { name: "", boards: [
        [537, 0, "大航海时代5", ""],
        [420, 0, "我叫MT4", ""],
        [469, 0, "像素骑士团", ""],
        [601, 0, "晓之轨迹", ""],
        [428, 31576766, "联运网页游戏", ""],
      ] },
    ] },
    { name: "社区事务", groups: [
      { name: "", boards: [
        [10, 0, "银色黎明裁判所", "站务管理 问题解答 版务投诉"],
        [335, 0, "论坛开发", "APP/网站BUG/建议"],
      ] },
      { name: "合集", boards: [
        [781, 0, "合集事务", ""],
        [781, 26926296, "用户自建版面申请", ""],
        [510343, 0, "赛车俱乐部", ""],
        [-5944654, 0, "ASOUL综合讨论", "勇敢牛牛！不怕困难！"],
        [510345, 0, "科幻星球", ""],
        [781, 30022469, "钓鱼爱好者", ""],
        [510379, 0, "宝可梦TCG", ""],
        [781, 35552917, "黎明杀机", "Dead by Daylight"],
        [781, 28828161, "泰拉瑞亚", ""],
        [781, 28636354, "三国杀online", ""],
        [510344, 0, "三国杀", ""],
        [781, 30279084, "脑叶公司", "Lobotomy Corporation"],
        [510386, 0, "月亮计划", "Project Moon"],
        [781, 28343565, "忍者必须死3", ""],
        [781, 35404194, "无尽战区", ""],
        [781, 35327462, "神之天平", ""],
        [781, 35323415, "KARDS - 二战卡牌游戏", ""],
        [781, 34042379, "皇室奇兵", ""],
        [781, 33544228, "盖乐花园", ""],
        [781, 31858702, "血染钟楼", ""],
        [781, 30432934, "卡牌对决", ""],
        [781, 30149057, "命令与征服系列", ""],
        [781, 30142213, "BaldrSky DiveX", ""],
        [781, 30081562, "Torn City", ""],
        [781, 30059250, "噗哟噗哟quest", ""],
        [781, 29987234, "魔法禁书目录: 幻想收束", ""],
        [781, 29688918, "斐格罗斯", "Phigros"],
        [781, 28340492, "everdale", ""],
        [781, 27881729, "SQAUD战术小队", ""],
        [781, 27524441, "江湖悠悠", ""],
        [781, 27408532, "露营与野营", ""],
        [781, 27291705, "阿尔比恩OL", "Albion Online"],
        [510378, 0, "鹅鸭杀", ""],
        [510348, 0, "死亡细胞", ""],
        [510346, 0, "永歌森林", ""],
      ] },
    ] },
  ];

  const FORUMS_EXTRA_KEY = "ngax:forums:extra";   // 运行时补进来的版面
  const FORUMS_FAV_KEY = "ngax:favforums";        // 收藏的版面（本地，不依赖站点权限）
  const FORUMS_VISIT_KEY = "ngax:visits";         // 各版面访问次数（算「常去」用）

  let FORUM_MAP = null;                            // allForums() 的缓存

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }

  function writeJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* 隐私模式等 */ }
  }

  let INDEX_CAT_MAP = null;

  /**
   * 站点那份分类目录：fid → { name, cat, group, info }。
   * 数据来自 .build/extract-cats.py（首页 CDN 那份 bbs_index_data.js）。
   */
  function indexCatMap() {
    if (INDEX_CAT_MAP) return INDEX_CAT_MAP;
    INDEX_CAT_MAP = new Map();
    INDEX_CATS.forEach((c) => {
      (c.groups || []).forEach((g) => {
        (g.boards || []).forEach((b) => {
          // b = [fid, stid, 名字, 简介]；stid 非 0 的是「合集」，
          // 它不是版面（URL 是 ?stid=），不往版面表里放
          if (b[1]) return;
          INDEX_CAT_MAP.set(String(b[0]), {
            name: b[2] || "",
            info: b[3] || "",
            cat: c.name || "",
            group: g.name || ""
          });
        });
      });
    });
    return INDEX_CAT_MAP;
  }

  /** 分类目录的顺序（就是站点自己的展示顺序） */
  function indexCats() { return INDEX_CATS; }

  /**
   * 全部已知版面：烘焙的（爬来的）+ 分类目录里的 + 运行时发现的。
   * 返回 fid 字符串 → {fid, name, sub, cat, group, info}
   */
  function allForums() {
    if (FORUM_MAP) return FORUM_MAP;
    const map = new Map();
    FORUMS.forEach((f) => {
      const k = String(f.fid);
      if (!map.has(k)) map.set(k, { fid: f.fid, name: f.name, sub: f.sub || "" });
    });
    const extra = readJson(FORUMS_EXTRA_KEY, {});
    Object.keys(extra).forEach((k) => {
      if (!map.has(k) && extra[k]) map.set(k, { fid: Number(k), name: String(extra[k]), sub: "" });
    });
    // 再合分类目录：既给已知版面补上「分类 / 分组 / 简介」，也把目录里有、
    // 爬表里没有的版面补进来（目录有 679 个，爬表是超集但两边并不完全重合）
    indexCatMap().forEach((meta, k) => {
      const cur = map.get(k);
      if (cur) {
        cur.cat = meta.cat;
        cur.group = meta.group;
        if (meta.info) cur.info = meta.info;
      } else {
        map.set(k, {
          fid: Number(k), name: meta.name, sub: meta.info,
          cat: meta.cat, group: meta.group, info: meta.info
        });
      }
    });
    FORUM_MAP = map;
    return map;
  }

  /**
   * 从面包屑里抠出「当前版面」。
   *
   * 为什么需要它：**帖子页没有 __ALL_FORUM_DATA**（只有版面列表页才有），
   * 但帖子页有 __CURRENT_FID + 面包屑里那个指向本版的 nav_link。
   * 而用户大部分时间都在帖子页 —— 只认 __ALL_FORUM_DATA 的话，
   * 「逛到哪儿版面表长到哪儿」这件事在最重要的页面上根本不生效。
   */
  function currentForumFromBreadcrumb() {
    const fid = Number(window.__CURRENT_FID) || 0;
    if (!fid) return null;
    const nav = document.querySelector("#m_nav .nav") || document.querySelector("#b_nav .nav");
    if (!nav) return null;
    let name = "";
    nav.querySelectorAll("a.nav_link, a.nav_root").forEach((a) => {
      if (name) return;
      const m = attr(a, "href").match(/[?&]fid=(-?\d+)/);
      if (m && Number(m[1]) === fid) name = txt(a);
    });
    if (!name) return null;
    return { fid: String(fid), name };
  }

  /**
   * 把当前页能看到的版面合进本地表：
   *   ① 版面列表页的 __ALL_FORUM_DATA（一次能拿到本版 + 子版 + 联合版）；
   *   ② 任何页面面包屑里的当前版面（帖子页主要靠这条）。
   * 返回新增了几个（调用方可以用来决定要不要刷新 UI）。
   */
  function rememberForums() {
    const baked = new Set(FORUMS.map((f) => String(f.fid)));
    const extra = readJson(FORUMS_EXTRA_KEY, {});
    let added = 0;
    const add = (k, name) => {
      if (!k || !name) return;
      if (baked.has(k) || extra[k]) return;
      extra[k] = String(name);
      added++;
    };

    const data = window.__ALL_FORUM_DATA;
    if (data) {
      Object.keys(data).forEach((k) => {
        const v = data[k];
        if (v && v[1]) add(k, decodeEntities(v[1]));
      });
    }
    const cur = currentForumFromBreadcrumb();
    if (cur) add(cur.fid, decodeEntities(cur.name));

    if (added) {
      writeJson(FORUMS_EXTRA_KEY, extra);
      FORUM_MAP = null;
    }
    return added;
  }

  /* —— 收藏的版面（脚本自己存在本地）——
   * 不动 NGA 自己的「收藏版面」：那个在 /thread.php?fid=357，
   * 而且菜单里的门槛是 rvrc ≥ 20，普通账号（比如 rvrc=10）直接是「帐号权限不足」。
   * 脚本自己存一份反而更好用：不用权限、立即生效、能随便排序。
   */
  function favForums() {
    const list = readJson(FORUMS_FAV_KEY, []);
    return Array.isArray(list) ? list.map(String) : [];
  }

  function isFavForum(fid) {
    return favForums().indexOf(String(fid)) >= 0;
  }

  /** 收藏 / 取消收藏，返回操作后是否在收藏夹里 */
  function toggleFavForum(fid) {
    const key = String(fid);
    const list = favForums();
    const i = list.indexOf(key);
    if (i >= 0) list.splice(i, 1);
    else list.push(key);
    writeJson(FORUMS_FAV_KEY, list);
    return i < 0;
  }

  /* ============ NGA 自己的「版面收藏 + 浏览历史」 ============
   *
   * 站点首页那个「收藏版面」分区就是从这里来的，我一开始完全找错了地方：
   *
   *   1. 它**不在 HTTP 响应里**。首页 HTML 只有 5 个头条块 + 一句
   *      commonui.indexBlock.load(...)；版面目录本身来自一份 CDN 静态 JSON
   *      （proxy/cache_attach/bbs_index_data.js，373 个版面 + 分类，而且其中
   *      「收藏版面」分类在文件里是个**空占位**）。
   *   2. 收藏/历史也不在 cookie 里 —— 它在 **bbs.ngacn.cc 的 localStorage**
   *      （key `userCache_<uid>_ForumViewHisV2`），NGA 用一个隐藏 iframe +
   *      postMessage 跨域读写（commonui.hostStg / hisLink），并且会同步到服务端
   *      （/nuke.php?__lib=forum_favor2&__act=forum_favor）。
   *   3. 我当初找到的「收藏版面页」/thread.php?fid=357 返回「帐号权限不足」
   *      （菜单门槛 rvrc≥20），于是误判成「这个账号没有收藏版面」——
   *      但首页那条路根本不用那个页面。
   *
   * 好在这些接口都是在页面里可用的全局函数，脚本直接调就行：
   *   commonui.eachForumViewHis(cb)   → 逐条 [fid, name, lock, day, count, stid, name]
   *   commonui.waitForumViewHis(cb)   → 缓存异步 init 完再回调（官方等待接口）
   *   commonui.lockViewHis(fid, 1|0)  → 收藏 / 取消（本地 + 同步服务端）
   *
   * 字段含义（从 js_commonui.js 的 hisLink 里读出来的）：
   *   lock=1 就是「收藏」；count 是访问权重（新条目 1，隔天 +10、隔两天 =10，封顶 40）；
   *   收藏上限 maxlock=8；对已收藏的条目不累计 count。
   * ================================================================= */

  const NGA_HIS_SCORE = 10;   // count ≥ 10 相当于「至少隔天来过一次」
  const NGA_HIS_MAXLOCK = 8;  // 站点自己的收藏上限

  let NGA_HIS = null;      // null = 还没读到；[] = 读到了但是空的
  let NGA_HIS_WAIT = [];   // 等数据的回调

  function ngaHis() { return NGA_HIS || []; }
  function ngaHisReady() { return NGA_HIS !== null; }

  /**
   * 读 NGA 自己的版面历史/收藏。
   * cb(data, fresh)：fresh 表示「这次调用才把它读出来」——用在 rail 上重画一次，
   * 而且不会死循环（后续调用 fresh 都是 false）。
   */
  function readNgaHis(cb) {
    if (NGA_HIS !== null) { if (cb) cb(NGA_HIS, false); return; }
    if (cb) NGA_HIS_WAIT.push(cb);
    if (NGA_HIS_WAIT.length > 1) return;   // 只发起一次

    const c = com();
    const collect = () => {
      const out = [];
      if (c && typeof c.eachForumViewHis === "function") {
        try {
          c.eachForumViewHis((k, v) => {
            const fid = Number(v && v[0]);
            if (!fid) return;
            out.push({
              fid,
              name: decodeEntities(String(v[1] || "")),
              lock: Number(v[2]) || 0,
              day: Number(v[3]) || 0,
              count: Number(v[4]) || 0,
              stid: Number(v[5]) || 0
            });
          });
        } catch { /* 读不出来就当没有 */ }
      }
      NGA_HIS = out;
      const wait = NGA_HIS_WAIT;
      NGA_HIS_WAIT = [];
      wait.forEach((f) => { try { f(out, true); } catch { /* ignore */ } });
    };

    // history 是异步 init 的；没好的时候官方接口会把回调挂起来
    if (c && typeof c.waitForumViewHis === "function") {
      try { if (c.waitForumViewHis(collect)) return; } catch { /* 退回直接读 */ }
    }
    collect();
  }

  /** 这条版面在 NGA 的历史里吗（能不能用它的 lock 接口） */
  function ngaHisEntry(fid) {
    const key = String(fid);
    return ngaHis().find((x) => String(x.fid) === key) || null;
  }

  /** 收藏 / 取消收藏一个版面：优先写 NGA 自己那份，再镜像到本地 */
  function toggleBoardFav(fid) {
    const c = com();
    const entry = ngaHisEntry(fid);
    // 当前状态是「站点锁了」或「本地存了」的**并集** ——
    // 只看本地的话，点一个站点已收藏的版面会又收藏一次而不是取消（踩过）
    const on = !((entry && entry.lock) || isFavForum(fid));
    if (on !== isFavForum(fid)) toggleFavForum(fid);   // 本地镜像（只在真的变了时写）
    // 站点那份：只有它认识这个版面（在历史里）才能锁；unlock 是整条删掉
    if (ngaHisReady() && entry && typeof c.lockViewHis === "function") {
      try { c.lockViewHis(Number(fid), on ? 1 : 0, entry.stid || undefined); } catch { /* ignore */ }
    }
    return on;
  }

  /**
   * 收藏的版面列表：NGA 锁定的 ∪ 本地存的。
   *
   * 为什么要并集而不是「以 NGA 为准」：`unlock` 是**整条删掉**（不是只去掉锁），
   * 而 `lock` 又只对已经在历史里的版面有效 —— 直接从我的界面收藏一个从没去过的版面，
   * NGA 那边表示不了。所以本地那份必须留着兜住这种情况。
   *
   * 同时做一次「对账」：NGA 认识但没锁的，就从本地删掉 ——
   * 这样在原生首页取消收藏，脚本这边也会跟着取消。
   */
  function boardBookmarks() {
    const map = allForums();
    const out = [];
    const seen = new Set();
    const push = (fid, name) => {
      const k = String(fid);
      if (seen.has(k)) return;
      const f = map.get(k);
      if (!f && !name) return;
      seen.add(k);
      out.push({ fid: f ? f.fid : Number(fid), name: (f && f.name) || name || ("fid " + fid) });
    };

    ngaHis().filter((x) => x.lock && !x.stid).forEach((x) => push(x.fid, x.name));

    if (ngaHisReady()) {
      const stale = favForums().filter((fid) => {
        const e = ngaHisEntry(fid);
        return e && !e.lock;      // NGA 认识、但没锁 → 本地这条过期了
      });
      if (stale.length) {
        const keep = favForums().filter((fid) => stale.indexOf(fid) < 0);
        writeJson(FORUMS_FAV_KEY, keep);
      }
    }
    favForums().forEach((fid) => push(fid, forumInfo(fid).name));
    return out;
  }

  /**
   * 常去的版面：NGA 的访问权重（≥10，即至少隔天来过一次）优先，
   * 再补上脚本自己数的（≥2，只在 NGA 那份读不到时才有意义）。
   * 两套量纲不一样，所以不混着排序，各排各的、NGA 的在前。
   */
  function frequentBoards(n) {
    const limit = n || 8;
    const map = allForums();
    const seen = new Set();
    const out = [];
    const push = (fid, name, count, src) => {
      const k = String(fid);
      if (seen.has(k)) return;
      const f = map.get(k);
      seen.add(k);
      out.push({ fid: f ? f.fid : Number(fid), name: (f && f.name) || name || "", count, src });
    };

    ngaHis()
      .filter((x) => !x.stid && !x.lock && x.count >= NGA_HIS_SCORE)
      .sort((a, b) => b.count - a.count)
      .forEach((x) => push(x.fid, x.name, x.count, "nga"));

    frequentForums(limit).forEach((f) => push(f.fid, f.name, f.count, "local"));
    return out.slice(0, limit);
  }

  /* —— 访问次数：「常去版面」——
   * 「常用版面」如果写成一张写死的清单，那它永远不会是「你的」常用。
   * 所以这里按实际访问次数自动学，收藏的版面另外单独置顶，两者不混。
   */
  function rememberVisit(fid) {
    const key = String(fid || "");
    if (!key || key === "0") return;
    const c = readJson(FORUMS_VISIT_KEY, {});
    c[key] = (Number(c[key]) || 0) + 1;
    writeJson(FORUMS_VISIT_KEY, c);
  }

  /**
   * rail 的「常用版面」默认清单（只有 fid，名字一律从版面表里取）。
   *
   * 为什么还是要一份写死的默认：上一版把 rail 的版面列表换成「只显示访问过两次以上的」
   * 之后，rail 直接空了 —— 一个常驻的导航区不能依赖「用户已经用过它」才能出现。
   * 所以现在的结构是「收藏 → 常去 → 默认」三段合并去重：
   * 学习出来的东西往前排，但底永远有东西。
   */
  const DEFAULT_RAIL_FIDS = [
    -7, 436, -39223361, -7955747, 510346, -1459709, 704, -608808, -343809, -353371,
    -8725919, -576177, 524, 843, 847, 510418, 414, 428, 300, 422,
    716, 761, 767, -4567100, 498, 570, -522474, 485, -81981
  ];

  /**
   * rail 里要显示的版面列表。
   * 顺序 = 收藏的 → 常去的 → 默认清单（各自保持原顺序，重复的只留第一次出现）。
   * 每项带 { fid, name, fav, count }，方便 rail 决定显示星标还是计数。
   */
  function railBoards() {
    const map = allForums();
    const favs = favForums();
    const out = [];
    const seen = new Set();
    const push = (fid, meta) => {
      const key = String(fid);
      if (seen.has(key)) return;
      const f = map.get(key);
      if (!f) return;
      seen.add(key);
      out.push(Object.assign({ fid: f.fid, name: f.name }, meta || {}));
    };
    favs.forEach((fid) => push(fid, { fav: true }));
    frequentForums(8).forEach((f) => push(f.fid, { count: f.count }));
    DEFAULT_RAIL_FIDS.forEach((fid) => push(fid));
    return out;
  }

  /** 「常去」的阈值：只去过一次不算常去（否则这词就没意义了） */
  const FREQUENT_MIN = 2;

  /** 去得最多的 N 个版面（按访问次数降序，只算达到阈值的） */
  function frequentForums(n) {
    const counts = readJson(FORUMS_VISIT_KEY, {});
    const map = allForums();
    return Object.keys(counts)
      .filter((k) => map.has(k) && (Number(counts[k]) || 0) >= FREQUENT_MIN)
      .sort((a, b) => (Number(counts[b]) || 0) - (Number(counts[a]) || 0))
      .slice(0, n || 8)
      .map((k) => Object.assign({ count: Number(counts[k]) || 0 }, map.get(k)));
  }

  /* ============================== 路由判定 ============================== */

  function route() {
    const p = location.pathname;
    const q = new URLSearchParams(location.search);
    let m;

    if (p === "/" || p === "" || /index\.php$/.test(p)) {
      return { kind: "home", path: p };
    }
    if (/\/read\.php$/.test(p)) {
      return {
        kind: "thread",
        tid: num(q.get("tid")),
        page: num(q.get("page")) || 1,
        // 只看某人的回复 / 跳到某个 pid：这两种都还是同一个帖子页，原生会自己处理
        authorId: num(q.get("authorid")) || 0,
        pid: num(q.get("pid")) || 0,
        path: p
      };
    }
    if (/\/thread\.php$/.test(p)) {
      const fid = q.get("fid");
      const stid = q.get("stid");
      const key = q.get("key");
      const authorId = q.get("authorid");
      // thread.php?favor=1 / ?recommend=1 —— 收藏的主题 / 推荐的主题。
      // 这两个用的还是 #topicrows 那套结构，所以直接当列表页接管。
      if (q.get("favor") !== null) {
        return { kind: "list", listKind: "favor", folder: num(q.get("folder")) || 0, page: num(q.get("page")) || 1, path: p };
      }
      if (q.get("recommend") !== null) {
        return { kind: "list", listKind: "recommend", page: num(q.get("page")) || 1, path: p };
      }
      if (fid !== null) {
        return { kind: "list", listKind: "forum", fid: num(fid), page: num(q.get("page")) || 1, searchPost: num(q.get("searchpost")) || 0, authorId: num(authorId) || 0, path: p };
      }
      if (stid !== null) {
        return { kind: "list", listKind: "collection", stid: num(stid), page: num(q.get("page")) || 1, path: p };
      }
      if (key !== null) {
        return { kind: "list", listKind: "search", key: String(key), page: num(q.get("page")) || 1, path: p };
      }
      if (authorId !== null) {
        return { kind: "list", listKind: "author", authorId: num(authorId), page: num(q.get("page")) || 1, path: p };
      }
      return { kind: "other", path: p };
    }
    if (/\/nuke\.php$/.test(p)) {
      // nuke.php?func=ucp&uid=N —— 「用户信息」页。
      // 内容是 js_ucp.js 现渲染的（#ucp_block 在服务端 HTML 里是空的），
      // 但数据是页面内联的 __UCPUSER（完整 JSON），所以脚本直接读结构化数据，
      // 不依赖那些 DOM。
      if (q.get("func") === "ucp" && num(q.get("uid"))) {
        return { kind: "member", uid: num(q.get("uid")), path: p };
      }
      return { kind: "other", path: p };
    }
    return { kind: "other", path: p };
  }

  /**
   * 这个路由「应该被接管」吗？（**只看 URL，不碰 DOM**）
   *
   * 为什么要和 isSupported() 拆开：bootstrap() 跑在 @run-at document-start，
   * 那时 <body> 还没被解析，document.getElementById("mmc") 必然是 null。
   * 当初就是用带 DOM 探测的 isSupported() 决定要不要加 ngax-locked，
   * 结果那一行从来没生效过 —— 表现是切版面 / 点进帖子时闪一帧完整的原生页面。
   * 所以「首帧要不要先藏」只能看 URL；「真的能不能接管」才去看 DOM。
   */
  function lockableRoute(r) {
    return r.kind === "thread" || r.kind === "list" || r.kind === "home" || r.kind === "member";
  }

  /**
   * 真的可以接管吗？
   *
   * 除了路由，还得确认这是个正常的 NGA 内容页：NGA 对未登录访客返回 403 的
   * 「游客不能直接访问」页，那种页面里没有 #mmc。这个检查只能在 DOM 就绪后做，
   * 所以 bootstrap 阶段会「乐观锁定」、到 render() 阶段再回滚解锁。
   */
  function isSupported(r) {
    if (!document.getElementById("mmc")) return false;
    return lockableRoute(r);
  }

  function listTitle(r, page) {
    if (r.listKind === "favor") return "收藏的主题";
    if (r.listKind === "recommend") return "推荐的主题";
    if (r.listKind === "forum") {
      const f = forumInfo(r.fid);
      return f.name || (page && page.forumName) || ("版面 " + r.fid);
    }
    if (r.listKind === "collection") return (page && page.forumName) || "合集";
    if (r.listKind === "search") return "搜索：" + r.key;
    if (r.listKind === "author") {
      const u = userInfo(r.authorId);
      return (u.username || r.authorId) + (r.searchPost ? " 的回复" : " 发布的主题");
    }
    return "主题列表";
  }

  /* ============================== 解析：NGA DOM → 数据 ============================== */

  const parse = {};

  /**
   * 版面列表行。
   *
   * 服务端给的是 <tr class='row1 topicrow'> + 一堆带稳定 id 的子元素
   * （t_rc1_N 回复数 / t_tt1_N 标题 / t_ta1_N 作者 / t_pt1_N 发帖时间 /
   *   t_tr1_N 最后回复人 / t_rt1_N 最后回复时间 / t_pc1_N 附加标记）。
   *
   * 为什么按「行内 class」取而不是按列（c1..c4）取：NGA 的「精简模式」
   * 会把 c3/c4 合并成一格，列位置会变，但元素上的 class/id 不会变。
   */
  parse.topicRows = function (root) {
    const out = [];
    const seen = new Set();
    root.querySelectorAll("tr.topicrow").forEach((tr, idx) => {
      const a = tr.querySelector("a.topic");
      if (!a) return;
      const tid = num((attr(a, "href").match(/[?&]tid=(\d+)/) || [])[1]);
      if (!tid || seen.has(tid)) return;
      seen.add(tid);

      const arg = topicArg(idx);
      const authorA = tr.querySelector("a.author");
      const pt = tr.querySelector("span.postdate");
      const rt = tr.querySelector("a.replydate");
      const repliesEl = tr.querySelector("a.replies");
      const markEl = tr.querySelector("span[id^='t_pc']");

      out.push({
        tid,
        url: "/read.php?tid=" + tid,
        title: txt(a),
        mark: txt(markEl),
        replies: txt(repliesEl) || String((arg && arg.replies) || 0),
        repliesNum: num(txt(repliesEl)) || ((arg && arg.replies) || 0),
        author: txt(authorA),
        authorUid: uidFromHref(attr(authorA, "href")),
        timeIso: ngaTime((arg && arg.postTime) || txt(pt)),
        timeRaw: txt(pt),
        replier: txt(tr.querySelector("span.replyer")),
        lastIso: ngaTime((arg && arg.lastPost) || txt(rt)),
        lastRaw: txt(rt),
        sticky: !!tr.closest("#toptopics")
      });
    });
    return out;
  };

  /** 置顶区（#toptopics）单独拎出来：它不是 tr.topicrow，结构也不一样 */
  parse.stickyRows = function (root) {
    const box = root.querySelector("#toptopics");
    if (!box) return [];
    const out = [];
    box.querySelectorAll("h3 a[href*='tid=']").forEach((a) => {
      const tid = num((attr(a, "href").match(/[?&]tid=(\d+)/) || [])[1]);
      if (!tid) return;
      out.push({ tid, url: "/read.php?tid=" + tid, title: txt(a), sticky: true });
    });
    return out;
  };

  /**
   * 楼层。
   *
   * 服务端结构（每个楼层一个 <table>）：
   *   <tr id='post1strow0' class='postrow row2'>          ← row2/row1 交替，层号就是 id 尾巴
   *     <td class='c1'><span id='posterinfo0'>…</span></td>
   *     <td class='c2' id='postcontainer0'>
   *       <a id='pid881891670Anchor'></a><a name='l1'></a>
   *       <div id='postInfo0'><span id='postdate0'>…</span></div>
   *       <span id='postcontentandsubject0'>
   *         <h3 id='postsubject0'>…</h3>
   *         <p id='postcontent0' class='postcontent ubbcode'>…</p>
   *       </span>
   *       <div id='postsign0'>签名</div>
   *     </td>
   *     <td class='adshid'></td>
   *   </tr>
   *
   * 两个坑：
   *   1. #postauthorN 在源码里是空的，作者名要等 commonui.postArg.proc() 填；
   *      所以这里优先读 commonui.userInfo.users[uid]，DOM 只作兜底。
   *   2. #pid…Anchor 的 id 就是 pid，但**楼主那层是 pid0**（等于没有），
   *      引用楼主时 NGA 用 [tid=xxx] 而不是 [pid=xxx]。
   */
  /**
   * 从楼层行里抠附件元数据。
   *
   * 原生在这行里放了一个内联脚本调 ubbcode.attach.load(…)，参数里带着
   * 附件的真实路径（url:'mon_202609/16/xxx.jpg'）。attach 模块是**异步**的，
   * 万一本脚本渲染时它还没跑（或者根本就没跑起来），正文里就只剩一个空的
   * <span id='postattachN'>，图就丢了 —— 所以这里自己把路径抠出来当兜底。
   */
  function attachUrlsFromRow(tr) {
    const out = [];
    tr.querySelectorAll("script").forEach((s) => {
      const t = s.textContent || "";
      if (t.indexOf("ubbcode.attach.load") < 0) return;
      const re = /url\s*:\s*'([^']+)'/g;
      let m;
      while ((m = re.exec(t))) if (m[1]) out.push(m[1]);
    });
    return out;
  }

  parse.posts = function (root) {
    const out = [];
    root.querySelectorAll("tr[id^='post1strow']").forEach((tr) => {
      const m = tr.id.match(/^post1strow(\d+)$/);
      if (!m) return;
      const i = Number(m[1]);
      const arg = postArg(i);
      const authorA = tr.querySelector("[id^='postauthor']");
      const uid = Number(arg && arg.pAid) || uidFromHref(attr(authorA, "href"));
      const u = userInfo(uid);
      const pidAnchor = tr.querySelector("a[id^='pid'][id$='Anchor']");
      const pid = num((attr(pidAnchor, "id").match(/^pid(\d+)/) || [])[1]);
      const contentEl = tr.querySelector("[id^='postcontent']");
      const attachEl = tr.querySelector("[id^='postattach']");
      const dateEl = tr.querySelector("[id^='postdate']");

      out.push({
        i,
        isOp: i === 0,
        pid,
        tid: Number(window.__CURRENT_TID) || 0,
        uid,
        username: u.username || txt(authorA) || (uid ? String(uid) : "匿名"),
        avatar: u.avatar || "",
        reputation: u.rvrc,
        postnum: u.postnum,
        timeIso: (arg && arg.postTime) ? new Date(arg.postTime * 1000).toISOString() : ngaTime(txt(dateEl)),
        timeRaw: txt(dateEl),
        subject: txt(tr.querySelector("[id^='postsubject']")),
        contentHtml: contentEl ? contentEl.innerHTML : "",
        attachHtml: attachEl ? attachEl.innerHTML : "",
        attachUrls: attachUrlsFromRow(tr),
        signHtml: (tr.querySelector("[id^='postsign']") || {}).innerHTML || "",
        client: (arg && arg.fromClient) || "",
        // 「改动」区块（版主/作者编辑记录），原生会渲染到 #alertcN
        alertHtml: (tr.querySelector("[id^='alertc']") || {}).innerHTML || ""
      });
    });
    return out;
  };

  /**
   * 首页头条。
   *
   * NGA 的首页不是版面列表，而是 commonui.indexBlock.add(…) 拼出来的一堆头条卡片：
   *   indexBlock.add([ "标题","[url]https://bbs.nga.cn/read.php?tid=1[/url] [img]./mon_202609/14/c8Q39-x.jpg[/img]", … ],'games',0,'headline')
   * 数据就在内联脚本里（而且每条都是「标题 + 内容」两两成对），
   * 直接读它比猜那三个 float 容器的 DOM 稳得多。
   */
  parse.indexBlocks = function (root) {
    const out = [];
    (root || document).querySelectorAll("script").forEach((s) => {
      const t = s.textContent || "";
      let from = 0;
      for (;;) {
        const hit = t.indexOf("indexBlock.add(", from);
        if (hit < 0) break;
        from = hit + 1;

        const start = t.indexOf("[", hit);
        if (start < 0) continue;
        const arrSrc = balancedSlice(t, start);
        if (!arrSrc) continue;

        // 数组后面跟着 '分类',数字,'版式' —— 解析失败也不影响内容
        const tail = t.slice(start + arrSrc.length);
        const tm = tail.match(/^\s*,\s*'([^']*)'\s*,\s*(\d+)\s*,\s*'([^']*)'/);

        let arr;
        try { arr = Function("return " + arrSrc)(); } catch { continue; }
        if (!arr || !arr.length) continue;

        const items = [];
        for (let i = 0; i + 1 < arr.length; i += 2) {
          const title = String(arr[i] || "").trim();
          const body = String(arr[i + 1] || "").trim();
          if (!title) continue;
          items.push({
            title,
            body,
            url: (body.match(/\[url\]\s*([^\s\[\]]+?)\s*\[\/url\]/i) || [])[1] || "",
            img: (body.match(/\[img\]\s*([^\s\[\]]+?)\s*\[\/img\]/i) || [])[1] || ""
          });
        }
        if (items.length) out.push({ kind: (tm && tm[1]) || "", style: (tm && tm[3]) || "", items });
      }
    });
    return out;
  };

  /**
   * 用户信息页的「头衔」文本。
   *
   * NGA 把它编码成两种格式（服务端拼的字符串，不是结构化字段）：
   *   "头衔文字"                          永久头衔
   *   " <过期时间戳> <文字> <永久文字>"    带时限的；过期后回退到永久那个
   * 这段逻辑是照抄 js_ucp.js 里的 _title()（它用的就是这套判定），
   * 不复刻的话，界面上会直接出现一串时间戳。
   */
  function honorText(u) {
    const h = String((u && (u.honor || u.title)) || "");
    if (!h) return "";
    if (h.substr(0, 1) !== " ") return h.trim();
    const parts = h.split(" ");
    const until = Number(parts[1]) || 0;
    const now = Number(window.__NOW) || (Date.now() / 1000);
    if (until && until > now) return String(parts[2] || "").trim();
    if (parts[3]) return String(parts[3]).trim();
    return "";
  }

  /** buffs 是 { 序号: {0:id,1:bid,…,5:结束时间,…,9:渲染好的 HTML} }，两种形态都容忍 */
  function buffList(raw) {
    const out = [];
    if (!raw) return out;
    for (const k of Object.keys(raw)) {
      const v = raw[k];
      if (!v || typeof v !== "object") continue;
      const html = cleanContent(String(v[9] || "")).trim();
      if (!html) continue;
      out.push({ html, bid: Number(v[1]) || 0, until: Number(v[5]) || 0 });
    }
    return out;
  }

  /** reputation 是 { 序号: {0:来源,1:值,2:说明} } */
  function reputationList(raw) {
    const out = [];
    if (!raw) return out;
    for (const k of Object.keys(raw)) {
      const v = raw[k];
      if (!v || typeof v !== "object") continue;
      out.push({
        name: String(v[0] || ""),
        value: Number(v[1]) || 0,
        text: cleanContent(String(v[2] || "")).trim()
      });
    }
    return out;
  }

  /**
   * 那一排账号动作按钮。
   *
   * 它们是 js_ucp.js 现生成的，而且**相当一部分根本没有 href**
   * （比如「更改密码」是 onclick 里调 commonui.accountAction('changepass')）。
   * 所以这里只把「按钮叫什么」拄出来，点击时再交回给原生元素自己 ——
   * 权限判断、弹窗、短信验证、二次确认全归站点，不用重写也不容易写错。
   */
  function memberActions(root) {
    const out = [];
    const seen = new Set();
    (root || document).querySelectorAll("#ucp_block a").forEach((a) => {
      const label = txt(a);
      if (!label || label.length > 24 || seen.has(label)) return;
      seen.add(label);
      const href = attr(a, "href");
      out.push({ label, href: /^\//.test(href) ? href : "" });
    });
    return out;
  }

  /** 按文字找原生按钮并点它（拿不到就返回 false，交给调用方提示） */
  function clickNativeAction(label) {
    const a = Array.from(document.querySelectorAll("#ucp_block a"))
      .find((x) => txt(x) === label);
    if (!a) return false;
    a.click();
    return true;
  }

  /**
   * 用户信息页的数据。
   *
   * 主数据源是页面内联的 window.__UCPUSER（完整 JSON，同步可用）——
   * 比去解析 js_ucp.js 现渲染的那堆 div/span 稳得多，而且字段更全。
   */
  parse.member = function (root) {
    const u = window.__UCPUSER;
    if (!u || !u.uid) return null;
    let active = { html: Number(u.yz) > 0 ? "已激活" : "未激活", title: "" };
    // 激活状态的花样很多（手机认证 / 邮箱认证 / 实名…），让站点自己翻译
    const fn = com() && com().activeInfo;
    if (typeof fn === "function") {
      try {
        const r = fn(u.verified, u.uid, u.bit);
        if (r && r[2]) {
          active = { html: cleanContent(String(r[2])), title: [r[3], r[4]].filter(Boolean).join(" ") };
        }
      } catch { /* 用上面那个兜底 */ }
    }
    return {
      uid: Number(u.uid) || 0,
      username: String(u.username || ""),
      group: String(u.group || ""),
      gid: Number(u.gid || u.groupid) || 0,
      avatar: String(u.avatar || ""),
      posts: Number(u.posts) || 0,
      money: Number(u.money) || 0,
      rvrc: Number(u.rvrc) || 0,
      fame: Number(u.fame) || 0,
      regdate: Number(u.regdate) || 0,
      ipLoc: String(u.ipLoc || ""),
      email: String(u.email || ""),
      phone: String(u.phone || ""),
      honor: honorText(u),
      sign: cleanContent(String(u.sign || "")).trim(),
      active,
      muteTime: Number(u.muteTime) || 0,
      usernameChanged: !!u.usernameChanged,
      buffs: buffList(u.buffs),
      reputation: reputationList(u.reputation),
      actions: memberActions(root)
    };
  };

  /** 当前页面的解析上下文；每次渲染前重算（原生 DOM 一直留着，可以反复解析） */
  function collectPage() {
    const r = route();
    const titles = pageTitle();
    const data = {
      route: r,
      user: currentUser(),
      forumName: titles.forum,
      topicTitle: titles.topic,
      list: null,
      stickies: null,
      thread: null,
      blocks: null,
      member: null,
      pager: null,
      fid: Number(window.__CURRENT_FID) || (r.kind === "list" ? r.fid : 0)
    };
    if (r.kind === "home") {
      data.blocks = parse.indexBlocks(document);
    } else if (r.kind === "member") {
      data.member = parse.member(document);
    } else if (r.kind === "list") {
      data.list = parse.topicRows(document);
      data.stickies = parse.stickyRows(document);
      data.pager = pager();
    } else if (r.kind === "thread") {
      const posts = parse.posts(document);
      data.thread = {
        tid: r.tid,
        title: titles.topic || document.title.replace(/\s*NGA玩家社区\s*$/, ""),
        forum: titles.forum,
        fid: data.fid,
        posts,
        replies: posts.length ? posts.length - 1 : 0
      };
      data.pager = pager();
      data.list = null;
    }
    return data;
  }

  /* ============================== 构造 DOM 小工具 ============================== */

  function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  /**
   * 清掉原生正文里可能干扰的东西。
   *
   * 注意这里**故意不删** NGA 自己插入的 <span id='postattachN'> 之类，
   * 因为附件就挂在那里；只清脚本和行内事件（脚本里带的是附件元数据，
   * 已经由原生 JS 消费完了，留着只会在我重渲染的 DOM 里被重复执行）。
   */
  function cleanContent(html) {
    if (!html) return "";
    return String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<ins\b[^>]*class="adsbygoogle"[^>]*>[\s\S]*?<\/ins>/gi, "")
      .replace(/\son\w+="[^"]*"/gi, "")
      .replace(/\son\w+='[^']*'/gi, "");
  }

  /* ============================== 明暗模式 ============================== */

  function themeOverride() {
    const t = cfg("theme");
    return (t === "light" || t === "dark") ? t : null;
  }

  /** 把 #rgb / #rrggbb / rgb() / rgba() 解成 0-255 的亮度；认不出来返回 null */
  function lumOf(color) {
    const s = String(color || "").trim().toLowerCase();
    if (!s || s === "transparent") return null;
    let m;
    if ((m = s.match(/^#([0-9a-f]{3})$/))) {
      const h = m[1];
      return 0.2126 * parseInt(h[0] + h[0], 16) + 0.7152 * parseInt(h[1] + h[1], 16) + 0.0722 * parseInt(h[2] + h[2], 16);
    }
    if ((m = s.match(/^#([0-9a-f]{6})$/))) {
      const n = parseInt(m[1], 16);
      return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    }
    if ((m = s.match(/^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)$/))) {
      const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
      if (alpha < 0.5) return null; // 半透明底算不上「底色」
      return 0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3];
    }
    return null;
  }

  /**
   * 判定当前是否深色。
   *
   * 顺序很重要：NGA 自己的夜间模式是在 cookie（bbsmisccookies → uisetting）里、
   * 由 js_color3.js 换掉一堆色值实现的，没有 class 也没有 CSS 变量。
   * 所以：
   *   1. 先读 NGA 自己的主题色 window.__COLOR（js_color3.js 的产物）；
   *   2. 再量一个**原生**元素的背景色作兜底；
   *   3. 都没有就按深色算（NGA 的经典皮肤就是深色）。
   *
   * 为什么不能量 body：接管之后 body 的背景已经被我们自己的 CSS 用
   * !important 覆盖成 --cx-bg 了 —— 量它就等于量自己，“跟随站点”
   * 会变成“跟随上一次的结果”，永远不会真的跟随。
   */
  function isDarkMode() {
    const want = themeOverride();
    if (want) return want === "dark";

    const c = typeof window !== "undefined" ? window.__COLOR : null;
    if (c) {
      for (const k of ["bg0", "bg1", "bg2", "bg4"]) {
        const l = lumOf(c[k]);
        if (l !== null) return l < 128;
      }
    }

    try {
      for (const sel of ["#m_posts", "#m_threads", "#mmc", "#minWidthSpacer"]) {
        const node = document.querySelector(sel);
        if (!node) continue;
        const l = lumOf(getComputedStyle(node).backgroundColor);
        if (l !== null) return l < 128;
      }
    } catch { /* 量不到就算了 */ }

    return true;
  }

  function syncMode() {
    document.documentElement.classList.toggle(LIGHT_CLASS, !isDarkMode());
  }

  function syncModeBtn() {
    const btn = document.querySelector(".ngax-rail [data-mode-toggle]");
    if (!btn) return;
    const dark = isDarkMode();
    btn.innerHTML = dark ? ic("sun") : ic("moon");
    btn.title = dark ? "切换到光明模式" : "切换到黑暗模式";
  }

  /**
   * 「跟随站点」在 document-start 是**没法**知道站点主题的：
   * NGA 的主题色来自 js_color3.js（或它的其它变体 js_color.js / 1 / 2），
   * 那是解析到一半才被 document.write 出来的外部脚本。
   *
   * 而我们在首帧就得把原生页面藏掉，那时只能按深色猜（也是 Codex 的默认）。
   * 如果用户其实是亮色主题，就会看到「深色底 → 亮色底」那一下。
   *
   * 所以这里在开始的一秒内短轮询几次：__COLOR 一出现就立刻纠正明暗、
   * 顺便把 favicon 也补上（那时 document.head 通常已经存在了）。
   * 成本是每秒最多几十次属性读，确认到就立刻停。
   */
  function watchThemeColor() {
    if (cfg("theme") !== "auto") return;
    let tries = 0;
    const tick = () => {
      if (typeof window !== "undefined" && window.__COLOR) {
        syncMode();
        applyFavicon();
        return;
      }
      if (++tries > 40) return; // ≈1s，够 js_color*.js 执行完了
      setTimeout(tick, 25);
    };
    setTimeout(tick, 25);
  }

  /* ============================== BBSCode 渲染器 ==============================
   *
   * NGA 的正文是 BBSCode（[b] [quote] [s:ac:哭笑] [img]./mon_…[/img]），
   * 正常情况下站点自己的 ubbcode 模块会把它渲染成 HTML，脚本读到的就是 HTML。
   * 但这个渲染器仍然必须有，原因有三个：
   *
   *   1. 兜底：附件模块是**异步**的，页面刚出来时正文里可能还留着
   *      字面量 [img]./mon_202609/16/xxx.jpg[/img] —— 脚本得自己把它变成图。
   *   2. 发帖预览：输入框里是纯 BBSCode，预览得渲染成人看的样子。
   *   3. 表情：表情表是从 js_bbscode_core.js 里抄下来的官方数据，
   *      自己渲染出来的和站点渲染的一模一样（同一个图床 URL）。
   *
   * 设计上刻意「只处理认识的标签，其余原样输出」：
   * 认不出来就留着方括号，绝对不会把正文吃掉。
   * ========================================================================== */

  /* #region bbcode */

    /* NGA 官方表情表：数据取自 js_bbscode_core.js 的 ubbcode.smiles */
  const NGA_SMILES = [
    /* AC娘(v1) */
    ...[["blink", "ac0.png"], ["goodjob", "ac1.png"], ["上", "ac2.png"], ["中枪", "ac3.png"], ["偷笑", "ac4.png"], ["冷", "ac5.png"], ["凌乱", "ac6.png"], ["吓", "ac8.png"], ["吻", "ac9.png"], ["呆", "ac10.png"], ["咦", "ac11.png"], ["哦", "ac12.png"], ["哭", "ac13.png"], ["哭1", "ac14.png"], ["哭笑", "ac15.png"], ["喘", "ac17.png"], ["心", "ac23.png"], ["囧", "ac21.png"], ["晕", "ac33.png"], ["汗", "ac34.png"], ["瞎", "ac35.png"], ["羞", "ac36.png"], ["羡慕", "ac37.png"], ["委屈", "ac22.png"], ["忧伤", "ac24.png"], ["怒", "ac25.png"], ["怕", "ac26.png"], ["惊", "ac27.png"], ["愁", "ac28.png"], ["抓狂", "ac29.png"], ["哼", "ac16.png"], ["喷", "ac18.png"], ["嘲笑", "ac19.png"], ["嘲笑1", "ac20.png"], ["抠鼻", "ac30.png"], ["无语", "ac32.png"], ["衰", "ac40.png"], ["黑枪", "ac44.png"], ["花痴", "ac38.png"], ["闪光", "ac43.png"], ["擦汗", "ac31.png"], ["茶", "ac39.png"], ["计划通", "ac41.png"], ["反对", "ac7.png"], ["赞同", "ac42.png"]].map(([n,f]) => [n, f, "ac"]),
    /* AC娘(v2) */
    ...[["goodjob", "a2_02.png"], ["诶嘿", "a2_05.png"], ["偷笑", "a2_03.png"], ["怒", "a2_04.png"], ["笑", "a2_07.png"], ["那个…", "a2_08.png"], ["哦嗬嗬嗬", "a2_09.png"], ["舔", "a2_10.png"], ["鬼脸", "a2_14.png"], ["冷", "a2_16.png"], ["大哭", "a2_15.png"], ["哭", "a2_17.png"], ["恨", "a2_21.png"], ["中枪", "a2_23.png"], ["囧", "a2_24.png"], ["你看看你", "a2_25.png"], ["doge", "a2_27.png"], ["自戳双目", "a2_28.png"], ["偷吃", "a2_30.png"], ["冷笑", "a2_31.png"], ["壁咚", "a2_32.png"], ["不活了", "a2_33.png"], ["不明觉厉", "a2_36.png"], ["是在下输了", "a2_51.png"], ["你为猴这么", "a2_53.png"], ["干杯", "a2_54.png"], ["干杯2", "a2_55.png"], ["异议", "a2_47.png"], ["认真", "a2_48.png"], ["你已经死了", "a2_45.png"], ["你这种人…", "a2_49.png"], ["妮可妮可妮", "a2_18.png"], ["惊", "a2_19.png"], ["抢镜头", "a2_52.png"], ["yes", "a2_26.png"], ["有何贵干", "a2_11.png"], ["病娇", "a2_12.png"], ["lucky", "a2_13.png"], ["poi", "a2_20.png"], ["囧2", "a2_22.png"], ["威吓", "a2_42.png"], ["jojo立", "a2_37.png"], ["jojo立2", "a2_38.png"], ["jojo立3", "a2_39.png"], ["jojo立4", "a2_41.png"], ["jojo立5", "a2_40.png"]].map(([n,f]) => [n, f, "a2"]),
    /* 潘斯特 */
    ...[["举手", "pt00.png"], ["亲", "pt01.png"], ["偷笑", "pt02.png"], ["偷笑2", "pt03.png"], ["偷笑3", "pt04.png"], ["傻眼", "pt05.png"], ["傻眼2", "pt06.png"], ["兔子", "pt07.png"], ["发光", "pt08.png"], ["呆", "pt09.png"], ["呆2", "pt10.png"], ["呆3", "pt11.png"], ["呕", "pt12.png"], ["呵欠", "pt13.png"], ["哭", "pt14.png"], ["哭2", "pt15.png"], ["哭3", "pt16.png"], ["嘲笑", "pt17.png"], ["基", "pt18.png"], ["宅", "pt19.png"], ["安慰", "pt20.png"], ["幸福", "pt21.png"], ["开心", "pt22.png"], ["开心2", "pt23.png"], ["开心3", "pt24.png"], ["怀疑", "pt25.png"], ["怒", "pt26.png"], ["怒2", "pt27.png"], ["怨", "pt28.png"], ["惊吓", "pt29.png"], ["惊吓2", "pt30.png"], ["惊呆", "pt31.png"], ["惊呆2", "pt32.png"], ["惊呆3", "pt33.png"], ["惨", "pt34.png"], ["斜眼", "pt35.png"], ["晕", "pt36.png"], ["汗", "pt37.png"], ["泪", "pt38.png"], ["泪2", "pt39.png"], ["泪3", "pt40.png"], ["泪4", "pt41.png"], ["满足", "pt42.png"], ["满足2", "pt43.png"], ["火星", "pt44.png"], ["牙疼", "pt45.png"], ["电击", "pt46.png"], ["看戏", "pt47.png"], ["眼袋", "pt48.png"], ["眼镜", "pt49.png"], ["笑而不语", "pt50.png"], ["紧张", "pt51.png"], ["美味", "pt52.png"], ["背", "pt53.png"], ["脸红", "pt54.png"], ["脸红2", "pt55.png"], ["腐", "pt56.png"], ["星星眼", "pt57.png"], ["谢", "pt58.png"], ["醉", "pt59.png"], ["闷", "pt60.png"], ["闷2", "pt61.png"], ["音乐", "pt62.png"], ["黑脸", "pt63.png"], ["鼻血", "pt64.png"]].map(([n,f]) => [n, f, "pst"]),
    /* 外域三人组 */
    ...[["ROLL", "dt01.png"], ["上", "dt02.png"], ["傲娇", "dt03.png"], ["叉出去", "dt04.png"], ["发光", "dt05.png"], ["呵欠", "dt06.png"], ["哭", "dt07.png"], ["啃古头", "dt08.png"], ["嘲笑", "dt09.png"], ["心", "dt10.png"], ["怒", "dt11.png"], ["怒2", "dt12.png"], ["怨", "dt13.png"], ["惊", "dt14.png"], ["惊2", "dt15.png"], ["无语", "dt16.png"], ["星星眼", "dt17.png"], ["星星眼2", "dt18.png"], ["晕", "dt19.png"], ["注意", "dt20.png"], ["注意2", "dt21.png"], ["泪", "dt22.png"], ["泪2", "dt23.png"], ["烧", "dt24.png"], ["笑", "dt25.png"], ["笑2", "dt26.png"], ["笑3", "dt27.png"], ["脸红", "dt28.png"], ["药", "dt29.png"], ["衰", "dt30.png"], ["鄙视", "dt31.png"], ["闲", "dt32.png"], ["黑脸", "dt33.png"]].map(([n,f]) => [n, f, "dt"]),
    /* 企鹅 */
    ...[["战斗力", "pg01.png"], ["哈啤", "pg02.png"], ["满分", "pg03.png"], ["衰", "pg04.png"], ["拒绝", "pg05.png"], ["心", "pg06.png"], ["严肃", "pg07.png"], ["吃瓜", "pg08.png"], ["嘣", "pg09.png"], ["嘣2", "pg10.png"], ["冻", "pg11.png"], ["谢", "pg12.png"], ["哭", "pg13.png"], ["响指", "pg14.png"], ["转身", "pg15.png"]].map(([n,f]) => [n, f, "pg"]),
  ];

  const SMILE_MAP = (() => {
    const m = new Map();
    for (const row of NGA_SMILES) m.set(row[2] + ":" + row[0], row[1]);
    return m;
  })();

  /** ./mon_202609/16/xxx.jpg / attachments/mon_… → 可访问的绝对 URL */
  function resolveAttachUrl(u) {
    const s = String(u == null ? "" : u).trim().replace(/^["']|["']$/g, "");
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith("./")) return ATTACH_BASE + s.slice(2);
    if (/^\/?attachments\//i.test(s)) return "https://img.nga.cn/" + s.replace(/^\//, "");
    if (/^mon_\d{6}\//.test(s)) return ATTACH_BASE + s;
    return "";
  }

  /** [s:ac:哭笑] / [s:a2:doge] → <img>。认不出来的（比如旧版数字编号 [s:1]）返回 null */
  function smileTagHtml(code) {
    const file = SMILE_MAP.get(String(code));
    if (!file) return null;
    const name = String(code).split(":")[1] || "";
    return `<img class="ngax-smile" src="${SMILE_BASE}${file}" alt="${escapeHtml(name)}" title="[s:${escapeHtml(code)}]">`;
  }

  /** 从 [tag] 开始找配对的 [/tag]（要数嵌套，引用里套引用很常见） */
  function findCloseTag(src, tag, from) {
    let depth = 1, i = from;
    const open = "[" + tag, close = "[/" + tag + "]";
    while (i < src.length) {
      const o = src.indexOf(open, i);
      const c = src.indexOf(close, i);
      if (c < 0) return -1;
      if (o >= 0 && o < c) {
        const ch = src[o + open.length];
        if (ch === "]" || ch === "=") depth++;
        i = o + open.length;
        continue;
      }
      depth--;
      if (depth === 0) return c;
      i = c + close.length;
    }
    return -1;
  }

  /** 成对标签：BBSCode 名 → 输出标签 + 需要保留的属性 */
  const BB_SIMPLE_PAIRS = {
    b: "b", i: "i", u: "u", del: "del", sup: "sup", sub: "sub", h: "b"
  };

  /**
   * NGA 的「回复某楼」头部。会遇到的两种形态：
   *   [b]Reply to [pid=1,2,3]Reply[/pid] Post by [uid=4]名字[/uid] (2026-09-16 10:07)[/b]
   *   [pid=1,2,3]Reply[/pid] [b]Post by [uid=4]名字[/uid] (2026-09-16 10:07):[/b]
   * 所以 [b] / "Reply to" / 结尾的冒号都是可选的。
   */
  const RE_REPLY_HEAD = new RegExp(
    "^(?:\\[b\\])?\\s*(?:Reply to\\s*)?\\[(pid|tid)=([\\d,]+)\\]\\s*(?:Reply|Topic)\\s*\\[\\/(?:pid|tid)\\]" +
    "\\s*(?:\\[b\\])?\\s*Post\\s+by\\s*(?:\\[uid=(\\d*)\\]?([^\\[\\]]{0,40}?)\\[\\/uid\\]?)?" +
    "\\s*\\(([^)]{0,30})\\)\\s*:?\\s*(?:\\[\\/b\\])?", "i");

  /** 一行内联样式白名单：只放行安全的（颜色/字号/对齐），其余丢掉 */
  function safeStyle(style) {
    const out = [];
    String(style || "").split(";").forEach((part) => {
      const m = part.match(/^\s*(color|font-size|text-align|font-family|font-weight|font-style)\s*:\s*([^;]+)$/i);
      if (!m) return;
      const v = m[2].trim();
      // 值里不能出现 url( / expression( / javascript: 这类东西
      if (/url\s*\(|expression|javascript:/i.test(v)) return;
      out.push(m[1] + ":" + v);
    });
    return out.join(";");
  }

  function bbTagAt(src, i, ctx) {
    const rest = src.slice(i);
    let m;

    // —— NGA 自动生成的「回复某楼」头部 ——
    // 点「回复」时 NGA 会在正文开头插一段：
    //   [b]Reply to [pid=824921217,44191387,1]Reply[/pid] Post by [uid=360579]某人[/uid] (2025-05-26 17:37)[/b]
    // 注意 pid 是**逗号分隔的三段**（pid,tid,楼层），不是纯数字 ——
    // 这个必须在通用 [pid=] 处理器和 [b] 处理器之前拦下来，
    // 否则要么漏掉后面两段，要么被 [b] 吞进去当成普通粗体。
    // 楼层号这时候还不知道（要等 DOM 阶段查 pidMap），所以先放 data-* 属性，
    // 交给 upgradeReplyHeads() 补。
    if ((m = rest.match(RE_REPLY_HEAD))) {
      // 捕获组顺序：1=pid|tid 2=id列表 3=uid 4=名字 5=时间
      const kind = m[1].toLowerCase();
      const pid = kind === "pid" ? String(m[2]).split(",")[0] : "";
      const tid = kind === "tid" ? String(m[2]).split(",")[0] : "";
      const uid = m[3] || "";
      const name = (m[4] || "").trim();
      const time = (m[5] || "").trim();
      return {
        html: '<span class="ngax-replyhead"' +
          (pid ? ' data-pid="' + escapeHtml(pid) + '"' : "") +
          (tid ? ' data-tid="' + escapeHtml(tid) + '"' : "") +
          ' data-uid="' + escapeHtml(uid) + '"' +
          ' data-name="' + escapeHtml(name) + '"' +
          ' data-time="' + escapeHtml(time) + '">' +
          "回复 " + (name ? '<b class="ngax-replyhead-name">' + escapeHtml(name) + "</b>" : "") +
          (time ? '<span class="ngax-replyhead-time">' + escapeHtml(time) + "</span>" : "") +
          "</span>",
        end: i + m[0].length
      };
    }

    // —— 表情 ——
    if ((m = rest.match(/^\[s:([^\]\[]{1,24})\]/))) {
      const html = smileTagHtml(m[1]);
      if (html) return { html, end: i + m[0].length };
      return null;
    }

    // —— 图片：[img] / [img=120,80] ——
    if ((m = rest.match(/^\[img(?:=[^\]]{0,20})?\]([\s\S]*?)\[\/img\]/i))) {
      const url = resolveAttachUrl(m[1].split(/\s+/)[0]);
      if (url) return { html: `<img src="${escapeHtml(url)}" alt="" loading="lazy">`, end: i + m[0].length };
      return null;
    }

    // —— 链接：[url]x[/url] / [url=href]x[/url] ——
    if ((m = rest.match(/^\[url(?:=([^\]]+))?\]([\s\S]*?)\[\/url\]/i))) {
      const href = String(m[1] || m[2] || "").trim();
      const text = String(m[2] || "").trim();
      const safe = /^(https?:|\/|\.\/)/i.test(href) ? href : "";
      if (!safe) return null;
      return {
        html: `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener nofollow">${escapeHtml(text || safe)}</a>`,
        end: i + m[0].length
      };
    }

    // —— 用户 / 帖子 / 版面引用：[uid=123]名字[/uid] [tid=1]标题[/tid] [pid=1,2,3]…[/pid] ——
    // 注意 pid/tid 常见逗号分段（pid,tid,楼层），所以不能只认 \d。
    if ((m = rest.match(/^\[(uid|tid|pid|stid)=([\d,]*)\]([\s\S]*?)\[\/\1\]/i))) {
      const kind = m[1].toLowerCase(), id = String(m[2]).split(",")[0], label = m[3];
      if (kind === "uid" && id) return { html: `<a class="ngax-mention" href="/nuke.php?func=ucp&uid=${id}">${escapeHtml(label || id)}</a>`, end: i + m[0].length };
      if (kind === "tid" && id) return { html: `<a class="ngax-mention" href="/read.php?tid=${id}">${escapeHtml(label || ("tid " + id))}</a>`, end: i + m[0].length };
      if (kind === "pid" && id) return { html: `<a class="ngax-mention" data-jump-pid="${id}" href="/read.php?tid=${(ctx && ctx.tid) || ""}&pid=${id}">${escapeHtml(label || "引用")}</a>`, end: i + m[0].length };
      return { html: escapeHtml(label), end: i + m[0].length };
    }

    // —— 成对样式标签 ——
    for (const key of Object.keys(BB_SIMPLE_PAIRS)) {
      if (!rest.startsWith("[" + key + "]")) continue;
      const inner0 = i + key.length + 2;
      const close = findCloseTag(src, key, inner0);
      if (close < 0) return null;
      const inner = src.slice(inner0, close);
      const tag = BB_SIMPLE_PAIRS[key];
      return {
        html: `<${tag}>${bbscodeToHtml(inner, ctx)}</${tag}>`,
        end: close + key.length + 3
      };
    }

    // —— 代码块：原样输出，不做任何转换 ——
    if (rest.startsWith("[code]")) {
      const close = findCloseTag(src, "code", i + 6);
      if (close < 0) return null;
      const inner = src.slice(i + 6, close);
      return { html: `<pre class="ngax-code">${escapeHtml(inner)}</pre>`, end: close + 7 };
    }
    if ((m = rest.match(/^\[code(?:=([a-z]+))?\]/i))) {
      const close = findCloseTag(src, "code", i + m[0].length);
      if (close < 0) return null;
      const inner = src.slice(i + m[0].length, close);
      return { html: `<pre class="ngax-code" data-lang="${escapeHtml(m[1] || "")}">${escapeHtml(inner)}</pre>`, end: close + 7 };
    }

    // —— 折叠 ——
    if ((m = rest.match(/^\[collapse(?:=([^\]]{0,80}))?\]/i))) {
      const close = findCloseTag(src, "collapse", i + m[0].length);
      if (close < 0) return null;
      const inner = src.slice(i + m[0].length, close);
      const label = m[1] || "展开";
      return {
        html: `<details class="ngax-collapse"><summary>${escapeHtml(label)}</summary>` +
          `<div class="ngax-collapse-body">${bbscodeToHtml(inner, ctx)}</div></details>`,
        end: close + 11
      };
    }

    // —— 引用。NGA 自己会渲染成 div.quote，这里只兜底；兜底时输出同样的 class，
    //     好让 upgradeQuotes() 统一处理成引用卡片 ——
    if (rest.startsWith("[quote]")) {
      const close = findCloseTag(src, "quote", i + 7);
      if (close < 0) return null;
      const inner = src.slice(i + 7, close);
      return { html: `<div class="quote">${bbscodeToHtml(inner, ctx)}</div>`, end: close + 8 };
    }

    // —— 列表 ——
    if ((m = rest.match(/^\[list(=[^\]]{0,8})?\]/i))) {
      const close = findCloseTag(src, "list", i + m[0].length);
      if (close < 0) return null;
      const inner = src.slice(i + m[0].length, close);
      const ordered = /=[a1]/i.test(m[1] || "");
      const tag = ordered ? "ol" : "ul";
      const items = inner.split(/\[\*\]/).map((s) => s.trim()).filter(Boolean)
        .map((s) => `<li>${bbscodeToHtml(s, ctx)}</li>`).join("");
      return { html: `<${tag} class="ngax-list">${items}</${tag}>`, end: close + 7 };
    }

    // —— 表格：NGA 的表格语法是 [table][tr][td]…[/td][/tr][/table] ——
    if (rest.startsWith("[table")) {
      const mTable = rest.match(/^\[table(?:=[^\]]{0,20})?\]/i);
      const close = findCloseTag(src, "table", i + mTable[0].length);
      if (close < 0) return null;
      const inner = src.slice(i + mTable[0].length, close);
      const rows = [];
      const re = /\[tr(?:=[^\]]{0,10})?\]([\s\S]*?)\[\/tr\]/gi;
      let r;
      while ((r = re.exec(inner))) {
        const cells = [];
        const ce = /\[td(?:=[^\]]{0,20})?\]([\s\S]*?)\[\/td\]/gi;
        let c;
        while ((c = ce.exec(r[1]))) cells.push(`<td>${bbscodeToHtml(c[1].trim(), ctx)}</td>`);
        if (cells.length) rows.push(`<tr>${cells.join("")}</tr>`);
      }
      return { html: `<table class="ngax-table">${rows.join("")}</table>`, end: close + 8 };
    }

    // —— 颜色 / 字号 / 对齐 / 字体：只留样式，不留标签 ——
    if ((m = rest.match(/^\[(color|size|font|align)=([^\]]{0,40})\]/i))) {
      const kind = m[1].toLowerCase(), val = m[2];
      const close = findCloseTag(src, kind, i + m[0].length);
      if (close < 0) return null;
      const inner = src.slice(i + m[0].length, close);
      let style = "";
      if (kind === "color") style = "color:" + val;
      else if (kind === "size") style = "font-size:" + (Number(val) <= 200 ? Math.min(200, Number(val)) + "%" : "120%");
      else if (kind === "font") style = "font-family:" + val.replace(/["'<>]/g, "");
      else style = "text-align:" + val;
      return {
        html: `<span style="${safeStyle(style)}">${bbscodeToHtml(inner, ctx)}</span>`,
        end: close + kind.length + 3
      };
    }

    // —— @某人：NGA 的提及语法就是 [@名字] ——
    if ((m = rest.match(/^\[@([^\]\s]{1,32})\]/))) {
      const name = m[1];
      return {
        html: `<button type="button" class="ngax-mention" data-act="reply" data-user="${escapeHtml(name)}" title="回复 @${escapeHtml(name)}">@${escapeHtml(name)}</button>`,
        end: i + m[0].length
      };
    }

    return null;
  }

  /**
   * 把 BBSCode 转成 HTML。
   *
   * 关键：输入**可能是 HTML**（正文就是 HTML，只是里头漏了一两个 BBSCode），
   * 所以扫描时遇到 `<…>` 一律原样跳过，只处理方括号。
   * 预览场景先把纯文本 escape 一遍再喂进来即可。
   */
  function bbscodeToHtml(input, ctx) {
    const src = String(input == null ? "" : input);
    let out = "", i = 0, guard = 0;
    while (i < src.length && guard++ < 200000) {
      const ch = src[i];
      if (ch === "<") {
        const j = src.indexOf(">", i);
        if (j < 0) { out += src.slice(i); break; }
        out += src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (ch === "[") {
        const t = bbTagAt(src, i, ctx);
        if (t) { out += t.html; i = t.end; continue; }
      }
      out += ch === "\n" ? "<br>" : ch;
      i++;
    }
    return out;
  }

  /* #endregion bbcode */

  /* ============================== 正文渲染管线 ==============================
   *
   * cleanContent → BBSCode 兜底 → 引用卡片升级 → 图片标记
   * 顺序不能换：BBSCode 兜底要在引用升级之前（兜底会生成 div.quote），
   * 图片标记要在最后（升级引用时会把引用里的图换成占位符）。
   * ====================================================================== */

  /** 楼层号 → 引用卡片里的「#N」。NGA 楼层是 0 基的，0 是楼主 */
  function floorLabel(i) {
    return i === 0 ? "楼主" : "#" + i;
  }

  /** pid → 楼层索引（给引用卡片的跳转用） */
  function buildPidMap(posts) {
    const m = new Map();
    (posts || []).forEach((p) => { if (p.pid) m.set(String(p.pid), p.i); });
    return m;
  }

  /**
   * 引用卡片升级。
   *
   * NGA 自己渲染的引用是 <div class='quote'>，里面第一段是
   *   [pid=881891670]Reply[/pid] [b]Post by [uid=123]某人[/uid] (2026-09-16 10:07):[/b]
   * 这行的形态随版本变过好几次（也见过只剩 "Reply to 某人 (时间):" 的），
   * 所以这里用一串宽松正则去抠，抠不到就退化成「只显示引用内容」——
   * 引用的正文永远不会丢。
   */
  function upgradeQuotes(root, ctx) {
    root.querySelectorAll("div.quote").forEach((q) => {
      if (q.dataset.ngaxDone === "1") return;
      q.dataset.ngaxDone = "1";

      let pid = "", name = "", time = "";

      // 优先用 BBSCode 阶段已经认出来的头部元素（最准，而且能把头部从正文里拿掉）
      const rh = q.querySelector(".ngax-replyhead");
      if (rh) {
        pid = rh.dataset.pid || "";
        name = rh.dataset.name || (rh.dataset.tid ? "楼主" : "");
        time = rh.dataset.time || "";
        rh.remove();
      }

      // 退路：站点自己渲染过一遍，头部变成了纯文本，用宽松正则抠
      if (!pid && !name) {
        const head0 = (q.textContent || "").slice(0, 220);
        let m;
        if ((m = head0.match(/\[pid=([\d,]+)\]\s*Reply\s*\[\/pid\][\s\S]{0,40}?Post by\s*\[uid=\d*\]?([^\[\]]*?)\[\/uid\]?\s*\(([^)]+)\)/i))) {
          pid = m[1].split(",")[0]; name = m[2].trim(); time = m[3].trim();
        } else if ((m = head0.match(/\[pid=([\d,]+)\]/i))) {
          pid = m[1].split(",")[0];
          const n = head0.match(/Post by\s*\[uid=\d*\]?([^\[\]]*?)\[\/uid\]?/i)
            || head0.match(/Reply to\s*\[uid=\d*\]?([^\[\]]*?)\[\/uid\]?/i);
          if (n) name = n[1].trim();
          const t = head0.match(/\((\d{4}-\d{2}-\d{2} \d{2}:\d{2})\)/);
          if (t) time = t[1];
        } else if (/\[tid=[\d,]+\]\s*Topic\s*\[\/tid\]/i.test(head0)) {
          name = name || "楼主";
        }

        // 从正文里把那段头部抠掉（能抠掉就抠，抠不掉也只是多显示一行，
        // 比「把引用内容删了」安全得多）
        const walker = document.createTreeWalker(q, NodeFilter.SHOW_TEXT, null);
        const first = walker.nextNode();
        if (first && /\[pid=|\[tid=|Post by|Reply to/.test(first.nodeValue || "")) {
          first.nodeValue = String(first.nodeValue)
            .replace(/^\s*\[(?:pid|tid)=[\d,]+\]\s*(?:Reply|Topic)\s*\[\/(?:pid|tid)\]\s*/i, "")
            .replace(/^\s*\[b\]\s*/i, "")
            .replace(/^\s*Post by\s*\[uid=\d*\]?[^\[\]]*?\[\/uid\]?\s*\([^)]*\)\s*:?\s*\[\/b\]\s*/i, "")
            .replace(/^\s*Reply to\s*\[uid=\d*\]?[^\[\]]*?\[\/uid\]?\s*\([^)]*\)\s*:?\s*/i, "");
        }
      }

      // 楼层号：NGA 的 pid=0 就是楼主那层（楼主没有独立的 pid），
      // 其它 pid 拿 pidMap 反查；查不到（比如引用了别的帖子）就退化成「引用」。
      const floor = pid === ""
        ? undefined
        : (pid === "0" ? 0 : (ctx && ctx.pidMap ? ctx.pidMap.get(String(pid)) : undefined));
      const label = floor !== undefined ? floorLabel(floor) : "引用";
      const body = q.innerHTML
        // 引用里的图换成占位符：原楼层已经有大图了，重复显示只会撑爆布局
        .replace(/<img\b[^>]*>/gi, '<span class="ngax-quote-img">[图片]</span>');
      const link = pid === ""
        ? ""
        : "/read.php?tid=" + (ctx && ctx.tid ? ctx.tid : "") + (pid === "0" ? "" : "&pid=" + pid);

      const card = el("div", "ngax-quote" + (cfg("quoteOpen") ? " open" : ""));
      card.innerHTML =
        '<div class="ngax-quote-head">' +
        '<span class="ngax-quote-ic">' + ic("quote") + "</span>" +
        '<span class="ngax-quote-title">' + escapeHtml(label) +
        (name ? " · " + escapeHtml(name) : "") + "</span>" +
        (time ? '<span class="ngax-quote-time">' + escapeHtml(time) + "</span>" : "") +
        (link ? '<a class="ngax-quote-jump" href="' + escapeHtml(link) + '" data-jump-pid="' + escapeHtml(pid) +
          '" title="跳到该楼层">' + ic("external") + "</a>" : "") +
        '<span class="ngax-quote-chev"></span>' +
        "</div>" +
        '<div class="ngax-quote-body">' + body + "</div>";
      q.replaceWith(card);
    });
  }

  /**
   * 不在引用里、而是直接写在正文开头的「回复某楼」头部：
   * 补上楼层号，并把它变成可点的跳转。
   * （在引用里的那些已经被 upgradeQuotes 吸收成卡片头了，这里查不到。）
   */
  function upgradeReplyHeads(root, ctx) {
    root.querySelectorAll(".ngax-replyhead").forEach((rh) => {
      const pid = rh.dataset.pid || "";
      const floor = pid && ctx && ctx.pidMap ? ctx.pidMap.get(String(pid)) : undefined;
      if (floor === undefined) return;
      if (rh.dataset.ngaxDone === "1") return;
      rh.dataset.ngaxDone = "1";
      const label = document.createElement("span");
      label.className = "ngax-replyhead-floor";
      label.textContent = floorLabel(floor);
      const jump = document.createElement("a");
      jump.className = "ngax-replyhead-jump";
      jump.href = "/read.php?tid=" + ((ctx && ctx.tid) || "") + "&pid=" + pid;
      jump.dataset.jumpPid = pid;
      jump.title = "跳到该楼层";
      jump.innerHTML = ic("external");
      rh.insertBefore(document.createTextNode(" "), rh.firstChild);
      rh.insertBefore(label, rh.firstChild);
      rh.appendChild(jump);
    });
  }

  /**
   * 把 URL 归一化成「同一张附件」的指纹，用来去重。
   *
   * NGA 同一张附件会以多种 URL 出现。实测同一个楼层里同时存在：
   *   正文 [img] 里：  ./mon_202609/16/-7Q44-454xZaT3cSng-sg.jpg.medium.jpg   ← 中等尺寸变体
   *   附件元数据里：   mon_202609/16/-7Q44-454xZaT3cSng-sg.jpg              ← 原图
   * 只比文件名（我之前就是）会把它们当成两张图 → **同一张图渲染两遍**。
   * 所以这里把 NGA 的尺寸变体后缀统一剥掉再比。
   *
   * 顺便：之所以能确定「原生是只显示一遍」，是因为 NGA 的 attach 模块签名是
   * ubbcode.attach.load(spanId, contentId, list, …) —— 它特意把正文元素的 id
   * 传进去了，就是为了跳过已经写在正文里的附件。
   */
  function attachKey(url) {
    const s = String(url || "");
    if (!s) return "";
    let base = s.split(/[?#]/)[0].split("/").pop() || "";
    try { base = decodeURIComponent(base); } catch { /* 不是编码过的就算了 */ }
    return base
      .toLowerCase()
      // xxx.jpg.medium.jpg / xxx.png.medium.png …
      .replace(/\.(medium|thumb|small|big|original|tmp)\.(jpe?g|png|gif|webp|bmp)$/i, "")
      // xxx.jpg.thumb / xxx.jpg.tmp …
      .replace(/\.(thumb|medium|tmp)$/i, "")
      // thumb_xxx.jpg …
      .replace(/^thumb_/, "");
  }

  /** 滚动到某个元素（jsdom / 老浏览器没有 scrollIntoView，别因此把点击处理器炸掉） */
  function scrollNearest(node) {
    if (node && typeof node.scrollIntoView === "function") {
      try { node.scrollIntoView({ block: "nearest" }); } catch { /* ignore */ }
    }
  }

  /**
   * 一个版面条目：名字（链接）+ 收藏星标。
   *
   * 两种形态：版面用 ?fid=，**合集**用 ?stid=（同一个宿主版面下有上百个合集，
   * 链接写错就会点进另一个版面）。合集暂不给星标 —— 站点的收藏是按
   * f+fid / t+stid 两种 key 存的，合集那条路径没做，宁可没有也不要写错。
   */
  function boardChipHtml(f, fav) {
    const isColl = !!f.stid;
    const href = isColl ? "/thread.php?stid=" + encodeURIComponent(f.stid)
      : "/thread.php?fid=" + encodeURIComponent(f.fid);
    const dup = !isColl && BOARD_NAME_DUP.has(f.name);
    const label = f.name + (dup ? " (" + f.fid + ")" : "");
    const tip = f.info || f.sub || (isColl ? "合集" : "");
    return '<span class="ngax-bitem">' +
      '<a class="ngax-pill" href="' + href + '"' +
      (tip ? ' title="' + escapeHtml(tip) + '"' : "") + ">" +
      escapeHtml(label) + "</a>" +
      (isColl
        ? '<span class="ngax-bstar off" title="合集（不参与收藏）">·</span>'
        : '<button type="button" class="ngax-bstar' + (fav !== undefined ? fav : isFavForum(f.fid) ? " on" : "") +
          '" data-fav-board="' + escapeHtml(String(f.fid)) + '" title="收藏版面">' +
          (isFavForum(f.fid) ? "★" : "☆") + "</button>") +
      "</span>";
  }

  /**
   * 首页的版面大全。
   *
   * 按**站点自己的分类目录**分组（分类 → 分组 → 版面），而不是一坨按拼音排的平铺：
   * 那份目录来自首页的 CDN 文件（见 extract-cats.py），顺序也是站点自己的顺序。
   * 目录里没有的版面（爬表是超集）归到最后的「其它版面」。
   *
   * 搜索是前端筛选：隐藏不匹配的条目，再把空的分组 / 分类一起隐藏掉。
   */
  function boardDirectoryHtml(page) {
    const map = allForums();
    const favs = boardBookmarks().map((b) => String(b.fid));
    const favList = favs.map((k) => map.get(k)).filter(Boolean);

    // 目录里已经出现过的 fid（剩下的进「其它版面」）
    const claimed = new Set();
    const cats = indexCats().map((c) => {
      const groups = (c.groups || []).map((g) => {
        // 直接按分类表里的条目建（合集也在里面，而且不能用版面表去查）
        const boards = (g.boards || []).map((b) => ({
          fid: b[0], stid: b[1] || 0, name: b[2] || "", info: b[3] || ""
        }));
        boards.forEach((b) => { if (!b.stid) claimed.add(String(b.fid)); });
        return { name: g.name || "", boards };
      }).filter((g) => g.boards.length);
      return { name: c.name, groups, count: groups.reduce((n, g) => n + g.boards.length, 0) };
    }).filter((c) => c.groups.length);

    const others = Array.from(map.values())
      .filter((f) => !claimed.has(String(f.fid)))
      // 其它版面按名字排（剥掉开头全角标点，否则「“每周一歌”」会跑到最前面）
      .sort((a, b) => sortBoardName(a.name).localeCompare(sortBoardName(b.name), "zh"));

    const catHtml = (c) => `
      <div class="ngax-bcat" data-board-cat>
        <div class="ngax-bcat-head"><span>${escapeHtml(c.name)}</span><span class="ngax-bcat-count">${c.count}</span></div>
        ${c.groups.map((g) => `
          <div class="ngax-bgroup" data-board-group>
            ${g.name ? `<div class="ngax-bgroup-head">${escapeHtml(g.name)}</div>` : ""}
            <div class="ngax-board-grid">${g.boards.map((b) => boardChipHtml(b)).join("")}</div>
          </div>`).join("")}
      </div>`;

    return `
      <div class="ngax-head">
        <div class="ngax-head-title">
          <button class="ngax-filter-btn" title="展开 / 收起版面大全">${ic("filter")}</button>
          <h1>版面大全</h1>
        </div>
        <a class="ngax-new-topic-btn" href="https://bbs.nga.cn/thread.php?fid=-7" target="_blank" rel="noopener">${ic("external")}原生首页</a>
      </div>
      <div class="ngax-head-desc">共 ${map.size} 个版面 · 分类和简介来自站点自己的目录（${indexCats().length} 个分类），目录外的归入「其它版面」</div>

      ${favList.length ? `
        <div class="ngax-set-section">收藏的版面（${favList.length}）</div>
        <div class="ngax-board-grid" data-fav-grid>${favList.map((f) => boardChipHtml(f, true)).join("")}</div>
      ` : `
        <div class="ngax-set-section">收藏的版面</div>
        <div class="ngax-empty">还没有收藏。点任意版面旁边的 ☆ 就能收藏（写回站点，和原生首页那个勾选同一份数据）。</div>
      `}

      <div class="ngax-set-section">全部版面（${map.size}）</div>
      <input class="ngax-search-input" data-board-filter type="search"
        placeholder="筛选版面（名字，如「魔兽」「手机」）…" autocomplete="off">

      ${cats.map(catHtml).join("")}

      ${others.length ? catHtml({ name: "其它版面", count: others.length, groups: [{ name: "", boards: others }] }) : ""}

      <div class="ngax-list-status" data-board-empty style="display:none">没有匹配的版面</div>

      ${(page.blocks && page.blocks.length) ? `
        <div class="ngax-set-section">头条</div>
        ${page.blocks.map((b) => `
          <div class="ngax-hl-sub">${escapeHtml(b.kind || "")}</div>
          <div class="ngax-hl-grid">${b.items.map(headlineHtml).join("")}</div>
        `).join("")}
      ` : ""}
    `;
  }

  /** 首页 —— 返回 false 表示认不出内容，让调用方退回原生页 */
  function renderHome(inner, page) {
    const blocks = page.blocks || [];
    const total = blocks.reduce((n, b) => n + b.items.length, 0);
    // 以前：没有 indexBlock 就不接管。现在版面大全是主要功能，
    // 头条只是附加内容，所以只要本地版面表非空就能接管。
    if (!total && !allForums().size) return false;
    inner.innerHTML = boardDirectoryHtml(page);
    return true;
  }

  /**
   * 一个楼层的正文 → 可以塞进页面的 HTML。
   *
   * 附件有两个来源，都得收：
   *   1. #postattachN —— 原生 attach 模块异步渲染的结果；
   *   2. 行内脚本里的附件元数据 —— 模块还没跑（或者根本没跑）时的兜底。
   * 两条路都要按**文件名**去重：同一张图在正文里写作
   * [img]./mon_202609/16/xxx.jpg[/img]，在元数据里是 mon_202609/16/xxx.jpg，
   * 原生渲染出来还可能带缩略图后缀 —— 只比 URL 全串一定会重复显示。
   */
  function renderPostContent(post, ctx) {
    const holder = el("div", "ngax-raw");
    holder.innerHTML = bbscodeToHtml(cleanContent(post.contentHtml), ctx);

    const seen = new Set();
    holder.querySelectorAll("img").forEach((i) => seen.add(attachKey(i.getAttribute("src"))));

    const extra = [];
    const push = (url) => {
      const key = attachKey(url);
      if (!key || seen.has(key)) return;
      seen.add(key);
      extra.push(url);
    };

    if (post.attachHtml) {
      const t = el("div");
      t.innerHTML = cleanContent(post.attachHtml);
      t.querySelectorAll("img").forEach((i) => {
        const src = i.getAttribute("src") || "";
        try { push(src ? new URL(src, location.href).href : ""); } catch { push(src); }
      });
    }
    (post.attachUrls || []).forEach((u) => {
      const abs = resolveAttachUrl(u);
      if (abs) push(abs);
    });

    if (extra.length) {
      const box = el("div", "ngax-attach");
      box.innerHTML = extra.map((u) =>
        '<img src="' + escapeHtml(u) + '" alt="" loading="lazy">').join("");
      holder.appendChild(box);
    }

    upgradeQuotes(holder, ctx);
    upgradeReplyHeads(holder, ctx);
    return holder.innerHTML;
  }

  /* ============================== 主区骨架 ============================== */

  function ensureMain() {
    let main = document.querySelector(".ngax-main");
    if (main) return main;

    main = el("main", "ngax-main");
    main.innerHTML = `
      <div class="ngax-thread-col">
        <header class="ngax-topbar">
          <button class="ngax-icon-btn ngax-menu-btn" title="打开侧栏">${ic("menu")}</button>
          <a class="ngax-icon-btn" href="/" title="回首页">${ic("home")}</a>
          <div class="ngax-crumb">
            <span class="ngax-proj"></span>
            <span class="ngax-sep">/</span>
            <span class="ngax-model"></span>
          </div>
          <div class="ngax-spacer"></div>
          <div class="ngax-icon-btn" data-settings-open title="设置（Ctrl+,）">${ic("gear")}</div>
          <div class="ngax-icon-btn ngax-panel-toggle" data-panel-toggle title="显示 / 隐藏代码面板">${ic("panel")}</div>
          <a class="ngax-icon-btn" href="${escapeHtml(location.href)}" target="_blank" rel="noopener" title="在 NGA 原生界面打开">${ic("external")}</a>
          <div class="ngax-icon-btn" title="复制当前链接" data-copy-link>${ic("dots")}</div>
        </header>
        <div class="ngax-thread">
          <div class="ngax-thread-inner"></div>
        </div>
        <div class="ngax-composer-wrap">
          <div class="ngax-composer">
            <div class="ngax-md-edit" data-compose contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="写点什么…"></div>
            <div class="ngax-compose-preview" aria-live="polite"></div>
            <div class="ngax-composer-toolbar">${composerToolbarHtml()}</div>
            <div class="ngax-plus-pop" data-plus-pop>${PLUS_ITEMS.map((p, i) =>
              `<button type="button" data-plus-item="${i}">${escapeHtml(p.label)}</button>`).join("")}</div>
            <div class="ngax-smile-pop" data-smile-pop></div>
          </div>
        </div>
      </div>
      <aside class="ngax-code-panel">
        <div class="ngax-resizer" data-resize="panel" title="拖拽调整分栏宽度（双击重置）"></div>
        <div class="ngax-code-tabs">
          <div class="ngax-code-tab">
            <span class="ngax-rs-ic" data-code-icon>RS</span>
            <span data-code-file-name>lib.rs</span>
            <span class="ngax-close" title="关闭代码面板">×</span>
          </div>
          <span class="ngax-code-add" title="新建标签（装饰）">＋</span>
          <div class="ngax-code-tabs-actions">
            <span class="ngax-icon-btn" title="放大（装饰）">${ic("expand")}</span>
            <span class="ngax-icon-btn" title="分栏（装饰）">${ic("panel")}</span>
            <span class="ngax-icon-btn" data-panel-toggle2 title="关闭面板">${ic("sidebar")}</span>
          </div>
        </div>
        <div class="ngax-code-crumb">
          <div class="ngax-crumbs">
            <span class="ngax-seg" data-code-crumb-root>service</span> ›
            <span class="ngax-seg" data-code-crumb-cat>forum</span> ›
            <span class="ngax-seg" data-code-crumb-dir>store</span> ›
            <span class="ngax-cur" data-code-crumb-file>lib.rs</span>
          </div>
          <span class="ngax-spacer"></span>
          <div class="ngax-code-view-toggle" data-code-view-toggle>
            <span class="on" data-v="code">代码</span><span data-v="diff">diff</span>
          </div>
          <button class="ngax-open-btn" data-lang-menu-btn>
            <span data-lang-label>Rust</span>${ic("chevronDown")}
          </button>
        </div>
        <div class="ngax-code-body" data-code-body></div>
        <div class="ngax-lang-menu" data-lang-menu></div>
      </aside>
    `;
    document.body.appendChild(main);

    // 事件绑定
    main.addEventListener("click", (e) => {
      const t = e.target;

      if (t.closest(".ngax-menu-btn")) {
        document.documentElement.classList.toggle("ngax-rail-open");
        return;
      }
      if (t.closest("[data-copy-link]")) {
        copyText(location.href);
        return;
      }
      if (t.closest("[data-panel-toggle]") || t.closest("[data-panel-toggle2]") ||
        t.closest(".ngax-code-tab .ngax-close")) {
        setPanelHidden(!panelHidden(), true);
        return;
      }
      const vt = t.closest("[data-code-view-toggle] span");
      if (vt) {
        main.querySelectorAll("[data-code-view-toggle] span").forEach((x) =>
          x.classList.toggle("on", x === vt));
        setCfg("codeMode", vt.dataset.v || "code", { visualOnly: true });
        renderCodePanel();
        return;
      }
      if (t.closest("[data-lang-menu-btn]")) {
        main.querySelector("[data-lang-menu]")?.classList.toggle("on");
        return;
      }
      const li = t.closest("[data-code-lang-item]");
      if (li) {
        setCfg("lang", li.dataset.codeLangItem, { visualOnly: true });
        main.querySelector("[data-lang-menu]")?.classList.remove("on");
        renderCodePanel();
        return;
      }
      if (t.closest(".ngax-filter-btn")) {
        main.classList.toggle("filters-open");
        return;
      }
      // 引用卡片展开 / 折叠
      if (t.closest(".ngax-quote-head")) {
        t.closest(".ngax-quote")?.classList.toggle("open");
        return;
      }
      // 折叠块里的引用：跳转到 pid
      const jump = t.closest("[data-jump-pid]");
      if (jump) {
        e.preventDefault();
        jumpToPid(jump.dataset.jumpPid);
        return;
      }
      // 思考块展开 / 折叠
      if (t.closest(".ngax-think-head")) {
        t.closest(".ngax-think")?.classList.toggle("open");
        return;
      }
      // 楼层操作
      const act = t.closest("[data-act]");
      if (act) {
        handleTurnAction(act, e);
        return;
      }
      // 用户页的动作按钮（更改密码 / 绑定手机号 …）：交回给原生元素
      const mAct = t.closest("[data-member-act]");
      if (mAct) {
        if (!clickNativeAction(mAct.dataset.memberAct)) {
          toastNow("没找到对应的原页按钮，请到原生页面操作");
        }
        return;
      }
      // 加载更多
      const more = t.closest("[data-more]");
      if (more && !more.dataset.busy) {
        loadMore(more);
        return;
      }
    });

    // 点击面板外收起语言菜单 / 表情面板
    document.addEventListener("click", (e) => {
      const menu = document.querySelector("[data-lang-menu]");
      if (menu && menu.classList.contains("on") &&
        !e.target.closest("[data-lang-menu]") && !e.target.closest("[data-lang-menu-btn]")) {
        menu.classList.remove("on");
      }
    });

    setPanelHidden(panelHidden(), false);
    bindResizers(main);
    bindComposer(main);
    return main;
  }

  /* ============================== 视图渲染 ============================== */

  let PAGE = null;       // 最近一次 collectPage() 的结果
  let MORE_PAGE = 1;     // 已加载到第几页
  let MORE_URL = null;   // 下一页地址

  function threadInner() {
    return document.querySelector(".ngax-main .ngax-thread-inner");
  }

  function syncChrome(page) {
    const main = document.querySelector(".ngax-main");
    if (!main) return;
    const r = page.route;
    const proj = main.querySelector(".ngax-proj");
    const model = main.querySelector(".ngax-model");

    if (r.kind === "thread" && page.thread) {
      proj.textContent = page.thread.forum || forumInfo(page.thread.fid).name || "主题";
      model.textContent = `${page.thread.title} · ${page.thread.posts.length} 楼`;
      model.title = page.thread.title; // 截断时悬停看全称
    } else if (r.kind === "list") {
      proj.textContent = brandName();
      model.textContent = `${listTitle(r, page)} · ${(page.list || []).length} 个主题`;
    } else if (r.kind === "member") {
      proj.textContent = "用户";
      model.textContent = page.member ? page.member.username + " · UID " + page.member.uid : "用户信息";
    } else {
      proj.textContent = brandName();
      model.textContent = "首页头条";
    }
    syncComposer(page);
  }

  /** 参与「要不要重渲染」判断的签名：原生 JS 异步补内容时靠它决定是否需要刷新 */
  function pageSignature(page) {
    const r = page.route;
    if (r.kind === "thread" && page.thread) {
      return "T" + page.thread.tid + "|" + page.thread.title + "|" +
        page.thread.posts.map((p) => [p.i, p.username, p.pid, p.contentHtml.length, p.attachHtml.length].join(":")).join(",");
    }
    if (r.kind === "list" && page.list) {
      return "L" + r.listKind + ":" + (r.fid || r.stid || r.key || r.authorId || "") + "|" +
        page.list.map((t) => [t.tid, t.replies, t.title.length, t.replier].join(":")).join(",");
    }
    if (r.kind === "home" && page.blocks) {
      return "H" + page.blocks.map((b) => b.kind + ":" + b.items.length).join(",");
    }
    if (r.kind === "member") {
      // 数据本身是内联的，但「动作按钮」要等 js_ucp.js 把 #ucp_block 建出来，
      // 所以签名里得带上它 —— 否则就永远不会有那排按钮。
      return "M" + r.uid + "|" + ((page.member && page.member.actions.length) || 0);
    }
    return "H";
  }

  function render() {
    const page = collectPage();
    PAGE = page;
    const r = page.route;
    syncTitle();

    if (!isSupported(r)) {
      // 不接管：只保留 rail，原生页面照旧
      document.documentElement.classList.remove(LOCK_CLASS);
      document.querySelector(".ngax-main")?.remove();
      ensureRail(page);
      bindResizers(null); // 未接管路由也有 rail 拖拽把手
      syncModeBtn();
      return;
    }

    document.documentElement.classList.add(LOCK_CLASS);
    ensureRail(page);
    ensureMain();
    syncChrome(page);

    const inner = threadInner();
    if (!inner) return;

    if (r.kind === "thread") renderThread(inner, page);
    else if (r.kind === "list") renderList(inner, page);
    else if (r.kind === "member") {
      if (!renderMember(inner, page)) {
        // 拿不到 __UCPUSER（比如碰到了 ucp 的其它子页面）—— 退回原生页
        document.documentElement.classList.remove(LOCK_CLASS);
        document.querySelector(".ngax-main")?.remove();
        return;
      }
    } else if (!renderHome(inner, page)) {
      // 首页结构认不出来（NGA 改版 / 没登录）—— 老实退回原生页面，
      // 别给用户一个空壳。rail 留着，所以导航还能用。
      document.documentElement.classList.remove(LOCK_CLASS);
      document.querySelector(".ngax-main")?.remove();
      return;
    }

    renderCodePanel();
  }

  /* ---------- 列表视图 ---------- */

  /** 行首的小圆点：有回复的实心一点，没回复的是空心（比头像省地方，也不那么像论坛） */
  function rowAvatarHtml(t) {
    const hot = num(t.replies) >= 50;
    const has = num(t.replies) > 0;
    return '<span class="ngax-row-avatar' + (has ? " has-replies" : "") + (hot ? " hot" : "") + '"></span>';
  }

  function rowHtml(t) {
    const sub = [];
    if (t.author) sub.push('<span class="ngax-node">@' + escapeHtml(t.author) + "</span>");
    if (t.replier && t.replier !== t.author) sub.push('<span class="ngax-replier">↳ ' + escapeHtml(t.replier) + "</span>");
    if (t.mark) sub.push('<span class="ngax-mark">' + escapeHtml(t.mark) + "</span>");

    return '<a class="ngax-row" href="' + escapeHtml(t.url) + '" title="' +
      escapeHtml(t.title + (t.author ? "  ·  由 " + t.author + " 发布" : "")) + '">' +
      rowAvatarHtml(t) +
      '<span class="ngax-row-texts">' +
      '<span class="ngax-row-title">' + escapeHtml(t.title) + "</span>" +
      '<span class="ngax-row-sub">' + sub.join("") + "</span>" +
      "</span>" +
      '<span class="ngax-row-meta">' +
      '<span class="ngax-replies">' + escapeHtml(shortNum(num(t.replies)) || "0") + "</span>" +
      '<span class="ngax-time">' + escapeHtml(formatTime(t.lastIso) || formatTime(t.timeIso) || t.lastRaw || t.timeRaw || "") + "</span>" +
      "</span>" +
      "</a>";
  }

  /**
   * 列表里的 agent 痕迹。列表页是最容易被一眼看穿的地方，
   * 所以在行与行之间按种子插入「思考行 / 工具调用行」，让整页读起来
   * 像一份 agent 会话日志，而不是论坛帖子流。
   *
   * 密度刻意压低（每行之间最多一条，且大部分位置仍是普通分隔线）。
   */
  function listTraceHtml(t, idx, avoidRun) {
    const sep = { html: '<div class="ngax-row-sep"></div>', run: avoidRun };
    if (!cfg("decorations")) return sep;
    const rate = Math.max(0, Math.min(100, Number(cfg("listTraceRate")) || 0));
    if (rate <= 0) return sep;

    const rnd = mulberry32((((idx + 1) * 2654435761) ^ Number(t.tid || 0)) >>> 0);
    const roll = rnd() * 100;
    if (roll >= rate) return sep;
    if (roll < rate / 2) {
      return { html: thinkingHtml(rnd, !!cfg("listThinkingOpen")), run: avoidRun };
    }
    const r = runlineParts(rnd, avoidRun);
    return { html: r.html, run: r.idx };
  }

  function listRowsHtml(rows) {
    const out = [];
    let lastRun = -1;
    rows.forEach((t, i) => {
      if (i > 0) {
        const trace = listTraceHtml(t, i, lastRun);
        lastRun = trace.run;
        out.push(trace.html);
      }
      out.push(rowHtml(t));
    });
    return out.join("");
  }

  /** 当前版面自己的子版面（服务端给在 __ALL_FORUM_DATA 里，比 DOM 稳） */
  function forumChips(page) {
    const cur = String(page.fid || "");
    const all = window.__ALL_FORUM_DATA;
    const list = [];
    if (all) {
      for (const k of Object.keys(all)) {
        const v = all[k];
        if (!v || !v[1]) continue;
        list.push({ fid: String(v[0]), name: String(v[1]) });
      }
    }
    if (!list.length) FORUMS.forEach((f) => list.push({ fid: String(f.fid), name: f.name }));
    return list.slice(0, 40).map((f) =>
      `<a class="ngax-fchip${f.fid === cur ? " on" : ""}" href="/thread.php?fid=${encodeURIComponent(f.fid)}">` +
      `${escapeHtml(f.name)}</a>`).join("");
  }

  function pagerHtml(page, kind) {
    const p = page.pager;
    if (!p || p.total <= 1) return "";
    MORE_PAGE = p.current;
    MORE_URL = p.current < p.total ? pageUrl(p.base, p.current + 1) : null;

    const links = [];
    const win = 2;
    for (let i = 1; i <= p.total; i++) {
      if (i > 1 && i < p.total && Math.abs(i - p.current) > win) {
        if (links[links.length - 1] !== "…") links.push("…");
        continue;
      }
      links.push(`<a class="ngax-fchip${i === p.current ? " on" : ""}" href="${escapeHtml(pageUrl(p.base, i))}">${i}</a>`);
    }
    return `<div class="ngax-card-links ngax-pager" data-pager="${kind}">${links.join("")}</div>`;
  }

  /**
   * 版面名排序用的键：剥掉开头的符号再比。
   * 否则「“每周一歌”活动合集」「[公告] 二手交易」这种会全部挤到最前面 ——
   * 中文全角引号不在 ASCII 范围内，只剥 ASCII 引号是不够的。
   */
  function sortBoardName(name) {
    return String(name).replace(
      /^[\s\[\](){}<>【】（）《》「」『』〈〉〖〗〔〕［］｛｝“”‘’"'«»\-—_·、,，.。!！?？:：;；|｜~～]+/, "");
  }

  /** 名字重复的版面（每次渲染版面大全新算） */
  let BOARD_NAME_DUP = new Set();

  /* ---------- 版面星标 / 版面筛选（document 级委托） ---------- */

  /** 首页版面大全的筛选：纯前端，不重渲染也不发请求，所以近千个也能直接用 */
  function applyBoardFilter(q) {
    const needle = String(q || "").trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll(".ngax-bitem").forEach((it) => {
      const hit = !needle || it.textContent.toLowerCase().indexOf(needle) >= 0;
      it.style.display = hit ? "" : "none";
      if (hit) shown++;
    });
    // 版面是按「分类 → 分组」套着的，筛完得把空的分组/分类一起收起来，
    // 否则搜完之后会留下一堆只有标题的空壳
    document.querySelectorAll("[data-board-group]").forEach((g) => {
      const any = Array.from(g.querySelectorAll(".ngax-bitem")).some((i) => i.style.display !== "none");
      g.style.display = any ? "" : "none";
    });
    document.querySelectorAll("[data-board-cat]").forEach((c) => {
      const any = Array.from(c.querySelectorAll(".ngax-bitem")).some((i) => i.style.display !== "none");
      c.style.display = any ? "" : "none";
    });
    const empty = document.querySelector("[data-board-empty]");
    if (empty) empty.style.display = shown ? "none" : "";
  }

  /** 收藏变化后同步各处 UI（rail 的收藏分区、首页的收藏区都要重建） */
  function refreshAfterFavChange() {
    const rail = document.querySelector(".ngax-rail");
    if (rail && PAGE) renderRail(rail, PAGE, true);
    if (PAGE && PAGE.route.kind === "home") {
      const before = document.querySelector("[data-board-filter]");
      const val = before ? before.value : "";
      const y = window.scrollY;
      render();
      const after = document.querySelector("[data-board-filter]");
      if (after && val) { after.value = val; applyBoardFilter(val); }
      try { window.scrollTo(0, y); } catch { /* 某些环境没实现 scrollTo */ }
    }
  }

  /**
   * 星标和筛选都用 document 级委托。
   * 星标会同时出现在 rail、首页「收藏的版面」、首页「全部版面」、版面页四处，
   * 分别绑到各自容器上一定会漏掉某处。
   */
  function bindBoardControls() {
    document.addEventListener("click", (e) => {
      const star = e.target.closest && e.target.closest("[data-fav-board]");
      if (!star) return;
      e.preventDefault();
      e.stopPropagation();
      const fid = star.dataset.favBoard;
      // 收藏写回站点（lockViewHis），所以和原生首页的勾选同步；
      // 写不了（版面没进过站点历史）就只写本地
      const on = toggleBoardFav(fid);
      document.querySelectorAll('[data-fav-board="' + fid + '"]').forEach((b) => {
        b.classList.toggle("on", on);
        b.textContent = on ? "★" : "☆";
        b.title = on ? "取消收藏" : "收藏版面";
      });
      toastNow(on ? "已收藏版面" : "已取消收藏");
      refreshAfterFavChange();
    }, true);

    document.addEventListener("input", (e) => {
      const f = e.target.closest && e.target.closest("[data-board-filter]");
      if (f) applyBoardFilter(f.value);
    });
  }

  /* ---------- 首页 ---------- */

  /** 首页头条卡：一张图 + 一个标题，整卡可点 */
  function headlineHtml(item) {
    // 同站的改成相对路径，这样点进去还是被脚本接管的页面；
    // 外站的就保持绝对地址 + 新标签打开。
    let href = item.url;
    let external = false;
    try {
      const u = new URL(item.url, location.href);
      if (u.host === location.host) href = u.pathname + u.search;
      else external = true;
    } catch { /* 不是合法 URL 就用原样 */ }
    const img = resolveAttachUrl(item.img);
    return '<a class="ngax-hl" href="' + escapeHtml(href) + '" title="' + escapeHtml(item.title) + '"' +
      (external ? ' target="_blank" rel="noopener nofollow"' : "") + ">" +
      (img ? '<span class="ngax-hl-img"><img src="' + escapeHtml(img) +
        '" alt="" loading="lazy" referrerpolicy="no-referrer"></span>' : "") +
      '<span class="ngax-hl-title">' + escapeHtml(item.title) + "</span>" +
      "</a>";
  }

  /* ---------- 用户信息页 ---------- */

  /** 把时间戳（秒）变成「2014-12-21」 */
  function dateOf(sec) {
    if (!sec) return "";
    const d = new Date(sec * 1000);
    if (Number.isNaN(d.getTime())) return "";
    const p2 = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  }

  /** 一个大数字 + 小标题的统计格子 */
  function statHtml(value, label, hint) {
    return '<div class="ngax-stat"' + (hint ? ' title="' + escapeHtml(hint) + '"' : "") + ">" +
      '<b>' + escapeHtml(String(value)) + "</b><span>" + escapeHtml(label) + "</span></div>";
  }

  /** 返回 false = 拿不到数据，让调用方退回原生页面 */
  function renderMember(inner, page) {
    const m = page.member;
    if (!m) return false;

    const stats = [
      statHtml(shortNum(m.posts), "发帖", "发帖数 " + m.posts),
      statHtml(m.money, "金钱"),
      statHtml(m.rvrc, "声望", "rvrc"),
      statHtml(m.fame, "威望")
    ];
    const regDate = dateOf(m.regdate);
    if (regDate) {
      const years = Math.max(0, Math.floor((Date.now() / 1000 - m.regdate) / 31536000));
      stats.push(statHtml(regDate, "注册", regDate + (years ? "（" + years + " 年）" : "")));
    }

    const meta = ["UID " + m.uid];
    if (m.group) meta.push(m.group + (m.gid ? "(" + m.gid + ")" : ""));
    if (m.ipLoc) meta.push("IP 属地 " + m.ipLoc);
    if (m.email) meta.push("邮箱 " + m.email);
    if (m.phone) meta.push("手机 " + m.phone);

    const badges = [];
    if (m.honor) badges.push('<span class="ngax-pill" title="头衔">' + escapeHtml(m.honor) + "</span>");
    if (m.active && m.active.html) {
      badges.push('<span class="ngax-pill on" title="' + escapeHtml(m.active.title || "") + '">' +
        m.active.html + "</span>");
    }
    if (m.muteTime && m.muteTime * 1000 > Date.now()) {
      badges.push('<span class="ngax-pill ngax-bad" title="禁言中">禁言至 ' +
        escapeHtml(dateOf(m.muteTime)) + "</span>");
    }

    // 动作按钮：有真 href 的就当普通链接（能中键新标签页）；
    // 纯 JS 动作交给原生元素自己处理
    const quick = [
      { label: "TA 的主题", href: "/thread.php?authorid=" + m.uid },
      { label: "TA 的回复", href: "/thread.php?searchpost=1&authorid=" + m.uid }
    ];
    if (m.uid !== ((page.user && page.user.uid) || 0)) {
      quick.push({ label: "发私信", href: "/nuke.php?func=message#to=" + m.uid });
    }
    const actHtml = quick.concat(m.actions).map((a) =>
      a.href
        ? '<a class="ngax-pill" href="' + escapeHtml(a.href) + '">' + escapeHtml(a.label) + "</a>"
        : '<button type="button" class="ngax-pill ngax-act-pill" data-member-act="' + escapeHtml(a.label) + '">' +
          escapeHtml(a.label) + "</button>"
    ).join("");

    // 状态 / 头像 / 签名 / 声望
    const buffs = m.buffs.length
      ? '<div class="ngax-buff-list">' + m.buffs.map((b) =>
        '<div class="ngax-buff">' + b.html +
        // 站点渲染好的那串 HTML 里通常已经写了「持续至 YYYY-MM-DD」，
        // 那就别再补一个「至 …」，否则同一件事显示两遍
        (b.until && b.until * 1000 > Date.now() && !/持续至|至\s*\d{4}-/.test(b.html)
          ? '<span class="ngax-buff-until">至 ' + escapeHtml(dateOf(b.until)) + "</span>" : "") +
        "</div>").join("") + "</div>"
      : '<div class="ngax-empty">没有生效中的状态</div>';

    const avatarBlock = m.avatar
      ? '<div class="ngax-avatar-box"><img class="ngax-member-avatar-lg" src="' + escapeHtml(m.avatar) + '" alt="" referrerpolicy="no-referrer"></div>'
      : '<div class="ngax-empty">没有设置头像</div>';

    const signBlock = m.sign
      ? '<div class="ngax-cooked ngax-sign-box">' + m.sign + "</div>"
      : '<div class="ngax-empty">没有设置签名</div>';

    const repuHtml = m.reputation.length
      ? '<table class="ngax-repu"><tbody>' + m.reputation.map((r) =>
        "<tr><td>" + escapeHtml(r.name) + "</td>" +
        '<td class="ngax-repu-val' + (r.value < 0 ? " neg" : "") + '">' +
        (r.value > 0 ? "+" : "") + r.value + "</td>" +
        "<td>" + escapeHtml(r.text) + "</td></tr>").join("") + "</tbody></table>"
      : '<div class="ngax-empty">还没有声望记录</div>';

    inner.innerHTML = `
      <div class="ngax-card ngax-member">
        ${m.avatar ? '<img src="' + escapeHtml(m.avatar) + '" alt="" referrerpolicy="no-referrer">' : ""}
        <div class="ngax-card-main">
          <div class="ngax-card-title">
            <h1>${escapeHtml(m.username)}</h1>
            ${m.usernameChanged ? '<span class="ngax-pill" title="改过名">改过名</span>' : ""}
            ${badges.join("")}
          </div>
          <div class="ngax-card-sub">${escapeHtml(meta.join("  ·  "))}</div>
          <div class="ngax-card-links">${actHtml}</div>
        </div>
      </div>

      <div class="ngax-stats">${stats.join("")}</div>

      <div class="ngax-set-section">状态</div>
      ${buffs}

      <div class="ngax-set-section">头像</div>
      ${avatarBlock}

      <div class="ngax-set-section">签名</div>
      ${signBlock}

      <div class="ngax-set-section">声望</div>
      ${repuHtml}

      <div class="ngax-card-links" style="margin-top:18px">
        <a class="ngax-pill" href="${escapeHtml(location.href)}" target="_blank" rel="noopener">原生页面</a>
      </div>
    `;
    markSmallImages(inner);
    return true;
  }

  function renderList(inner, page) {
    const r = page.route;
    const rows = page.list || [];
    const stickies = page.stickies || [];
    MORE_PAGE = page.pager ? page.pager.current : 1;
    MORE_URL = page.pager && page.pager.current < page.pager.total
      ? pageUrl(page.pager.base, page.pager.current + 1) : null;

    const title = listTitle(r, page);
    const desc = r.listKind === "search"
      ? `关键词「${r.key}」的搜索结果 · 共 ${rows.length} 条`
      : r.listKind === "author"
        ? `${userInfo(r.authorId).username || r.authorId} ${r.searchPost ? "在本版的回复" : "发布的主题"} · ${rows.length} 条`
        : `${title} · 第 ${MORE_PAGE} / ${(page.pager && page.pager.total) || 1} 页 · ${rows.length} 个主题`;

    const newTopicUrl = r.listKind === "forum" ? "/post.php?fid=" + r.fid : "/";

    inner.innerHTML = `
      <div class="ngax-head">
        <div class="ngax-head-title">
          <button class="ngax-filter-btn" title="展开 / 收起版面">${ic("filter")}</button>
          <h1>${escapeHtml(title)}</h1>
        </div>
        <a class="ngax-new-topic-btn" href="${escapeHtml(newTopicUrl)}" title="发表新帖">${ic("plus")}发新帖</a>
      </div>
      ${(r.listKind === "forum" && r.fid) ? `
        <div class="ngax-head-desc ngax-board-bar">
          <span class="ngax-dim">收藏本版：</span>${boardChipHtml({ fid: r.fid, name: title, sub: "" })}
          <span class="ngax-dim">钉在左侧栏，下次直接点</span>
        </div>` : ""}
      <div class="ngax-filter-row">${forumChips(page)}</div>
      <div class="ngax-head-desc">${escapeHtml(desc)}</div>
      ${stickies.length ? `<div class="ngax-sticky-box">${stickies.map((t) =>
        `<a class="ngax-sticky" href="${escapeHtml(t.url)}">${ic("tag")}${escapeHtml(t.title)}</a>`).join("")}</div>` : ""}
      <div class="ngax-rows">${listRowsHtml(rows)}</div>
      ${pagerHtml(page, "list")}
      <div class="ngax-list-status${MORE_URL ? " link" : ""}" ${MORE_URL ? 'data-more="list"' : ""}>${
        rows.length ? (MORE_URL ? `点击加载更多（第 ${MORE_PAGE + 1} 页）` : "没有更多了") : "这个列表是空的"}</div>
    `;
  }

  /* ============================== 楼层伪装装饰 ==============================
   *
   * 这一段是给「上班摸鱼」用的核心伪装：
   *   1. 每个楼层顶部混入一个 agent 思考块（✻ Worked for 27s），可折叠；
   *   2. 部分楼层里穿插淡色的「工具调用」行（Running command / Applied changes…）；
   *   3. 鼠标停在楼层上时，右侧浮出操作胶囊（引用 / 支持 / 反对 / 收藏 / 复制链接）。
   * 全部按 (tid, 楼层号) 播种，同一楼层每次刷新长得一样，不会闪。
   *
   * 文案刻意用「通用的技术判断」而不是论坛腔 —— 万一有人凑近看屏幕，
   * 看到的是一段英文技术推理，而不是「这人在逛论坛」。
   * ======================================================================== */

  const THINK_OPENERS = [
    "Okay, let me think through this properly.",
    "Alright, reading the post again — the claim hinges on one assumption.",
    "So the question is essentially about trade-offs, not correctness.",
    "Hmm, this is more subtle than it first looks.",
    "The framing is plausible but incomplete — let me reason about why.",
    "Let me unpack what's actually being claimed here before reacting.",
    "Interesting — the symptom and the cause are probably two different things.",
    "Before agreeing, I want to check the failure mode this implies.",
    "First instinct: this is a config issue masquerading as a bug.",
    "Let me separate the diagnosis from the proposed fix.",
    "There's a decent argument on both sides here, which is worth admitting up front.",
    "I've seen this pattern before — it usually ends up being permissions.",
    "Reproducing it locally would settle half of this discussion instantly.",
    "Let me check whether the numbers in the post actually support the conclusion.",
    "The tone is confident; the evidence is thinner than it sounds."
  ];

  const THINK_MIDS = [
    "The most likely explanation is resource contention, not the code path itself.",
    "If the numbers hold under a controlled benchmark, the conclusion is solid; if not, it's measurement noise.",
    "There are two ways to verify this: profile it under load, or bisect the change.",
    "I should distinguish between what the author measured and what they inferred.",
    "The failure mode only shows up under load, which is exactly why it's easy to miss.",
    "Correlation is doing a lot of work in that argument — worth pointing out gently.",
    "The simple approach probably wins here; the clever one just moves the complexity.",
    "Backwards compatibility matters more than elegance in this specific case.",
    "Queueing delay would explain the tail latency better than throughput does.",
    "Caching is the obvious lever, but it only helps if the read path is actually hot.",
    "The version pin matters here — half of these reports turn out to be a dependency bump.",
    "This smells like an ordering problem: the cleanup runs before the flush.",
    "In practice the config default wins; nobody reads the docs that deeply.",
    "The budget is the real constraint here, not the implementation.",
    "Two people describing the same symptom with different vocabularies."
  ];

  const THINK_CLOSERS = [
    "Let me structure the reply around the one number that matters.",
    "I'll keep it short and ask the question that actually needs answering.",
    "I should avoid sounding dismissive — the work is genuinely good.",
    "Okay, writing it out step by step is the right move here.",
    "One concrete suggestion beats three abstract ones. Going with that.",
    "I'll agree with the direction, then flag the one thing that could bite later.",
    "Better to leave a question than a lecture — keeping the reply to two points.",
    "Let me lead with the concrete number, then the caveat.",
    "I'll ask for the reproduction steps before committing to a diagnosis.",
    "Idempotency handles the retry storm better than a tighter timeout ever will.",
    "Wrapping up with the fix I'd actually ship, not the one that sounds smart.",
    "That's enough analysis — the practical next step is obvious.",
    "I'll point at the trade-off and let them decide; it's their system.",
    "Two sentences and a link would be more useful than a longer reply here."
  ];

  /** 楼层里穿插的「工具调用」行（纯装饰，英文对齐 Codex CLI） */
  const RUN_LINES = [
    ["terminal", "Running command", true],
    ["file", "Reading file", false],
    ["globe", "Searching the web", false],
    ["folder", "Listing directory", false],
    ["check", "Applied changes", false],
    ["globe", "Fetched page", false],
    ["branch", "Checked out branch", false],
    ["clock", "Waiting on build", false]
  ];
  const RUN_CMDS = [
    "cargo build --release", "npm run build", "pytest -q tests/cache",
    "go test ./...", "git diff --stat", "ls src/", "make lint",
    "npm test -- --filter=auth", "cargo test --release", "go vet ./...",
    "docker compose up -d", "kubectl get pods -n prod", "rg -n 'ttl' src/",
    "git log --oneline -8", "node --check dist/app.js", "ruff check ."
  ];

  /** 每个楼层一个稳定种子：同一主题同一楼层永远得到同一套装饰 */
  function turnSeed(tid, floor) {
    const n = Number(floor) || 0;
    return (((n * 7919 + 1) * 2654435761) ^ (Number(tid) || 0)) >>> 0;
  }

  function thinkSentences(rnd) {
    const pick = (pool) => pool[Math.floor(rnd() * pool.length)];
    const out = [pick(THINK_OPENERS)];
    if (rnd() < 0.65) out.push(pick(THINK_MIDS));
    if (rnd() < 0.60) out.push(pick(THINK_CLOSERS));
    return out;
  }

  /** ✻ Worked for 27s —— 可折叠的思考块（HTML 字符串） */
  function thinkingHtml(rnd, openByDefault) {
    const secs = 2 + Math.floor(rnd() * 46);
    return '<div class="ngax-think' + (openByDefault ? " open" : "") + '">' +
      '<div class="ngax-think-head"><span class="ngax-spin">' + ic("sparkle") + "</span>" +
      '<span>Worked for ' + secs + 's</span><span class="ngax-think-chev"></span></div>' +
      '<div class="ngax-think-body">' + escapeHtml(thinkSentences(rnd).join("\n\n")) + "</div>" +
      "</div>";
  }

  /**
   * 「工具调用」淡色行。
   * avoidIdx 用来避开上一条用过的样式 —— 否则列表里连着出现两个
   * 「Running command」，一眼就看出是生成的。
   */
  function runlineParts(rnd, avoidIdx) {
    let i = Math.floor(rnd() * RUN_LINES.length);
    if (avoidIdx != null && avoidIdx >= 0 && i === avoidIdx) i = (i + 1) % RUN_LINES.length;
    const [icon, text, withCmd] = RUN_LINES[i];
    return {
      idx: i,
      html: '<div class="ngax-runline">' +
        (icon ? ic(icon) : "") +
        "<span>" + escapeHtml(text) + "</span>" +
        (withCmd ? "<code>" + escapeHtml(RUN_CMDS[Math.floor(rnd() * RUN_CMDS.length)]) + "</code>" : "") +
        "</div>"
    };
  }

  function runlineHtml(rnd, avoidIdx) {
    return runlineParts(rnd, avoidIdx).html;
  }

  /**
   * 给一批已渲染的楼层加伪装装饰。在 detached 容器上调用（改完再序列化进页面）。
   * 覆盖率对齐参考实现：~70% 楼层带思考块，~28% 额外掺工具调用行。
   */
  function decorateTurns(container, tid) {
    if (!container || !cfg("decorations")) return;
    container.querySelectorAll(".ngax-turn-agent[data-floor]").forEach((turn) => {
      if (turn.dataset.decorated === "1") return;
      turn.dataset.decorated = "1";
      const cooked = turn.querySelector(".ngax-cooked");
      if (!cooked) return;
      const rnd = mulberry32(turnSeed(tid, turn.dataset.floor));
      if (rnd() < 0.70) {
        const holder = el("div");
        holder.innerHTML = thinkingHtml(rnd, !!cfg("detailThinkingOpen"));
        cooked.prepend(holder.firstChild);
      }
      if (cooked.children.length < 2) return;
      if (rnd() < 0.72) return;
      const n = rnd() < 0.22 ? 2 : 1;
      const kids = [...cooked.children];
      let lastRun = -1;
      for (let k = 0; k < n; k++) {
        const parts = runlineParts(rnd, lastRun);
        lastRun = parts.idx;
        const holder = el("div");
        holder.innerHTML = parts.html;
        const line = holder.firstChild;
        // 多数插在末尾（读起来像这步刚跑完），偶尔插在中间
        const at = rnd() < 0.7 ? kids.length : Math.max(1, Math.floor(rnd() * kids.length));
        kids[at - 1].insertAdjacentElement("afterend", line);
        kids.splice(at, 0, line);
      }
    });
  }

  /** 滚到某一楼并闪一下；找不到就退化成原生锚点（NGA 每层都有 <a name='lN'>） */
  function jumpToPid(pid) {
    const key = String(pid == null ? "" : pid);
    // pid=0 就是楼主那层（NGA 给楼主用的就是 0），没有 data-pid="0" 时退回到第一层
    let node = document.querySelector('[data-pid="' + key + '"]');
    if (!node && key === "0") node = document.querySelector(".ngax-turn");
    if (!node) {
      location.href = "/read.php?tid=" + ((PAGE && PAGE.route.tid) || "") + (key && key !== "0" ? "&pid=" + key : "");
      return;
    }
    if (typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    const turn = node.closest(".ngax-turn") || node;
    turn.classList.remove("ngax-flash");
    void turn.offsetWidth; // 强制重排，保证连点同一条也能重放动画
    turn.classList.add("ngax-flash");
    setTimeout(() => turn.classList.remove("ngax-flash"), 1300);
  }

  /* ============================== 详情视图（帖子） ============================== */

  /** 签名 / 版主编辑记录：原生有就带上，没有就算了（带子了才算「不丢内容」） */
  function postFootHtml(p) {
    const out = [];
    const sign = cleanContent(p.signHtml || "").trim();
    if (sign && sign.replace(/<[^>]*>/g, "").trim()) {
      out.push('<div class="ngax-sign">' + sign + "</div>");
    }
    const alert = cleanContent(p.alertHtml || "").trim();
    if (alert && alert.replace(/<[^>]*>/g, "").trim()) {
      out.push('<div class="ngax-alert">' + alert + "</div>");
    }
    return out.join("");
  }

  /** 楼层操作胶囊：引用 / 支持 / 反对 / 收藏 / 复制链接 */
  function turnActionsHtml(opts) {
    const i = opts.i, p = opts.post;
    const link = location.origin + "/read.php?tid=" + (opts.tid || "") + (p.pid ? "&pid=" + p.pid : "");
    return '' +
      '<span class="ngax-actions">' +
      '<button class="ngax-act" data-act="quote" data-i="' + escapeHtml(String(i)) + '" title="引用该楼层（生成 NGA 原生格式的 [quote]）">' + ic("quote") + "<span>引用</span></button>" +
      '<button class="ngax-act" data-act="good" data-i="' + escapeHtml(String(i)) + '" title="支持（调用 NGA 原生 postScoreAdd）">' + ic("thumbsUp") + "<span>支持</span></button>" +
      '<button class="ngax-act" data-act="bad" data-i="' + escapeHtml(String(i)) + '" title="反对（调用 NGA 原生 postScoreAdd）">' + ic("thumbsDown") + "<span>反对</span></button>" +
      '<button class="ngax-act" data-act="fav" data-i="' + escapeHtml(String(i)) + '" data-pid="' + escapeHtml(String(p.pid || "")) + '" title="收藏（调用 NGA 原生 favor）">' + ic("star") + "<span>收藏</span></button>" +
      '<button class="ngax-act" data-act="copy-link" data-value="' + escapeHtml(link) + '" title="复制楼层链接">' + ic("link") + "<span>链接</span></button>" +
      "</span>";
  }

  /** 楼层底部那行「楼主 用户名 · 时间 · 操作」 */
  function workedHtml(p, tid) {
    const bits = [];
    const av = cfg("avatars") && p.avatar
      ? '<img class="ngax-ava" src="' + escapeHtml(p.avatar) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
      : "";
    bits.push('<span class="ngax-floor">' + escapeHtml(floorLabel(p.i)) + "</span>");
    bits.push(av + '<a class="ngax-user" href="/nuke.php?func=ucp&uid=' + escapeHtml(String(p.uid || "")) +
      '" title="用户中心">' + escapeHtml(p.username) + "</a>");
    if (p.i === 0 && p.uid) {
      bits.push('<a class="ngax-pill ngax-only-op" href="/read.php?tid=' + escapeHtml(String(tid)) +
        "&authorid=" + escapeHtml(String(p.uid)) + '" title="只看楼主">只看楼主</a>');
    }
    const t = formatTime(p.timeIso);
    if (t) bits.push("<span title=\"" + escapeHtml(p.timeIso || "") + "\">" + escapeHtml(t) + "</span>");
    if (cfg("showClient") && p.client) bits.push("<span>" + escapeHtml(p.client) + "</span>");
    if (p.postnum) bits.push('<span class="ngax-dim">' + escapeHtml(shortNum(p.postnum)) + " 帖</span>");
    bits.push(turnActionsHtml({ i: p.i, post: p, tid }));
    return '<div class="ngax-worked">' + bits.join('<span class="ngax-dotsep">·</span>') + "</div>";
  }

  function renderThread(inner, page) {
    const t = page.thread;
    if (!t) {
      inner.innerHTML = `<div class="ngax-list-status">没能解析出主题内容</div>`;
      return;
    }
    const op = t.posts[0];
    const replies = t.posts.slice(1);
    const ctx = { tid: t.tid, pidMap: buildPidMap(t.posts) };

    const metaBits = [];
    if (op) {
      metaBits.push('<a href="/nuke.php?func=ucp&uid=' + escapeHtml(String(op.uid || "")) + '" style="color:inherit">' +
        escapeHtml(op.username) + "</a>");
      const time = formatTime(op.timeIso);
      if (time) metaBits.push("<span>" + escapeHtml(time) + "</span>");
    }
    metaBits.push('<span>' + t.posts.length + " 楼</span>");
    if (page.pager && page.pager.total > 1) {
      metaBits.push("<span>第 " + page.pager.current + " / " + page.pager.total + " 页</span>");
    }
    if (t.forum) {
      metaBits.push('<a class="ngax-node" href="/thread.php?fid=' + escapeHtml(String(t.fid)) + '">' +
        escapeHtml(t.forum) + "</a>");
    }

    // 楼主那层：正文放「用户气泡」里（对齐 Codex 里 user message 的样式），
    // 回复则放 agent 区。这样一眼能看出「主题」和「讨论」的分界。
    const opTurn = op ? `
      <div class="ngax-turn">
        <div class="ngax-turn-user" data-pid="${escapeHtml(String(op.pid || 0))}">
          <div class="ngax-turn-user-bubble">${renderPostContent(op, ctx) || '<span style="color:var(--cx-text-dim)">（正文为空）</span>'}</div>
          ${postFootHtml(op)}
        </div>
        ${workedHtml(op, t.tid)}
      </div>` : "";

    const turns = replies.map((p) => `
      <div class="ngax-turn">
        <div class="ngax-turn-agent" data-pid="${escapeHtml(String(p.pid || 0))}" data-floor="${escapeHtml(String(p.i))}">
          <div class="ngax-cooked">${renderPostContent(p, ctx)}</div>
          ${postFootHtml(p)}
        </div>
        ${workedHtml(p, t.tid)}
      </div>`).join("");

    // 先在 detached 容器里渲染 + 加伪装装饰，再一次性写回：
    // decorateTurns 要动 DOM（prepend 思考块 / 插入工具调用行），在字符串上做不了。
    const holder = el("div");
    holder.innerHTML = `
      <div class="ngax-detail-head"><div class="ngax-detail-meta">${metaBits.join('<span class="ngax-dotsep">·</span>')}</div></div>
      ${opTurn}
      ${replies.length ? `<div class="ngax-turn-divider">以下 ${replies.length} 条回复${page.pager && page.pager.total > 1 ? " · 第 " + page.pager.current + " / " + page.pager.total + " 页" : ""}</div>` : `<div class="ngax-turn-divider">还没有回复</div>`}
      ${turns}
      ${pagerHtml(page, "thread")}
      <div class="ngax-card-links" style="margin-top:18px;align-items:center">
        <a class="ngax-new-topic-btn" href="/post.php?action=reply&fid=${escapeHtml(String(t.fid))}&tid=${escapeHtml(String(t.tid))}">${ic("plus")}回复（原生页面）</a>
        <a class="ngax-pill" href="${escapeHtml(location.href)}" target="_blank" rel="noopener" title="在原站打开">原生页面</a>
      </div>
    `;
    decorateTurns(holder, t.tid);
    markSmallImages(holder);
    inner.replaceChildren(...holder.childNodes);
  }

  /* ---------- 加载更多（列表分页；同源 fetch 后解析） ---------- */

  async function loadMore(btn) {
    if (!PAGE || PAGE.route.kind !== "list") return;
    const nextNum = MORE_PAGE + 1;
    const url = MORE_URL || pageUrl(location.pathname + location.search.replace(/[?&]page=\d+/, ""), nextNum);

    btn.dataset.busy = "1";
    btn.textContent = "加载中…";
    try {
      const resp = await fetch(url, { credentials: "same-origin" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, "text/html");

      const fresh = parse.topicRows(doc);
      const have = new Set((PAGE.list || []).map((x) => x.tid));
      const add = fresh.filter((x) => !have.has(x.tid));

      const rowsBox = document.querySelector(".ngax-rows");
      if (rowsBox && add.length) {
        rowsBox.insertAdjacentHTML("beforeend", '<div class="ngax-row-sep"></div>' + listRowsHtml(add));
        PAGE.list = (PAGE.list || []).concat(add);
      }

      MORE_PAGE = nextNum;
      const pd = doc.getElementById("pagebtop") || doc.getElementById("pagebbtm");
      const hasNext = pageHasNext(pd, nextNum);
      MORE_URL = hasNext ? pageUrl(url.replace(/[?&]page=\d+/, ""), nextNum + 1) : null;

      if (MORE_URL) {
        delete btn.dataset.busy;
        btn.textContent = `点击加载更多（第 ${MORE_PAGE + 1} 页）`;
      } else {
        btn.classList.remove("link");
        btn.removeAttribute("data-more");
        btn.textContent = "没有更多了";
      }
      // rail 里的「本页主题」也跟着更新
      renderRail(document.querySelector(".ngax-rail"), PAGE, true);
    } catch (err) {
      delete btn.dataset.busy;
      btn.textContent = `加载失败（${err.message}），点击重试`;
    }
  }

  /** 下一页还在不在：看服务端分页区里有没有指向 page=N+1 的链接 */
  function pageHasNext(box, cur) {
    if (!box) return false;
    const links = Array.from(box.querySelectorAll("a[href*='page=']"));
    return links.some((a) => num((attr(a, "href").match(/[?&]page=(\d+)/) || [])[1]) === cur + 1)
      || !!(box.querySelector("a.pager_spacer"));
  }

  /* ============================== 左 rail ============================== */

  let railScrollTop = 0;

  function ensureRail(page) {
    const all = document.querySelectorAll(".ngax-rail");
    // 保险：真要是留下了第二个（渲染中途被打断之类的），砍掉多余的 ——
    // 否则会出现「两个用户栏」，而 querySelector 只会拿到第一个，永远修不干净
    for (let i = 1; i < all.length; i++) all[i].remove();
    let rail = all[0];
    if (!rail) {
      rail = el("div", "ngax-rail");
      document.body.appendChild(rail);
    }
    renderRail(rail, page, false);
    return rail;
  }

  /* —— rail 渲染的防重入 ——
   *
   * 为什么要这一层（真实 bug，左下角用户名出现两行）：
   * renderRail 里会去读 NGA 的版面历史，而读的时候如果 hisLink **已经 init 好了**，
   * commonui.waitForumViewHis 会**同步**回调 → 回调里又调 renderRail，
   * 而外层那趟还没跑完：内层把 foot / 用户栏 / 明暗按钮 / 拖拽把手追加了一遍，
   * 外层接着又追加了一遍（滚动容器只有新的那个，所以只有这几样翻倍）。
   *
   * 同步还是异步取决于 hisLink 有没有 init —— 版面页的页面脚本会调 ForumViewHis()
   * 记录访问，于是提前 init → 走同步路径 → 出问题；帖子页不记录，init 没完成 →
   * 回调异步 → 没问题。这就是「只有部分页面渲染两次」的原因。
   *
   * 修法不是把那一处改成 setTimeout，而是在入口挡住重入：以后任何地方在渲染过程中
   * 再触发一次渲染，都只会被合并成「跑完后再来一趟」，不会再往 DOM 上追加一遍。
   */
  let RAIL_BUSY = false;
  let RAIL_PENDING = false;

  function renderRail(rail, page, keepScroll) {
    if (!rail || !page) return;
    if (RAIL_BUSY) { RAIL_PENDING = true; return; }
    RAIL_BUSY = true;
    try {
      renderRailInner(rail, page, keepScroll);
    } finally {
      RAIL_BUSY = false;
    }
    if (RAIL_PENDING) {
      RAIL_PENDING = false;
      nextFrame(() => renderRail(rail, PAGE || page, true));
    }
  }

  function renderRailInner(rail, page, keepScroll) {
    if (!rail || !page) return;
    if (keepScroll) railScrollTop = (rail.querySelector(".ngax-rail-scroll") || {}).scrollTop || 0;
    const r = page.route;
    const onFid = r.kind === "list" && r.listKind === "forum" ? String(r.fid) : "";
    const onHome = r.kind === "home";

    // 顶栏（traffic lights + 品牌）
    rail.innerHTML = `
      <div class="ngax-rail-traffic">
        <span data-rail-drawer-close title="收起侧栏">${ic("sidebar")}</span>
      </div>
      <div class="ngax-rail-brand">
        <a class="ngax-rail-brand-name" href="/">${escapeHtml(brandName())} ${ic("chevronDown")}</a>
        <div class="ngax-rail-brand-actions">
          <span data-rail-search title="搜索帖子">${ic("search")}</span>
          <span class="ngax-rail-bell" title="通知" data-rail-notif>${ic("bell")}</span>
        </div>
      </div>
    `;

    const scroll = el("div", "ngax-rail-scroll");
    rail.appendChild(scroll);

    // —— 导航 ——
    const nav = el("nav", "ngax-rail-nav");
    const navItem = (href, icon, label, active) =>
      `<a class="ngax-rail-item${active ? " active" : ""}" href="${escapeHtml(href)}">${icon}<span class="ngax-label">${escapeHtml(label)}</span></a>`;
    nav.innerHTML = [
      navItem("/", ic("home"), "首页", onHome),
      navItem("/thread.php?fid=-7", ic("forum"), "网事杂谈", onFid === "-7"),
      navItem("/thread.php?favor=1", ic("star"), "收藏的主题", false),
      navItem("/nuke.php?__lib=message&__act=message&act=list", ic("mail"), "短消息", false),
      navItem("/thread.php?authorid=" + ((page.user && page.user.uid) || ""), ic("user"), "我的主题", false)
    ].join("");
    scroll.appendChild(nav);

    // —— 版面：收藏的 / 常去的 / 全部 ——
    //
    // 收藏与常去的**数据源是站点自己那份**（原生首页「收藏版面」分区用的就是它）：
    //   commonui.eachForumViewHis → 每个版面的 { lock, count, day }
    //     lock=1  → 收藏（就是站点首页那个勾选）
    //     count≥10 → 至少隔天来过一次 = 常去
    // 读不到时退回脚本本地存的那份，所以永远有东西。
    // 全量 973 个不铺在侧栏（会把侧栏撑爆），分区标题右侧的「全部 N ›」进
    // 首页的版面大全（带搜索框）。
    //
    // NGA 那份历史是异步 init 的：第一次可能读不到，读到了重画一次 rail。
    readNgaHis((his, fresh) => {
      if (!fresh) return;
      const r = document.querySelector(".ngax-rail");
      if (r && r.isConnected && PAGE) renderRail(r, PAGE, true);
    });

    const favs = boardBookmarks();
    if (favs.length) {
      const box = el("div", "ngax-rail-section-items");
      box.innerHTML = favs.map((b) =>
        '<a class="ngax-rail-item' + (onFid === String(b.fid) ? " active" : "") + '" href="/thread.php?fid=' +
        encodeURIComponent(b.fid) + '" title="' + escapeHtml(b.name + " · 已收藏") + '">' +
        '<span class="ngax-bstar on" data-fav-board="' + escapeHtml(String(b.fid)) + '" title="取消收藏">★</span>' +
        '<span class="ngax-label">' + escapeHtml(b.name) + "</span></a>"
      ).join("");
      scroll.appendChild(el("div", "ngax-rail-section",
        `<span>收藏的版面</span><span class="ngax-more">${favs.length}</span>`));
      scroll.appendChild(box);
    }

    const freq = frequentBoards(8);
    if (freq.length) {
      const box = el("div", "ngax-rail-section-items");
      box.innerHTML = freq.map((f) =>
        '<a class="ngax-rail-item' + (onFid === String(f.fid) ? " active" : "") + '" href="/thread.php?fid=' +
        encodeURIComponent(f.fid) + '" title="' + escapeHtml(f.name + " · 去过 " + f.count + " 次") + '">' +
        ic("folder") + '<span class="ngax-label">' + escapeHtml(f.name) + "</span>" +
        '<span class="ngax-count">' + f.count + "</span></a>"
      ).join("");
      scroll.appendChild(el("div", "ngax-rail-section", "<span>常去版面</span>"));
      scroll.appendChild(box);
    }

    // 默认清单：上面两块都空时垫底（全新状态、站点数据也没读到），
    // 保证侧栏不会是一个没有版面可点的空壳
    if (!favs.length && !freq.length) {
      const box = el("div", "ngax-rail-section-items");
      box.innerHTML = railBoards().slice(0, 12).map((b) =>
        '<a class="ngax-rail-item' + (onFid === String(b.fid) ? " active" : "") + '" href="/thread.php?fid=' +
        encodeURIComponent(b.fid) + '" title="' + escapeHtml(b.name) + '">' +
        ic("folder") + '<span class="ngax-label">' + escapeHtml(b.name) + "</span></a>"
      ).join("");
      scroll.appendChild(el("div", "ngax-rail-section", "<span>常用版面</span>"));
      scroll.appendChild(box);
      scroll.appendChild(el("div", "ngax-rail-hint",
        "逛过的版面会按站点自己的历史出现在这里；也可以在版面页点一下「收藏本版」把它钉住。"));
    }

    scroll.appendChild(el("div", "ngax-rail-section",
      `<span>版面</span><a class="ngax-more" href="/" title="打开首页的版面大全">全部 ${allForums().size} ›</a>`));

    // —— 本页主题 / 本页楼层 ——
    if (page.list && page.list.length) {
      const b = el("div", "ngax-rail-section-items");
      b.innerHTML = page.list.slice(0, 14).map((t) =>
        `<a class="ngax-rail-item" href="${escapeHtml(t.url)}" title="${escapeHtml(t.title)}">` +
        `<span class="ngax-label">${escapeHtml(t.title)}</span>` +
        (num(t.replies) ? `<span class="ngax-count">${escapeHtml(shortNum(num(t.replies)))}</span>` : "") +
        `</a>`
      ).join("");
      scroll.appendChild(el("div", "ngax-rail-section", `<span>本页主题</span>`));
      scroll.appendChild(b);
    }
    if (page.thread && page.thread.posts.length) {
      const b = el("div", "ngax-rail-section-items");
      b.innerHTML = page.thread.posts.slice(0, 20).map((p) =>
        `<a class="ngax-rail-item" href="/read.php?tid=${escapeHtml(String(page.thread.tid))}${p.pid ? "&pid=" + p.pid : ""}" ` +
        `data-rail-pid="${escapeHtml(String(p.pid || 0))}" title="${escapeHtml(p.username + " · " + floorLabel(p.i))}">` +
        `<span class="ngax-floor">${escapeHtml(floorLabel(p.i))}</span>` +
        `<span class="ngax-label">${escapeHtml(p.username)}</span></a>`
      ).join("");
      scroll.appendChild(el("div", "ngax-rail-section", `<span>本页楼层</span>`));
      scroll.appendChild(b);
    }

    // —— 底部：用户 / 明暗 ——
    const foot = el("div", "ngax-rail-foot");
    const userHtml = page.user
      ? `<a class="ngax-rail-foot-user" href="/nuke.php?func=ucp&uid=${escapeHtml(String(page.user.uid))}" title="${escapeHtml(page.user.name)}">
           ${ic("user")}<span class="ngax-label">${escapeHtml(page.user.name)}</span></a>`
      : `<a class="ngax-rail-foot-user" href="/nuke.php?func=ucp" title="登录">${ic("user")}<span class="ngax-label">未登录</span></a>`;
    foot.innerHTML = `${userHtml}<button class="ngax-mode-btn" data-mode-toggle title="切换明暗模式"></button>`;
    rail.appendChild(foot);

    // 右缘拖拽把手
    const rz = el("div", "ngax-resizer");
    rz.dataset.resize = "rail";
    rz.title = "拖拽调整侧栏宽度";
    rail.appendChild(rz);

    if (keepScroll) scroll.scrollTop = railScrollTop;

    // 事件
    rail.querySelector("[data-mode-toggle]")?.addEventListener("click", () => {
      setCfg("theme", isDarkMode() ? "light" : "dark", { visualOnly: true });
      syncMode();
      applyFavicon();
      syncModeBtn();
    });
    rail.querySelector("[data-rail-search]")?.addEventListener("click", openSearch);
    rail.querySelector("[data-rail-notif]")?.addEventListener("click", () => {
      location.href = page.user ? "/nuke.php?__lib=notification&__act=list" : "/nuke.php?func=ucp";
    });
    rail.querySelector("[data-rail-drawer-close]")?.addEventListener("click", () => {
      document.documentElement.classList.remove("ngax-rail-open");
    });
    // rail 里的「本页楼层」：在当前页里滚动而不是整页跳转
    rail.querySelectorAll("[data-rail-pid]").forEach((a) => {
      a.addEventListener("click", (e) => {
        const pid = a.dataset.railPid;
        if (!pid || !document.querySelector('[data-pid="' + pid + '"]')) return;
        e.preventDefault();
        jumpToPid(pid);
      });
    });

    syncModeBtn();
  }

  /* ============================== 搜索 ============================== */

  /**
   * NGA 的搜索是 GET：thread.php?key=关键词（实测返回「搜索结果」页，
   * 而且用的还是同一套 #topicrows 结构，所以搜索结果页也是被接管的列表页）。
   */
  function openSearch() {
    const q = window.prompt("搜索 NGA 帖子（回车打开结果）", "");
    if (!q) return;
    location.href = "/thread.php?key=" + encodeURIComponent(q);
  }

  /* ============================== 底部输入框（composer） ==============================
   *
   * 编辑区是 contenteditable，但内容按「纯文本 + \n」维护（容器 white-space:pre-wrap），
   * 所以所有编辑操作都能在字符串上做，不用处理 contenteditable 那套 <div>/<br> 混排。
   *
   * 和 V2EX 版最大的不同：这里插的是 **BBSCode**，不是 Markdown。
   * NGA 的帖子格式是 BBSCode，插 Markdown 语法上去了也发不出去。
   * ================================================================================= */

  const TOOL_ICONS = {
    bold: `<b>B</b>`,
    italic: `<i>I</i>`,
    underline: `<u>U</u>`,
    strike: `<s>S</s>`,
    link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>`,
    quote: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.6 6.2C6.6 7.6 5 10 5 13.3V18h5.3v-5.3H7.9c0-2 .9-3.4 2.7-4.3L9.6 6.2Zm9 0C15.6 7.6 14 10 14 13.3V18h5.3v-5.3h-2.4c0-2 .9-3.4 2.7-4.3L18.6 6.2Z"/></svg>`,
    code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 7 4 12 9 17"/><polyline points="15 7 20 12 15 17"/></svg>`,
    collapse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M8 10h8M8 14h5"/></svg>`,
    image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="M4 17l4.5-4.2a1.6 1.6 0 0 1 2.2 0L15 17"/><path d="M14 15l1.8-1.6a1.6 1.6 0 0 1 2.2 0L21 16"/></svg>`,
    listUl: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="9.5" y1="7" x2="20" y2="7"/><line x1="9.5" y1="12" x2="20" y2="12"/><line x1="9.5" y1="17" x2="20" y2="17"/><circle cx="5" cy="7" r="1.5" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="5" cy="17" r="1.5" fill="currentColor" stroke="none"/></svg>`,
    smile: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8.6"/><path d="M8.6 14.2a4.2 4.2 0 0 0 6.8 0"/><circle cx="9.2" cy="9.8" r=".95" fill="currentColor" stroke="none"/><circle cx="14.8" cy="9.8" r=".95" fill="currentColor" stroke="none"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="8.6"/><path d="M12 8.4v7.2M8.4 12h7.2" stroke-linecap="round"/></svg>`,
    preview: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>`
  };

  const TOOL_TITLES = {
    bold: "粗体 [b]（Ctrl+B）",
    italic: "斜体 [i]（Ctrl+I）",
    underline: "下划线 [u]",
    strike: "删除线 [del]",
    link: "链接 [url]",
    quote: "引用 [quote]",
    code: "代码 [code]",
    collapse: "折叠 [collapse]",
    image: "图片 [img]",
    listUl: "列表 [list]",
    smile: "NGA 表情 [s:ac:…]",
    plus: "更多（表格 / 骰子 / 分割线）",
    preview: "实时预览"
  };

  const TOOL_SEQ = [
    "bold", "italic", "underline", "strike", "link", "quote", "code",
    "collapse", "image", "listUl", "smile", "plus", "preview"
  ];

  const PLUS_ITEMS = [
    { label: "折叠", snippet: "[collapse=点击展开]\n\n[/collapse]" },
    { label: "表格", snippet: "[table]\n[tr][td]列 1[/td][td]列 2[/td][/tr]\n[tr][td][/td][td][/td][/tr]\n[/table]" },
    { label: "代码块", snippet: "[code]\n\n[/code]" },
    { label: "骰子", snippet: "[dice]1d100[/dice]" },
    { label: "分割线", snippet: "\n[b]───────[/b]\n" }
  ];

  function composerToolbarHtml() {
    return TOOL_SEQ.map((k) =>
      `<button type="button" class="ngax-tool-btn" data-tool="${k}" title="${escapeHtml(TOOL_TITLES[k])}">${TOOL_ICONS[k]}</button>`
    ).join("") +
      `<span class="ngax-composer-status"></span>` +
      `<button type="button" class="ngax-send" data-send title="发送（Enter）" disabled>${ic("send")}</button>`;
  }

  function bbEditEl() {
    return document.querySelector(".ngax-md-edit");
  }

  function bbSource(edit) {
    return (edit ? edit.textContent : "").replace(/\u00a0/g, " ");
  }

  function bbSyncState() {
    const edit = bbEditEl();
    if (!edit) return;
    const src = bbSource(edit);
    edit.classList.toggle("has-content", src.trim().length > 0);
    bbSyncPreview(src);
    bbSyncSend();
    if (COMPOSER.draftKey) lsSet(COMPOSER.draftKey, src);
  }

  function bbSyncSend() {
    const edit = bbEditEl();
    const btn = document.querySelector(".ngax-send");
    if (!btn || !edit) return;
    btn.disabled = bbSource(edit).trim().length === 0;
  }

  function setStatus(text, kind) {
    const el = document.querySelector(".ngax-composer-status");
    if (!el) return;
    el.textContent = text || "";
    el.className = "ngax-composer-status" + (kind ? " " + kind : "");
  }

  /* ---- 光标 ↔ 纯文本偏移 ---- */

  function caretOffsets(edit) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!edit.contains(r.startContainer)) return null;
    const at = (container, offset) => {
      const pre = document.createRange();
      pre.selectNodeContents(edit);
      pre.setEnd(container, offset);
      return pre.toString().length;
    };
    return { start: at(r.startContainer, r.startOffset), end: at(r.endContainer, r.endOffset) };
  }

  function setCaret(edit, offset) {
    const walker = document.createTreeWalker(edit, NodeFilter.SHOW_TEXT, null);
    let acc = 0, node;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (acc + len >= offset) {
        const r = document.createRange();
        r.setStart(node, Math.max(0, Math.min(len, offset - acc)));
        r.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        return;
      }
      acc += len;
    }
    const r = document.createRange();
    r.selectNodeContents(edit);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** 在纯文本上做一次编辑：fn(src, start, end) → { text, caret } */
  function bbApply(fn) {
    const edit = bbEditEl();
    if (!edit) return;
    const src = bbSource(edit);
    // 优先用 mousedown 时快照下来的选区（见 bindComposer），否则读当前光标
    const off = COMPOSER.sel || caretOffsets(edit) || { start: src.length, end: src.length };
    COMPOSER.sel = null;
    const out = fn(src, off.start, off.end);
    if (!out) return;
    edit.textContent = out.text;
    setCaret(edit, typeof out.caret === "number" ? out.caret : out.text.length);
    bbSyncState();
  }

  function opWrap(before, after) {
    return (src, s, e) => {
      const picked = src.slice(s, e);
      if (picked) {
        return {
          text: src.slice(0, s) + before + picked + after + src.slice(e),
          caret: s + before.length + picked.length + after.length
        };
      }
      return { text: src.slice(0, s) + before + after + src.slice(s), caret: s + before.length };
    };
  }

  function opInsertAtLineStart(prefix) {
    return (src, s) => {
      const ls = src.lastIndexOf("\n", s - 1) + 1;
      let le = src.indexOf("\n", s);
      if (le < 0) le = src.length;
      const line = src.slice(ls, le);
      if (line.startsWith(prefix)) {
        return { text: src.slice(0, ls) + line.slice(prefix.length) + src.slice(le), caret: Math.max(ls, s - prefix.length) };
      }
      return { text: src.slice(0, ls) + prefix + src.slice(ls), caret: s + prefix.length };
    };
  }

  /** 代码：选中多行 → [code] 块；否则插一对行内代码 */
  function opCode() {
    return (src, s, e) => {
      const picked = src.slice(s, e);
      if (picked.includes("\n")) {
        return { text: src.slice(0, s) + "[code]\n" + picked + "\n[/code]" + src.slice(e), caret: s + 7 + picked.length + 7 };
      }
      return { text: src.slice(0, s) + "[code]" + picked + "[/code]" + src.slice(e), caret: s + 6 + picked.length + 7 };
    };
  }

  /** 折叠：选中文字当标题，光标放到正文里 */
  function opCollapse() {
    return (src, s, e) => {
      const picked = src.slice(s, e).replace(/\n/g, " ").trim();
      const head = "[collapse=" + (picked || "点击展开") + "]\n";
      return {
        text: src.slice(0, s) + head + "\n[/collapse]" + src.slice(e),
        caret: s + head.length
      };
    };
  }

  /** 列表：把选中的每一行变成 [*] 项 */
  function opList() {
    return (src, s, e) => {
      const picked = src.slice(s, e);
      if (picked.includes("\n")) {
        const body = picked.split("\n").map((l) => "[*]" + l.trim()).join("\n");
        const block = "[list]\n" + body + "\n[/list]";
        return { text: src.slice(0, s) + block + src.slice(e), caret: s + block.length };
      }
      return { text: src.slice(0, s) + "[list]\n[*]" + src.slice(s), caret: s + 9 };
    };
  }

  function opSnippet(snippet) {
    return (src, s) => ({ text: src.slice(0, s) + snippet + src.slice(s), caret: s + snippet.length });
  }

  /* ---- 实时预览 ---- */

  function bbSyncPreview(src) {
    const box = document.querySelector(".ngax-compose-preview");
    if (!box) return;
    const on = box.closest(".ngax-composer")?.classList.contains("preview-on");
    if (!on) return;
    const text = src == null ? bbSource(bbEditEl()) : src;
    box.innerHTML = text.trim()
      ? bbscodeToHtml(escapeHtml(text), { tid: (PAGE && PAGE.route.tid) || 0 })
      : `<span style="color:var(--cx-text-faint)">（还没有内容）</span>`;
  }

  /* ---- 表情面板 ---- */

  function ensureSmilePop() {
    const pop = document.querySelector("[data-smile-pop]");
    if (!pop || pop.dataset.built === "1") return pop;
    pop.dataset.built = "1";
    const groups = [];
    for (const [name, file, cat] of NGA_SMILES) {
      let g = groups.find((x) => x.cat === cat);
      if (!g) { g = { cat, items: [] }; groups.push(g); }
      g.items.push({ name, file });
    }
    pop.innerHTML = groups.map((g) => `
      <div class="ngax-smile-group">
        <div class="ngax-smile-title">[s:${escapeHtml(g.cat)}:…]</div>
        <div class="ngax-smile-grid">${g.items.map((s) =>
          `<button type="button" data-smile="${escapeHtml(g.cat + ":" + s.name)}" title="${escapeHtml(s.name)}">` +
          `<img loading="lazy" src="${SMILE_BASE}${escapeHtml(s.file)}" alt="${escapeHtml(s.name)}"></button>`).join("")}</div>
      </div>`).join("");
    return pop;
  }

  /* ---- 发送：驱动 NGA 自己的快速回复 / 快速发帖表单 ---- */

  /**
   * NGA 的原生快速回复框。
   *
   * 它由 commonui.fastPostUi(fid, tid) 在页面加载时建好，塞在 <span id='fast_post_c'> 里：
   *   <input>      标题（只有发新帖才有）
   *   <textarea>   正文（BBSCode）
   *   <a.uitxt1>   发表回复 / 发表新帖（Ctrl+Enter）
   * 提交走 commonui.newPost()，里面有校验位、权限位、确认弹窗一整套。
   * 所以这里只「填值 + 点它自己的按钮」，绝不自己发请求 ——
   * 和 V2EX 版驱动原生回复框是同一个思路。
   */
  function nativePostForm() {
    const box = document.getElementById("fast_post_c");
    if (!box) return null;
    const ta = box.querySelector("textarea");
    if (!ta) return null;
    const submit = box.querySelector("a.uitxt1")
      || Array.from(box.querySelectorAll("a")).find((a) => /发表(回复|新帖)/.test(txt(a)));
    const subject = box.querySelector("input[type='text'], input:not([type])");
    return { box, ta, submit, subject };
  }

  function bbSend() {
    const edit = bbEditEl();
    if (!edit) return;
    const text = bbSource(edit).trim();
    if (!text) { setStatus("写点什么先", "err"); return; }

    const r = route();
    const form = nativePostForm();
    const isNewTopic = r.kind === "list" || r.kind === "home";

    if (!form) {
      // 未登录 / 原生表单没建起来：不伪造提交，老实复制草稿并给原生入口
      copyText(text);
      setStatus(isNewTopic ? "没有可用的原生发帖表单，草稿已复制" : "没有可用的原生回复框，草稿已复制", "err");
      const url = isNewTopic
        ? "/post.php" + (r.kind === "list" && r.listKind === "forum" ? "?fid=" + r.fid : "")
        : "/post.php?action=reply&fid=" + ((PAGE && PAGE.fid) || "") + "&tid=" + r.tid;
      window.open(url, "_blank", "noopener");
      return;
    }

    try {
      if (isNewTopic) {
        // 发新帖的快速表单有标题字段：约定「首行当标题，其余当正文」，
        // 状态栏会明说这件事，免得用户以为正文被吃了
        const lines = text.split("\n");
        const title = (lines.shift() || "").replace(/^\[[^\]]*\]\s*/, "").trim();
        if (form.subject) {
          form.subject.value = title;
          form.subject.dispatchEvent(new Event("input", { bubbles: true }));
          form.ta.value = lines.join("\n").trim();
        } else {
          form.ta.value = text;
        }
      } else {
        form.ta.value = text;
      }
      form.ta.dispatchEvent(new Event("input", { bubbles: true }));
      form.ta.dispatchEvent(new Event("change", { bubbles: true }));

      if (!form.submit) {
        setStatus("已填入原生表单，请手动提交", "ok");
        return;
      }
      form.submit.click();
      setStatus(isNewTopic ? "已提交发帖…" : "已提交回复…", "ok");
      lsSet(COMPOSER.draftKey, "");
      edit.textContent = "";
      bbSyncState();
    } catch (err) {
      setStatus("提交失败：" + ((err && err.message) || err), "err");
    }
  }

  /* ---- 草稿 + 占位符随路由同步 ---- */

  const COMPOSER = { draftKey: "", sel: null };

  function syncComposer(page) {
    const edit = bbEditEl();
    if (!edit) return;
    const r = page.route;

    let placeholder = "发新帖：首行当标题，其余当正文…";
    let key = "ngax:draft:new";
    if (r.kind === "thread" && page.thread) {
      placeholder = `回复「${page.thread.title}」…（BBSCode，Enter 发送 / Shift+Enter 换行）`;
      key = "ngax:draft:t:" + r.tid;
    } else if (r.kind === "list") {
      const t = listTitle(r, page);
      placeholder = `在 ${t} 发新帖：首行当标题，其余当正文…`;
      key = "ngax:draft:l:" + (r.fid || r.stid || r.key || r.authorId || "");
    } else if (r.kind === "member") {
      placeholder = "用户页不能发帖，去版面里发…";
      key = "ngax:draft:member:" + r.uid;
    } else if (r.kind === "home") {
      placeholder = "首页没有发帖入口，去版面里发…";
      key = "ngax:draft:home";
    }

    edit.dataset.placeholder = placeholder;

    // 只在真正换了目标时恢复草稿（否则会覆盖用户正在写的内容）
    if (COMPOSER.draftKey !== key) {
      COMPOSER.draftKey = key;
      edit.textContent = lsGet(key, "");
      setStatus("");
    }
    bbSyncState();
  }

  /* ---- 事件绑定（在 ensureMain 里调一次） ---- */

  function bindComposer(main) {
    const edit = main.querySelector(".ngax-md-edit");
    const composer = main.querySelector(".ngax-composer");
    if (!edit || !composer) return;

    edit.addEventListener("input", bbSyncState);

    // Enter 发送 / Shift+Enter 换行
    edit.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        bbSend();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const k = (e.key || "").toLowerCase();
      if (k === "b") { e.preventDefault(); bbApply(opWrap("[b]", "[/b]")); }
      else if (k === "i") { e.preventDefault(); bbApply(opWrap("[i]", "[/i]")); }
      else if (k === "u") { e.preventDefault(); bbApply(opWrap("[u]", "[/u]")); }
      else if (k === "e") { e.preventDefault(); bbApply(opCode()); }
    });

    // 粘贴一律落成纯文本，避免把外部 HTML 带进编辑区
    edit.addEventListener("paste", (e) => {
      const text = (e.clipboardData || window.clipboardData)?.getData("text/plain");
      if (text == null) return;
      e.preventDefault();
      bbApply(opSnippet(text));
    });

    // 工具条按下时：先快照选区，再阻止默认行为。
    // 否则按钮会抢走 contenteditable 的焦点，选区在 click 处理器运行前就已经塌陷。
    composer.addEventListener("mousedown", (e) => {
      if (e.target.closest("[data-tool], [data-send], [data-smile], [data-plus-item]")) {
        const box = bbEditEl();
        COMPOSER.sel = box ? caretOffsets(box) : null;
        e.preventDefault();
      }
    });

    composer.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tool]");
      if (btn) {
        const tool = btn.dataset.tool;
        const plus = composer.querySelector("[data-plus-pop]");
        const smi = composer.querySelector("[data-smile-pop]");
        if (tool === "plus") {
          smi?.classList.remove("on");
          plus?.classList.toggle("on");
          return;
        }
        if (tool === "smile") {
          plus?.classList.remove("on");
          const pop = ensureSmilePop();
          pop?.classList.toggle("on");
          return;
        }
        plus?.classList.remove("on");
        smi?.classList.remove("on");
        edit.focus();
        switch (tool) {
          case "bold": bbApply(opWrap("[b]", "[/b]")); break;
          case "italic": bbApply(opWrap("[i]", "[/i]")); break;
          case "underline": bbApply(opWrap("[u]", "[/u]")); break;
          case "strike": bbApply(opWrap("[del]", "[/del]")); break;
          case "link": bbApply(opWrap("[url]", "[/url]")); break;
          case "quote": bbApply(opSnippet("[quote]\n\n[/quote]")); break;
          case "code": bbApply(opCode()); break;
          case "collapse": bbApply(opCollapse()); break;
          case "image": bbApply(opSnippet("[img][/img]")); break;
          case "listUl": bbApply(opList()); break;
          case "preview": {
            composer.classList.toggle("preview-on");
            btn.classList.toggle("on", composer.classList.contains("preview-on"));
            bbSyncPreview();
            break;
          }
          default: break;
        }
        return;
      }

      const smile = e.target.closest("[data-smile]");
      if (smile) {
        edit.focus();
        bbApply(opSnippet("[s:" + smile.dataset.smile + "]"));
        return;
      }

      const plus = e.target.closest("[data-plus-item]");
      if (plus) {
        const item = PLUS_ITEMS[Number(plus.dataset.plusItem)];
        if (item) { edit.focus(); bbApply(opSnippet(item.snippet)); }
        composer.querySelector("[data-plus-pop]")?.classList.remove("on");
        return;
      }

      if (e.target.closest("[data-send]")) { bbSend(); return; }

      // 点空白处收起弹层
      if (!e.target.closest("[data-plus-pop], [data-smile-pop]")) {
        composer.querySelectorAll("[data-plus-pop], [data-smile-pop]").forEach((p) => p.classList.remove("on"));
      }
    });
  }

  /* ============================== 楼层操作（全部走原生能力） ==============================
   *
   * 这一段是「不自己造请求」原则最集中的地方：
   *   引用     → 生成 NGA 原生格式的 [quote]，塞进原生回复框（不提交）
   *   支持/反对 → commonui.postScoreAdd(el, postArg.data[i], badgood)
   *   收藏     → commonui.favor(event, el, tid, pid)
   *   复制链接 → 本地
   * 好处：校验位、权限位、每日额度、登录判定、报错文案全部由站点负责，
   * 我们既不用抄一套，也不会因为抄错而「看起来点赞成功其实没发出去」。
   * ================================================================================== */

  /** NGA 的引用格式，照抄 commonui.quoteTo.procText() 的产物 */
  function buildQuote(post) {
    const isOp = !post.pid;
    const tag = isOp ? "tid" : "pid";
    const id = isOp ? post.tid : post.pid;
    const label = isOp ? "Topic" : "Reply";
    // 引用的时间用 NGA 自己的格式：Y-m-d H:i
    const d = post.timeIso ? new Date(post.timeIso) : new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const time = Number.isNaN(d.getTime())
      ? ""
      : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;

    // 引用的正文取纯文本（NGA 自己也是取纯文本，图会变成"图片"占位）
    const holder = el("div");
    holder.innerHTML = bbscodeToHtml(cleanContent(post.contentHtml), { tid: post.tid });
    holder.querySelectorAll("img").forEach((img) => {
      img.replaceWith(document.createTextNode("[图片]"));
    });
    let body = (holder.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    if (body.length > 400) body = body.slice(0, 400) + "…";

    return `[quote][${tag}=${id}]${label}[/${tag}] [b]Post by [uid=${post.uid || ""}]${post.username}[/uid] (${time}):[/b]\n\n${body}[/quote]\n`;
  }

  function handleTurnAction(act, e) {
    const kind = act.dataset.act;

    if (kind === "copy-link") {
      copyText(act.dataset.value || location.href);
      return;
    }

    if (kind === "reply") {
      // 正文里的 [@某人]：把 @提及插到输入框
      const user = act.dataset.user || "";
      const edit = bbEditEl();
      if (edit) {
        edit.focus();
        bbApply(opSnippet("@" + user + " "));
        setStatus("回复 @" + user, "ok");
      }
      return;
    }

    if (kind === "quote") {
      const i = num(act.dataset.i);
      const post = PAGE && PAGE.thread && PAGE.thread.posts[i];
      if (!post) { toastNow("拿不到该楼层数据"); return; }
      const edit = bbEditEl();
      if (!edit) return;
      edit.focus();
      // 引用放在最前面（和 NGA 原生行为一致），已有的草稿顺延到后面
      const src = bbSource(edit);
      edit.textContent = buildQuote(post) + (src.trim() ? "\n" + src : "");
      bbSyncState();
      setStatus("已引用 " + floorLabel(post.i) + " · " + post.username, "ok");
      scrollNearest(document.querySelector(".ngax-composer"));
      return;
    }

    if (kind === "good" || kind === "bad") {
      const i = num(act.dataset.i);
      const arg = postArg(i);
      const fn = com() && com().postScoreAdd;
      if (!arg || typeof fn !== "function") {
        toastNow("原生脚本未就绪，试试原生页面");
        return;
      }
      // NGA 的原生函数：第三个参数为真表示「反对」
      fn(act, arg, kind === "bad" ? 1 : 0);
      return;
    }

    if (kind === "fav") {
      const fn = com() && com().favor;
      const tid = (PAGE && PAGE.route.tid) || 0;
      const pid = num(act.dataset.pid);
      if (typeof fn !== "function" || !tid) {
        toastNow("原生脚本未就绪，试试原生页面");
        return;
      }
      // NGA 的收藏会弹出「收藏到哪个收藏夹」的窗口，用的是站点自己的 UI
      fn(e || null, act, tid, pid);
      return;
    }
  }

  /* ============================== 右侧代码面板（纯氛围） ==============================
   *
   * 内容和这个论坛**没有任何关系**，是刻意保持中立的通用工程代码：
   * 摸鱼时被人扫一眼，看到的是"某人在改一个抓取/缓存模块"，
   * 而不是"某人在逛一个论坛"。项目名也走 settings（默认 platform）。
   * ============================================================================== */

  const CODE_LANGS = {
    rust: {
      label: "Rust", file: "forum_cache.rs", dir: "store", icon: "RS", comment: "//",
      get root() { return cfg("projectName"); },
      kw: ["fn", "let", "mut", "impl", "pub", "use", "struct", "enum", "match", "if", "else", "for", "in", "return", "mod", "crate", "self", "Self", "async", "await", "move", "where", "const", "trait", "loop", "while", "Ok", "Err", "Some", "None", "Box", "Vec", "String", "Result", "Option"],
      blocks: [
        ["use std::collections::HashMap;", "use std::time::{Duration, Instant};", ""],
        ["pub struct ThreadCache {", "    entries: HashMap<u64, CachedThread>,", "    ttl: Duration,", "}", ""],
        ["pub struct CachedThread {", "    id: u64,", "    title: String,", "    posts: usize,", "    fetched_at: Instant,", "}", ""],
        ["impl ThreadCache {", "    pub fn new(ttl: Duration) -> Self {", "        Self { entries: HashMap::new(), ttl }", "    }", "}", ""],
        ["    pub fn get(&self, id: u64) -> Option<&CachedThread> {", "        match self.entries.get(&id) {", "            Some(t) if !self.stale(t) => Some(t),", "            _ => None,", "        }", "    }", ""],
        ["    fn stale(&self, t: &CachedThread) -> bool {", "        t.fetched_at.elapsed() > self.ttl", "    }", ""],
        ["    pub async fn refresh(&mut self, id: u64) -> Result<(), FetchError> {", "        let fresh = fetch_page(id).await?;", "        self.entries.insert(id, fresh);", "        Ok(())", "    }", ""],
        ["#[derive(Debug, Clone, Copy)]", "pub enum ViewMode {", "    List,", "    Detail { id: u64 },", "    Split { id: u64, panel: PanelKind },", "}", ""],
        ["// 列表页每页 20 条，翻页时只重渲染主区，侧栏保持不动", "const PAGE_SIZE: usize = 20;", ""],
        ["#[cfg(test)]", "mod tests {", "    use super::*;", "", "    #[test]", "    fn expired_entry_is_dropped() {", "        let mut c = ThreadCache::new(Duration::from_secs(0));", "        c.entries.insert(1, CachedThread::default());", "        assert!(c.get(1).is_none());", "    }", "}", ""]
      ]
    },
    python: {
      label: "Python", file: "crawler.py", dir: "workers", icon: "PY", comment: "#",
      get root() { return cfg("projectName"); },
      kw: ["def", "class", "return", "if", "else", "elif", "for", "while", "in", "import", "from", "as", "with", "try", "except", "finally", "raise", "lambda", "None", "True", "False", "async", "await", "yield", "pass", "self", "is", "not", "and", "or"],
      blocks: [
        ["import asyncio", "import hashlib", "from dataclasses import dataclass, field", "from typing import Optional", ""],
        ["@dataclass", "class PageSnapshot:", "    page_id: int", "    title: str", "    items: list = field(default_factory=list)", "    fetched_at: float = 0.0", ""],
        ["class Crawler:", '    """列表 -> 详情 -> 分页，每页 20 条。"""', "", "    def __init__(self, workers: int = 8):", "        self.workers = workers", "        self.queue: asyncio.Queue = asyncio.Queue(maxsize=1024)", "        self.seen: set[int] = set()", ""],
        ["    async def run(self) -> None:", "        producers = [asyncio.create_task(self.produce(i)) for i in range(2)]", "        consumers = [asyncio.create_task(self.consume(i)) for i in range(self.workers)]", "        await asyncio.gather(*producers, *consumers)", ""],
        ["    async def consume(self, idx: int) -> None:", "        while True:", "            snap = await self.queue.get()", "            try:", "                await self.persist(snap)", "            except Exception as exc:", '                logger.warning("persist failed: %s", exc)', "            finally:", "                self.queue.task_done()", ""],
        ["    def fingerprint(self, snap: PageSnapshot) -> str:", "        digest = hashlib.sha256(snap.title.encode()).hexdigest()", "        return digest[:16]", ""],
        ["    async def page_count(self, total_items: int) -> int:", "        return max(1, -(-total_items // PAGE_SIZE))", ""],
        ["def backoff(attempt: int, base: float = 0.5) -> float:", "    # 指数退避 + 抖动，避免触发站点限流", "    return base * (2 ** attempt) * (0.5 + random.random())", ""],
        ["async def main() -> None:", "    crawler = Crawler(workers=16)", "    await crawler.run()", "", 'if __name__ == "__main__":', "    asyncio.run(main())", ""]
      ]
    },
    typescript: {
      label: "TypeScript", file: "app.ts", dir: "web", icon: "TS", comment: "//",
      get root() { return cfg("projectName"); },
      kw: ["const", "let", "var", "function", "return", "if", "else", "for", "of", "in", "while", "import", "from", "export", "default", "class", "extends", "interface", "type", "enum", "new", "this", "async", "await", "try", "catch", "finally", "throw", "switch", "case", "break", "readonly", "public", "private", "void", "string", "number", "boolean", "Promise", "Map", "Set"],
      blocks: [
        ['import { EventEmitter } from "events";', 'import type { Thread, Post, BoardInfo } from "./types";', ""],
        ["interface CacheEntry<T> {", "  value: T;", "  expiresAt: number;", "}", ""],
        ["export class ThreadStore extends EventEmitter {", "  private cache = new Map<number, CacheEntry<Thread>>();", "  private readonly ttl = 30_000;", "", "  constructor(private readonly client: ApiClient) {", "    super();", "  }", ""],
        ["  async get(id: number): Promise<Thread | null> {", "    const hit = this.cache.get(id);", "    if (hit && hit.expiresAt > Date.now()) return hit.value;", "    const fresh = await this.client.fetchThread(id);", "    this.cache.set(id, { value: fresh, expiresAt: Date.now() + this.ttl });", '    this.emit("update", fresh);', "    return fresh;", "  }", ""],
        ["  async posts(id: number, page: number): Promise<Post[]> {", "    // 详情页每页 20 楼", "    return this.client.fetchPosts(id, page);", "  }", ""],
        ["  invalidate(id?: number): void {", "    if (id === undefined) this.cache.clear();", "    else this.cache.delete(id);", "  }", ""],
        ["export function renderRow(t: Thread): string {", '  const board = t.board ? `[${t.board.name}]` : "";', "  return `${board} ${t.title} (${t.replies})`;", "}", ""],
        ["// 状态机：idle -> loading -> ready | error", "type ViewState =", '  | { kind: "idle" }', '  | { kind: "loading" }', '  | { kind: "ready"; posts: Post[] }', '  | { kind: "error"; message: string };', ""],
        ["export function reduce(state: ViewState, ev: ViewEvent): ViewState {", "  switch (ev.type) {", '    case "load": return { kind: "loading" };', '    case "ok":   return { kind: "ready", posts: ev.posts };', '    case "err":  return { kind: "error", message: ev.message };', "    default:     return state;", "  }", "}", ""],
        ["const store = new ThreadStore(new ApiClient(BASE_URL));", 'store.on("update", (t) => console.log("thread updated", t.id));', ""]
      ]
    },
    go: {
      label: "Go", file: "main.go", dir: "cmd", icon: "GO", comment: "//",
      get root() { return cfg("projectName"); },
      kw: ["func", "package", "import", "return", "if", "else", "for", "range", "go", "chan", "select", "case", "default", "type", "struct", "interface", "map", "var", "const", "defer", "nil", "err", "string", "int", "bool", "error", "true", "false"],
      blocks: [
        ["package main", "", "import (", '    "context"', '    "fmt"', '    "sync"', '    "time"', ")", ""],
        ["type ThreadCache struct {", "    mu      sync.RWMutex", "    entries map[uint64]CachedThread", "    ttl     time.Duration", "}", ""],
        ["func NewThreadCache(ttl time.Duration) *ThreadCache {", "    return &ThreadCache{entries: make(map[uint64]CachedThread), ttl: ttl}", "}", ""],
        ["func (c *ThreadCache) Get(id uint64) (CachedThread, bool) {", "    c.mu.RLock()", "    defer c.mu.RUnlock()", "    t, ok := c.entries[id]", "    if !ok || t.Expired(c.ttl) {", "        return CachedThread{}, false", "    }", "    return t, true", "}", ""],
        ["func (c *ThreadCache) Refresh(ctx context.Context, id uint64) error {", "    fresh, err := FetchPage(ctx, id)", "    if err != nil {", '        return fmt.Errorf("refresh page %d: %w", id, err)', "    }", "    c.mu.Lock()", "    defer c.mu.Unlock()", "    c.entries[id] = fresh", "    return nil", "}", ""],
        ["// 每页 20 条，按总分页拉取剩余楼层", "func TotalPages(posts int) int {", "    if posts <= 20 {", "        return 1", "    }", "    return (posts + 19) / 20", "}", ""],
        ["func main() {", "    ctx, cancel := context.WithCancel(context.Background())", "    defer cancel()", "    cache := NewThreadCache(30 * time.Second)", '    fmt.Println("listening on :8080", cache)', "}", ""]
      ]
    },
    java: {
      label: "Java", file: "ThreadService.java", dir: "src/main/java", icon: "JV", comment: "//",
      get root() { return cfg("projectName"); },
      kw: ["public", "private", "protected", "class", "interface", "enum", "static", "final", "void", "return", "if", "else", "for", "while", "new", "this", "import", "package", "extends", "implements", "try", "catch", "finally", "throw", "throws", "int", "long", "boolean", "String", "List", "Map", "Optional", "var"],
      blocks: [
        ["package com.example.crawler;", "", "import java.time.Duration;", "import java.util.Map;", "import java.util.Optional;", "import java.util.concurrent.ConcurrentHashMap;", ""],
        ["public class ThreadService {", "", "    private final Map<Long, CachedThread> cache = new ConcurrentHashMap<>();", "    private final Duration ttl;", "    private final PageClient client;", ""],
        ["    public ThreadService(PageClient client, Duration ttl) {", "        this.client = client;", "        this.ttl = ttl;", "    }", ""],
        ["    public Optional<CachedThread> get(long id) {", "        CachedThread hit = cache.get(id);", "        if (hit == null || hit.expired(ttl)) {", "            return Optional.empty();", "        }", "        return Optional.of(hit);", "    }", ""],
        ["    public CachedThread refresh(long id) throws FetchException {", "        CachedThread fresh = client.fetchPage(id);", "        cache.put(id, fresh);", "        return fresh;", "    }", ""],
        ["    // 每页 20 条", "    public int totalPages(int items) {", "        return items <= 20 ? 1 : (items + 19) / 20;", "    }", "", "}", ""]
      ]
    }
  };

  /** 迷你语法高亮（字符串 → 转义 → 关键字/数字/类型 → 注释） */
  function highlightCode(line, L) {
    let s = line, cm = "";
    const ci = s.indexOf(L.comment);
    if (ci >= 0) { cm = s.slice(ci); s = s.slice(0, ci); }
    const slots = [];
    const stash = (m) => { slots.push(m); return "\u0001" + (slots.length - 1) + "\u0002"; };
    s = s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
      (m) => stash('<span class="tk-s">' + escapeHtml(m) + "</span>"));
    s = escapeHtml(s);
    s = s.replace(new RegExp("\\b(" + L.kw.join("|") + ")\\b", "g"), '<span class="tk-k">$1</span>');
    s = s.replace(/\b(\d[\d_]*(?:\.\d+)?)\b/g, '<span class="tk-n">$1</span>');
    s = s.replace(/\b([A-Z][A-Za-z0-9]+)\b/g, '<span class="tk-t">$1</span>');
    s = s.replace(/\u0001(\d+)\u0002/g, (_, i) => slots[+i]);
    if (cm) s += '<span class="tk-c">' + escapeHtml(cm) + "</span>";
    return s;
  }

  function genCodeLines(langKey, seed) {
    const L = CODE_LANGS[langKey];
    const rnd = mulberry32(((seed || 0) * 2654435761 + langKey.length * 97 + 7) | 0);
    const out = [];
    let guard = 0;
    while (out.length < 150 && guard++ < 60) {
      out.push(...L.blocks[Math.floor(rnd() * L.blocks.length)]);
    }
    return out;
  }

  function getLang() {
    const v = cfg("lang");
    return CODE_LANGS[v] ? v : "rust";
  }

  function getCodeMode() {
    return cfg("codeMode") === "diff" ? "diff" : "code";
  }

  function panelHidden() {
    return !cfg("codePanel");
  }

  function setPanelHidden(hidden, persist) {
    const main = document.querySelector(".ngax-main");
    if (!main) return;
    main.classList.toggle("panel-hidden", hidden);
    if (persist) {
      // 顶栏那个按钮和设置面板里的开关是同一件事，改完要把面板里的状态同步过去
      setCfg("codePanel", !hidden, { visualOnly: true });
      syncSettingControls();
    }
  }

  /** 面板种子：帖子 = tid；列表 = 路径字符串哈希 */
  function panelSeed() {
    const r = route();
    if (r.kind === "thread" && r.tid) return r.tid | 0;
    const s = r.path + (r.fid || r.stid || r.key || r.authorId || "");
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  function renderCodePanel() {
    const main = document.querySelector(".ngax-main");
    if (!main) return;
    const L = CODE_LANGS[getLang()];
    const mode = getCodeMode();
    const seed = panelSeed();
    const r = route();

    const iconEl = main.querySelector("[data-code-icon]");
    const fileEl = main.querySelector("[data-code-file-name]");
    if (iconEl) iconEl.textContent = L.icon;
    if (fileEl) fileEl.textContent = L.file;

    const setSeg = (sel, text) => {
      const n = main.querySelector(sel);
      if (n) n.textContent = text;
    };
    setSeg("[data-code-crumb-root]", L.root);
    setSeg("[data-code-crumb-cat]", r.kind === "thread" ? "threads" : (r.listKind || "boards"));
    setSeg("[data-code-crumb-dir]", r.kind === "thread" ? "detail" : L.dir);
    setSeg("[data-code-crumb-file]", L.file);

    const langLabel = main.querySelector("[data-lang-label]");
    if (langLabel) langLabel.textContent = L.label;

    const menu = main.querySelector("[data-lang-menu]");
    if (menu) {
      menu.innerHTML = Object.entries(CODE_LANGS).map(([k, v]) =>
        `<div class="${k === getLang() ? "on" : ""}" data-code-lang-item="${k}">
           <span>${escapeHtml(v.label)}</span><span style="color:var(--cx-text-faint)">${escapeHtml(v.file)}</span>
         </div>`).join("");
    }

    const body = main.querySelector("[data-code-body]");
    if (!body) return;
    const lines = genCodeLines(getLang(), seed);

    let html = "";
    if (mode === "diff") {
      const rnd = mulberry32((seed * 7919 + 13) | 0);
      let ln = 0;
      lines.forEach((line, i) => {
        if (i % 17 === 0) {
          html += `<div class="ngax-code-line hunk"><span class="ngax-ln"></span><span class="ngax-src">@@ -${ln + 1},9 +${ln + 1},11 @@</span></div>`;
        }
        const roll = rnd();
        const cls = roll < 0.14 ? " del" : roll < 0.30 ? " add" : "";
        if (cls !== " del") ln++;
        const src = cls === " del" ? line : (cls === " add" ? line + "_patched();" : line);
        html += `<div class="ngax-code-line${cls}"><span class="ngax-ln">${ln || ""}</span><span class="ngax-src">${highlightCode(src, L)}</span></div>`;
      });
    } else {
      lines.forEach((line, i) => {
        html += `<div class="ngax-code-line"><span class="ngax-ln">${i + 1}</span><span class="ngax-src">${highlightCode(line, L)}</span></div>`;
      });
    }
    body.innerHTML = html;
    body.scrollTop = 0;
    setPanelHidden(panelHidden(), false);
    syncTitle();
    if (bossOn()) renderBoss();
  }

  /* ============================== 三栏拖拽调宽 ============================== */

  /**
   * 两个拖拽把手：rail 右缘、代码面板左缘。
   * 宽度在这里是「直接改 CSS 变量」而不是走 setCfg()，因为 mousemove 频率很高；
   * 松手时才落到设置里。双击 = 重置回 DEFAULTS 里的默认宽度。
   */
  function bindResizers(main) {
    document.querySelectorAll(".ngax-resizer").forEach((rz) => {
      if (rz.dataset.bound === "1") return;
      rz.dataset.bound = "1";

      const isRail = rz.dataset.resize === "rail";
      const apply = (w) => {
        if (isRail) {
          document.documentElement.style.setProperty("--cx-rail-w", w + "px");
          const rail = document.querySelector(".ngax-rail");
          if (rail) rail.style.width = w + "px";
        } else {
          document.documentElement.style.setProperty("--ngax-panel-w", w + "px");
          if (main) main.style.setProperty("--ngax-panel-w", w + "px");
        }
      };

      rz.addEventListener("dblclick", () => {
        const def = isRail ? RAIL_W : PANEL_DEFAULT_W;
        apply(def);
        setCfg(isRail ? "railWidth" : "panelWidth", def, { visualOnly: true });
        toastNow(isRail ? "侧栏宽度已重置" : "面板宽度已重置");
      });

      rz.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const rail = document.querySelector(".ngax-rail");
        const startRail = rail ? rail.getBoundingClientRect().width : RAIL_W;
        const panelEl = (main || document).querySelector(".ngax-code-panel");
        const startPanel = panelEl ? panelEl.getBoundingClientRect().width : PANEL_DEFAULT_W;
        rz.classList.add("dragging");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";

        const move = (ev) => {
          const dx = ev.clientX - startX;
          if (isRail) {
            apply(Math.round(Math.min(520, Math.max(200, startRail + dx))));
          } else {
            // 把手在面板左缘，往左拖 → 面板变宽
            apply(Math.round(Math.min(window.innerWidth - 520, Math.max(240, startPanel - dx))));
          }
        };
        const up = () => {
          rz.classList.remove("dragging");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          if (isRail) {
            const w = rail ? Math.round(rail.getBoundingClientRect().width) : RAIL_W;
            setCfg("railWidth", w, { visualOnly: true });
            syncSettingControls();
          } else {
            const el2 = (main || document).querySelector(".ngax-code-panel");
            const w = Math.round(el2 ? el2.getBoundingClientRect().width : 0);
            if (w) { setCfg("panelWidth", w, { visualOnly: true }); syncSettingControls(); }
          }
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });
    });
  }

  /* ============================== 图片灯箱 ============================== */

  let lightboxOpen = false;

  function closeLightbox() {
    document.querySelector(".ngax-lightbox")?.remove();
    lightboxOpen = false;
    document.removeEventListener("keydown", onLightboxKey);
  }

  function onLightboxKey(e) {
    if (e.key === "Escape") closeLightbox();
  }

  function openLightbox(src, alt) {
    hideImgPreview(); // 灯箱和悬浮预览别叠在一起
    closeLightbox();
    const box = el("div", "ngax-lightbox");
    box.innerHTML = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt || "")}">
      <a class="ngax-lb-open" href="${escapeHtml(src)}" target="_blank" rel="noopener">在新标签打开原图</a>`;
    box.addEventListener("click", (e) => {
      if (e.target === box) closeLightbox();
    });
    document.body.appendChild(box);
    lightboxOpen = true;
    document.addEventListener("keydown", onLightboxKey);
  }

  /**
   * 这个 img 是表情吗？
   *
   * 两种形态都要认：脚本自己渲染的是 ngax-smile，而**真实浏览器里**
   * 正文是站点自己的 ubbcode 渲染的，表情的 class 是 smile / smile_ac /
   * smile_a2 …（见 js_bbscode_core.js 里那个 img class 拼接）。
   * 只认自己那个 class 的话，真实环境里点一下表情会弹出图片灯箱。
   */
  function isSmiley(img) {
    const c = (img && img.className) || "";
    return typeof c === "string" && (c.indexOf("ngax-smile") >= 0 || /(^|\s)smile/.test(c));
  }

  /** 委托：点击正文里的图片开灯箱 */
  function bindLightbox() {
    document.addEventListener("click", (e) => {
      const img = e.target.closest(CONTENT_IMG_SEL);
      if (!img) return;
      if (isSmiley(img)) return;               // 表情不参与灯箱
      const src = img.getAttribute("src") || "";
      if (!src || /^data:image\/svg/i.test(src)) return;
      e.preventDefault();
      e.stopPropagation();
      openLightbox(new URL(src, location.href).href, img.getAttribute("alt"));
    }, true);
  }

  /* ============================== 正文图片：缩略图 + 悬浮预览 ==============================
   *
   * 默认小图（CSS 约束），鼠标停上去在旁边浮出大图，点击仍然开灯箱。
   * 预览用 fixed 定位、不进文档流，所以不会把正文顶得跳来跳去。
   *
   * NGA 的附件图有两种：正文里的 <img>（原图 URL）和
   * 「缩略图 + 点击放大」的链接形式。这里一律用 <img> 自己的 URL：
   * 浏览器已经下载过，所以悬浮预览零延迟、也不会多发请求。
   * ================================================================================= */

  const CONTENT_IMG_SEL = ".ngax-cooked img, .ngax-turn-user-bubble img, .ngax-attach img";

  let imgPreviewEl = null;
  let imgPreviewTarget = null;
  let imgPreviewTimer = null;

  const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)(\?|#|$)/i;

  function contentImgs(root) {
    return (root || document).querySelectorAll(CONTENT_IMG_SEL);
  }

  function fullImageUrl(img) {
    const raw = img.currentSrc || img.src || img.getAttribute("src") || "";
    if (raw) {
      try { return new URL(raw, location.href).href; } catch { /* fallthrough */ }
    }
    const link = img.closest("a[href]");
    const href = link ? link.getAttribute("href") : "";
    if (href && IMG_EXT.test(href)) {
      try { return new URL(href, location.href).href; } catch { /* fallthrough */ }
    }
    return "";
  }

  function ensureImgPreview() {
    if (imgPreviewEl && imgPreviewEl.isConnected) return imgPreviewEl;
    imgPreviewEl = el("div", "ngax-imgpreview");
    imgPreviewEl.innerHTML =
      '<img alt="">' +
      '<span class="ngax-ipv-load">载入中…</span>' +
      '<div class="ngax-ipv-cap"><span class="ngax-ipv-name" data-ipv-name></span>' +
      '<span class="ngax-ipv-size" data-ipv-size></span></div>';
    document.body.appendChild(imgPreviewEl);
    return imgPreviewEl;
  }

  function placeImgPreview(anchorImg) {
    const box = imgPreviewEl;
    if (!box || !anchorImg || !anchorImg.isConnected) return;
    const a = anchorImg.getBoundingClientRect();
    const p = box.getBoundingClientRect();
    const gap = 14;
    const vw = window.innerWidth, vh = window.innerHeight;

    let left = a.right + gap;
    if (left + p.width > vw - gap) left = a.left - gap - p.width;
    if (left < gap) left = Math.max(gap, Math.min(vw - p.width - gap, a.left));

    let top = a.top + (a.height - p.height) / 2;
    top = Math.max(gap, Math.min(vh - p.height - gap, top));

    box.style.left = Math.round(left) + "px";
    box.style.top = Math.round(top) + "px";
  }

  function showImgPreview(img) {
    if (!cfg("thumbPreview")) return;
    if (imgPreviewTarget === img && imgPreviewEl && imgPreviewEl.classList.contains("on")) return;
    const url = fullImageUrl(img);
    if (!url) return;
    imgPreviewTarget = img;
    const box = ensureImgPreview();
    const big = box.querySelector("img");
    if (big.getAttribute("src") !== url) big.setAttribute("src", url);

    const name = decodeURIComponent((url.split("/").pop() || "").split("?")[0]);
    box.querySelector("[data-ipv-name]").textContent = name;
    const w = img.naturalWidth, h = img.naturalHeight;
    box.querySelector("[data-ipv-size]").textContent = w && h ? w + "×" + h : "";

    box.classList.add("on");
    const pending = !big.complete || !big.naturalWidth;
    box.classList.toggle("loading", pending);
    placeImgPreview(img);

    if (pending) {
      big.addEventListener("load", () => {
        if (imgPreviewTarget !== img) return;
        box.classList.remove("loading");
        placeImgPreview(img);
      }, { once: true });
      big.addEventListener("error", () => {
        if (imgPreviewTarget === img) hideImgPreview();
      }, { once: true });
    } else {
      nextFrame(() => { if (box.classList.contains("on")) placeImgPreview(img); });
    }
  }

  function hideImgPreview() {
    imgPreviewTarget = null;
    if (imgPreviewEl) imgPreviewEl.classList.remove("on");
  }

  /** 太小的图（图标、分割线、等级图标）没必要缩略也没必要预览；表情直接跳过 */
  function markSmallImages(root) {
    contentImgs(root || document).forEach((img) => {
      if (isSmiley(img)) return;
      if (img.dataset.sized === "1") return;
      img.dataset.sized = "1";
      const mark = () => {
        const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
        img.dataset.noPreview = (w && w <= 200 && h <= 160) ? "1" : "";
        img.classList.toggle("ngax-img-sm", !!img.dataset.noPreview);
      };
      if (img.complete) mark();
      else img.addEventListener("load", mark, { once: true });
    });
  }

  function bindImgPreview() {
    document.addEventListener("mouseover", (e) => {
      const img = e.target && e.target.closest ? e.target.closest(CONTENT_IMG_SEL) : null;
      if (!img || img.dataset.noPreview === "1" || isSmiley(img)) return;
      clearTimeout(imgPreviewTimer);
      showImgPreview(img);
    }, true);

    document.addEventListener("mouseout", (e) => {
      const img = e.target && e.target.closest ? e.target.closest(CONTENT_IMG_SEL) : null;
      if (!img) return;
      clearTimeout(imgPreviewTimer);
      imgPreviewTimer = setTimeout(hideImgPreview, 70);
    }, true);

    // 滚动会让 fixed 预览和缩略图错位，直接收起
    window.addEventListener("scroll", hideImgPreview, true);
    window.addEventListener("blur", hideImgPreview);
    document.addEventListener("visibilitychange", hideImgPreview);
  }

  /* ============================== 隐蔽性 ==============================
   *
   * 上班摸鱼场景下真正需要的不是「好看」，而是「一眼扫过去不像论坛」：
   *   1. 标签页标题伪装成源码文件名（NGA 的原始 <title> 是「帖子标题 NGA玩家社区」，
   *      这是最容易暴露的地方，所以默认就换掉）
   *   2. 应急伪装键：整个视口瞬间变成「代码编辑器 + 正在跑测试的终端」
   * 伪装视图沿用同一套 token 和同一份假代码生成器，所以切换时看起来像
   * 在同一个 IDE 里换了个面板，而不是「网页变了」。
   * ================================================================= */

  let ORIGINAL_TITLE = null;

  /** 标签页标题 → "<文件名> — <项目名>"，和代码面板/伪装视图保持一致 */
  function syncTitle() {
    if (ORIGINAL_TITLE === null) ORIGINAL_TITLE = document.title;
    if (!cfg("stealth")) {
      if (document.title !== ORIGINAL_TITLE) document.title = ORIGINAL_TITLE;
      return;
    }
    const L = CODE_LANGS[getLang()];
    const want = L.file + " \u2014 " + L.root;
    if (document.title !== want) document.title = want;
  }

  function bossOn() {
    return document.documentElement.classList.contains("ngax-boss-on");
  }

  /** 终端里那串「看起来刚跑完」的构建日志（按种子稳定） */
  const BOSS_TESTS = [
    "cache::tests::stale_entry_is_dropped",
    "cache::tests::refresh_updates_ttl",
    "http::tests::etag_is_stable_across_calls",
    "store::tests::upsert_is_idempotent",
    "parse::tests::unescapes_html_entities",
    "config::tests::env_overrides_file"
  ];

  function bossLogHtml(seed) {
    const rnd = mulberry32(seed);
    const out = [];
    const L = CODE_LANGS[getLang()];
    out.push('<span class="cmd">$ cargo build --release</span>');
    out.push('<span class="dim">   Compiling ' + escapeHtml(L.root) + '-store v0.9.3 (/Users/dev/work/' + escapeHtml(L.root) + '-store)</span>');
    out.push('<span class="dim">   Compiling thread-cache v0.2.4</span>');
    out.push('<span class="ok">    Finished</span> release [optimized] target(s) in ' + (6 + rnd() * 9).toFixed(1) + 's');
    out.push("");
    out.push('<span class="cmd">$ cargo test --release --quiet</span>');
    out.push('<span class="dim">running ' + BOSS_TESTS.length + ' tests</span>');
    for (const t of BOSS_TESTS) out.push("test " + t + " ... <span class=\"ok\">ok</span>");
    out.push("");
    out.push("test result: <span class=\"ok\">ok</span>. " + BOSS_TESTS.length + " passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in " + (0.2 + rnd() * 0.6).toFixed(2) + "s");
    out.push("");
    out.push('<span class="cmd">$ git diff --stat</span>');
    out.push(" 3 files changed, " + (20 + Math.floor(rnd() * 90)) + " insertions(+), " + Math.floor(rnd() * 20) + " deletions(-)");
    out.push("");
    out.push('<span class="cmd">$ <span class="ngax-boss-caret"></span></span>');
    return out.join("\n");
  }

  function ensureBoss() {
    let box = document.querySelector(".ngax-boss");
    if (box) return box;
    box = el("div", "ngax-boss");
    box.hidden = true;
    box.innerHTML = '' +
      '<div class="ngax-boss-bar">' +
      '  <span data-boss-tabs style="display:flex;align-items:center;gap:2px"></span>' +
      '  <span class="ngax-boss-spacer"></span>' +
      '  <span class="ngax-boss-shell" data-boss-shell></span>' +
      "</div>" +
      '<div class="ngax-boss-editor" data-boss-code></div>' +
      '<div class="ngax-boss-term">' +
      '  <div class="ngax-boss-term-head"><span>Terminal</span><span>zsh</span><span>cargo</span></div>' +
      '  <pre class="ngax-boss-term-body" data-boss-log></pre>' +
      "</div>";
    document.body.appendChild(box);
    return box;
  }

  function renderBoss() {
    const box = document.querySelector(".ngax-boss");
    if (!box) return;
    const cur = getLang();
    const others = Object.keys(CODE_LANGS).filter((k) => k !== cur).slice(0, 2);
    const tabs = [cur].concat(others);

    const tabsEl = box.querySelector("[data-boss-tabs]");
    if (tabsEl) {
      tabsEl.innerHTML = tabs.map((k, i) => {
        const l = CODE_LANGS[k];
        return '<span class="ngax-boss-tab' + (i === 0 ? " on" : "") + '">' +
          '<span class="ic">' + escapeHtml(l.icon) + "</span>" + escapeHtml(l.file) + "</span>";
      }).join("");
    }

    const L = CODE_LANGS[cur];
    const seed = panelSeed();
    const codeEl = box.querySelector("[data-boss-code]");
    if (codeEl) {
      const lines = genCodeLines(cur, seed);
      codeEl.innerHTML = lines.map((line, i) =>
        '<div class="ngax-code-line"><span class="ngax-ln">' + (i + 1) + '</span>' +
        '<span class="ngax-src">' + highlightCode(line, L) + "</span></div>").join("");
      codeEl.scrollTop = 0;
    }
    const logEl = box.querySelector("[data-boss-log]");
    if (logEl) {
      logEl.innerHTML = bossLogHtml(seed);
      const toBottom = () => { logEl.scrollTop = logEl.scrollHeight; };
      toBottom();
      nextFrame(toBottom);
    }
    const shellEl = box.querySelector("[data-boss-shell]");
    if (shellEl) shellEl.textContent = "~/work/" + L.root + "-store";
  }

  /** 切换应急伪装视图。注意：只切外观，不卸载任何真实 DOM，恢复时无损失 */
  function setBoss(on) {
    if (!cfg("stealth")) return;
    const box = ensureBoss();
    if (on) {
      // 切进去之前把输入焦点交出去，避免 composer 还在吃按键
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      renderBoss();
      box.hidden = false;
    } else {
      box.hidden = true;
    }
    document.documentElement.classList.toggle("ngax-boss-on", !!on);
  }

  /** "ctrl+shift+h" / "f2" 这类组合键匹配 */
  function bossKeyMatch(e, spec) {
    const parts = String(spec || "").toLowerCase().split("+").map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return false;
    const key = parts[parts.length - 1];
    const mods = parts.slice(0, -1);
    const wantCtrl = mods.indexOf("ctrl") >= 0 || mods.indexOf("cmd") >= 0 || mods.indexOf("meta") >= 0;
    if (wantCtrl !== (e.ctrlKey || e.metaKey)) return false;
    if (mods.indexOf("alt") >= 0 !== e.altKey) return false;
    if (mods.indexOf("shift") >= 0 !== e.shiftKey) return false;
    return (e.key || "").toLowerCase() === key;
  }

  let lastEscAt = 0;

  function bindSettingsKeys() {
    window.addEventListener("keydown", (e) => {
      // Ctrl/⌘ + , —— 和 VS Code / macOS 的「偏好设置」一致
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        e.stopPropagation();
        toggleSettings();
      }
    }, true);
  }

  function bindStealthKeys() {
    const spec = String(cfg("stealthKey") || "esc2").toLowerCase();

    window.addEventListener("keydown", (e) => {
      // 设置面板开着时 Esc 先关面板（别再触发应急伪装）
      if (e.key === "Escape" && settingsOpen()) {
        e.preventDefault();
        closeSettings();
        return;
      }
      if (spec === "esc2" && e.key === "Escape") {
        if (lightboxOpen) return; // 灯箱开着时 Esc 属于灯箱
        const now = Date.now();
        if (now - lastEscAt < 450) {
          lastEscAt = 0;
          e.preventDefault();
          setBoss(!bossOn());
        } else {
          lastEscAt = now;
        }
        return;
      }
      if (bossKeyMatch(e, spec) || bossKeyMatch(e, "ctrl+shift+h")) {
        e.preventDefault();
        e.stopPropagation();
        setBoss(!bossOn());
      }
    }, true);
  }

  /* ============================== 设置面板 ==============================
   *
   * 控件用一张声明式表描述（SETTING_SPEC），加新设置只需要往表里加一行。
   * 交互细节：拖滑块时只改 CSS 变量（previewSetting），松手才 setCfg() 落盘 +
   * 完整重渲染；否则每动一格都要重排整个列表。
   * =================================================================== */

  const SETTING_CSS_VAR = {
    railWidth: "--cx-rail-w",
    panelWidth: "--ngax-panel-w",
    threadMaxWidth: "--ngax-thread-max",
    thumbWidth: "--ngax-thumb-w",
    thumbHeight: "--ngax-thumb-h"
  };

  const SETTING_SPEC = [
    { section: "外观", items: [
      { key: "theme", type: "select", label: "主题", hint: "「跟随 NGA」会读站点自己的夜间模式设置",
        options: [["auto", "跟随 NGA"], ["dark", "深色"], ["light", "浅色"]] },
      { key: "railWidth", type: "range", label: "左栏宽度", min: 200, max: 520, step: 2, unit: "px" },
      { key: "panelWidth", type: "range", label: "代码面板宽度", min: 240, max: 900, step: 4, unit: "px" },
      { key: "threadMaxWidth", type: "range", label: "正文最大宽度", min: 560, max: 1100, step: 10, unit: "px" },
      { key: "codePanel", type: "toggle", label: "显示右侧代码面板", hint: "那块代码是假数据，纯氛围" },
      { key: "lang", type: "select", label: "代码面板语言",
        options: () => Object.keys(CODE_LANGS).map((k) => [k, CODE_LANGS[k].label]) },
      { key: "codeMode", type: "select", label: "代码面板视图", options: [["code", "代码"], ["diff", "diff"]] }
    ] },
    { section: "伪装", items: [
      { key: "stealth", type: "toggle", label: "伪装模式",
        hint: "品牌名 → Codex、标签页标题 → 源码文件名（NGA 的标题里带帖子标题，默认就该换掉）" },
      { key: "brandName", type: "text", label: "左栏品牌名", placeholder: "留空 = 跟随伪装模式" },
      { key: "projectName", type: "text", label: "项目名",
        hint: "出现在代码面板面包屑和标签页标题里（如 \"forum_cache.rs — platform\"）" },
      { key: "stealthKey", type: "select", label: "应急伪装键", hint: "Ctrl+Shift+H 始终有效",
        options: [["esc2", "连按两下 Esc"], ["f2", "F2"], ["ctrl+shift+h", "Ctrl+Shift+H"]] },
      { key: "favicon", type: "select", label: "标签页图标",
        options: [["codex", "Codex 风格圆角图标"], ["site", "保留 NGA 原图标"]] }
    ] },
    { section: "Agent 装饰", items: [
      { key: "decorations", type: "toggle", label: "启用 agent 装饰",
        hint: "思考块和工具调用行。内容是按种子生成的假文案，跟帖子无关，纯装饰" },
      { key: "listTraceRate", type: "range", label: "列表痕迹密度", min: 0, max: 100, step: 2, unit: "%",
        hint: "0 = 列表里不插痕迹" },
      { key: "listThinkingOpen", type: "toggle", label: "列表思考块默认展开",
        hint: "关掉时只占一行「✻ Worked for Ns ▸」，点一下展开" },
      { key: "detailThinkingOpen", type: "toggle", label: "详情页思考块默认展开" }
    ] },
    { section: "引用", items: [
      { key: "quoteCard", type: "toggle", label: "把引用渲染成卡片",
        hint: "NGA 的 [quote] 原生会渲染成灰框，这里升级成可折叠、可跳转到原楼层的卡片" },
      { key: "quoteOpen", type: "toggle", label: "引用卡片默认展开" }
    ] },
    { section: "楼层", items: [
      { key: "avatars", type: "toggle", label: "显示头像", hint: "NGA 原生把头像放左栏，这里改成行内小头像" },
      { key: "showClient", type: "toggle", label: "显示「来自客户端」", hint: "\"8 Android\" / \"100 /\" 这类标识" }
    ] },
    { section: "正文图片", items: [
      { key: "thumbWidth", type: "range", label: "缩略图宽度上限", min: 120, max: 600, step: 10, unit: "px" },
      { key: "thumbHeight", type: "range", label: "缩略图高度上限", min: 80, max: 400, step: 10, unit: "px" },
      { key: "thumbPreview", type: "toggle", label: "鼠标悬停浮出大图" }
    ] }
  ];

  function specItem(key) {
    for (const g of SETTING_SPEC) {
      for (const it of g.items) if (it.key === key) return it;
    }
    return null;
  }

  function settingControlHtml(it) {
    const v = cfg(it.key);
    if (it.type === "toggle") {
      return '<button type="button" class="ngax-switch' + (v ? " on" : "") + '"' +
        ' role="switch" aria-checked="' + (v ? "true" : "false") + '"' +
        ' data-set-toggle="' + it.key + '" aria-label="' + escapeHtml(it.label) + '"><span></span></button>';
    }
    if (it.type === "range") {
      return '<input type="range" class="ngax-range" data-set-range="' + it.key + '"' +
        ' min="' + it.min + '" max="' + it.max + '" step="' + it.step + '" value="' + v + '">' +
        '<span class="ngax-set-val" data-set-val="' + it.key + '">' + v + (it.unit || "") + "</span>";
    }
    if (it.type === "select") {
      const opts = typeof it.options === "function" ? it.options() : it.options;
      return '<select class="ngax-select" data-set-select="' + it.key + '">' +
        opts.map(([val, text]) =>
          '<option value="' + escapeHtml(val) + '"' +
          (String(v) === String(val) ? " selected" : "") + ">" + escapeHtml(text) + "</option>").join("") +
        "</select>";
    }
    return '<input type="text" class="ngax-text" data-set-text="' + it.key + '" value="' +
      escapeHtml(v) + '" placeholder="' + escapeHtml(it.placeholder || "") + '">';
  }

  function settingsOpen() {
    const m = document.querySelector(".ngax-modal");
    return !!m && !m.hidden;
  }

  function closeSettings() {
    const m = document.querySelector(".ngax-modal");
    if (m) m.hidden = true;
  }

  /** 拖滑块时的即时预览：只改 CSS 变量，不写存储、不重渲染 */
  function previewSetting(key, value) {
    const varName = SETTING_CSS_VAR[key];
    if (varName) document.documentElement.style.setProperty(varName, value + "px");
  }

  /** 把面板里所有控件的状态刷成 cfg() 的当前值 */
  function syncSettingControls() {
    const m = document.querySelector(".ngax-modal");
    if (!m || m.hidden) return;
    m.querySelectorAll("[data-set-toggle]").forEach((el2) => {
      const on = !!cfg(el2.dataset.setToggle);
      el2.classList.toggle("on", on);
      el2.setAttribute("aria-checked", on ? "true" : "false");
    });
    m.querySelectorAll("[data-set-range]").forEach((el3) => {
      const it = specItem(el3.dataset.setRange);
      el3.value = cfg(el3.dataset.setRange);
      const out = m.querySelector('[data-set-val="' + el3.dataset.setRange + '"]');
      if (out) out.textContent = el3.value + ((it && it.unit) || "");
    });
    m.querySelectorAll("[data-set-select]").forEach((el4) => {
      el4.value = cfg(el4.dataset.setSelect);
    });
    m.querySelectorAll("[data-set-text]").forEach((el5) => {
      el5.value = cfg(el5.dataset.setText);
    });
  }

  function renderSettingsPanel() {
    let m = document.querySelector(".ngax-modal");
    if (!m) {
      m = el("div", "ngax-modal");
      m.hidden = true;
      document.body.appendChild(m);
    }
    const rows = SETTING_SPEC.map((g) =>
      '<div class="ngax-set-section">' + escapeHtml(g.section) + "</div>" +
      g.items.map((it) =>
        '<div class="ngax-set-row" data-row="' + it.key + '">' +
        '<div class="ngax-set-label"><span>' + escapeHtml(it.label) + "</span>" +
        (it.hint ? '<div class="ngax-set-hint">' + escapeHtml(it.hint) + "</div>" : "") +
        "</div>" +
        '<div class="ngax-set-ctrl">' + settingControlHtml(it) + "</div>" +
        "</div>").join("")
    ).join("");

    m.innerHTML =
      '<div class="ngax-modal-card" role="dialog" aria-modal="true" aria-label="设置">' +
      '<div class="ngax-modal-head">' +
      '<span class="ngax-modal-title">设置</span>' +
      '<span class="ngax-modal-sub">改动即时生效并存在本机</span>' +
      '<button type="button" class="ngax-modal-x" data-settings-close title="关闭（Esc）">×</button>' +
      "</div>" +
      '<div class="ngax-modal-body">' + rows + "</div>" +
      '<div class="ngax-modal-foot">' +
      '<button type="button" class="ngax-modal-btn" data-settings-reset>恢复默认</button>' +
      '<span>设置存在 localStorage 的 <code>ngax:settings</code>，清掉就回到初始状态</span>' +
      "</div>" +
      "</div>";
    return m;
  }

  function openSettings() {
    const m = renderSettingsPanel();
    m.hidden = false;
    m.querySelector("[data-settings-close]")?.focus();
  }

  function toggleSettings() {
    if (settingsOpen()) closeSettings();
    else openSettings();
  }

  function bindSettingsPanel() {
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest && t.closest("[data-settings-open]")) { openSettings(); return; }
      if (!settingsOpen()) return;

      const m = document.querySelector(".ngax-modal");
      if (t.closest("[data-settings-close]")) { closeSettings(); return; }
      if (t.closest("[data-settings-reset]")) {
        resetSettings();
        renderSettingsPanel();
        toastNow("已恢复默认设置");
        return;
      }
      // 点遮罩关闭（点卡片内部不关）
      if (t === m) { closeSettings(); return; }

      const sw = t.closest("[data-set-toggle]");
      if (sw) {
        const key = sw.dataset.setToggle;
        const next = !cfg(key);
        sw.classList.toggle("on", next);
        sw.setAttribute("aria-checked", next ? "true" : "false");
        setCfg(key, next);
        return;
      }
    });

    // 拖滑块：input 只预览，change 才落盘 + 重渲染
    document.addEventListener("input", (e) => {
      const r = e.target;
      if (!r.dataset) return;
      if (r.dataset.setRange) {
        const key = r.dataset.setRange;
        const it = specItem(key);
        previewSetting(key, Number(r.value));
        const out = document.querySelector('[data-set-val="' + key + '"]');
        if (out) out.textContent = r.value + ((it && it.unit) || "");
        return;
      }
      // 文本类输入需要即时反馈（品牌名 / 项目名 → 标题、rail）
      if (r.dataset.setText) {
        const key = r.dataset.setText;
        if (!SETTINGS) SETTINGS = loadSettings();
        SETTINGS[key] = r.value;
        applyVisualSettings();
      }
    });

    // 落盘：range / select / text 都在 change 时做完整应用
    document.addEventListener("change", (e) => {
      const r = e.target;
      if (!r.dataset) return;
      if (r.dataset.setRange) setCfg(r.dataset.setRange, Number(r.value));
      else if (r.dataset.setSelect) setCfg(r.dataset.setSelect, r.value);
      else if (r.dataset.setText) setCfg(r.dataset.setText, r.value);
    });
  }

  /* ============================== CSS ==============================
   *
   * 视觉 token 实测自 Codex 桌面 app 深/浅两版截图；组件一律引用变量，明暗共用一套规则。
   * 这一大段是从同作者的 V2EX 版（v2ex-codex.user.js）搬过来的设计系统，
   * 只改了类名前缀（v2cx- → ngax-）和「隐藏原生页面」那几条选择器 ——
   * 因为要藏的已经不是 V2EX 的 #Top/#Wrapper，而是 NGA 的 #mc > .module_wrap 那一层。
   * ================================================================ */

  const RAW_CSS = String.raw`

    /* ---------- Token：深色（默认） ---------- */
    html.ngax {
      /*
       * rail 配色。
       *
       * 这里不能只看「名义对比度」：14px 细体中文在深色底上经过抗锯齿后，
       * 文字像素的加权平均亮度远低于名义色值。剪出真实截图里的 rail 区域做加权平均，
       * 实测：
       *   #27353b 底 + #c3ccd0 字 → 峰值 7.76:1，但有效值只有 3.38:1（看着就是看不清）
       *   #27353b 底 + 纯白字也只能到 ~4.0:1 —— 底色本身太亮，光提亮文字救不回来
       * 所以做法是：底色压暗 + 文字提到接近白 + 加半档字重（见 .ngax-rail-item）。
       * 目标是对齐主区正文的有效对比度量级（~5:1）。
       *
       * 复核方式：npm run shots 之后跑 node tools/measure-contrast.js
       */
      --cx-rail-bg: #1d272c;
      --cx-rail-bg-hover: #26343a;
      --cx-rail-bg-active: #2d3d45;
      --cx-rail-text: #f5f8f9;
      --cx-rail-text-dim: #dfe7ea;
      --cx-rail-text-faint: #b0babe;
      --cx-rail-border: rgba(255, 255, 255, 0.06);

      --cx-bg: #181818;
      --cx-bg-raised: #242424;
      --cx-bg-inset: #1c1c1c;
      --cx-bg-deep: #161616;
      --cx-panel-bg: #181818;
      --cx-composer-bg: #2a2a2a;

      --cx-border: rgba(255, 255, 255, 0.08);
      --cx-border-soft: rgba(255, 255, 255, 0.05);
      --cx-border-strong: rgba(255, 255, 255, 0.14);
      --cx-text: #ececec;
      --cx-text-secondary: #b9b9b9;
      --cx-text-dim: #909090;
      --cx-text-faint: #646464;

      --cx-blue: #83c3fe;
      --cx-blue-soft: rgba(131, 195, 254, 0.15);
      --cx-chip-bg: #2e2e2e;
      --cx-chip-text: #ececec;
      --cx-btn-hover: #333333;
      --cx-wash: rgba(255, 255, 255, 0.03);
      --cx-scroll-thumb: rgba(255, 255, 255, 0.12);
      --cx-send-bg: #8a8a8a;
      --cx-send-icon: #1f1f1f;

      --cx-code-text: #cfcfcf;
      --cx-code-gutter: #707070;
      --cx-tok-k: #f0954e;
      --cx-tok-s: #78cf70;
      --cx-tok-c: #6f7a6f;
      --cx-tok-t: #b06dff;
      --cx-tok-f: #63c2f2;
      --cx-tok-n: #64b5e0;
      --cx-diff-add-bg: rgba(64, 201, 119, 0.10);
      --cx-diff-del-bg: rgba(250, 66, 62, 0.09);
      --cx-diff-hunk-bg: rgba(131, 195, 254, 0.07);
      --cx-diff-hunk-tx: #7ba6c9;

      --cx-font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      --cx-font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas,
        "Liberation Mono", monospace;

      --cx-rail-w: 306pxpx;
      --cx-radius: 10px;
    }

    /* ---------- Token：浅色 ---------- */
    html.ngax.ngax-light {
      --cx-rail-bg: #e4eaeb;
      --cx-rail-bg-hover: #d9e1e3;
      --cx-rail-bg-active: #ced8da;
      --cx-rail-text: #14191b;
      --cx-rail-text-dim: #333a3d;
      --cx-rail-text-faint: #41494c;
      --cx-rail-border: rgba(0, 0, 0, 0.07);

      --cx-bg: #f4f4f4;
      --cx-bg-raised: #ffffff;
      --cx-bg-inset: #fafafa;
      --cx-bg-deep: #ebebeb;
      --cx-panel-bg: #ffffff;
      --cx-composer-bg: #ffffff;

      --cx-border: rgba(0, 0, 0, 0.10);
      --cx-border-soft: rgba(0, 0, 0, 0.06);
      --cx-border-strong: rgba(0, 0, 0, 0.16);
      --cx-text: #1b1c1e;
      --cx-text-secondary: #55565a;
      --cx-text-dim: #737477;
      --cx-text-faint: #a2a3a5;

      --cx-blue: #2a98ff;
      --cx-blue-soft: rgba(42, 152, 255, 0.13);
      --cx-chip-bg: #ededed;
      --cx-chip-text: #1b1c1e;
      --cx-btn-hover: #e6e6e6;
      --cx-wash: rgba(0, 0, 0, 0.04);
      --cx-scroll-thumb: rgba(0, 0, 0, 0.18);
      --cx-send-bg: #3c3c3c;
      --cx-send-icon: #ffffff;

      --cx-code-text: #26282b;
      --cx-code-gutter: #8a8b8f;
      --cx-tok-k: #aa3d00;
      --cx-tok-s: #1c7d28;
      --cx-tok-c: #8a9086;
      --cx-tok-t: #8a40d0;
      --cx-tok-f: #1670d8;
      --cx-tok-n: #2a62c9;
      --cx-diff-add-bg: rgba(23, 160, 88, 0.10);
      --cx-diff-del-bg: rgba(230, 60, 55, 0.10);
      --cx-diff-hunk-bg: rgba(42, 152, 255, 0.08);
      --cx-diff-hunk-tx: #46769e;
    }

    /* ---------- 自绘 UI 统一盒模型 ---------- */
    .ngax-rail, .ngax-rail *,
    .ngax-main, .ngax-main *,
    .ngax-lightbox, .ngax-lightbox *,
    .ngax-toast { box-sizing: border-box; }

    /* ---------- 隐藏原生页面（仅被接管的路由） ----------
     *
     * 主力规则是直接藏 #mmc —— 它是 NGA 所有内容的根（#mc 就在里面）。
     *
     * 一开始这里只列了具体的 .module_wrap / #m_posts 之类，想着「不藏将来
     * 可能想用的东西」；但那样只要 NGA 多出一类容器就会漏出来 —— 而漏出来的
     * 代价是「整帧原生页面闪一下」（用户实际碰到的就是这个问题），
     * 比偶尔多藏一个新模块严重得多。
     *
     * 藏了也不影响功能：原生 DOM 仍在内存里，站点自己的 JS 照跑，
     * 我们照样能读写它（比如快速回复框的 textarea）。
     *
     * 为什么用 display:none 而不是「移出视口」：NGA 的「跳到指定楼层」
     * （commonui.afterPostProc 里的 scrollIntoView）会把移出视口的元素当目标，
     * 视口就被横向拖到 -99999px 去了；display:none 的元素没有盒子，
     * scrollIntoView 是空操作，反而安全。
     *
     * 下面的具体选择器保留作为冗余（万一某个页面没有 #mmc 但有这些容器），
     * 同时兼作「到底藏了什么」的文档。
     */
    html.ngax.ngax-locked #mmc,
    html.ngax.ngax-locked #minWidthSpacer,
    html.ngax.ngax-locked #mc > .module_wrap,
    html.ngax.ngax-locked #mainmenu,
    html.ngax.ngax-locked #currentTopicName,
    html.ngax.ngax-locked #currentForumName,
    html.ngax.ngax-locked #currentSetName,
    html.ngax.ngax-locked #topicAuthorName,
    html.ngax.ngax-locked #fast_post_c,
    html.ngax.ngax-locked #footer,
    html.ngax.ngax-locked #m_posts,
    html.ngax.ngax-locked #m_threads {
      display: none !important;
    }

    /*
     * NGA 自己的弹窗（收藏夹选择、报错提示、图片查看器…）挂在 body 下、
     * 不在 #mc 里，所以不会被上面藏掉 —— 但会被我们的 rail / 主区盖住。
     * 单独把层级抬起来，让站点的弹窗永远在最上面。
     */
    html.ngax .commonwindow,
    html.ngax #adminwindow,
    html.ngax .single_ttip2 {
      z-index: 3000 !important;
    }
    /* 接管时接管底色 / 盒模型；样式收窄到 locked，避免干扰原生页面 */
    html.ngax.ngax-locked body {
      min-width: 0 !important;
      background: var(--cx-bg) !important;
      color: var(--cx-text) !important;
      overflow-x: hidden;
    }

    /*
     * 未接管的原生页面（/signin、/about、/help 等）：
     * rail 常驻，原生内容右移。
     * 其余样式一律不碰 —— box 底色 / 字体 / min-width 全部交还给 V2EX 自己，
     * 否则用户在 rail 里切到深色后，原生浅色页面会变成“白盒子飘在黑底上”。
     */
    html.ngax:not(.ngax-locked) #mmc {
      margin-left: var(--cx-rail-w) !important;
      min-width: 0 !important;
    }

    /* ================= 左 rail ================= */
    .ngax-rail {
      position: fixed;
      left: 0; top: 0; bottom: 0;
      width: var(--cx-rail-w);
      background: var(--cx-rail-bg);
      color: var(--cx-rail-text);
      display: flex;
      flex-direction: column;
      user-select: none;
      z-index: 800;
      font-family: var(--cx-font-ui);
      font-size: 14px;
    }
    .ngax-rail-traffic {
      height: 46px;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 0 14px;
      color: var(--cx-rail-text-dim);
      flex: none;
    }
    .ngax-rail-traffic svg { width: 20px; height: 20px; padding: 2px; border-radius: 6px; cursor: pointer; }
    .ngax-rail-traffic svg:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    .ngax-rail-brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 2px 14px 10px;
      flex: none;
    }
    .ngax-rail-brand-name {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 17px;
      font-weight: 600;
      letter-spacing: 0.2px;
      cursor: pointer;
      color: inherit;
      text-decoration: none;
    }
    .ngax-rail-brand-name svg { width: 12px; height: 12px; color: var(--cx-rail-text-dim); }
    .ngax-rail-brand-actions { display: flex; gap: 2px; color: var(--cx-rail-text-dim); }
    .ngax-rail-brand-actions svg { width: 19px; height: 19px; padding: 2px; border-radius: 6px; cursor: pointer; }
    .ngax-rail-brand-actions svg:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    .ngax-rail-bell { position: relative; display: inline-flex; }
    .ngax-rail-bell.has-unread::after {
      content: "";
      position: absolute; top: 1px; right: 1px;
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--cx-blue);
      border: 1.5px solid var(--cx-rail-bg);
    }

    .ngax-rail-scroll { flex: 1; overflow-y: auto; padding-bottom: 8px; }
    .ngax-rail-scroll::-webkit-scrollbar { width: 8px; }
    .ngax-rail-scroll::-webkit-scrollbar-thumb { background: var(--cx-scroll-thumb); border-radius: 4px; }

    .ngax-rail-nav { padding: 2px 8px; display: flex; flex-direction: column; gap: 1px; }
    .ngax-rail-item {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 6px 8px;
      border-radius: 7px;
      cursor: pointer;
      color: var(--cx-rail-text-dim);
      font-size: 14px;
      /* 500 而不是 400：细体中文在深色底上抗锯齿后有效亮度掉得厉害，
         加半档字重比单纯提亮颜色有效得多 */
      font-weight: 500;
      line-height: 1.4;
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
    }
    .ngax-rail-item:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    .ngax-rail-item.active { background: var(--cx-rail-bg-active); color: var(--cx-rail-text); }
    .ngax-rail-item svg { width: 16px; height: 16px; flex: none; color: var(--cx-rail-text-dim); }
    .ngax-rail-item.active svg { color: var(--cx-rail-text); }
    .ngax-rail-item .ngax-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ngax-rail-item.faint { color: var(--cx-rail-text-faint); }
    .ngax-rail-item .ngax-count {
      flex: none;
      font-size: 11.5px;
      color: var(--cx-rail-text-faint);
      font-variant-numeric: tabular-nums;
    }
    .ngax-rail-section {
      padding: 14px 16px 5px;
      font-size: 11.5px;
      font-weight: 600;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      color: var(--cx-rail-text-faint);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .ngax-rail-section .ngax-more {
      text-transform: none;
      letter-spacing: 0;
      font-weight: 400;
      cursor: pointer;
      color: var(--cx-rail-text-dim);
    }
    .ngax-rail-section .ngax-more:hover { color: var(--cx-rail-text); }
    .ngax-rail-section-items { padding: 0 8px; display: flex; flex-direction: column; gap: 1px; }
    .ngax-rail-foot {
      flex: none;
      border-top: 1px solid var(--cx-rail-border);
      padding: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .ngax-rail-foot-user {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 7px 8px;
      border-radius: 7px;
      cursor: pointer;
      color: var(--cx-rail-text-dim);
      font-size: 13px;
      text-decoration: none;
    }
    .ngax-rail-foot-user:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    .ngax-rail-foot-user svg { width: 17px; height: 17px; flex: none; }
    .ngax-rail-foot-user .ngax-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ngax-rail .ngax-mode-btn {
      flex: none;
      width: 32px; height: 32px;
      display: grid; place-items: center;
      border: none; background: none;
      border-radius: 7px;
      cursor: pointer;
      color: var(--cx-rail-text-dim);
    }
    .ngax-rail .ngax-mode-btn:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    .ngax-rail .ngax-mode-btn svg { width: 18px; height: 18px; pointer-events: none; }

    .ngax-resizer {
      position: absolute;
      top: 0; bottom: 0;
      width: 7px;
      cursor: col-resize;
      z-index: 20;
      /* 平时只显示一条 1px 分隔线，hover / 拖拽时才铺满高亮 */
      background: transparent;
    }
    .ngax-resizer::after {
      content: "";
      position: absolute;
      top: 0; bottom: 0;
      left: 3px;
      width: 1px;
      background: var(--cx-border);
    }
    .ngax-resizer:hover::after,
    .ngax-resizer.dragging::after {
      background: var(--cx-blue);
      width: 2px;
      left: 2.5px;
    }
    .ngax-resizer:hover,
    .ngax-resizer.dragging { background: var(--cx-blue-soft); }

    /*
     * 拖拽把手必须锚在「被调整的那条边」上：
     *   rail  → 贴在 rail 右缘
     *   panel → 贴在代码面板左缘（所以把手是 .ngax-code-panel 的子元素，
     *           依靠面板自身的 position:relative 定位）
     * 之前把手是 .ngax-main 的子元素，absolute 相对于 .ngax-main 定位，
     * 结果跑到主区最左边去了，根本拖不到。
     */
    .ngax-rail > .ngax-resizer { right: -3px; }
    .ngax-code-panel > .ngax-resizer { left: -3px; }
    .ngax-code-panel > .ngax-resizer::after { left: 3px; }

    /* ================= 主区 ================= */
    .ngax-main {
      position: fixed;
      left: var(--cx-rail-w); right: 0; top: 0; bottom: 0;
      background: var(--cx-bg);
      color: var(--cx-text);
      display: flex;
      min-width: 0;
      z-index: 500;
      font-family: var(--cx-font-ui);
      font-size: 14px;
      -webkit-font-smoothing: antialiased;
    }
    .ngax-main.panel-hidden .ngax-code-panel { display: none; }

    .ngax-thread-col {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      /* composer 是绝对定位浮层，所以定位基准在这里 */
      position: relative;
    }

    .ngax-topbar {
      height: 46px;
      flex: none;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      border-bottom: 1px solid var(--cx-border-soft);
      color: var(--cx-text-secondary);
    }
    .ngax-topbar svg { width: 16px; height: 16px; flex: none; }
    .ngax-topbar .ngax-crumb { display: flex; align-items: center; gap: 7px; font-size: 13px; min-width: 0; }
    .ngax-topbar .ngax-crumb .ngax-proj { color: var(--cx-text); }
    .ngax-topbar .ngax-crumb .ngax-sep { color: var(--cx-text-faint); }
    /* 详情页不再重复渲染大标题，顶栏这段就是唯一标题，所以要用正文色而不是 dim */
    .ngax-topbar .ngax-crumb .ngax-model {
      color: var(--cx-text);
      font-size: 13.5px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ngax-topbar .ngax-spacer { flex: 1; }
    .ngax-topbar .ngax-icon-btn {
      padding: 5px;
      border-radius: 6px;
      cursor: pointer;
      color: var(--cx-text-dim);
      display: grid;
      place-items: center;
      border: none;
      background: none;
    }
    .ngax-topbar .ngax-icon-btn:hover { background: var(--cx-bg-raised); color: var(--cx-text); }
    .ngax-topbar .ngax-menu-btn { display: none; }

    .ngax-thread {
      flex: 1;
      min-width: 0;
      overflow-y: auto;
      /* 底部留出 composer 的高度，否则滚到底时最后几层会被浮层盖住 */
      padding: 28px 40px 180px;
      scrollbar-width: thin;
    }
    .ngax-thread::-webkit-scrollbar { width: 8px; }
    .ngax-thread::-webkit-scrollbar-thumb { background: var(--cx-scroll-thumb); border-radius: 4px; }
    .ngax-thread-inner { max-width: var(--ngax-thread-max, 760px); margin: 0 auto; }

    /* —— 列表视图头部 —— */
    .ngax-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin: 6px 0 2px;
    }
    .ngax-head-title { display: flex; align-items: center; gap: 4px; min-width: 0; }
    .ngax-head h1 { font-size: 20px; font-weight: 600; letter-spacing: 0.2px; margin: 0; }
    .ngax-head-desc { font-size: 12.5px; color: var(--cx-text-dim); margin-bottom: 16px; }
    .ngax-new-topic-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: var(--cx-font-ui);
      font-size: 12.5px;
      font-weight: 500;
      color: var(--cx-text);
      background: var(--cx-chip-bg);
      border: 1px solid var(--cx-border-strong);
      border-radius: 999px;
      padding: 6px 13px;
      cursor: pointer;
      text-decoration: none;
      white-space: nowrap;
    }
    .ngax-new-topic-btn:hover { background: var(--cx-btn-hover); }
    .ngax-new-topic-btn svg { width: 13px; height: 13px; }
    .ngax-filter-btn {
      width: 26px; height: 26px;
      border-radius: 7px;
      color: var(--cx-text-dim);
      display: grid; place-items: center;
      cursor: pointer;
      border: none; background: none;
      flex: none;
    }
    .ngax-filter-btn:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .ngax-filter-btn svg { width: 14px; height: 14px; transition: transform 0.15s; }
    .ngax-main.filters-open .ngax-filter-btn svg { transform: rotate(180deg); }
    .ngax-filter-row { display: none; flex-wrap: wrap; gap: 6px; margin: 2px 0 12px; }
    .ngax-main.filters-open .ngax-filter-row { display: flex; }
    .ngax-fchip {
      font-size: 12px;
      color: var(--cx-text-secondary);
      background: var(--cx-chip-bg);
      border-radius: 999px;
      padding: 4px 12px;
      cursor: pointer;
      white-space: nowrap;
      text-decoration: none;
      border: 1px solid transparent;
    }
    .ngax-fchip:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .ngax-fchip.on { color: var(--cx-blue); border-color: var(--cx-blue); background: var(--cx-blue-soft); }

    /* —— 节点 / 会员 卡片 —— */
    .ngax-card {
      display: flex;
      gap: 14px;
      align-items: flex-start;
      padding: 14px 16px;
      margin-bottom: 18px;
      background: var(--cx-bg-raised);
      border: 1px solid var(--cx-border-soft);
      border-radius: var(--cx-radius);
    }
    .ngax-card img {
      width: 48px; height: 48px;
      border-radius: 10px;
      flex: none;
      background: var(--cx-bg-inset);
      object-fit: cover;
    }
    .ngax-card-main { min-width: 0; flex: 1; }
    .ngax-card-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .ngax-card-title h1 { font-size: 18px; font-weight: 600; margin: 0; }
    .ngax-card-sub { font-size: 12.5px; color: var(--cx-text-dim); margin-top: 4px; }
    .ngax-card-intro { font-size: 13px; color: var(--cx-text-secondary); margin-top: 8px; line-height: 1.6; }
    .ngax-card-links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .ngax-pill {
      font-size: 12px;
      color: var(--cx-text-secondary);
      background: var(--cx-chip-bg);
      border-radius: 999px;
      padding: 4px 11px;
      text-decoration: none;
      white-space: nowrap;
    }
    .ngax-pill:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .ngax-pill.on { color: var(--cx-blue); background: var(--cx-blue-soft); }

    /* —— 列表行（话题 = Codex 项目线程） —— */
    .ngax-rows { display: flex; flex-direction: column; }
    .ngax-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 11px 12px;
      border-radius: 9px;
      text-decoration: none;
      color: inherit;
      min-width: 0;
    }
    .ngax-row:hover { background: var(--cx-wash); }
    .ngax-row:hover .ngax-row-title { color: var(--cx-blue); }
    .ngax-row-avatar {
      width: 7px; height: 7px;
      border-radius: 50%;
      flex: none;
      background: transparent;
      border: 1.5px solid var(--cx-text-faint);
      box-sizing: border-box;
    }
    /* 有回复 → 实心蓝点；无回复 → 空心点（对齐 Codex 的未读/已读标记） */
    .ngax-row-avatar.has-replies {
      background: var(--cx-blue);
      border-color: var(--cx-blue);
    }
    .ngax-row-texts { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .ngax-row-title {
      font-size: 14px;
      font-weight: 500;
      color: var(--cx-text);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      transition: color 0.12s;
    }
    .ngax-row-sub {
      font-size: 12px;
      color: var(--cx-text-dim);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      display: flex; align-items: center; gap: 6px;
    }
    .ngax-row-sub .ngax-node {
      color: var(--cx-text-secondary);
      background: var(--cx-chip-bg);
      border-radius: 5px;
      padding: 1px 6px;
      font-size: 11.5px;
      flex: none;
    }
    .ngax-row-meta {
      flex: none;
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 12px;
      color: var(--cx-text-faint);
      font-variant-numeric: tabular-nums;
    }
    .ngax-row-meta .ngax-replies {
      min-width: 52px;
      text-align: right;
      color: var(--cx-text-secondary);
    }
    .ngax-row-meta .ngax-time { min-width: 72px; text-align: right; }
    .ngax-row-sep { height: 1px; background: var(--cx-border-soft); margin: 2px 12px; }

    .ngax-list-status {
      font-size: 12.5px;
      color: var(--cx-text-faint);
      text-align: center;
      padding: 18px 0 6px;
    }
    .ngax-list-status.link { cursor: pointer; }
    .ngax-list-status.link:hover { color: var(--cx-blue); }

    .ngax-search-input {
      width: 100%;
      font-family: var(--cx-font-ui);
      font-size: 13px;
      color: var(--cx-text);
      background: var(--cx-bg-raised);
      border: 1px solid var(--cx-border-soft);
      border-radius: 8px;
      padding: 8px 12px;
      margin: 2px 0 6px;
      outline: none;
    }
    .ngax-search-input::placeholder { color: var(--cx-text-faint); }
    .ngax-search-input:focus { border-color: var(--cx-blue); }

    /* ================= 详情视图（帖子 = agent thread） ================= */
    .ngax-detail-head { margin-bottom: 20px; }
    .ngax-detail-meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 12.5px;
      color: var(--cx-text-dim);
    }
    .ngax-detail-meta img {
      width: 22px; height: 22px;
      border-radius: 50%;
      object-fit: cover;
    }
    .ngax-detail-meta .ngax-dotsep { color: var(--cx-text-faint); }
    .ngax-detail-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .ngax-votes { display: inline-flex; gap: 2px; margin-left: 2px; }
    .ngax-vote-btn {
      padding: 3px;
      border-radius: 6px;
      border: 1px solid var(--cx-border-soft);
      background: none;
      color: var(--cx-text-dim);
      cursor: pointer;
      display: grid;
      place-items: center;
    }
    .ngax-vote-btn:hover { background: var(--cx-btn-hover); color: var(--cx-blue); }
    .ngax-vote-btn svg { width: 13px; height: 13px; }

    /* OP 气泡（用户消息，右对齐） */
    .ngax-turn-user { display: flex; justify-content: flex-end; margin: 0 0 8px; }
    .ngax-turn-user-bubble {
      max-width: 86%;
      background: var(--cx-bg-raised);
      border: 1px solid var(--cx-border-soft);
      border-radius: 14px;
      padding: 13px 16px;
      font-size: 14px;
      line-height: 1.75;
      overflow-wrap: anywhere;
    }
    /* agent turn（回帖，全宽） */
    .ngax-turn-agent { margin: 0 0 8px; }
    .ngax-turn-agent .ngax-cooked {
      font-size: 14px;
      line-height: 1.75;
      overflow-wrap: anywhere;
      padding: 2px 0;
    }
    .ngax-worked {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
      color: var(--cx-text-faint);
      padding: 2px 0 0;
      min-height: 22px;
    }
    .ngax-worked .ngax-floor {
      display: inline-grid;
      place-items: center;
      min-width: 22px; height: 18px;
      padding: 0 5px;
      border-radius: 5px;
      background: var(--cx-chip-bg);
      color: var(--cx-text-dim);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .ngax-worked img {
      width: 18px; height: 18px;
      border-radius: 50%;
      object-fit: cover;
    }
    .ngax-worked .ngax-user { color: var(--cx-text-secondary); }
    .ngax-worked .ngax-badge {
      font-size: 10.5px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 4px;
      background: var(--cx-blue-soft);
      color: var(--cx-blue);
    }
    /*
     * 楼层操作胶囊。参考实现里它是悬停时从右侧浮出来的独立胶囊，
     * 所以这里给容器加边框/底色/阴影，而不是做成光秃秃的行内图标。
     * 触发条件是「悬停整个楼层」——只悬停 worked 行的话很难点到。
     */
    .ngax-worked .ngax-actions {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      border: 1px solid var(--cx-border);
      border-radius: 999px;
      background: var(--cx-bg-raised);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
      opacity: 0;
      transition: opacity 0.13s;
      pointer-events: none;
    }
    .ngax-turn:hover .ngax-worked .ngax-actions,
    .ngax-supplement:hover .ngax-worked .ngax-actions,
    .ngax-detail-meta:hover .ngax-actions {
      opacity: 1;
      pointer-events: auto;
    }
    .ngax-worked .ngax-act {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 9px;
      border-radius: 999px;
      cursor: pointer;
      color: var(--cx-text-dim);
      border: none;
      background: none;
      font-family: var(--cx-font-ui);
      font-size: 12px;
      white-space: nowrap;
    }
    .ngax-worked .ngax-act:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .ngax-worked .ngax-act svg { width: 13px; height: 13px; flex: none; }
    .ngax-worked .ngax-act.on { color: var(--cx-blue); }

    /* ---------- agent 思考块（✻ Worked for 27s，默认展开、点标题收起） ---------- */
    .ngax-think {
      margin: 2px 0 12px;
      font-size: 12.5px;
      color: var(--cx-text-dim);
    }
    .ngax-think-head {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      cursor: pointer;
      user-select: none;
    }
    .ngax-think-head:hover { color: var(--cx-text-secondary); }
    .ngax-think-head .ngax-spin { display: inline-flex; color: var(--cx-blue); }
    .ngax-think-head .ngax-spin svg { width: 13px; height: 13px; }
    .ngax-think-chev { font-size: 10px; color: var(--cx-text-faint); }
    .ngax-think-body {
      display: none;
      margin: 8px 0 2px;
      padding: 8px 0 8px 12px;
      line-height: 1.72;
      color: var(--cx-text-secondary);
      border-left: 2px solid var(--cx-border);
      white-space: pre-wrap;
    }
    .ngax-think.open .ngax-think-body { display: block; }
    .ngax-think.open .ngax-think-chev::after { content: "\25be"; }
    .ngax-think:not(.open) .ngax-think-chev::after { content: "\25b8"; }

    /* ---------- 楼内「工具调用」淡色行 ---------- */
    .ngax-runline {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 11px 0;
      font-size: 12.5px;
      color: var(--cx-text-dim);
    }
    .ngax-runline svg { width: 14px; height: 14px; flex: none; color: var(--cx-text-faint); }
    .ngax-runline code {
      font-family: var(--cx-font-mono);
      font-size: 11.5px;
      color: var(--cx-chip-text);
      background: var(--cx-chip-bg);
      border-radius: 6px;
      padding: 1.5px 7px;
    }
    .ngax-turn { padding: 10px 0; }
    .ngax-turn + .ngax-turn { border-top: 1px solid var(--cx-border-soft); }
    .ngax-supplement { padding: 10px 0; }
    .ngax-supplement .ngax-cooked {
      font-size: 14px;
      line-height: 1.75;
      overflow-wrap: anywhere;
      padding: 10px 14px;
      border-left: 2px solid var(--cx-border-strong);
      border-radius: 0 8px 8px 0;
      background: var(--cx-wash);
    }
    .ngax-turn-divider {
      text-align: center;
      font-size: 12px;
      color: var(--cx-text-faint);
      padding: 20px 0;
      border-top: 1px solid var(--cx-border-soft);
      border-bottom: 1px solid var(--cx-border-soft);
      margin: 12px 0;
    }

    /* 正文里的内容元素（链接 / 代码 / 图片 / 引用 / 列表） */
    .ngax-cooked a, .ngax-turn-user-bubble a { color: var(--cx-blue); text-decoration: none; }
    .ngax-cooked a:hover, .ngax-turn-user-bubble a:hover { text-decoration: underline; }
    /*
     * 正文图片默认渲染成小缩略图（NGA 的附件不带缩略图变体，
     * 404 验证过，所以这里只能靠 CSS 约束尺寸 —— 好处是浏览器已经把原图下载过了，
     * 悬浮预览和灯箱都是零延迟）。
     */
    .ngax-cooked img, .ngax-turn-user-bubble img {
      max-width: var(--ngax-thumb-w, 260px);
      max-height: var(--ngax-thumb-h, 170px);
      width: auto;
      height: auto;
      border-radius: 8px;
      border: 1px solid var(--cx-border-soft);
      margin: 8px 0;
      cursor: zoom-in;
      display: block;
      background: var(--cx-bg-inset);
      transition: border-color 0.12s, box-shadow 0.12s;
    }
    .ngax-cooked img:hover, .ngax-turn-user-bubble img:hover {
      border-color: var(--cx-blue);
      box-shadow: 0 0 0 2px var(--cx-blue-soft);
    }
    /* 太小的图（表情、图标）不参与缩略/预览 */
    .ngax-cooked img[data-no-preview="1"] { cursor: default; }

    /* 悬浮大图预览：fixed 定位，不参与文档流 → 不引起重排 */
    .ngax-imgpreview {
      position: fixed;
      left: 0; top: 0;
      z-index: 1300;
      pointer-events: none;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.12s;
      background: var(--cx-bg-raised);
      border: 1px solid var(--cx-border-strong);
      border-radius: 10px;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
      padding: 8px;
      max-width: min(80vw, 900px);
      max-height: 80vh;
      font-family: var(--cx-font-ui);
    }
    .ngax-imgpreview.on { opacity: 1; visibility: visible; }
    /* 图还没到位时给个占位尺寸 + 居中提示，避免塌成小胶囊 */
    .ngax-imgpreview.loading { min-width: 240px; min-height: 150px; }
    .ngax-imgpreview.loading img { opacity: 0; }
    .ngax-imgpreview .ngax-ipv-load {
      display: none;
      position: absolute;
      inset: 0;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      color: var(--cx-text-faint);
    }
    .ngax-imgpreview.loading .ngax-ipv-load { display: flex; }
    .ngax-imgpreview img {
      display: block;
      opacity: 1;
      transition: opacity 0.12s;
      max-width: calc(min(80vw, 900px) - 18px);
      max-height: calc(80vh - 46px);
      width: auto;
      height: auto;
      border-radius: 6px;
      background: var(--cx-bg-inset);
    }
    .ngax-imgpreview .ngax-ipv-cap {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 2px 1px;
      font-size: 11.5px;
      color: var(--cx-text-dim);
      white-space: nowrap;
      overflow: hidden;
    }
    .ngax-imgpreview .ngax-ipv-name {
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--cx-font-mono);
    }
    .ngax-imgpreview .ngax-ipv-size { flex: none; color: var(--cx-text-faint); }
    .ngax-cooked code, .ngax-turn-user-bubble code {
      font-family: var(--cx-font-mono);
      font-size: 12.5px;
      background: var(--cx-bg-inset);
      border: 1px solid var(--cx-border-soft);
      border-radius: 5px;
      padding: 1px 5px;
      color: var(--cx-text);
    }
    .ngax-cooked pre, .ngax-turn-user-bubble pre {
      background: var(--cx-bg-inset);
      border: 1px solid var(--cx-border-soft);
      border-radius: 8px;
      padding: 12px 14px;
      overflow-x: auto;
      margin: 10px 0;
    }
    .ngax-cooked pre code, .ngax-turn-user-bubble pre code {
      border: none; background: none; padding: 0;
      font-size: 12.5px; line-height: 1.6;
    }
    .ngax-cooked blockquote, .ngax-turn-user-bubble blockquote {
      margin: 10px 0;
      padding: 2px 0 2px 12px;
      border-left: 2px solid var(--cx-border-strong);
      color: var(--cx-text-secondary);
    }
    .ngax-cooked ul, .ngax-cooked ol,
    .ngax-turn-user-bubble ul, .ngax-turn-user-bubble ol { padding-left: 22px; margin: 8px 0; }
    .ngax-cooked table, .ngax-turn-user-bubble table {
      border-collapse: collapse;
      margin: 10px 0;
      font-size: 13px;
    }
    .ngax-cooked th, .ngax-cooked td,
    .ngax-turn-user-bubble th, .ngax-turn-user-bubble td {
      border: 1px solid var(--cx-border);
      padding: 5px 9px;
    }
    .ngax-cooked hr, .ngax-turn-user-bubble hr {
      border: none;
      border-top: 1px solid var(--cx-border);
      margin: 16px 0;
    }
    /* 原生 tiny 标签在深色下不可读，统一收敛 */
    .ngax-cooked small, .ngax-cooked .small,
    .ngax-cooked .fade, .ngax-cooked .gray, .ngax-cooked .snow,
    .ngax-turn-user-bubble small, .ngax-turn-user-bubble .fade { color: var(--cx-text-dim) !important; }

    /* ================= 底部输入框（composer） ================= */
    /*
     * 移植自参考实现的 .codex-composer：悬浮在主区底部、居中、宽度跟正文一致、随分屏变窄。
     * 用绝对定位盖在滚动区上（对齐参考布局：正文从两侧透出、上方渐变淡出），
     * 所以 wrap 设 pointer-events:none，只有卡片本身可点，两侧空白仍能点到正文。
     */
    .ngax-composer-wrap {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      padding: 8px 16px 14px;
      background: linear-gradient(to top, var(--cx-bg) 62%, transparent);
      pointer-events: none;
    }
    .ngax-composer {
      width: 100%;
      max-width: 600px; /* 收起代码面板时的宽度 */
      margin: 0 auto;
      background: var(--cx-composer-bg);
      border: 1px solid var(--cx-border);
      border-radius: 16px;
      padding: 10px 12px 8px;
      box-shadow: 0 8px 26px rgba(0, 0, 0, 0.16);
      pointer-events: auto;
      position: relative;
    }
    /* 代码面板展开时再收一档（原版输入框随分屏变窄） */
    .ngax-main:not(.panel-hidden) .ngax-composer { max-width: 500px; }

    .ngax-compose-target {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--cx-text-dim);
      padding: 0 2px 6px;
    }
    /* 必须显式处理：作者样式里的 display:flex 会盖掉 [hidden] 的 UA display:none，
       否则未回复任何楼层时那个「×」会一直露在外面 */
    .ngax-compose-target[hidden] { display: none; }
    .ngax-compose-target > span {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ngax-compose-target > button {
      flex: none;
      border: none; background: none; cursor: pointer;
      color: var(--cx-text-faint);
      font-size: 14px; line-height: 1;
    }
    .ngax-compose-target > button:hover { color: var(--cx-text); }

    .ngax-md-edit {
      color: var(--cx-text);
      font-family: var(--cx-font-ui);
      font-size: 14px;
      line-height: 1.65;
      min-height: 46px;
      max-height: 220px;
      overflow-y: auto;
      outline: none;
      cursor: text;
      position: relative;
      word-break: break-word;
      white-space: pre-wrap;
    }
    /* 空态占位符（:not(.has-content) 比 :empty 更可靠：contenteditable 可能残留 <br>） */
    .ngax-md-edit:not(.has-content)::before {
      content: attr(data-placeholder);
      position: absolute;
      color: var(--cx-text-faint);
      pointer-events: none;
    }

    /* 实时预览（md 渲染） */
    .ngax-compose-preview {
      display: none;
      border-top: 1px dashed var(--cx-border-soft);
      margin-top: 8px;
      padding-top: 8px;
      max-height: 260px;
      overflow-y: auto;
      font-size: 13.5px;
      line-height: 1.7;
      color: var(--cx-text-secondary);
    }
    .ngax-composer.preview-on .ngax-compose-preview { display: block; }
    .ngax-compose-preview h2,
    .ngax-compose-preview h3 { margin: 4px 0; font-size: 1.15em; color: var(--cx-text); }
    .ngax-compose-preview p { margin: 4px 0; }
    .ngax-compose-preview code {
      font-family: var(--cx-font-mono);
      font-size: 12px;
      background: var(--cx-bg-inset);
      border-radius: 4px;
      padding: 1px 4px;
    }
    .ngax-compose-preview pre {
      background: var(--cx-bg-inset);
      border-radius: 6px;
      padding: 8px 10px;
      overflow-x: auto;
      margin: 6px 0;
    }
    .ngax-compose-preview pre code { background: none; padding: 0; }
    .ngax-compose-preview blockquote {
      margin: 4px 0;
      padding: 1px 0 1px 9px;
      border-left: 3px solid var(--cx-border-strong);
    }
    .ngax-compose-preview ul,
    .ngax-compose-preview ol { margin: 4px 0; padding-left: 20px; }
    .ngax-compose-preview a { color: var(--cx-blue); text-decoration: none; }
    .ngax-compose-preview img { max-width: 100%; border-radius: 6px; }
    .ngax-compose-preview hr { border: none; border-top: 1px solid var(--cx-border); margin: 8px 0; }

    .ngax-composer-toolbar {
      display: flex;
      align-items: center;
      gap: 2px;
      padding-top: 8px;
      margin-top: 6px;
      border-top: 1px solid var(--cx-border-soft);
    }
    .ngax-tool-btn {
      width: 28px; height: 28px;
      border-radius: 6px;
      display: grid; place-items: center;
      border: none; background: none;
      color: var(--cx-text-dim);
      cursor: pointer;
      font-family: var(--cx-font-ui);
      flex: none;
    }
    .ngax-tool-btn:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .ngax-tool-btn svg { width: 16px; height: 16px; }
    .ngax-tool-btn > b,
    .ngax-tool-btn > i,
    .ngax-tool-btn > s { font-size: 14px; line-height: 1; }
    .ngax-tool-btn > s { text-decoration-thickness: 1.5px; }
    .ngax-tool-txt { font-size: 13px; font-weight: 600; line-height: 1; }
    .ngax-tool-btn.on { color: var(--cx-blue); }
    .ngax-composer-status {
      flex: 1;
      min-height: 16px;
      font-size: 12px;
      color: var(--cx-text-faint);
      margin: 0 8px;
      text-align: right;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ngax-composer-status.ok { color: #52b36b; }
    .ngax-composer-status.err { color: #e0626a; }
    .ngax-send {
      flex: none;
      width: 30px; height: 30px;
      border-radius: 50%;
      background: var(--cx-send-bg);
      color: var(--cx-send-icon);
      border: none;
      display: grid;
      place-items: center;
      cursor: pointer;
    }
    .ngax-send svg { width: 15px; height: 15px; }
    /* 空内容时给一个一眼能看出的失效态（只靠 opacity 在大屏上几乎看不出来） */
    .ngax-send:disabled {
      background: var(--cx-chip-bg);
      color: var(--cx-text-faint);
      opacity: 0.75;
      cursor: default;
    }

    /* 「更多」小弹层（表格 / 分隔线 / 代码块 / 折叠） */
    .ngax-plus-pop {
      position: absolute;
      bottom: 46px;
      left: 12px;
      z-index: 60;
      background: var(--cx-bg-raised);
      border: 1px solid var(--cx-border-strong);
      border-radius: 10px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
      padding: 4px;
      display: none;
      min-width: 168px;
    }
    .ngax-plus-pop.on { display: block; }
    .ngax-plus-pop button {
      display: block;
      width: 100%;
      text-align: left;
      padding: 6px 10px;
      border: none;
      background: none;
      border-radius: 6px;
      color: var(--cx-text-secondary);
      font-family: var(--cx-font-ui);
      font-size: 12.5px;
      cursor: pointer;
    }
    .ngax-plus-pop button:hover { background: var(--cx-btn-hover); color: var(--cx-text); }

    /* ================= 右侧代码面板（纯氛围装饰） ================= */
    .ngax-code-panel {
      width: var(--ngax-panel-w, 460px);
      flex: none;
      position: relative;
      background: var(--cx-panel-bg);
      border-left: 1px solid var(--cx-border-soft);
      display: flex;
      flex-direction: column;
      min-width: 0;
      font-family: var(--cx-font-ui);
    }
    .ngax-code-tabs {
      height: 38px;
      flex: none;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 10px;
      background: var(--cx-bg-deep);
      border-bottom: 1px solid var(--cx-border-soft);
      font-size: 12px;
      color: var(--cx-text-secondary);
    }
    .ngax-code-tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 6px;
      background: var(--cx-bg-raised);
    }
    .ngax-code-tab .ngax-rs-ic { color: var(--cx-tok-k); font-weight: 600; font-size: 10.5px; }
    .ngax-code-tab .ngax-close { cursor: pointer; color: var(--cx-text-faint); font-size: 14px; line-height: 1; }
    .ngax-code-tab .ngax-close:hover { color: var(--cx-text); }
    .ngax-code-add { color: var(--cx-text-faint); cursor: pointer; }
    .ngax-code-tabs-actions { margin-left: auto; display: flex; gap: 2px; }
    .ngax-code-tabs-actions .ngax-icon-btn {
      padding: 4px; border-radius: 6px; cursor: pointer; color: var(--cx-text-dim);
      display: grid; place-items: center; border: none; background: none;
    }
    .ngax-code-tabs-actions .ngax-icon-btn:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .ngax-code-tabs-actions svg { width: 14px; height: 14px; }

    .ngax-code-crumb {
      flex: none;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      font-size: 12px;
      color: var(--cx-text-dim);
      border-bottom: 1px solid var(--cx-border-soft);
      min-width: 0;
    }
    .ngax-code-crumb .ngax-crumbs { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ngax-code-crumb .ngax-cur { color: var(--cx-text); }
    .ngax-code-crumb .ngax-spacer { flex: 1; }
    .ngax-code-view-toggle {
      display: flex;
      background: var(--cx-bg-inset);
      border-radius: 6px;
      padding: 2px;
      flex: none;
    }
    .ngax-code-view-toggle span {
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11.5px;
    }
    .ngax-code-view-toggle span.on { background: var(--cx-chip-bg); color: var(--cx-text); }
    .ngax-open-btn {
      flex: none;
      display: flex; align-items: center; gap: 4px;
      font-size: 11.5px;
      color: var(--cx-text-secondary);
      background: var(--cx-chip-bg);
      border: none;
      border-radius: 6px;
      padding: 3px 7px;
      cursor: pointer;
      font-family: var(--cx-font-ui);
    }
    .ngax-open-btn:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .ngax-open-btn svg { width: 11px; height: 11px; }

    .ngax-lang-menu {
      position: absolute;
      right: 12px;
      top: 76px;
      z-index: 50;
      background: var(--cx-bg-raised);
      border: 1px solid var(--cx-border);
      border-radius: 8px;
      padding: 4px;
      display: none;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      min-width: 132px;
    }
    .ngax-lang-menu.on { display: block; }
    .ngax-lang-menu div {
      padding: 6px 10px;
      border-radius: 5px;
      font-size: 12.5px;
      cursor: pointer;
      color: var(--cx-text-secondary);
      display: flex;
      justify-content: space-between;
      gap: 10px;
    }
    .ngax-lang-menu div:hover { background: var(--cx-wash); color: var(--cx-text); }
    .ngax-lang-menu div.on { color: var(--cx-blue); }

    .ngax-code-body {
      flex: 1;
      overflow: auto;
      padding: 10px 0 40px;
      font-family: var(--cx-font-mono);
      font-size: 12.5px;
      line-height: 1.65;
      color: var(--cx-code-text);
      scrollbar-width: thin;
    }
    .ngax-code-body::-webkit-scrollbar { width: 8px; height: 8px; }
    .ngax-code-body::-webkit-scrollbar-thumb { background: var(--cx-scroll-thumb); border-radius: 4px; }
    .ngax-code-line { display: flex; white-space: pre; }
    .ngax-code-line > .ngax-ln {
      flex: none;
      width: 46px;
      text-align: right;
      padding-right: 14px;
      color: var(--cx-code-gutter);
      user-select: none;
      font-variant-numeric: tabular-nums;
    }
    .ngax-code-line > .ngax-src { padding-right: 20px; }
    .ngax-code-line.add { background: var(--cx-diff-add-bg); }
    .ngax-code-line.del { background: var(--cx-diff-del-bg); }
    .ngax-code-line.hunk { background: var(--cx-diff-hunk-bg); }
    .ngax-code-line.hunk .ngax-src { color: var(--cx-diff-hunk-tx); }
    .ngax-code-body .tk-k, .ngax-boss-editor .tk-k { color: var(--cx-tok-k); }
    .ngax-code-body .tk-s, .ngax-boss-editor .tk-s { color: var(--cx-tok-s); }
    .ngax-code-body .tk-c, .ngax-boss-editor .tk-c { color: var(--cx-tok-c); font-style: italic; }
    .ngax-code-body .tk-n, .ngax-boss-editor .tk-n { color: var(--cx-tok-n); }
    .ngax-code-body .tk-t, .ngax-boss-editor .tk-t { color: var(--cx-tok-t); }

    /* ================= 图片灯箱 ================= */
    .ngax-lightbox {
      position: fixed;
      inset: 0;
      z-index: 3000;
      background: rgba(0, 0, 0, 0.86);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: zoom-out;
      padding: 40px;
    }
    .ngax-lightbox img {
      max-width: 100%;
      max-height: 100%;
      border-radius: 10px;
      cursor: default;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
    }
    .ngax-lightbox .ngax-lb-open {
      position: fixed;
      right: 20px; bottom: 20px;
      font-size: 12.5px;
      color: #fff;
      background: rgba(255, 255, 255, 0.14);
      border-radius: 999px;
      padding: 6px 14px;
      text-decoration: none;
    }
    .ngax-lightbox .ngax-lb-open:hover { background: rgba(255, 255, 255, 0.24); }

    /* ================= 应急伪装视图（Esc Esc / Ctrl+Shift+H） =================
     *
     * 整个视口变成「代码编辑器 + 构建日志」，不露 rail、不露论坛内容。
     * 用的是同一套 token，所以从正常视图切过来像是同一个 IDE 里换了个面板，
     * 不会出现「网站突然变了」的观感。
     * ====================================================================== */
    html.ngax.ngax-boss-on .ngax-rail,
    html.ngax.ngax-boss-on .ngax-main { visibility: hidden !important; }

    .ngax-boss {
      position: fixed;
      inset: 0;
      z-index: 1400;
      display: flex;
      flex-direction: column;
      background: var(--cx-bg);
      color: var(--cx-text);
      font-family: var(--cx-font-ui);
      font-size: 13px;
    }
    .ngax-boss[hidden] { display: none; }

    .ngax-boss-bar {
      height: 38px;
      flex: none;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 10px;
      background: var(--cx-bg-deep);
      border-bottom: 1px solid var(--cx-border-soft);
      font-size: 12px;
      color: var(--cx-text-dim);
    }
    .ngax-boss-tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 6px 6px 0 0;
      color: var(--cx-text-dim);
      white-space: nowrap;
    }
    .ngax-boss-tab.on { background: var(--cx-bg); color: var(--cx-text); }
    .ngax-boss-tab .ic { font-size: 10.5px; font-weight: 600; color: var(--cx-tok-k); }
    .ngax-boss-spacer { flex: 1; }
    .ngax-boss-shell {
      flex: none;
      font-family: var(--cx-font-mono);
      font-size: 11.5px;
      color: var(--cx-text-faint);
      padding: 0 10px;
      white-space: nowrap;
    }

    .ngax-boss-editor {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 10px 0 20px;
      font-family: var(--cx-font-mono);
      font-size: 12.5px;
      line-height: 1.65;
      color: var(--cx-code-text);
      scrollbar-width: thin;
    }
    .ngax-boss-editor::-webkit-scrollbar { width: 10px; }
    .ngax-boss-editor::-webkit-scrollbar-thumb { background: var(--cx-scroll-thumb); border-radius: 5px; }

    .ngax-boss-term {
      flex: none;
      height: 34%;
      min-height: 150px;
      display: flex;
      flex-direction: column;
      border-top: 1px solid var(--cx-border);
      background: var(--cx-bg-inset);
    }
    .ngax-boss-term-head {
      flex: none;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 12px;
      font-size: 11px;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      color: var(--cx-text-faint);
      border-bottom: 1px solid var(--cx-border-soft);
    }
    .ngax-boss-term-body {
      flex: 1;
      min-height: 0;
      overflow: auto;
      margin: 0;
      padding: 10px 14px 16px;
      font-family: var(--cx-font-mono);
      font-size: 12.5px;
      line-height: 1.6;
      color: var(--cx-text-secondary);
      white-space: pre-wrap;
      scrollbar-width: thin;
    }
    .ngax-boss-term-body::-webkit-scrollbar { width: 10px; }
    .ngax-boss-term-body::-webkit-scrollbar-thumb { background: var(--cx-scroll-thumb); border-radius: 5px; }
    .ngax-boss-term-body .ok { color: #52b36b; }
    .ngax-boss-term-body .warn { color: #d3a03c; }
    .ngax-boss-term-body .dim { color: var(--cx-text-faint); }
    .ngax-boss-term-body .cmd { color: var(--cx-text); }
    .ngax-boss-caret {
      display: inline-block;
      width: 7px;
      height: 14px;
      vertical-align: -2px;
      background: var(--cx-text-secondary);
      animation: ngax-blink 1.1s steps(1) infinite;
    }
    @keyframes ngax-blink { 0%, 50% { opacity: 1; } 50.01%, 100% { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .ngax-boss-caret { animation: none; } }

    /* ---------- 楼中楼引用卡片 ---------- */
    .ngax-quote {
      margin: 0 0 10px;
      border: 1px solid var(--cx-border);
      border-left: 3px solid var(--cx-border-strong);
      border-radius: 8px;
      background: var(--cx-wash);
      overflow: hidden;
    }
    .ngax-quote-head {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 10px;
      font-size: 12px;
      color: var(--cx-text-dim);
      cursor: pointer;
      user-select: none;
    }
    .ngax-quote-head:hover { color: var(--cx-text-secondary); }
    .ngax-quote-ic { display: inline-flex; flex: none; }
    .ngax-quote-ic svg { width: 13px; height: 13px; display: block; }
    .ngax-quote-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ngax-quote-title b { color: var(--cx-text); font-weight: 600; }
    .ngax-quote-jump {
      margin-left: auto;
      flex: none;
      border: none;
      background: none;
      padding: 2px;
      border-radius: 5px;
      cursor: pointer;
      color: var(--cx-text-faint);
      display: grid;
      place-items: center;
    }
    .ngax-quote-jump:hover { background: var(--cx-btn-hover); color: var(--cx-blue); }
    .ngax-quote-jump svg { width: 12px; height: 12px; }
    .ngax-quote-chev { flex: none; font-size: 10px; color: var(--cx-text-faint); }
    .ngax-quote.open .ngax-quote-chev::after { content: "\25be"; }
    .ngax-quote:not(.open) .ngax-quote-chev::after { content: "\25b8"; }
    .ngax-quote-body {
      padding: 8px 10px 9px;
      border-top: 1px solid var(--cx-border-soft);
      font-size: 13px;
      line-height: 1.65;
      color: var(--cx-text-secondary);
      overflow-wrap: anywhere;
    }
    .ngax-quote:not(.open) .ngax-quote-body { display: none; }
    /* 展开时长引用限个高度，超了内部滚动，别把整屏占满 */
    .ngax-quote.open .ngax-quote-body { max-height: 260px; overflow: auto; }
    .ngax-quote-body img { display: none; }
    .ngax-quote-img {
      display: inline-block;
      font-size: 11.5px;
      color: var(--cx-text-faint);
      background: var(--cx-chip-bg);
      border-radius: 5px;
      padding: 1px 6px;
      margin: 0 2px;
    }
    .ngax-quote-body code {
      font-family: var(--cx-font-mono);
      font-size: 12px;
      background: var(--cx-bg-inset);
      border-radius: 4px;
      padding: 1px 4px;
    }
    /* 跳到源楼层时闪一下，方便定位 */
    .ngax-turn.ngax-flash { animation: ngax-flash 1.2s ease-out; }
    @keyframes ngax-flash {
      0%, 20% { background: var(--cx-blue-soft); }
      100% { background: transparent; }
    }

    /* ================= 设置面板 ================= */
    .ngax-modal {
      position: fixed;
      inset: 0;
      z-index: 1500;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
      font-family: var(--cx-font-ui);
    }
    .ngax-modal[hidden] { display: none; }

    .ngax-modal-card {
      width: 100%;
      max-width: 640px;
      max-height: min(86vh, 820px);
      display: flex;
      flex-direction: column;
      background: var(--cx-bg-raised);
      color: var(--cx-text);
      border: 1px solid var(--cx-border-strong);
      border-radius: 14px;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
      overflow: hidden;
    }
    .ngax-modal-head {
      flex: none;
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 15px 18px 13px;
      border-bottom: 1px solid var(--cx-border-soft);
    }
    .ngax-modal-title { font-size: 15px; font-weight: 600; }
    .ngax-modal-sub { font-size: 11.5px; color: var(--cx-text-faint); }
    .ngax-modal-x {
      margin-left: auto;
      align-self: center;
      width: 26px; height: 26px;
      border: none; background: none;
      border-radius: 6px;
      color: var(--cx-text-dim);
      font-size: 18px; line-height: 1;
      cursor: pointer;
      display: grid; place-items: center;
    }
    .ngax-modal-x:hover { background: var(--cx-btn-hover); color: var(--cx-text); }

    .ngax-modal-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 4px 18px 14px;
      scrollbar-width: thin;
    }
    .ngax-modal-body::-webkit-scrollbar { width: 8px; }
    .ngax-modal-body::-webkit-scrollbar-thumb { background: var(--cx-scroll-thumb); border-radius: 4px; }

    .ngax-set-section {
      margin: 18px 0 6px;
      font-size: 11.5px;
      font-weight: 600;
      letter-spacing: 0.5px;
      color: var(--cx-text-faint);
    }
    .ngax-set-row {
      display: flex;
      align-items: flex-start;
      gap: 18px;
      padding: 9px 0;
      border-bottom: 1px solid var(--cx-border-soft);
    }
    .ngax-set-row:last-child { border-bottom: none; }
    .ngax-set-label { flex: 1; min-width: 0; font-size: 13px; }
    .ngax-set-hint {
      margin-top: 3px;
      font-size: 11.5px;
      line-height: 1.5;
      color: var(--cx-text-faint);
    }
    .ngax-set-ctrl {
      flex: none;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 132px;
      justify-content: flex-end;
    }
    .ngax-set-val {
      min-width: 46px;
      text-align: right;
      font-size: 12px;
      color: var(--cx-text-dim);
      font-variant-numeric: tabular-nums;
      font-family: var(--cx-font-mono);
    }

    /* 开关 */
    .ngax-switch {
      width: 38px; height: 22px;
      flex: none;
      border-radius: 999px;
      border: 1px solid var(--cx-border-strong);
      background: var(--cx-bg-inset);
      cursor: pointer;
      padding: 0;
      position: relative;
      transition: background 0.14s, border-color 0.14s;
    }
    .ngax-switch > span {
      position: absolute;
      top: 2px; left: 2px;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: var(--cx-text-dim);
      transition: transform 0.14s, background 0.14s;
    }
    .ngax-switch.on { background: var(--cx-blue-soft); border-color: var(--cx-blue); }
    .ngax-switch.on > span { transform: translateX(16px); background: var(--cx-blue); }
    .ngax-switch:focus-visible { outline: 2px solid var(--cx-blue); outline-offset: 2px; }

    /* 滑块 */
    .ngax-range {
      flex: 1;
      min-width: 110px;
      max-width: 190px;
      height: 22px;
      accent-color: var(--cx-blue);
      cursor: pointer;
    }
    /* 下拉 / 输入框 */
    .ngax-select,
    .ngax-text {
      font-family: var(--cx-font-ui);
      font-size: 12.5px;
      color: var(--cx-text);
      background: var(--cx-bg-inset);
      border: 1px solid var(--cx-border);
      border-radius: 7px;
      padding: 5px 8px;
      outline: none;
      min-width: 0;
    }
    .ngax-select { max-width: 200px; }
    .ngax-text { width: 160px; }
    .ngax-text::placeholder { color: var(--cx-text-faint); }
    .ngax-select:focus,
    .ngax-text:focus { border-color: var(--cx-blue); }

    .ngax-modal-foot {
      flex: none;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 18px;
      border-top: 1px solid var(--cx-border-soft);
      font-size: 11.5px;
      color: var(--cx-text-faint);
    }
    .ngax-modal-btn {
      font-family: var(--cx-font-ui);
      font-size: 12.5px;
      color: var(--cx-text);
      background: var(--cx-chip-bg);
      border: 1px solid var(--cx-border-strong);
      border-radius: 999px;
      padding: 5px 14px;
      cursor: pointer;
    }
    .ngax-modal-btn:hover { background: var(--cx-btn-hover); }

    /* ================= toast ================= */
    .ngax-toast {
      position: fixed;
      left: 50%;
      bottom: 32px;
      transform: translate(-50%, 12px);
      z-index: 4000;
      background: var(--cx-bg-raised);
      color: var(--cx-text);
      border: 1px solid var(--cx-border);
      border-radius: 8px;
      padding: 8px 16px;
      font-family: var(--cx-font-ui);
      font-size: 13px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s, transform 0.18s;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }
    .ngax-toast.on { opacity: 1; transform: translate(-50%, 0); }

    /* ================= 窄屏降级：rail 收成抽屉 ================= */
    @media (max-width: 1160px) {
      html.ngax .ngax-code-panel { display: none !important; }
      html.ngax .ngax-main .ngax-panel-toggle { display: none; }
      /* 面板被媒体查询藏了，但 .panel-hidden 类并未加上，
         所以这里要把「面板展开时收窄到 500px」那条规则盖回去。
         选择器权重必须高于 .ngax-main:not(.panel-hidden) .ngax-composer。 */
      html.ngax .ngax-main .ngax-composer { max-width: 600px; }
    }
    @media (max-width: 900px) {
      html.ngax .ngax-rail {
        transform: translateX(-100%);
        transition: transform 0.2s ease;
      }
      html.ngax.ngax-rail-open .ngax-rail { transform: none; }
      html.ngax .ngax-main { left: 0; }
      html.ngax:not(.ngax-locked) #Wrapper { margin-left: 0 !important; }
      html.ngax .ngax-topbar .ngax-menu-btn { display: grid; }
      .ngax-thread { padding: 20px 18px 160px; }
      .ngax-turn-user-bubble { max-width: 100%; }
    }
    /* ================= NGA 专属：正文里的站点元素 ================= */

    /*
     * NGA 的正文是站点自己渲染的 HTML，会带一堆内联样式和站点 class。
     * 这里只做「收拢」不做「重绘」：宽度、换行、图片尺寸这些交给下面统一管，
     * 颜色/字号一律继承我们的 token，免得深色模式下出现黑字灰底。
     */
    .ngax-cooked, .ngax-turn-user-bubble { color: var(--cx-text); }

    /* 站点正文里的表格（[table] 渲染出来的那种） */
    .ngax-cooked table, .ngax-table {
      border-collapse: collapse;
      margin: 8px 0;
      max-width: 100%;
      font-size: 13px;
    }
    .ngax-cooked table td, .ngax-cooked table th, .ngax-table td {
      border: 1px solid var(--cx-border);
      padding: 4px 8px;
      vertical-align: top;
    }
    .ngax-cooked table.quote { border: 0; }

    /* 引用：原生渲染成 div.quote，脚本会把它升级成 .ngax-quote 卡片；
       万一升级没跑到（解析不出来），至少别是一片灰底黑字 */
    .ngax-cooked div.quote, .ngax-turn-user-bubble div.quote {
      border-left: 2px solid var(--cx-border);
      padding-left: 10px;
      color: var(--cx-text-secondary);
      margin: 6px 0;
    }

    /* NGA 表情：站点默认尺寸不一，统一成行内小图。
     *
     * 这里的优先级很关键：上面那条「.ngax-cooked img」（把内容图当大图约束的）
     * 是 (0,1,1)，而光秃秃的「.ngax-smile」只有 (0,1,0) —— 比不过它。
     * 结果就是：表情被当成内容大图，width/height 被改成 auto、
     * 再被 max-width 撑到 260px，三个表情竖着占满一屏（实拍确认过）。
     * 所以这里得写成 (0,2,1) 把它压下去。
     *
     * 两种 class 都要盖：脚本自己渲染的用 ngax-smile，
     * 站点原生渲染好的用 smile / smile_ac / smile_a2 …（见 js_bbscode_core.js 里
     * 那个 img class 拼接），后者只靠 [class^="smile"] 匹配。
     */
    .ngax-cooked img.ngax-smile,
    .ngax-turn-user-bubble img.ngax-smile,
    .ngax-cooked img[class^="smile"],
    .ngax-turn-user-bubble img[class^="smile"] {
      display: inline-block;
      width: auto;
      height: auto;
      max-width: 1.7em;
      max-height: 1.7em;
      margin: 0 1px;
      vertical-align: -0.35em;
      border: 0;
      border-radius: 0;
      box-shadow: none;
      background: none;
    }

    /* 正文里的小图（图标/等级条）：不缩略、不预览。
     * 同样要写成 (0,2,1) 才压得住上面那条。
     */
    .ngax-cooked img.ngax-img-sm,
    .ngax-turn-user-bubble img.ngax-img-sm {
      display: inline-block;
      vertical-align: middle;
      max-width: 120px;
      max-height: 80px;
      box-shadow: none;
    }

    /* 代码块 */
    .ngax-code {
      background: var(--cx-bg-inset);
      border: 1px solid var(--cx-border);
      border-radius: 6px;
      padding: 10px 12px;
      overflow-x: auto;
      font-family: var(--cx-font-mono);
      font-size: 12.5px;
      line-height: 1.55;
      white-space: pre;
      margin: 8px 0;
    }

    /* 折叠 [collapse] */
    .ngax-collapse {
      border: 1px solid var(--cx-border);
      border-radius: var(--cx-radius);
      margin: 8px 0;
      overflow: hidden;
    }
    .ngax-collapse > summary {
      cursor: pointer;
      padding: 6px 10px;
      font-size: 12.5px;
      color: var(--cx-text-secondary);
      background: var(--cx-wash);
      list-style: none;
    }
    .ngax-collapse > summary::-webkit-details-marker { display: none; }
    .ngax-collapse-body { padding: 8px 10px; }

    /* 列表 */
    .ngax-list { margin: 6px 0 6px 20px; padding: 0; }

    /* @某人 / [uid] 提及：按钮或链接，都做得像正文的一部分 */
    .ngax-mention {
      color: var(--cx-blue);
      background: none;
      border: 0;
      padding: 0;
      font: inherit;
      cursor: pointer;
      text-decoration: none;
    }
    .ngax-mention:hover { text-decoration: underline; }

    /* 楼层里的附带信息 */
    .ngax-dim { color: var(--cx-text-faint); }
    .ngax-mark {
      color: var(--cx-text-secondary);
      background: var(--cx-chip-bg);
      border-radius: 4px;
      padding: 0 4px;
      font-size: 11px;
    }
    .ngax-no-avatar .ngax-user { margin-left: 0; }

    /* 附件区（原生异步渲染出来的图，脚本会搬到正文后面） */
    .ngax-attach { margin-top: 8px; }
    .ngax-attach img { margin-right: 6px; }

    /* 置顶主题 */
    .ngax-sticky-box {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin: 0 0 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--cx-border);
    }
    .ngax-sticky {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 5px 8px;
      border-radius: 6px;
      color: var(--cx-text-secondary);
      font-size: 13px;
      text-decoration: none;
    }
    .ngax-sticky:hover { background: var(--cx-wash); color: var(--cx-text); }
    .ngax-sticky svg { width: 13px; height: 13px; flex: none; opacity: .7; }

    /* 分页（页数可能很多，允许换行） */
    .ngax-pager { flex-wrap: wrap; gap: 4px; }

    /* ================= NGA 专属：版面大全 / 星标 / rail 提示 ================= */

    /* 版面大全的分类 / 分组标题：分类是「主标题」级别，分组是小一号的灰标题 */
    .ngax-bcat { margin-top: 18px; }
    .ngax-bcat-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--cx-border-soft);
      font-size: 14px;
      font-weight: 600;
    }
    .ngax-bcat-count {
      font-size: 11.5px;
      font-weight: 400;
      color: var(--cx-text-faint);
      font-family: var(--cx-font-mono);
    }
    .ngax-bgroup { margin: 8px 0 0; }
    .ngax-bgroup-head {
      font-size: 12px;
      color: var(--cx-text-secondary);
      margin: 6px 0 0;
    }

    .ngax-board-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 5px 6px;
      margin: 8px 0 4px;
    }
    /* 一个版面条目 = 链接 + 星标按钮。星标不能放进 <a> 里（嵌套交互元素非法），
       所以外面套一层 inline-flex 的框。 */
    .ngax-bitem {
      display: inline-flex;
      align-items: center;
      gap: 0;
    }
    .ngax-bitem > a.ngax-pill {
      border-top-right-radius: 0;
      border-bottom-right-radius: 0;
      border-right: 0;
    }
    .ngax-bstar {
      flex: none;
      font-size: 11px;
      line-height: 1;
      padding: 0.38em 0.5em;
      color: var(--cx-text-faint);
      background: var(--cx-chip-bg);
      border: 1px solid var(--cx-border);
      border-left: 0;
      border-radius: 0 999px 999px 0;
      cursor: pointer;
      font-family: inherit;
    }
    .ngax-bstar:hover { color: var(--cx-text); background: var(--cx-btn-hover); }
    .ngax-bstar.on { color: #e8b339; }
    /* rail 里的星标：贴在行首，没有背景框 */
    .ngax-rail-item .ngax-bstar {
      border: 0;
      background: none;
      padding: 0 4px 0 0;
      border-radius: 0;
      font-size: 12px;
    }
    .ngax-rail-item .ngax-bstar:hover { background: none; }
    .ngax-rail-hint {
      font-size: 11.5px;
      line-height: 1.6;
      color: var(--cx-rail-text-faint);
      padding: 2px 12px 6px;
    }
    .ngax-board-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .ngax-hl-sub {
      font-size: 12px;
      color: var(--cx-text-faint);
      margin: 14px 0 0;
      font-family: var(--cx-font-mono);
    }

    /* ================= NGA 专属：首页头条卡片 ================= */

    .ngax-hl-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 10px;
      margin: 6px 0 2px;
    }
    .ngax-hl {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px;
      border: 1px solid var(--cx-border);
      border-radius: var(--cx-radius);
      background: var(--cx-panel-bg);
      color: var(--cx-text);
      text-decoration: none;
      transition: background 0.12s, border-color 0.12s;
    }
    .ngax-hl:hover { background: var(--cx-wash); border-color: var(--cx-border-strong); }
    .ngax-hl-img {
      display: block;
      aspect-ratio: 16 / 9;
      overflow: hidden;
      border-radius: 7px;
      background: var(--cx-bg-inset);
    }
    .ngax-hl-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .ngax-hl-title {
      font-size: 13px;
      line-height: 1.45;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    /* ================= NGA 专属：楼层行内小头像 / 签名 / 改动 ================= */

    .ngax-ava {
      width: 18px;
      height: 18px;
      border-radius: 4px;
      object-fit: cover;
      vertical-align: -4px;
      margin-right: 5px;
      background: var(--cx-wash);
      flex: none;
    }
    .ngax-worked { flex-wrap: wrap; }
    /* 头像去掉时（设置里可关）不用留空 */
    html.ngax-no-avatar .ngax-ava { display: none; }

    .ngax-sign, .ngax-alert {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px dashed var(--cx-border);
      font-size: 12px;
      color: var(--cx-text-faint);
      max-height: 160px;
      overflow: hidden;
    }
    .ngax-sign img, .ngax-alert img { max-height: 60px; width: auto; }

    /* ================= NGA 专属：用户信息页 ================= */

    .ngax-member { align-items: flex-start; }
    .ngax-member .ngax-card-title h1 { font-size: 19px; }
    .ngax-member .ngax-card-sub { line-height: 1.7; }

    /* 统计格子：数字为主、标题为辅（对齐 Codex 里那些指标块的观感） */
    .ngax-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
      gap: 8px;
      margin: 14px 0 4px;
    }
    .ngax-stat {
      border: 1px solid var(--cx-border);
      border-radius: var(--cx-radius);
      background: var(--cx-panel-bg);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .ngax-stat b {
      font-size: 17px;
      font-weight: 600;
      font-family: var(--cx-font-mono);
      letter-spacing: -0.01em;
    }
    .ngax-stat span { font-size: 11.5px; color: var(--cx-text-faint); }

    /* 状态（buffs）：站点已经把每一项渲染成 HTML 了，只负责排版 */
    .ngax-buff-list { display: flex; flex-direction: column; gap: 6px; }
    .ngax-buff {
      border: 1px solid var(--cx-border);
      border-left: 2px solid var(--cx-blue);
      border-radius: 0 8px 8px 0;
      background: var(--cx-panel-bg);
      padding: 7px 11px;
      font-size: 13px;
      display: flex;
      align-items: baseline;
      gap: 10px;
      flex-wrap: wrap;
    }
    .ngax-buff img { max-height: 22px; width: auto; vertical-align: middle; }
    .ngax-buff-until {
      margin-left: auto;
      font-size: 11.5px;
      color: var(--cx-text-faint);
      font-family: var(--cx-font-mono);
      white-space: nowrap;
    }

    /* 头像 / 签名 */
    .ngax-avatar-box { margin: 2px 0; }
    img.ngax-member-avatar-lg {
      max-width: 160px;
      max-height: 160px;
      width: auto;
      height: auto;
      border-radius: var(--cx-radius);
      border: 1px solid var(--cx-border);
      background: var(--cx-bg-inset);
      display: block;
    }
    .ngax-sign-box {
      border-left: 2px solid var(--cx-border-strong);
      padding: 2px 0 2px 12px;
      color: var(--cx-text-secondary);
      font-size: 13px;
    }
    .ngax-sign-box img { max-height: 80px; width: auto; }

    .ngax-empty { font-size: 13px; color: var(--cx-text-faint); padding: 4px 0; }

    /* 声望表：来源 / 值 / 说明 */
    .ngax-repu {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .ngax-repu td {
      border-bottom: 1px solid var(--cx-border-soft);
      padding: 7px 10px;
      vertical-align: top;
    }
    .ngax-repu tr:last-child td { border-bottom: 0; }
    .ngax-repu td:first-child { white-space: nowrap; color: var(--cx-text-secondary); }
    .ngax-repu td:last-child { color: var(--cx-text-secondary); }
    .ngax-repu-val {
      width: 1%;
      white-space: nowrap;
      text-align: right;
      font-family: var(--cx-font-mono);
      font-weight: 600;
      color: var(--cx-blue);
    }
    /* 负声望 / 禁言这类「坏消息」用固定红：两套主题下都要看得清，
       而 token 里没有语义红，用 filter 凑颜色是自找麻烦 */
    .ngax-repu-val.neg { color: #e5484d; }

    /* 动作胶囊：<button> 的默认样式压掉，长成和 <a class="ngax-pill"> 一样 */
    button.ngax-pill {
      font: inherit;
      cursor: pointer;
      border: 1px solid var(--cx-border);
    }
    button.ngax-pill:hover { background: var(--cx-btn-hover); }
    .ngax-pill.ngax-bad { color: #e5484d; border-color: currentColor; }

    /* ================= NGA 专属：表情面板 ================= */

    .ngax-smile-pop {
      position: absolute;
      left: 12px;
      right: 12px;
      bottom: calc(100% + 6px);
      max-height: 240px;
      overflow-y: auto;
      background: var(--cx-bg-raised);
      border: 1px solid var(--cx-border);
      border-radius: var(--cx-radius);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
      padding: 8px 10px 10px;
      display: none;
      z-index: 40;
    }
    .ngax-smile-pop.on { display: block; }
    .ngax-smile-title {
      font-size: 11px;
      color: var(--cx-text-faint);
      margin: 6px 0 4px;
      font-family: var(--cx-font-mono);
    }
    .ngax-smile-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(30px, 1fr));
      gap: 3px;
    }
    .ngax-smile-grid button {
      background: none;
      border: 0;
      padding: 3px;
      border-radius: 5px;
      cursor: pointer;
      line-height: 0;
    }
    .ngax-smile-grid button:hover { background: var(--cx-btn-hover); }
    .ngax-smile-grid img { width: 22px; height: 22px; }
  `;


  /* ============================== 基础设施 ============================== */

  function injectStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = RAW_CSS; // 始终刷新，避免旧版残留
  }

  let faviconObserver = null;
  let faviconBusy = false;

  function applyFavicon() {
    const uri = makeFaviconUri();
    if (!uri) return;
    const head = document.head;
    if (!head || faviconBusy) return;
    faviconBusy = true;
    try {
      const type = "image/svg+xml";
      head.querySelectorAll(
        "link[rel='icon'], link[rel='shortcut icon'], link[rel~='icon'], " +
        "link[rel='apple-touch-icon'], link[rel='apple-touch-icon-precomposed']"
      ).forEach((icon) => {
        if (icon.id && icon.id !== FAVICON_ID) icon.removeAttribute("id");
        if (icon.getAttribute("href") !== uri) icon.setAttribute("href", uri);
        if (icon.getAttribute("type") !== type) icon.setAttribute("type", type);
        if (!icon.getAttribute("sizes")) icon.setAttribute("sizes", "any");
      });
      let link = document.getElementById(FAVICON_ID);
      if (!link) {
        link = document.createElement("link");
        link.id = FAVICON_ID;
        link.rel = "icon";
        link.type = type;
        link.sizes = "any";
        head.appendChild(link);
      }
      link.setAttribute("href", uri);

      if (!faviconObserver) {
        faviconObserver = new MutationObserver(() => {
          if (faviconBusy) return;
          // 页面卸载 / 进了 bfcache / jsdom 里被 close 之后，head 甚至 document 都可能没了
          try {
            if (typeof document === "undefined" || !document.head) return;
            const want = makeFaviconUri();
            const cur = document.getElementById(FAVICON_ID);
            if (want && (!cur || cur.getAttribute("href") !== want)) applyFavicon();
          } catch { /* 环境已经拆了，忽略 */ }
        });
        faviconObserver.observe(head, {
          childList: true, subtree: true,
          attributes: true, attributeFilter: ["href", "rel", "type", "sizes"]
        });
      }
    } finally {
      faviconBusy = false;
    }
  }

  /* ============================== 原生 DOM 变化 → 增量升级 ==============================
   *
   * 为什么需要这个（V2EX 版没有）：
   *   NGA 的附件、表情、作者名、头像、支持/反对数都是**异步补上来的**。
   *   页面 ready 的瞬间正文里可能还是字面量 [img]./mon_…[/img]，
   *   作者名还是空的。脚本读的是原生 DOM，所以必须能「后面再补一次」。
   *
   * 策略：观察原生内容容器 → 防抖 → 重算页面签名 → **只有签名变了**才重渲染，
   *      并在重渲染前后保住滚动位置。签名没变就什么都不做，
   *      免得把用户的滚动位置和折叠状态冲掉。
   * ================================================================================= */

  let lastSignature = "";
  let upgradeTimer = null;

  function nativeContentRoots() {
    return ["m_posts", "m_threads", "m_nav", "fast_post_c"]
      .map((id) => document.getElementById(id))
      .filter(Boolean);
  }

  function scheduleUpgrade() {
    if (upgradeTimer) clearTimeout(upgradeTimer);
    upgradeTimer = setTimeout(() => {
      upgradeTimer = null;
      try {
        if (bossOn()) return;              // 伪装视图下别动
        if (settingsOpen()) return;        // 设置面板开着别动
        if (!document.documentElement.classList.contains(LOCK_CLASS)) return;
        const page = collectPage();

        // 「加载更多」追加的页只存在于我们的渲染结果里，原生 DOM 里没有。
        // 这时候照常重渲染会把用户翻出来的内容覆盖掉 —— 所以只要
        // 原生能解析出的行数比已渲染的少，就直接跳过（宁可少刷一次，也不能丢内容）。
        if (PAGE && PAGE.route.kind === "list" && PAGE.list && page.list &&
          page.list.length < PAGE.list.length) return;

        const sig = pageSignature(page);
        if (sig === lastSignature) return;
        const y = window.scrollY;
        lastSignature = sig;
        render();
        window.scrollTo(0, y);
      } catch (err) {
        console.warn("[nga-codex] 增量刷新失败，忽略这次", err);
      }
    }, 350);
  }

  let contentObserver = null;

  function observeNative() {
    if (contentObserver) contentObserver.disconnect();
    const roots = nativeContentRoots();
    if (!roots.length) return;
    contentObserver = new MutationObserver(() => scheduleUpgrade());
    roots.forEach((r) => contentObserver.observe(r, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["src", "href", "class"]
    }));
  }

  /* ============================== 编排 ============================== */

  /** 别的 Codex 风格脚本在跑时避让（顺便和 V2EX 版互斥，虽然域名本来就不重叠） */
  function otherThemeActive() {
    const root = document.documentElement;
    return root.classList.contains("v2cx") ||
      root.classList.contains("codex-theme") ||
      root.classList.contains("feishu-im-theme") ||
      root.classList.contains("idea-ide-theme") ||
      !!document.getElementById("v2ex-codex-theme") ||
      !!document.getElementById("linuxdo-codex-theme");
  }

  let scheduled = false;
  let visitCounted = false;
  function scheduleApply() {
    if (scheduled) return;
    scheduled = true;
    nextFrame(() => {
      scheduled = false;
      try {
        if (otherThemeActive()) {
          document.documentElement.classList.remove(ROOT_CLASS, LOCK_CLASS, "ngax-rail-open");
          document.querySelector(".ngax-main")?.remove();
          document.querySelector(".ngax-rail")?.remove();
          return;
        }
        document.documentElement.classList.add(ROOT_CLASS);
        syncMode();
        // favicon 也在这里补一次：bootstrap 跑在 document-start，那时
        // document.head 可能还不存在，applyFavicon() 会直接返回。
        applyFavicon();

        // 每次「页面加载」只做一次的两件事：
        //   1. 把本页 __ALL_FORUM_DATA 里没见过的版面合进本地版面表
        //      （用户逛到哪儿，首页的版面大全就长到哪儿）；
        //   2. 给当前版面记一次访问，供 rail 的「常去版面」排序。
        // 放在这里而不是 render() 里：render() 会被 MutationObserver 反复调用。
        if (!visitCounted) {
          visitCounted = true;
          rememberForums();
          const rr = route();
          if (rr.kind === "list" && rr.listKind === "forum") rememberVisit(rr.fid);
        }

        render();
        lastSignature = PAGE ? pageSignature(PAGE) : "";
        observeNative();
      } catch (err) {
        // 解析失败时绝不破坏原站：撤掉接管，回退原生页面
        console.error("[nga-codex] 渲染失败，已回退原生页面", err);
        document.documentElement.classList.remove(ROOT_CLASS, LOCK_CLASS, "ngax-rail-open");
        document.querySelector(".ngax-main")?.remove();
        document.querySelector(".ngax-rail")?.remove();
      }
    });
  }

  /* ============================== 启动 ============================== */

  function bootstrap() {
    if (!document.documentElement) {
      setTimeout(bootstrap, 0);
      return;
    }

    injectStyle();
    if (!otherThemeActive()) {
      syncMode();
      document.documentElement.classList.add(ROOT_CLASS);
      /*
       * 首帧就先藏。这一步必须在 document-start 发生，否则用户会看到一帧
       * 完整的原生 NGA 页面（米色底 + 顶栏 + 分页），也就是「切版面/点进帖子
       * 闪一下」那个问题。
       *
       * 两个关键点：
       *   1. 只按 URL 判（lockableRoute）—— 这个时间点 body 还没解析，
       *      任何 DOM 探测都是 false，用它做条件等于永远不生效（踩过）；
       *   2. 是「乐观锁定」：万一真身是游客 403 错误页，render() 会因为
       *      没有 #mmc 而把 ngax-locked 摘掉。错误页上没有 #mmc/#mc/.module_wrap，
       *      所以在我们锁着的那几十毫秒里它也基本不会变形。
       */
      if (lockableRoute(route())) document.documentElement.classList.add(LOCK_CLASS);
      applyFavicon();
      watchThemeColor();
    }
    applyVisualSettings();

    // 标签重新可见时再刷一次 favicon（部分浏览器未聚焦时会缓存旧图标）
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !otherThemeActive()) applyFavicon();
    });

    bindBoardControls();
    bindLightbox();
    bindImgPreview();
    bindSettingsPanel();
    bindStealthKeys();
    bindSettingsKeys();

    domReady().then(() => {
      scheduleApply();

      // NGA 的原生 JS 是内联同步脚本，DOMContentLoaded 时基本都跑完了；
      // 但附件/favicon 之类还会再动几拍，所以这里补几次，配合 MutationObserver 兜底。
      [400, 1200, 2600].forEach((ms) => setTimeout(scheduleUpgrade, ms));

      // ⌘/Ctrl + K → 搜索
      window.addEventListener("keydown", (e) => {
        if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
        if ((e.key || "").toLowerCase() !== "k") return;
        if (otherThemeActive()) return;
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "TEXTAREA" || tag === "INPUT") return;
        e.preventDefault();
        e.stopPropagation();
        openSearch();
      }, true);

      // 单页内锚点跳转（NGA 的「跳到最后回复」是普通链接，不需要特殊处理）
      window.addEventListener("popstate", scheduleApply);
    });
  }

  bootstrap();
})();
