// ==UserScript==
// @name         NGA · Codex 外观
// @namespace    https://bbs.nga.cn/
// @version      1.1.0
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
    /**
     * 页面透明度（%）。100 = 不透明。
     *
     * 只作用于脚本自绘的两大块 —— 左侧 rail 和主区（CSS 变量 --ngax-opacity 是
     * 0~1 的无单位数，见 applyVisualSettings）。设置面板 / 灯箱 / 应急伪装视图
     * 刻意不跟着变淡：前两个正在被操作，后一个必须看起来像另一个 app。
     */
    pageOpacity: 100,
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
    /**
     * 侧边栏模式：实时盯着鼠标，指针一离开页面区域（浏览器视口）就自动切到
     * 应急伪装 —— 和连按两下 Esc 是同一个视图。默认关。
     * 需要 stealth 也开着（伪装被禁用时它没有意义）。
     */
    sidebarMode: false,
    /**
     * 侧边栏模式：鼠标回到页面区域时自动还原。
     * 只还原「鼠标离开」自动触发的那次；用户自己按应急键进入的伪装不受影响
     * （手动按应急键也会清掉自动标记，回来后不再替你还原）。
     * 关掉它就变成单向的：离开即伪装，只能自己按应急键还原。
     */
    sidebarRestore: true,
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

  /** 透明度设置（滑杆读数是 20~100 %）→ CSS 变量值（0~1 的无单位数） */
  function opacityVar(pct) {
    const n = Math.min(100, Math.max(0, Number(pct) || 0));
    return String(n / 100);
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
    root.style.setProperty("--ngax-opacity", opacityVar(cfg("pageOpacity")));
    root.classList.toggle("ngax-no-avatar", !cfg("avatars"));
    syncMode();
    applyFavicon();
    syncTitle();
    setPanelHidden(!cfg("codePanel"), false);
    // 侧边栏模式的监听随开关挂 / 摘（定义在「隐蔽性」那一段）
    syncSidebarMode();
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

/*__FORUMS__*/

  /*__CATS__*/

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
