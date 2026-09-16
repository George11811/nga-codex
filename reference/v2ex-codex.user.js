// ==UserScript==
// @name         V2EX · Codex 外观
// @namespace    https://www.v2ex.com/
// @version      1.0.0
// @description  把 V2EX 换成 Codex 桌面 app 风格（左 rail + 主区 + 右侧代码面板，明暗双模式）。仅改变外观，保留站点原有内容与交互。
// @author       link
// @match        https://www.v2ex.com/*
// @match        https://v2ex.com/*
// @icon         https://www.v2ex.com/static/icon-192.png
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * ── 与原脚本（linux.do 版）的核心差异 ───────────────────────────────────────
 *
 * 1. linux.do 是 Ember SPA，靠 /latest.json 等 JSON 端点拿数据、靠 DiscourseURL
 *    做软跳转；V2EX 是服务端渲染的 MPA，**没有**列表 JSON 端点。
 *    因此本脚本改为「解析当前页面已渲染的 DOM → 重渲染成 Codex UI」，
 *    导航用原生 <a> 整页跳转（本来就是 MPA，无需 history hack）。
 *    好处：不需要 API、不需要登录、不需要模拟站点内部调用链。
 *
 * 2. 原脚本的 composer / 通知菜单收养 / 阅读进度上报等 Discourse 专属逻辑全部剔除；
 *    原生 DOM 保持原样（只是被隐藏），所以站点自己的 JS（投票、AJAX 等）仍然可用。
 *
 * 3. V2EX 主题页每 100 楼一页，脚本会读取 .ps_container 支持「加载更多」。
 * ────────────────────────────────────────────────────────────────────────────
 */

(function () {
  "use strict";

  /* ============================== 配置（想改外观改这里） ============================== */

  /* ============================== 设置 ==============================
   *
   * 默认值全在 DEFAULTS 里；用户改过的项统一存成一个 JSON
   * （localStorage 的 v2cx:settings），读走 cfg()、写走 setCfg()。
   *
   * 早期版本是「一个设置一个独立的 localStorage 键」（v2cx:theme / v2cx:railW …），
   * 这里做一次性迁移，老用户不会丢设置。
   * ============================================================== */

  const DEFAULTS = {
    /* —— 外观 —— */
    /** "auto" 跟随 V2EX 自己的主题 | "dark" | "light" */
    theme: "auto",
    /** 左 rail 宽度（Codex 原版约 20% 窗宽，306 是按截图校准的） */
    railWidth: 306,
    /** 右侧代码面板宽度 */
    panelWidth: 460,
    /** 正文最大宽度 */
    threadMaxWidth: 760,
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
     *   - 标签页标题 → 源码文件名（不再出现 "V2EX" / "主题" 字样）
     *   - 启用应急伪装键
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
    /** 左栏品牌名。空字符串 = 由 stealth 决定（Codex / V2EX） */
    brandName: "",
    /**
     * 代码面板 / 面包屑 / 标签页标题里显示的项目名。
     * 默认取一个不含站点痕迹的通用名：标签页标题会变成
     * "topic_cache.rs — platform"，扫一眼就是普通工程目录。
     */
    projectName: "platform",
    /** favicon："codex" = Codex 风格圆角图标 | "site" = 保留 V2EX 原图标 */
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

    /* —— 楼中楼引用 —— */
    /** 把「@某人」的回复渲染成引用卡片（显示引用的是哪一楼、内容和跳转） */
    quoteCard: true,
    /** 引用卡片的正文默认展开 */
    quoteOpen: true,

    /* —— 正文图片 —— */
    /** 缩略图尺寸上限 */
    thumbWidth: 260,
    thumbHeight: 170,
    /** 鼠标悬停时浮出大图预览 */
    thumbPreview: true
  };

  const SETTINGS_KEY = "v2cx:settings";
  /** 旧版本用过的独立键 → 新设置的字段名 */
  const LEGACY_KEYS = {
    theme: "v2cx:theme",
    railWidth: "v2cx:railW",
    panelWidth: "v2cx:panelW",
    codePanel: "v2cx:panelHidden",
    lang: "v2cx:lang",
    codeMode: "v2cx:mode"
  };

  let SETTINGS = null;

  function loadSettings() {
    const out = Object.assign({}, DEFAULTS);
    // 1) 先吃旧键（迁移）
    for (const k of Object.keys(LEGACY_KEYS)) {
      const v = lsGet(LEGACY_KEYS[k], null);
      if (v === null || v === "") continue;
      if (k === "codePanel") out.codePanel = String(v) !== "1";
      else if (k === "railWidth" || k === "panelWidth") {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) out[k] = n;
      } else out[k] = v;
    }
    // 2) 再吃新键，覆盖旧键
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
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS));
      for (const k of Object.keys(LEGACY_KEYS)) localStorage.removeItem(LEGACY_KEYS[k]);
    } catch { /* ignore */ }
    applySettings();
  }

  function brandName() {
    const custom = cfg("brandName");
    return custom || (cfg("stealth") ? "Codex" : "V2EX");
  }

  /**
   * 只改 CSS 变量 / class —— 不重渲染。
   * 拖宽度滑块时走这条，否则每动一格都重排整个列表会很卡。
   */
  function applyVisualSettings() {
    const root = document.documentElement;
    root.style.setProperty("--cx-rail-w", cfg("railWidth") + "px");
    root.style.setProperty("--v2cx-panel-w", cfg("panelWidth") + "px");
    root.style.setProperty("--v2cx-thread-max", cfg("threadMaxWidth") + "px");
    root.style.setProperty("--v2cx-thumb-w", cfg("thumbWidth") + "px");
    root.style.setProperty("--v2cx-thumb-h", cfg("thumbHeight") + "px");
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

  const STYLE_ID = "v2ex-codex-theme";
  const FAVICON_ID = "v2ex-codex-favicon";
  const ROOT_CLASS = "v2cx";            // <html> 上的激活标记
  const LIGHT_CLASS = "v2cx-light";     // 浅色模式
  const LOCK_CLASS = "v2cx-locked";     // 隐藏原生页面

  // 「默认宽度」——双击拖拽把手是重置回这两个值，不是重置回当前设置
  const RAIL_W = DEFAULTS.railWidth;
  const PANEL_DEFAULT_W = DEFAULTS.panelWidth;


  /* ============================== 内联 SVG 图标 ============================== */

  const ICONS = {
    sidebar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="3"/><line x1="9.5" y1="4" x2="9.5" y2="20"/></svg>`,
    chevronDown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 9 12 14 17 9"/></svg>`,
    chevronUp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 15 12 10 17 15"/></svg>`,
    chevronRightSm: `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`,
    search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`,
    bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/></svg>`,
    pencil: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
    layers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>`,
    clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>`,
    fire: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2s5 5 5 9a5 5 0 0 1-10 0c0-1.5.7-2.8 1.5-3.8C8 9 9 9.5 9 8c0-2 3-6 3-6Z"/><path d="M12 22a5 5 0 0 0 5-5c0-3-2-5-5-8-3 3-5 5-5 8a5 5 0 0 0 5 5Z"/></svg>`,
    home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5"/></svg>`,
    gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z"/></svg>`,
    folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`,
    folderOpen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
    external: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>`,
    dots: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`,
    dotsV: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>`,
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
    star: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.9L12 3.6Z"/></svg>`,
    starFill: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.9L12 3.6Z"/></svg>`,
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
   * 自建图标集少了任何一个 key，模板拼接就会写出字面 "undefined"，
   * 而这种事已经发生过三次（send / heart+star+sparkle / branch）。
   * 所有图标引用一律走这里，丢掉图标总比页面上出现 "undefined" 好。
   */
  function ic(name) {
    return ICONS[name] || "";
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

  /**
   * 取文本，但把块级分隔符（<br> / .sep5 / .sep10）换成 " · "。
   * V2EX 用空 <div class="sep5"> 当换行，直接 textContent 会把两句话粘在一起，
   * 例如会员页 bio 会变成 "…+08:00Today's activity rank 1033"。
   */
  function txtBlock(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("br, .sep5, .sep10, .sep20").forEach((n) => {
      n.replaceWith(document.createTextNode(" \u00b7 "));
    });
    return txt(clone).replace(/^(?:\s*\u00b7\s*)+|(?:\s*\u00b7\s*)+$/g, "").trim();
  }

  /** V2EX 的绝对时间写在 title 上： "2026-09-14 11:37:45 +08:00" */
  function isoFromTitle(t) {
    if (!t) return "";
    const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*(.*)$/);
    if (!m) return "";
    const tz = (m[7] || "").replace(/\s+/g, "");
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${tz || "Z"}`;
  }

  function formatTime(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const now = Date.now();
    const diff = now - date.getTime();
    const minute = 60e3, hour = 3600e3, day = 86400e3;
    if (diff < minute) return "刚刚";
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day && date.getDate() === new Date().getDate()) {
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }
    if (diff < 2 * day) return "昨天";
    if (diff < 365 * day) return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")}`;
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }

  /** 只取数字（"1,774 views" / "44" → 数字） */
  function num(s) {
    const m = String(s || "").replace(/,/g, "").match(/-?\d+/);
    return m ? Number(m[0]) : 0;
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
    let el = document.querySelector(".v2cx-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "v2cx-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("on");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("on"), 1600);
  }

  /* ============================== 路由判定 ============================== */

  const TABS = [
    { key: "tech", label: "技术" },
    { key: "creative", label: "创意" },
    { key: "play", label: "好玩" },
    { key: "apple", label: "Apple" },
    { key: "jobs", label: "酷工作" },
    { key: "deals", label: "交易" },
    { key: "city", label: "城市" },
    { key: "qna", label: "问与答" },
    { key: "hot", label: "最热" },
    { key: "all", label: "全部" },
    { key: "r2", label: "R2" }
  ];

  /** 常用节点（rail 里的快捷入口，可按喜好增删） */
  const QUICK_NODES = [
    { name: "programmer", label: "程序员" },
    { name: "python", label: "Python" },
    { name: "openai", label: "OpenAI" },
    { name: "claude", label: "Claude" },
    { name: "localllm", label: "Local LLM" },
    { name: "idev", label: "iDev" },
    { name: "cloud", label: "云计算" },
    { name: "bb", label: "宽带症候群" },
    { name: "share", label: "分享发现" },
    { name: "qna", label: "问与答" },
    { name: "create", label: "程序员创造" },
    { name: "jobs", label: "酷工作" },
    { name: "deals", label: "交易" },
    { name: "apple", label: "Apple" },
    { name: "android", label: "Android" },
    { name: "linux", label: "Linux" },
    { name: "macos", label: "macOS" },
    { name: "hardware", label: "硬件" },
    { name: "design", label: "设计" },
    { name: "photography", label: "摄影" }
  ];

  function route() {
    const p = location.pathname;
    const q = new URLSearchParams(location.search);

    let m;
    if ((m = p.match(/^\/t\/(\d+)/))) {
      return { kind: "topic", topicId: Number(m[1]), page: num(q.get("p")) || 1, path: p };
    }
    if (p === "/" || p === "") {
      const explicit = q.get("tab") || "";
      return {
        kind: "list", listKind: "tab",
        tab: explicit || "tech",
        explicitTab: explicit,
        path: p, page: num(q.get("p")) || 1
      };
    }
    if (p === "/recent") {
      return { kind: "list", listKind: "recent", path: p, page: num(q.get("p")) || 1 };
    }
    if ((m = p.match(/^\/go\/([A-Za-z0-9_-]+)/))) {
      return { kind: "list", listKind: "node", node: m[1], path: p, page: num(q.get("p")) || 1 };
    }
    if ((m = p.match(/^\/tag\/([^/?#]+)/))) {
      return { kind: "list", listKind: "tag", tag: decodeURIComponent(m[1]), path: p, page: num(q.get("p")) || 1 };
    }
    if ((m = p.match(/^\/(?:member|u)\/([^/?#]+)/))) {
      return { kind: "member", username: decodeURIComponent(m[1]), path: p };
    }
    if (p === "/planes") {
      return { kind: "planes", path: p };
    }
    return { kind: "other", path: p };
  }

  /** 只有这些路由会被接管；其余（设置、登录、帮助等）保留原生页面 + rail */
  function isSupported(r) {
    return r.kind === "topic" || r.kind === "list" || r.kind === "member" || r.kind === "planes";
  }

  function listTitle(r) {
    if (r.listKind === "tab") {
      const t = TABS.find((x) => x.key === r.tab);
      return t ? t.label : "技术";
    }
    if (r.listKind === "recent") return "最近";
    if (r.listKind === "tag") return `#${r.tag}`;
    if (r.listKind === "node") return r.node;
    return "话题";
  }

  /* ============================== 解析：V2EX DOM → 数据 ============================== */

  /**
   * 拆掉回复正文开头的 "@某人"。
   * V2EX 没有结构化的引用节点，楼中楼就是正文以
   *   @<a href="/member/xxx">xxx</a> 内容…
   * 开头。这里把这段前缀摘出来，剩下的正文交给引用卡片去承载。
   * 摘不出来（不是 @ 开头）就原样返回。
   */
  function splitMention(html) {
    const m = String(html || "").match(/^\s*@<a href="\/member\/([^"]+)"[^>]*>([^<]+)<\/a>\s*/);
    if (!m) return { html: html || "", mention: null };
    return { html: String(html).slice(m[0].length), mention: { slug: m[1], name: m[2] } };
  }

  const parse = {};

  /** 通用话题行解析：任何含 .item_title a.topic-link 的 div.cell 都算
   *  （首页/最近/节点页/标签页/会员页通用；节点页的行类名是 .cell.from_xxx.t_xxx） */
  parse.listRows = function (root) {
    const out = [];
    const seen = new Set();
    const cells = root.querySelectorAll("div.cell");
    for (const cell of cells) {
      const titleA = cell.querySelector(".item_title a.topic-link") ||
        cell.querySelector(".item_title a");
      if (!titleA) continue;
      const idM = attr(titleA, "href").match(/\/t\/(\d+)/);
      const id = idM ? idM[1] : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const info = cell.querySelector(".topic_info");
      const nodeA = cell.querySelector(".topic_info a.node") || cell.querySelector("a.node");
      const strongs = info ? Array.from(info.querySelectorAll("strong a")) : [];
      const timeSpan = info ? info.querySelector("span[title]") : null;
      const countA = cell.querySelector("a.count_livid, a.count_orange, a.count_gray, a.count_green, a.count_neutral");

      out.push({
        id,
        url: attr(titleA, "href"),
        title: txt(titleA),
        node: nodeA ? { name: txt(nodeA), url: attr(nodeA, "href") } : null,
        author: strongs.length ? txt(strongs[0]) : "",
        authorUrl: strongs.length ? attr(strongs[0], "href") : "",
        lastReplyBy: strongs.length > 1 ? txt(strongs[strongs.length - 1]) : "",
        timeText: txt(timeSpan),
        timeIso: isoFromTitle(attr(timeSpan, "title")),
        replies: countA ? (txt(countA) || "0") : "0"
      });
    }
    return out;
  };

  /** 首页右栏 /TopicsHot 的今日热榜 → rail 用 */
  parse.hotTopics = function (root) {
    const out = [];
    const box = root.querySelector("#TopicsHot");
    if (!box) return out;
    box.querySelectorAll(".item_hot_topic_title a").forEach((a) => {
      const href = attr(a, "href");
      if (!/^\/t\/\d+/.test(href)) return;
      out.push({ url: href, title: txt(a) });
    });
    return out.slice(0, 10);
  };

  /** 分页信息：返回 { current, total, next } —— next 为下一页 URL 或 null */
  parse.pagination = function (root) {
    const box = root.querySelector(".ps_container");
    if (!box) return { current: 1, total: 1, next: null };
    const cur = box.querySelector(".page_current");
    const current = num(txt(cur)) || 1;

    let total = current;
    const pages = box.querySelectorAll(".page_normal, .page_current");
    for (const p of pages) total = Math.max(total, num(txt(p)));

    // 节点页有两个 .ps_container（上/下），取带 next 的那个
    let next = null;
    const nextBtn = box.querySelector("[title='Next Page'], .normal_page_right");
    if (nextBtn && !nextBtn.classList.contains("disable_now")) {
      const oc = attr(nextBtn, "onclick");
      const m = oc.match(/location\.href\s*=\s*'([^']+)'/);
      if (m) next = m[1];
    }
    if (!next) {
      const sel = root.querySelector(".ps_container select");
      if (sel) {
        sel.querySelectorAll("option").forEach((o) => {
          const v = num(o.getAttribute("value"));
          if (v === current + 1) {
            const oc = attr(sel, "onchange");
            const m = oc.match(/=\s*'([^']*)'\s*\+/);
            if (m) next = `${m[1]}${v}`;
          }
        });
      }
    }
    return { current, total, next };
  };

  /** 主题页：header + 正文 + 补充 + 回复 */
  parse.topic = function (root) {
    const main = root.querySelector("#Main") || root;
    const h1 = main.querySelector(".header h1, h1");
    const header = h1 ? h1.closest(".header") : null;

    const title = txt(h1) || txt(root.querySelector("title")).replace(/\s*-\s*V2EX\s*$/, "");

    // 面包屑：V2EX › 节点
    let node = null;
    if (header) {
      const nodeA = header.querySelector('a[href^="/go/"]');
      if (nodeA) node = { name: txt(nodeA), url: attr(nodeA, "href") };
    }

    // 作者 / 时间 / 阅读数
    const small = header ? header.querySelector("small.gray") : null;
    const authorA = small ? small.querySelector('a[href^="/member/"]') : null;
    const timeSpan = small ? small.querySelector("span[title]") : null;
    const smallTxt = txt(small);
    const viewsM = smallTxt.match(/([\d,]+)\s*views/i);

    const author = authorA ? txt(authorA) : "";
    const authorUrl = authorA ? attr(authorA, "href") : "";

    // 正文：主题页第一个 .cell > .topic_content
    const firstContent = main.querySelector(".cell > .topic_content, .topic_content");
    const contentHtml = firstContent ? firstContent.innerHTML : "";

    // 补充（Supplement）：div.subtle
    const supplements = Array.from(main.querySelectorAll("div.subtle")).map((el) => {
      const label = txt(el.querySelector(".fade")) || "补充";
      const t = el.querySelector("span[title]");
      const body = el.querySelector(".topic_content");
      return {
        label: label.replace(/\s*·.*$/, "").trim(),
        timeIso: isoFromTitle(attr(t, "title")),
        html: body ? body.innerHTML : ""
      };
    });

    // 标签
    const tags = Array.from(main.querySelectorAll("a.tag")).map((a) => ({
      label: txt(a),
      url: attr(a, "href")
    }));

    // 回复条数
    const repliesLabel = txt(main.querySelector(".box .cell .gray")) || "";
    const repliesCountM = repliesLabel.match(/([\d,]+)\s*replies/i);

    const replies = parse.replies(main);

    const pag = parse.pagination(main);

    return {
      topicId: (location.pathname.match(/^\/t\/(\d+)/) || [])[1] || "",
      title,
      node,
      author,
      authorUrl,
      timeIso: isoFromTitle(attr(timeSpan, "title")),
      timeText: txt(timeSpan),
      views: viewsM ? viewsM[1] : "",
      contentHtml,
      supplements,
      tags,
      repliesCount: repliesCountM ? num(repliesCountM[1]) : replies.length,
      replies,
      page: pag.current,
      totalPages: pag.total
    };
  };

  /** 回复列表（主题页 / 分页 AJAX 复用） */
  parse.replies = function (root) {
    const out = [];
    root.querySelectorAll('div[id^="r_"]').forEach((cell) => {
      const idM = attr(cell, "id").match(/^r_(\d+)$/);
      const userA = cell.querySelector("strong a.dark") || cell.querySelector("strong a");
      const ago = cell.querySelector("span.ago");
      const contentEl = cell.querySelector(".reply_content");
      const badges = Array.from(cell.querySelectorAll(".badges .badge")).map((b) => txt(b));
      const raw = contentEl ? contentEl.innerHTML : "";
      // V2EX 的「楼中楼」就是回复正文以 "@<a href=/member/X>X</a>" 开头。
      // 两个版本都留着：html 是摘掉 @ 的（给引用卡片用），
      // htmlRaw 是原文 —— 不开引用卡片、或解析不到引用目标时要用它，否则 @ 就丢了。
      const split = splitMention(raw);
      out.push({
        id: idM ? idM[1] : "",
        floor: txt(cell.querySelector(".no")),
        username: txt(userA),
        userUrl: attr(userA, "href"),
        timeIso: isoFromTitle(attr(ago, "title")),
        timeText: txt(ago),
        via: (txt(ago).match(/via\s+(.+)$/i) || [])[1] || "",
        html: split.html,
        htmlRaw: raw,
        mention: split.mention,
        badges,
        isOp: badges.some((b) => /^OP$/i.test(b))
      });
    });
    return out;
  };

  /** 节点页 header */
  parse.nodeHeader = function (root) {
    const box = root.querySelector(".node-header");
    if (!box) return null;
    const img = box.querySelector("img");
    return {
      avatar: img ? attr(img, "src") : "",
      name: (attr(img, "alt") || "").trim(),
      breadcrumb: txt(box.querySelector(".node-breadcrumb")),
      topicCount: num(txt(box.querySelector(".topic-count"))),
      intro: txt(box.querySelector(".intro"))
    };
  };

  /** 会员页 header */
  parse.memberHeader = function (root) {
    const main = root.querySelector("#Main");
    if (!main) return null;
    const h1 = main.querySelector("h1");
    if (!h1) return null;
    const box = h1.closest(".box");
    const img = box ? box.querySelector("img.avatar") : null;
    const gray = box ? box.querySelector("span.gray") : null;
    const widgets = box ? Array.from(box.querySelectorAll(".widgets a")).map((a) => ({
      label: txt(a),
      url: attr(a, "href")
    })) : [];
    const tabs = main.querySelectorAll(".cell_tabs a");
    return {
      username: txt(h1),
      avatar: img ? attr(img, "src") : "",
      bio: gray ? txtBlock(gray) : "",
      widgets,
      tabs: Array.from(tabs).map((a) => ({
        label: txt(a),
        url: attr(a, "href"),
        active: a.classList.contains("tab_current")
      })),
      online: !!main.querySelector("strong.online")
    };
  };

  /** 全部节点页 /planes：每个 .box 是一个「位面」分组，节点是 a.item_node */
  parse.planes = function (root) {
    const main = root.querySelector("#Main") || root;
    const groups = [];

    // 顶部说明："V2EX 位面列表" + "1376 nodes now and growing."
    const intro = main.querySelector(".box .cell .fade");
    const totalM = txt(intro).match(/([\d,]+)\s*nodes/i);

    main.querySelectorAll(".box").forEach((box) => {
      const links = Array.from(box.querySelectorAll("a.item_node")).map((a) => ({
        label: txt(a),
        url: attr(a, "href")
      }));
      if (!links.length) return;

      const header = box.querySelector(".header");
      // 分组名是 .header 的第一个非空直接文本节点（"混沌海"），
      // 后面还跟着 "Limbo • 110 nodes" 之类的元信息，不能整段取。
      let name = "";
      if (header) {
        for (const n of header.childNodes) {
          if (n.nodeType === 3 && n.textContent.trim()) { name = n.textContent.trim(); break; }
        }
        if (!name) name = txt(header).split(/\s{2,}|•/)[0].trim();
      }
      const meta = header ? txt(header.querySelector(".small")) : "";

      groups.push({ group: name || "未分组", meta, links });
    });

    return { groups, total: totalM ? num(totalM[1]) : groups.reduce((n, g) => n + g.links.length, 0) };
  };

  /** 当前登录用户名（未登录 → null）。V2EX 的 .tools 里未登录会显示 Sign In */
  function currentUser(root) {
    const tools = root.querySelector("#Top .tools");
    if (!tools) return null;
    if (tools.querySelector('a[href*="signin"]')) return null;
    const a = tools.querySelector('a[href^="/member/"]');
    if (a) return { name: txt(a), url: attr(a, "href") };
    const first = tools.querySelector("a.top");
    return first ? { name: txt(first), url: attr(first, "href") } : null;
  }

  /* ============================== CSS ============================== */

  // 视觉 token 实测自 Codex 桌面 app 深/浅两版截图；组件一律引用变量，明暗共用一套规则。
  // 说明：原脚本浅色 token 块尾部多了一个 `}`，导致后面的 --cx-font-* / --cx-rail-w
  //      落在选择器外面失效；这里已修正。
  const RAW_CSS = String.raw`
    /* ---------- Token：深色（默认） ---------- */
    html.${ROOT_CLASS} {
      /*
       * rail 配色。
       *
       * 这里不能只看「名义对比度」：14px 细体中文在深色底上经过抗锯齿后，
       * 文字像素的加权平均亮度远低于名义色值。剪出真实截图里的 rail 区域做加权平均，
       * 实测：
       *   #27353b 底 + #c3ccd0 字 → 峰值 7.76:1，但有效值只有 3.38:1（看着就是看不清）
       *   #27353b 底 + 纯白字也只能到 ~4.0:1 —— 底色本身太亮，光提亮文字救不回来
       * 所以做法是：底色压暗 + 文字提到接近白 + 加半档字重（见 .v2cx-rail-item）。
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

      --cx-rail-w: ${RAIL_W}px;
      --cx-radius: 10px;
    }

    /* ---------- Token：浅色 ---------- */
    html.${ROOT_CLASS}.${LIGHT_CLASS} {
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
    .v2cx-rail, .v2cx-rail *,
    .v2cx-main, .v2cx-main *,
    .v2cx-lightbox, .v2cx-lightbox *,
    .v2cx-toast { box-sizing: border-box; }

    /* ---------- 隐藏原生页面（仅被接管的路由） ---------- */
    html.${ROOT_CLASS}.${LOCK_CLASS} #Top,
    html.${ROOT_CLASS}.${LOCK_CLASS} #Wrapper,
    html.${ROOT_CLASS}.${LOCK_CLASS} #Bottom,
    html.${ROOT_CLASS}.${LOCK_CLASS} .scroll-top {
      display: none !important;
    }
    /* 接管时接管底色 / 盒模型；样式收窄到 locked，避免干扰原生页面 */
    html.${ROOT_CLASS}.${LOCK_CLASS} body {
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
    html.${ROOT_CLASS}:not(.${LOCK_CLASS}) #Wrapper {
      margin-left: var(--cx-rail-w) !important;
    }

    /* ================= 左 rail ================= */
    .v2cx-rail {
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
    .v2cx-rail-traffic {
      height: 46px;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 0 14px;
      color: var(--cx-rail-text-dim);
      flex: none;
    }
    .v2cx-rail-traffic svg { width: 20px; height: 20px; padding: 2px; border-radius: 6px; cursor: pointer; }
    .v2cx-rail-traffic svg:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    .v2cx-rail-brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 2px 14px 10px;
      flex: none;
    }
    .v2cx-rail-brand-name {
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
    .v2cx-rail-brand-name svg { width: 12px; height: 12px; color: var(--cx-rail-text-dim); }
    .v2cx-rail-brand-actions { display: flex; gap: 2px; color: var(--cx-rail-text-dim); }
    .v2cx-rail-brand-actions svg { width: 19px; height: 19px; padding: 2px; border-radius: 6px; cursor: pointer; }
    .v2cx-rail-brand-actions svg:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    .v2cx-rail-bell { position: relative; display: inline-flex; }
    .v2cx-rail-bell.has-unread::after {
      content: "";
      position: absolute; top: 1px; right: 1px;
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--cx-blue);
      border: 1.5px solid var(--cx-rail-bg);
    }

    .v2cx-rail-scroll { flex: 1; overflow-y: auto; padding-bottom: 8px; }
    .v2cx-rail-scroll::-webkit-scrollbar { width: 8px; }
    .v2cx-rail-scroll::-webkit-scrollbar-thumb { background: var(--cx-scroll-thumb); border-radius: 4px; }

    .v2cx-rail-nav { padding: 2px 8px; display: flex; flex-direction: column; gap: 1px; }
    .v2cx-rail-item {
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
    .v2cx-rail-item:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    .v2cx-rail-item.active { background: var(--cx-rail-bg-active); color: var(--cx-rail-text); }
    .v2cx-rail-item svg { width: 16px; height: 16px; flex: none; color: var(--cx-rail-text-dim); }
    .v2cx-rail-item.active svg { color: var(--cx-rail-text); }
    .v2cx-rail-item .v2cx-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .v2cx-rail-item.faint { color: var(--cx-rail-text-faint); }
    .v2cx-rail-item .v2cx-count {
      flex: none;
      font-size: 11.5px;
      color: var(--cx-rail-text-faint);
      font-variant-numeric: tabular-nums;
    }
    .v2cx-rail-section {
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
    .v2cx-rail-section .v2cx-more {
      text-transform: none;
      letter-spacing: 0;
      font-weight: 400;
      cursor: pointer;
      color: var(--cx-rail-text-dim);
    }
    .v2cx-rail-section .v2cx-more:hover { color: var(--cx-rail-text); }
    .v2cx-rail-section-items { padding: 0 8px; display: flex; flex-direction: column; gap: 1px; }
    .v2cx-rail-foot {
      flex: none;
      border-top: 1px solid var(--cx-rail-border);
      padding: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .v2cx-rail-foot-user {
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
    .v2cx-rail-foot-user:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    .v2cx-rail-foot-user svg { width: 17px; height: 17px; flex: none; }
    .v2cx-rail-foot-user .v2cx-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .v2cx-rail .v2cx-mode-btn {
      flex: none;
      width: 32px; height: 32px;
      display: grid; place-items: center;
      border: none; background: none;
      border-radius: 7px;
      cursor: pointer;
      color: var(--cx-rail-text-dim);
    }
    .v2cx-rail .v2cx-mode-btn:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    .v2cx-rail .v2cx-mode-btn svg { width: 18px; height: 18px; pointer-events: none; }

    .v2cx-resizer {
      position: absolute;
      top: 0; bottom: 0;
      width: 7px;
      cursor: col-resize;
      z-index: 20;
      /* 平时只显示一条 1px 分隔线，hover / 拖拽时才铺满高亮 */
      background: transparent;
    }
    .v2cx-resizer::after {
      content: "";
      position: absolute;
      top: 0; bottom: 0;
      left: 3px;
      width: 1px;
      background: var(--cx-border);
    }
    .v2cx-resizer:hover::after,
    .v2cx-resizer.dragging::after {
      background: var(--cx-blue);
      width: 2px;
      left: 2.5px;
    }
    .v2cx-resizer:hover,
    .v2cx-resizer.dragging { background: var(--cx-blue-soft); }

    /*
     * 拖拽把手必须锚在「被调整的那条边」上：
     *   rail  → 贴在 rail 右缘
     *   panel → 贴在代码面板左缘（所以把手是 .v2cx-code-panel 的子元素，
     *           依靠面板自身的 position:relative 定位）
     * 之前把手是 .v2cx-main 的子元素，absolute 相对于 .v2cx-main 定位，
     * 结果跑到主区最左边去了，根本拖不到。
     */
    .v2cx-rail > .v2cx-resizer { right: -3px; }
    .v2cx-code-panel > .v2cx-resizer { left: -3px; }
    .v2cx-code-panel > .v2cx-resizer::after { left: 3px; }

    /* ================= 主区 ================= */
    .v2cx-main {
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
    .v2cx-main.panel-hidden .v2cx-code-panel { display: none; }

    .v2cx-thread-col {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      /* composer 是绝对定位浮层，所以定位基准在这里 */
      position: relative;
    }

    .v2cx-topbar {
      height: 46px;
      flex: none;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      border-bottom: 1px solid var(--cx-border-soft);
      color: var(--cx-text-secondary);
    }
    .v2cx-topbar svg { width: 16px; height: 16px; flex: none; }
    .v2cx-topbar .v2cx-crumb { display: flex; align-items: center; gap: 7px; font-size: 13px; min-width: 0; }
    .v2cx-topbar .v2cx-crumb .v2cx-proj { color: var(--cx-text); }
    .v2cx-topbar .v2cx-crumb .v2cx-sep { color: var(--cx-text-faint); }
    /* 详情页不再重复渲染大标题，顶栏这段就是唯一标题，所以要用正文色而不是 dim */
    .v2cx-topbar .v2cx-crumb .v2cx-model {
      color: var(--cx-text);
      font-size: 13.5px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .v2cx-topbar .v2cx-spacer { flex: 1; }
    .v2cx-topbar .v2cx-icon-btn {
      padding: 5px;
      border-radius: 6px;
      cursor: pointer;
      color: var(--cx-text-dim);
      display: grid;
      place-items: center;
      border: none;
      background: none;
    }
    .v2cx-topbar .v2cx-icon-btn:hover { background: var(--cx-bg-raised); color: var(--cx-text); }
    .v2cx-topbar .v2cx-menu-btn { display: none; }

    .v2cx-thread {
      flex: 1;
      min-width: 0;
      overflow-y: auto;
      /* 底部留出 composer 的高度，否则滚到底时最后几层会被浮层盖住 */
      padding: 28px 40px 180px;
      scrollbar-width: thin;
    }
    .v2cx-thread::-webkit-scrollbar { width: 8px; }
    .v2cx-thread::-webkit-scrollbar-thumb { background: var(--cx-scroll-thumb); border-radius: 4px; }
    .v2cx-thread-inner { max-width: var(--v2cx-thread-max, 760px); margin: 0 auto; }

    /* —— 列表视图头部 —— */
    .v2cx-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin: 6px 0 2px;
    }
    .v2cx-head-title { display: flex; align-items: center; gap: 4px; min-width: 0; }
    .v2cx-head h1 { font-size: 20px; font-weight: 600; letter-spacing: 0.2px; margin: 0; }
    .v2cx-head-desc { font-size: 12.5px; color: var(--cx-text-dim); margin-bottom: 16px; }
    .v2cx-new-topic-btn {
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
    .v2cx-new-topic-btn:hover { background: var(--cx-btn-hover); }
    .v2cx-new-topic-btn svg { width: 13px; height: 13px; }
    .v2cx-filter-btn {
      width: 26px; height: 26px;
      border-radius: 7px;
      color: var(--cx-text-dim);
      display: grid; place-items: center;
      cursor: pointer;
      border: none; background: none;
      flex: none;
    }
    .v2cx-filter-btn:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .v2cx-filter-btn svg { width: 14px; height: 14px; transition: transform 0.15s; }
    .v2cx-main.filters-open .v2cx-filter-btn svg { transform: rotate(180deg); }
    .v2cx-filter-row { display: none; flex-wrap: wrap; gap: 6px; margin: 2px 0 12px; }
    .v2cx-main.filters-open .v2cx-filter-row { display: flex; }
    .v2cx-fchip {
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
    .v2cx-fchip:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .v2cx-fchip.on { color: var(--cx-blue); border-color: var(--cx-blue); background: var(--cx-blue-soft); }

    /* —— 节点 / 会员 卡片 —— */
    .v2cx-card {
      display: flex;
      gap: 14px;
      align-items: flex-start;
      padding: 14px 16px;
      margin-bottom: 18px;
      background: var(--cx-bg-raised);
      border: 1px solid var(--cx-border-soft);
      border-radius: var(--cx-radius);
    }
    .v2cx-card img {
      width: 48px; height: 48px;
      border-radius: 10px;
      flex: none;
      background: var(--cx-bg-inset);
      object-fit: cover;
    }
    .v2cx-card-main { min-width: 0; flex: 1; }
    .v2cx-card-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .v2cx-card-title h1 { font-size: 18px; font-weight: 600; margin: 0; }
    .v2cx-card-sub { font-size: 12.5px; color: var(--cx-text-dim); margin-top: 4px; }
    .v2cx-card-intro { font-size: 13px; color: var(--cx-text-secondary); margin-top: 8px; line-height: 1.6; }
    .v2cx-card-links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .v2cx-pill {
      font-size: 12px;
      color: var(--cx-text-secondary);
      background: var(--cx-chip-bg);
      border-radius: 999px;
      padding: 4px 11px;
      text-decoration: none;
      white-space: nowrap;
    }
    .v2cx-pill:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .v2cx-pill.on { color: var(--cx-blue); background: var(--cx-blue-soft); }

    /* —— 列表行（话题 = Codex 项目线程） —— */
    .v2cx-rows { display: flex; flex-direction: column; }
    .v2cx-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 11px 12px;
      border-radius: 9px;
      text-decoration: none;
      color: inherit;
      min-width: 0;
    }
    .v2cx-row:hover { background: var(--cx-wash); }
    .v2cx-row:hover .v2cx-row-title { color: var(--cx-blue); }
    .v2cx-row-avatar {
      width: 7px; height: 7px;
      border-radius: 50%;
      flex: none;
      background: transparent;
      border: 1.5px solid var(--cx-text-faint);
      box-sizing: border-box;
    }
    /* 有回复 → 实心蓝点；无回复 → 空心点（对齐 Codex 的未读/已读标记） */
    .v2cx-row-avatar.has-replies {
      background: var(--cx-blue);
      border-color: var(--cx-blue);
    }
    .v2cx-row-texts { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .v2cx-row-title {
      font-size: 14px;
      font-weight: 500;
      color: var(--cx-text);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      transition: color 0.12s;
    }
    .v2cx-row-sub {
      font-size: 12px;
      color: var(--cx-text-dim);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      display: flex; align-items: center; gap: 6px;
    }
    .v2cx-row-sub .v2cx-node {
      color: var(--cx-text-secondary);
      background: var(--cx-chip-bg);
      border-radius: 5px;
      padding: 1px 6px;
      font-size: 11.5px;
      flex: none;
    }
    .v2cx-row-meta {
      flex: none;
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 12px;
      color: var(--cx-text-faint);
      font-variant-numeric: tabular-nums;
    }
    .v2cx-row-meta .v2cx-replies {
      min-width: 52px;
      text-align: right;
      color: var(--cx-text-secondary);
    }
    .v2cx-row-meta .v2cx-time { min-width: 72px; text-align: right; }
    .v2cx-row-sep { height: 1px; background: var(--cx-border-soft); margin: 2px 12px; }

    .v2cx-list-status {
      font-size: 12.5px;
      color: var(--cx-text-faint);
      text-align: center;
      padding: 18px 0 6px;
    }
    .v2cx-list-status.link { cursor: pointer; }
    .v2cx-list-status.link:hover { color: var(--cx-blue); }

    .v2cx-search-input {
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
    .v2cx-search-input::placeholder { color: var(--cx-text-faint); }
    .v2cx-search-input:focus { border-color: var(--cx-blue); }

    /* ================= 详情视图（帖子 = agent thread） ================= */
    .v2cx-detail-head { margin-bottom: 20px; }
    .v2cx-detail-meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 12.5px;
      color: var(--cx-text-dim);
    }
    .v2cx-detail-meta img {
      width: 22px; height: 22px;
      border-radius: 50%;
      object-fit: cover;
    }
    .v2cx-detail-meta .v2cx-dotsep { color: var(--cx-text-faint); }
    .v2cx-detail-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .v2cx-votes { display: inline-flex; gap: 2px; margin-left: 2px; }
    .v2cx-vote-btn {
      padding: 3px;
      border-radius: 6px;
      border: 1px solid var(--cx-border-soft);
      background: none;
      color: var(--cx-text-dim);
      cursor: pointer;
      display: grid;
      place-items: center;
    }
    .v2cx-vote-btn:hover { background: var(--cx-btn-hover); color: var(--cx-blue); }
    .v2cx-vote-btn svg { width: 13px; height: 13px; }

    /* OP 气泡（用户消息，右对齐） */
    .v2cx-turn-user { display: flex; justify-content: flex-end; margin: 0 0 8px; }
    .v2cx-turn-user-bubble {
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
    .v2cx-turn-agent { margin: 0 0 8px; }
    .v2cx-turn-agent .v2cx-cooked {
      font-size: 14px;
      line-height: 1.75;
      overflow-wrap: anywhere;
      padding: 2px 0;
    }
    .v2cx-worked {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
      color: var(--cx-text-faint);
      padding: 2px 0 0;
      min-height: 22px;
    }
    .v2cx-worked .v2cx-floor {
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
    .v2cx-worked img {
      width: 18px; height: 18px;
      border-radius: 50%;
      object-fit: cover;
    }
    .v2cx-worked .v2cx-user { color: var(--cx-text-secondary); }
    .v2cx-worked .v2cx-badge {
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
    .v2cx-worked .v2cx-actions {
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
    .v2cx-turn:hover .v2cx-worked .v2cx-actions,
    .v2cx-supplement:hover .v2cx-worked .v2cx-actions,
    .v2cx-detail-meta:hover .v2cx-actions {
      opacity: 1;
      pointer-events: auto;
    }
    .v2cx-worked .v2cx-act {
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
    .v2cx-worked .v2cx-act:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .v2cx-worked .v2cx-act svg { width: 13px; height: 13px; flex: none; }
    .v2cx-worked .v2cx-act.on { color: var(--cx-blue); }

    /* ---------- agent 思考块（✻ Worked for 27s，默认展开、点标题收起） ---------- */
    .v2cx-think {
      margin: 2px 0 12px;
      font-size: 12.5px;
      color: var(--cx-text-dim);
    }
    .v2cx-think-head {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      cursor: pointer;
      user-select: none;
    }
    .v2cx-think-head:hover { color: var(--cx-text-secondary); }
    .v2cx-think-head .v2cx-spin { display: inline-flex; color: var(--cx-blue); }
    .v2cx-think-head .v2cx-spin svg { width: 13px; height: 13px; }
    .v2cx-think-chev { font-size: 10px; color: var(--cx-text-faint); }
    .v2cx-think-body {
      display: none;
      margin: 8px 0 2px;
      padding: 8px 0 8px 12px;
      line-height: 1.72;
      color: var(--cx-text-secondary);
      border-left: 2px solid var(--cx-border);
      white-space: pre-wrap;
    }
    .v2cx-think.open .v2cx-think-body { display: block; }
    .v2cx-think.open .v2cx-think-chev::after { content: "\25be"; }
    .v2cx-think:not(.open) .v2cx-think-chev::after { content: "\25b8"; }

    /* ---------- 楼内「工具调用」淡色行 ---------- */
    .v2cx-runline {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 11px 0;
      font-size: 12.5px;
      color: var(--cx-text-dim);
    }
    .v2cx-runline svg { width: 14px; height: 14px; flex: none; color: var(--cx-text-faint); }
    .v2cx-runline code {
      font-family: var(--cx-font-mono);
      font-size: 11.5px;
      color: var(--cx-chip-text);
      background: var(--cx-chip-bg);
      border-radius: 6px;
      padding: 1.5px 7px;
    }
    .v2cx-turn { padding: 10px 0; }
    .v2cx-turn + .v2cx-turn { border-top: 1px solid var(--cx-border-soft); }
    .v2cx-supplement { padding: 10px 0; }
    .v2cx-supplement .v2cx-cooked {
      font-size: 14px;
      line-height: 1.75;
      overflow-wrap: anywhere;
      padding: 10px 14px;
      border-left: 2px solid var(--cx-border-strong);
      border-radius: 0 8px 8px 0;
      background: var(--cx-wash);
    }
    .v2cx-turn-divider {
      text-align: center;
      font-size: 12px;
      color: var(--cx-text-faint);
      padding: 20px 0;
      border-top: 1px solid var(--cx-border-soft);
      border-bottom: 1px solid var(--cx-border-soft);
      margin: 12px 0;
    }

    /* 正文里的内容元素（链接 / 代码 / 图片 / 引用 / 列表） */
    .v2cx-cooked a, .v2cx-turn-user-bubble a { color: var(--cx-blue); text-decoration: none; }
    .v2cx-cooked a:hover, .v2cx-turn-user-bubble a:hover { text-decoration: underline; }
    /*
     * 正文图片默认渲染成小缩略图（V2EX 的 i.v2ex.co 没有 _thumb 变体，
     * 404 验证过，所以这里只能靠 CSS 约束尺寸 —— 好处是浏览器已经把原图下载过了，
     * 悬浮预览和灯箱都是零延迟）。
     */
    .v2cx-cooked img, .v2cx-turn-user-bubble img {
      max-width: var(--v2cx-thumb-w, 260px);
      max-height: var(--v2cx-thumb-h, 170px);
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
    .v2cx-cooked img:hover, .v2cx-turn-user-bubble img:hover {
      border-color: var(--cx-blue);
      box-shadow: 0 0 0 2px var(--cx-blue-soft);
    }
    /* 太小的图（表情、图标）不参与缩略/预览 */
    .v2cx-cooked img[data-no-preview="1"] { cursor: default; }

    /* 悬浮大图预览：fixed 定位，不参与文档流 → 不引起重排 */
    .v2cx-imgpreview {
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
    .v2cx-imgpreview.on { opacity: 1; visibility: visible; }
    /* 图还没到位时给个占位尺寸 + 居中提示，避免塌成小胶囊 */
    .v2cx-imgpreview.loading { min-width: 240px; min-height: 150px; }
    .v2cx-imgpreview.loading img { opacity: 0; }
    .v2cx-imgpreview .v2cx-ipv-load {
      display: none;
      position: absolute;
      inset: 0;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      color: var(--cx-text-faint);
    }
    .v2cx-imgpreview.loading .v2cx-ipv-load { display: flex; }
    .v2cx-imgpreview img {
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
    .v2cx-imgpreview .v2cx-ipv-cap {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 2px 1px;
      font-size: 11.5px;
      color: var(--cx-text-dim);
      white-space: nowrap;
      overflow: hidden;
    }
    .v2cx-imgpreview .v2cx-ipv-name {
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--cx-font-mono);
    }
    .v2cx-imgpreview .v2cx-ipv-size { flex: none; color: var(--cx-text-faint); }
    .v2cx-cooked code, .v2cx-turn-user-bubble code {
      font-family: var(--cx-font-mono);
      font-size: 12.5px;
      background: var(--cx-bg-inset);
      border: 1px solid var(--cx-border-soft);
      border-radius: 5px;
      padding: 1px 5px;
      color: var(--cx-text);
    }
    .v2cx-cooked pre, .v2cx-turn-user-bubble pre {
      background: var(--cx-bg-inset);
      border: 1px solid var(--cx-border-soft);
      border-radius: 8px;
      padding: 12px 14px;
      overflow-x: auto;
      margin: 10px 0;
    }
    .v2cx-cooked pre code, .v2cx-turn-user-bubble pre code {
      border: none; background: none; padding: 0;
      font-size: 12.5px; line-height: 1.6;
    }
    .v2cx-cooked blockquote, .v2cx-turn-user-bubble blockquote {
      margin: 10px 0;
      padding: 2px 0 2px 12px;
      border-left: 2px solid var(--cx-border-strong);
      color: var(--cx-text-secondary);
    }
    .v2cx-cooked ul, .v2cx-cooked ol,
    .v2cx-turn-user-bubble ul, .v2cx-turn-user-bubble ol { padding-left: 22px; margin: 8px 0; }
    .v2cx-cooked table, .v2cx-turn-user-bubble table {
      border-collapse: collapse;
      margin: 10px 0;
      font-size: 13px;
    }
    .v2cx-cooked th, .v2cx-cooked td,
    .v2cx-turn-user-bubble th, .v2cx-turn-user-bubble td {
      border: 1px solid var(--cx-border);
      padding: 5px 9px;
    }
    .v2cx-cooked hr, .v2cx-turn-user-bubble hr {
      border: none;
      border-top: 1px solid var(--cx-border);
      margin: 16px 0;
    }
    /* 原生 tiny 标签在深色下不可读，统一收敛 */
    .v2cx-cooked small, .v2cx-cooked .small,
    .v2cx-cooked .fade, .v2cx-cooked .gray, .v2cx-cooked .snow,
    .v2cx-turn-user-bubble small, .v2cx-turn-user-bubble .fade { color: var(--cx-text-dim) !important; }

    /* ================= 底部输入框（composer） ================= */
    /*
     * 移植自原脚本的 .codex-composer：悬浮在主区底部、居中、宽度跟正文一致、随分屏变窄。
     * 用绝对定位盖在滚动区上（对齐参考布局：正文从两侧透出、上方渐变淡出），
     * 所以 wrap 设 pointer-events:none，只有卡片本身可点，两侧空白仍能点到正文。
     */
    .v2cx-composer-wrap {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      padding: 8px 16px 14px;
      background: linear-gradient(to top, var(--cx-bg) 62%, transparent);
      pointer-events: none;
    }
    .v2cx-composer {
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
    .v2cx-main:not(.panel-hidden) .v2cx-composer { max-width: 500px; }

    .v2cx-compose-target {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--cx-text-dim);
      padding: 0 2px 6px;
    }
    /* 必须显式处理：作者样式里的 display:flex 会盖掉 [hidden] 的 UA display:none，
       否则未回复任何楼层时那个「×」会一直露在外面 */
    .v2cx-compose-target[hidden] { display: none; }
    .v2cx-compose-target > span {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .v2cx-compose-target > button {
      flex: none;
      border: none; background: none; cursor: pointer;
      color: var(--cx-text-faint);
      font-size: 14px; line-height: 1;
    }
    .v2cx-compose-target > button:hover { color: var(--cx-text); }

    .v2cx-md-edit {
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
    .v2cx-md-edit:not(.has-content)::before {
      content: attr(data-placeholder);
      position: absolute;
      color: var(--cx-text-faint);
      pointer-events: none;
    }

    /* 实时预览（md 渲染） */
    .v2cx-compose-preview {
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
    .v2cx-composer.preview-on .v2cx-compose-preview { display: block; }
    .v2cx-compose-preview h2,
    .v2cx-compose-preview h3 { margin: 4px 0; font-size: 1.15em; color: var(--cx-text); }
    .v2cx-compose-preview p { margin: 4px 0; }
    .v2cx-compose-preview code {
      font-family: var(--cx-font-mono);
      font-size: 12px;
      background: var(--cx-bg-inset);
      border-radius: 4px;
      padding: 1px 4px;
    }
    .v2cx-compose-preview pre {
      background: var(--cx-bg-inset);
      border-radius: 6px;
      padding: 8px 10px;
      overflow-x: auto;
      margin: 6px 0;
    }
    .v2cx-compose-preview pre code { background: none; padding: 0; }
    .v2cx-compose-preview blockquote {
      margin: 4px 0;
      padding: 1px 0 1px 9px;
      border-left: 3px solid var(--cx-border-strong);
    }
    .v2cx-compose-preview ul,
    .v2cx-compose-preview ol { margin: 4px 0; padding-left: 20px; }
    .v2cx-compose-preview a { color: var(--cx-blue); text-decoration: none; }
    .v2cx-compose-preview img { max-width: 100%; border-radius: 6px; }
    .v2cx-compose-preview hr { border: none; border-top: 1px solid var(--cx-border); margin: 8px 0; }

    .v2cx-composer-toolbar {
      display: flex;
      align-items: center;
      gap: 2px;
      padding-top: 8px;
      margin-top: 6px;
      border-top: 1px solid var(--cx-border-soft);
    }
    .v2cx-tool-btn {
      width: 28px; height: 28px;
      border-radius: 6px;
      display: grid; place-items: center;
      border: none; background: none;
      color: var(--cx-text-dim);
      cursor: pointer;
      font-family: var(--cx-font-ui);
      flex: none;
    }
    .v2cx-tool-btn:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .v2cx-tool-btn svg { width: 16px; height: 16px; }
    .v2cx-tool-btn > b,
    .v2cx-tool-btn > i,
    .v2cx-tool-btn > s { font-size: 14px; line-height: 1; }
    .v2cx-tool-btn > s { text-decoration-thickness: 1.5px; }
    .v2cx-tool-txt { font-size: 13px; font-weight: 600; line-height: 1; }
    .v2cx-tool-btn.on { color: var(--cx-blue); }
    .v2cx-composer-status {
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
    .v2cx-composer-status.ok { color: #52b36b; }
    .v2cx-composer-status.err { color: #e0626a; }
    .v2cx-send {
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
    .v2cx-send svg { width: 15px; height: 15px; }
    /* 空内容时给一个一眼能看出的失效态（只靠 opacity 在大屏上几乎看不出来） */
    .v2cx-send:disabled {
      background: var(--cx-chip-bg);
      color: var(--cx-text-faint);
      opacity: 0.75;
      cursor: default;
    }

    /* 「更多」小弹层（表格 / 分隔线 / 代码块 / 折叠） */
    .v2cx-plus-pop {
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
    .v2cx-plus-pop.on { display: block; }
    .v2cx-plus-pop button {
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
    .v2cx-plus-pop button:hover { background: var(--cx-btn-hover); color: var(--cx-text); }

    /* ================= 右侧代码面板（纯氛围装饰） ================= */
    .v2cx-code-panel {
      width: var(--v2cx-panel-w, 460px);
      flex: none;
      position: relative;
      background: var(--cx-panel-bg);
      border-left: 1px solid var(--cx-border-soft);
      display: flex;
      flex-direction: column;
      min-width: 0;
      font-family: var(--cx-font-ui);
    }
    .v2cx-code-tabs {
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
    .v2cx-code-tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 6px;
      background: var(--cx-bg-raised);
    }
    .v2cx-code-tab .v2cx-rs-ic { color: var(--cx-tok-k); font-weight: 600; font-size: 10.5px; }
    .v2cx-code-tab .v2cx-close { cursor: pointer; color: var(--cx-text-faint); font-size: 14px; line-height: 1; }
    .v2cx-code-tab .v2cx-close:hover { color: var(--cx-text); }
    .v2cx-code-add { color: var(--cx-text-faint); cursor: pointer; }
    .v2cx-code-tabs-actions { margin-left: auto; display: flex; gap: 2px; }
    .v2cx-code-tabs-actions .v2cx-icon-btn {
      padding: 4px; border-radius: 6px; cursor: pointer; color: var(--cx-text-dim);
      display: grid; place-items: center; border: none; background: none;
    }
    .v2cx-code-tabs-actions .v2cx-icon-btn:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .v2cx-code-tabs-actions svg { width: 14px; height: 14px; }

    .v2cx-code-crumb {
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
    .v2cx-code-crumb .v2cx-crumbs { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .v2cx-code-crumb .v2cx-cur { color: var(--cx-text); }
    .v2cx-code-crumb .v2cx-spacer { flex: 1; }
    .v2cx-code-view-toggle {
      display: flex;
      background: var(--cx-bg-inset);
      border-radius: 6px;
      padding: 2px;
      flex: none;
    }
    .v2cx-code-view-toggle span {
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11.5px;
    }
    .v2cx-code-view-toggle span.on { background: var(--cx-chip-bg); color: var(--cx-text); }
    .v2cx-open-btn {
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
    .v2cx-open-btn:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .v2cx-open-btn svg { width: 11px; height: 11px; }

    .v2cx-lang-menu {
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
    .v2cx-lang-menu.on { display: block; }
    .v2cx-lang-menu div {
      padding: 6px 10px;
      border-radius: 5px;
      font-size: 12.5px;
      cursor: pointer;
      color: var(--cx-text-secondary);
      display: flex;
      justify-content: space-between;
      gap: 10px;
    }
    .v2cx-lang-menu div:hover { background: var(--cx-wash); color: var(--cx-text); }
    .v2cx-lang-menu div.on { color: var(--cx-blue); }

    .v2cx-code-body {
      flex: 1;
      overflow: auto;
      padding: 10px 0 40px;
      font-family: var(--cx-font-mono);
      font-size: 12.5px;
      line-height: 1.65;
      color: var(--cx-code-text);
      scrollbar-width: thin;
    }
    .v2cx-code-body::-webkit-scrollbar { width: 8px; height: 8px; }
    .v2cx-code-body::-webkit-scrollbar-thumb { background: var(--cx-scroll-thumb); border-radius: 4px; }
    .v2cx-code-line { display: flex; white-space: pre; }
    .v2cx-code-line > .v2cx-ln {
      flex: none;
      width: 46px;
      text-align: right;
      padding-right: 14px;
      color: var(--cx-code-gutter);
      user-select: none;
      font-variant-numeric: tabular-nums;
    }
    .v2cx-code-line > .v2cx-src { padding-right: 20px; }
    .v2cx-code-line.add { background: var(--cx-diff-add-bg); }
    .v2cx-code-line.del { background: var(--cx-diff-del-bg); }
    .v2cx-code-line.hunk { background: var(--cx-diff-hunk-bg); }
    .v2cx-code-line.hunk .v2cx-src { color: var(--cx-diff-hunk-tx); }
    .v2cx-code-body .tk-k, .v2cx-boss-editor .tk-k { color: var(--cx-tok-k); }
    .v2cx-code-body .tk-s, .v2cx-boss-editor .tk-s { color: var(--cx-tok-s); }
    .v2cx-code-body .tk-c, .v2cx-boss-editor .tk-c { color: var(--cx-tok-c); font-style: italic; }
    .v2cx-code-body .tk-n, .v2cx-boss-editor .tk-n { color: var(--cx-tok-n); }
    .v2cx-code-body .tk-t, .v2cx-boss-editor .tk-t { color: var(--cx-tok-t); }

    /* ================= 图片灯箱 ================= */
    .v2cx-lightbox {
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
    .v2cx-lightbox img {
      max-width: 100%;
      max-height: 100%;
      border-radius: 10px;
      cursor: default;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
    }
    .v2cx-lightbox .v2cx-lb-open {
      position: fixed;
      right: 20px; bottom: 20px;
      font-size: 12.5px;
      color: #fff;
      background: rgba(255, 255, 255, 0.14);
      border-radius: 999px;
      padding: 6px 14px;
      text-decoration: none;
    }
    .v2cx-lightbox .v2cx-lb-open:hover { background: rgba(255, 255, 255, 0.24); }

    /* ================= 应急伪装视图（Esc Esc / Ctrl+Shift+H） =================
     *
     * 整个视口变成「代码编辑器 + 构建日志」，不露 rail、不露论坛内容。
     * 用的是同一套 token，所以从正常视图切过来像是同一个 IDE 里换了个面板，
     * 不会出现「网站突然变了」的观感。
     * ====================================================================== */
    html.${ROOT_CLASS}.v2cx-boss-on .v2cx-rail,
    html.${ROOT_CLASS}.v2cx-boss-on .v2cx-main { visibility: hidden !important; }

    .v2cx-boss {
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
    .v2cx-boss[hidden] { display: none; }

    .v2cx-boss-bar {
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
    .v2cx-boss-tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 6px 6px 0 0;
      color: var(--cx-text-dim);
      white-space: nowrap;
    }
    .v2cx-boss-tab.on { background: var(--cx-bg); color: var(--cx-text); }
    .v2cx-boss-tab .ic { font-size: 10.5px; font-weight: 600; color: var(--cx-tok-k); }
    .v2cx-boss-spacer { flex: 1; }
    .v2cx-boss-shell {
      flex: none;
      font-family: var(--cx-font-mono);
      font-size: 11.5px;
      color: var(--cx-text-faint);
      padding: 0 10px;
      white-space: nowrap;
    }

    .v2cx-boss-editor {
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
    .v2cx-boss-editor::-webkit-scrollbar { width: 10px; }
    .v2cx-boss-editor::-webkit-scrollbar-thumb { background: var(--cx-scroll-thumb); border-radius: 5px; }

    .v2cx-boss-term {
      flex: none;
      height: 34%;
      min-height: 150px;
      display: flex;
      flex-direction: column;
      border-top: 1px solid var(--cx-border);
      background: var(--cx-bg-inset);
    }
    .v2cx-boss-term-head {
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
    .v2cx-boss-term-body {
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
    .v2cx-boss-term-body::-webkit-scrollbar { width: 10px; }
    .v2cx-boss-term-body::-webkit-scrollbar-thumb { background: var(--cx-scroll-thumb); border-radius: 5px; }
    .v2cx-boss-term-body .ok { color: #52b36b; }
    .v2cx-boss-term-body .warn { color: #d3a03c; }
    .v2cx-boss-term-body .dim { color: var(--cx-text-faint); }
    .v2cx-boss-term-body .cmd { color: var(--cx-text); }
    .v2cx-boss-caret {
      display: inline-block;
      width: 7px;
      height: 14px;
      vertical-align: -2px;
      background: var(--cx-text-secondary);
      animation: v2cx-blink 1.1s steps(1) infinite;
    }
    @keyframes v2cx-blink { 0%, 50% { opacity: 1; } 50.01%, 100% { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .v2cx-boss-caret { animation: none; } }

    /* ---------- 楼中楼引用卡片 ---------- */
    .v2cx-quote {
      margin: 0 0 10px;
      border: 1px solid var(--cx-border);
      border-left: 3px solid var(--cx-border-strong);
      border-radius: 8px;
      background: var(--cx-wash);
      overflow: hidden;
    }
    .v2cx-quote-head {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 10px;
      font-size: 12px;
      color: var(--cx-text-dim);
      cursor: pointer;
      user-select: none;
    }
    .v2cx-quote-head:hover { color: var(--cx-text-secondary); }
    .v2cx-quote-ic { display: inline-flex; flex: none; }
    .v2cx-quote-ic svg { width: 13px; height: 13px; display: block; }
    .v2cx-quote-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .v2cx-quote-title b { color: var(--cx-text); font-weight: 600; }
    .v2cx-quote-jump {
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
    .v2cx-quote-jump:hover { background: var(--cx-btn-hover); color: var(--cx-blue); }
    .v2cx-quote-jump svg { width: 12px; height: 12px; }
    .v2cx-quote-chev { flex: none; font-size: 10px; color: var(--cx-text-faint); }
    .v2cx-quote.open .v2cx-quote-chev::after { content: "\25be"; }
    .v2cx-quote:not(.open) .v2cx-quote-chev::after { content: "\25b8"; }
    .v2cx-quote-body {
      padding: 8px 10px 9px;
      border-top: 1px solid var(--cx-border-soft);
      font-size: 13px;
      line-height: 1.65;
      color: var(--cx-text-secondary);
      overflow-wrap: anywhere;
    }
    .v2cx-quote:not(.open) .v2cx-quote-body { display: none; }
    /* 展开时长引用限个高度，超了内部滚动，别把整屏占满 */
    .v2cx-quote.open .v2cx-quote-body { max-height: 260px; overflow: auto; }
    .v2cx-quote-body img { display: none; }
    .v2cx-quote-img {
      display: inline-block;
      font-size: 11.5px;
      color: var(--cx-text-faint);
      background: var(--cx-chip-bg);
      border-radius: 5px;
      padding: 1px 6px;
      margin: 0 2px;
    }
    .v2cx-quote-body code {
      font-family: var(--cx-font-mono);
      font-size: 12px;
      background: var(--cx-bg-inset);
      border-radius: 4px;
      padding: 1px 4px;
    }
    /* 跳到源楼层时闪一下，方便定位 */
    .v2cx-turn.v2cx-flash { animation: v2cx-flash 1.2s ease-out; }
    @keyframes v2cx-flash {
      0%, 20% { background: var(--cx-blue-soft); }
      100% { background: transparent; }
    }

    /* ================= 设置面板 ================= */
    .v2cx-modal {
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
    .v2cx-modal[hidden] { display: none; }

    .v2cx-modal-card {
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
    .v2cx-modal-head {
      flex: none;
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 15px 18px 13px;
      border-bottom: 1px solid var(--cx-border-soft);
    }
    .v2cx-modal-title { font-size: 15px; font-weight: 600; }
    .v2cx-modal-sub { font-size: 11.5px; color: var(--cx-text-faint); }
    .v2cx-modal-x {
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
    .v2cx-modal-x:hover { background: var(--cx-btn-hover); color: var(--cx-text); }

    .v2cx-modal-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 4px 18px 14px;
      scrollbar-width: thin;
    }
    .v2cx-modal-body::-webkit-scrollbar { width: 8px; }
    .v2cx-modal-body::-webkit-scrollbar-thumb { background: var(--cx-scroll-thumb); border-radius: 4px; }

    .v2cx-set-section {
      margin: 18px 0 6px;
      font-size: 11.5px;
      font-weight: 600;
      letter-spacing: 0.5px;
      color: var(--cx-text-faint);
    }
    .v2cx-set-row {
      display: flex;
      align-items: flex-start;
      gap: 18px;
      padding: 9px 0;
      border-bottom: 1px solid var(--cx-border-soft);
    }
    .v2cx-set-row:last-child { border-bottom: none; }
    .v2cx-set-label { flex: 1; min-width: 0; font-size: 13px; }
    .v2cx-set-hint {
      margin-top: 3px;
      font-size: 11.5px;
      line-height: 1.5;
      color: var(--cx-text-faint);
    }
    .v2cx-set-ctrl {
      flex: none;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 132px;
      justify-content: flex-end;
    }
    .v2cx-set-val {
      min-width: 46px;
      text-align: right;
      font-size: 12px;
      color: var(--cx-text-dim);
      font-variant-numeric: tabular-nums;
      font-family: var(--cx-font-mono);
    }

    /* 开关 */
    .v2cx-switch {
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
    .v2cx-switch > span {
      position: absolute;
      top: 2px; left: 2px;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: var(--cx-text-dim);
      transition: transform 0.14s, background 0.14s;
    }
    .v2cx-switch.on { background: var(--cx-blue-soft); border-color: var(--cx-blue); }
    .v2cx-switch.on > span { transform: translateX(16px); background: var(--cx-blue); }
    .v2cx-switch:focus-visible { outline: 2px solid var(--cx-blue); outline-offset: 2px; }

    /* 滑块 */
    .v2cx-range {
      flex: 1;
      min-width: 110px;
      max-width: 190px;
      height: 22px;
      accent-color: var(--cx-blue);
      cursor: pointer;
    }
    /* 下拉 / 输入框 */
    .v2cx-select,
    .v2cx-text {
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
    .v2cx-select { max-width: 200px; }
    .v2cx-text { width: 160px; }
    .v2cx-text::placeholder { color: var(--cx-text-faint); }
    .v2cx-select:focus,
    .v2cx-text:focus { border-color: var(--cx-blue); }

    .v2cx-modal-foot {
      flex: none;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 18px;
      border-top: 1px solid var(--cx-border-soft);
      font-size: 11.5px;
      color: var(--cx-text-faint);
    }
    .v2cx-modal-btn {
      font-family: var(--cx-font-ui);
      font-size: 12.5px;
      color: var(--cx-text);
      background: var(--cx-chip-bg);
      border: 1px solid var(--cx-border-strong);
      border-radius: 999px;
      padding: 5px 14px;
      cursor: pointer;
    }
    .v2cx-modal-btn:hover { background: var(--cx-btn-hover); }

    /* ================= toast ================= */
    .v2cx-toast {
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
    .v2cx-toast.on { opacity: 1; transform: translate(-50%, 0); }

    /* ================= 窄屏降级：rail 收成抽屉 ================= */
    @media (max-width: 1160px) {
      html.${ROOT_CLASS} .v2cx-code-panel { display: none !important; }
      html.${ROOT_CLASS} .v2cx-main .v2cx-panel-toggle { display: none; }
      /* 面板被媒体查询藏了，但 .panel-hidden 类并未加上，
         所以这里要把「面板展开时收窄到 500px」那条规则盖回去。
         选择器权重必须高于 .v2cx-main:not(.panel-hidden) .v2cx-composer。 */
      html.${ROOT_CLASS} .v2cx-main .v2cx-composer { max-width: 600px; }
    }
    @media (max-width: 900px) {
      html.${ROOT_CLASS} .v2cx-rail {
        transform: translateX(-100%);
        transition: transform 0.2s ease;
      }
      html.${ROOT_CLASS}.v2cx-rail-open .v2cx-rail { transform: none; }
      html.${ROOT_CLASS} .v2cx-main { left: 0; }
      html.${ROOT_CLASS}:not(.${LOCK_CLASS}) #Wrapper { margin-left: 0 !important; }
      html.${ROOT_CLASS} .v2cx-topbar .v2cx-menu-btn { display: grid; }
      .v2cx-thread { padding: 20px 18px 160px; }
      .v2cx-turn-user-bubble { max-width: 100%; }
    }
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
          // 页面正在销毁 / 已进 bfcache 时 head 可能已经没了，直接跳过
          if (!document.head) return;
          const want = makeFaviconUri();
          const cur = document.getElementById(FAVICON_ID);
          if (want && (!cur || cur.getAttribute("href") !== want)) applyFavicon();
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

  /* ============================== 明暗模式 ============================== */

  function themeOverride() {
    if (cfg("theme") === "light" || cfg("theme") === "dark") return cfg("theme");
    const t = cfg("theme");
    return (t === "light" || t === "dark") ? t : null;
  }

  /**
   * 判定当前是否深色。
   * V2EX 3.x 的 night 模式通过 CSS 变量换肤（--box-background-color 等），
   * 没有稳定的 html class，所以这里优先读变量，再退回亮度测量。
   */
  function isDarkMode() {
    const want = themeOverride();
    if (want) return want === "dark";
    try {
      const rootStyle = getComputedStyle(document.documentElement);
      const vars = ["--box-background-color", "--box-foreground-color"];
      for (const v of vars) {
        const c = rootStyle.getPropertyValue(v).trim();
        const m = c.match(/^#([0-9a-f]{6})$/i);
        if (m) {
          const n = parseInt(m[1], 16);
          const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
          return v === "--box-background-color" ? lum < 128 : lum > 128;
        }
      }
    } catch { /* ignore */ }
    try {
      const bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
      const m = bg.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/);
      if (!m) return false;
      const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
      if (alpha < 0.5) return false;
      return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) < 128;
    } catch {
      return false;
    }
  }

  function syncMode() {
    document.documentElement.classList.toggle(LIGHT_CLASS, !isDarkMode());
  }

  function syncModeBtn() {
    const btn = document.querySelector(".v2cx-rail [data-mode-toggle]");
    if (!btn) return;
    const dark = isDarkMode();
    btn.innerHTML = dark ? ic("sun") : ic("moon");
    btn.title = dark ? "切换到光明模式" : "切换到黑暗模式";
  }

  /* ============================== 底部输入框（composer） ============================== */

  /*
   * 工具条图标。原脚本用的是 Font Awesome 6 的 path 数据（很长的 base64 风格串），
   * 这里改成手写的紧凑 SVG + 字母字形：
   *   - 文字格式类（粗体/强调/标题/删除线/有序列表）用字母，跟参考图一致；
   *   - 结构类（链接/引用/代码/列表/图片/表情/更多/预览）用简单几何路径。
   * 好处：体积从 ~6KB 降到 ~1KB，且不涉及第三方图标集的授权。
   */
  const TOOL_ICONS = {
    bold: `<b>B</b>`,
    italic: `<i>I</i>`,
    heading: `<span class="v2cx-tool-txt">H</span>`,
    strike: `<s>S</s>`,
    link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>`,
    quote: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.6 6.2C6.6 7.6 5 10 5 13.3V18h5.3v-5.3H7.9c0-2 .9-3.4 2.7-4.3L9.6 6.2Zm9 0C15.6 7.6 14 10 14 13.3V18h5.3v-5.3h-2.4c0-2 .9-3.4 2.7-4.3L18.6 6.2Z"/></svg>`,
    code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 7 4 12 9 17"/><polyline points="15 7 20 12 15 17"/></svg>`,
    listUl: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="9.5" y1="7" x2="20" y2="7"/><line x1="9.5" y1="12" x2="20" y2="12"/><line x1="9.5" y1="17" x2="20" y2="17"/><circle cx="5" cy="7" r="1.5" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="5" cy="17" r="1.5" fill="currentColor" stroke="none"/></svg>`,
    listOl: `<span class="v2cx-tool-txt">1.</span>`,
    image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="M4 17l4.5-4.2a1.6 1.6 0 0 1 2.2 0L15 17"/><path d="M14 15l1.8-1.6a1.6 1.6 0 0 1 2.2 0L21 16"/></svg>`,
    emoji: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8.6"/><path d="M8.6 14.2a4.2 4.2 0 0 0 6.8 0"/><circle cx="9.2" cy="9.8" r=".95" fill="currentColor" stroke="none"/><circle cx="14.8" cy="9.8" r=".95" fill="currentColor" stroke="none"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="8.6"/><path d="M12 8.4v7.2M8.4 12h7.2" stroke-linecap="round"/></svg>`,
    preview: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>`
  };

  const TOOL_TITLES = {
    bold: "粗体（Ctrl+B）",
    italic: "强调（Ctrl+I）",
    heading: "标题（循环 标题2→3→4→正文）",
    strike: "删除线",
    link: "链接",
    quote: "块引用",
    code: "代码（选中多行自动围栏）",
    listUl: "无序列表",
    listOl: "有序列表",
    image: "图片（插入 Markdown 图片语法）",
    emoji: "表情符号",
    plus: "更多（表格 / 分隔线 / 代码块 / 折叠）",
    preview: "实时预览"
  };

  const TOOL_SEQ = [
    "bold", "italic", "heading", "strike", "link", "quote", "code",
    "listUl", "listOl", "image", "emoji", "plus", "preview"
  ];

  const EMOJIS = [
    "\ud83d\ude00", "\ud83d\ude04", "\ud83d\ude02", "\ud83d\ude05", "\ud83d\ude0a", "\ud83d\ude0d", "\ud83e\udd14", "\ud83d\ude10",
    "\ud83d\ude2d", "\ud83d\ude22", "\ud83d\ude24", "\ud83e\udd2f", "\ud83d\ude31", "\ud83d\ude0e", "\ud83e\udd18", "\ud83d\udc4d",
    "\ud83d\udc4e", "\ud83d\ude4f", "\ud83d\udc4c", "\ud83d\udc40", "\ud83e\udd79", "\ud83d\udc4f", "\ud83c\udf89", "\u2764\ufe0f",
    "\ud83d\udd25", "\u2705", "\u274c", "\u26a0\ufe0f", "\ud83d\udca1", "\ud83d\udcda", "\ud83d\ude80", "\u2615"
  ];

  const PLUS_ITEMS = [
    { label: "表格", snippet: "| 列 1 | 列 2 |\n| --- | --- |\n|  |  |" },
    { label: "分隔线", snippet: "\n---\n" },
    { label: "代码块", snippet: "```\n\n```" },
    { label: "折叠", snippet: "[details=点击展开]\n\n[/details]" }
  ];

  function composerToolbarHtml() {
    return TOOL_SEQ.map((k) =>
      `<button type="button" class="v2cx-tool-btn" data-tool="${k}" title="${escapeHtml(TOOL_TITLES[k])}">${TOOL_ICONS[k]}</button>`
    ).join("") +
      `<span class="v2cx-composer-status"></span>` +
      `<button type="button" class="v2cx-send" data-send title="发送（Enter）" disabled>${ic("send")}</button>`;
  }

  /* ============================== 解析上下文（页面数据） ============================== */

  /** 每次渲染前重新解析一次原生 DOM；原生 DOM 始终保留，所以可重复解析 */
  function collectPage() {
    const r = route();
    const data = {
      route: r,
      user: currentUser(document),
      list: null,
      topic: null,
      nodeHeader: null,
      memberHeader: null,
      planes: null,
      hot: parse.hotTopics(document),
      pagination: null
    };
    if (r.kind === "list") {
      data.list = parse.listRows(document);
      data.pagination = parse.pagination(document);
      data.nodeHeader = r.listKind === "node" ? parse.nodeHeader(document) : null;
    } else if (r.kind === "topic") {
      data.topic = parse.topic(document);
      data.list = parse.listRows(document); // 侧栏「相关」之类，可能为空
    } else if (r.kind === "member") {
      data.list = parse.listRows(document);
      data.memberHeader = parse.memberHeader(document);
      data.pagination = parse.pagination(document);
    } else if (r.kind === "planes") {
      const p = parse.planes(document);
      data.planes = p.groups;
      data.planesTotal = p.total;
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

  function a(href, className, html) {
    const node = document.createElement("a");
    node.href = href;
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  /** 清掉原生正文里可能干扰的元素（脚本、广告占位） */
  function cleanContent(html) {
    if (!html) return "";
    return String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<ins\b[^>]*class="adsbygoogle"[^>]*>[\s\S]*?<\/ins>/gi, "")
      .replace(/\son\w+="[^"]*"/gi, "");
  }

  /* ============================== 左 rail ============================== */

  let quickNodesExpanded = false;

  function ensureRail(page) {
    let rail = document.querySelector(".v2cx-rail");
    if (!rail) {
      rail = el("div", "v2cx-rail");
      document.body.appendChild(rail);
    }
    renderRail(rail, page);
    return rail;
  }

  function renderRail(rail, page) {
    const r = page.route;
    const onNode = r.kind === "list" && r.listKind === "node" ? "/go/" + r.node : "";
    const onTab = r.kind === "list" && r.listKind === "tab" ? r.tab : "";

    /*
     * 顶部导航与「版块」列表指向同一批路由，必须保证同时只有一项高亮：
     *   - 「最热」从版块里提到顶部导航（版块列表里就不再渲染它）
     *   - 版块的高亮用「显式 ?tab=」判断：直接访问 / 时只点亮「首页」，
     *     否则 / 会同时点亮「首页」和「技术」。
     */
    const activeKey =
      r.kind === "planes" ? "planes" :
      r.kind === "list" && r.listKind === "recent" ? "recent" :
      (r.kind === "list" && r.listKind === "tab" && r.explicitTab === "hot") ? "hot" :
      (r.kind === "list" && r.listKind === "tab" && !r.explicitTab) ? "home" : "";

    // 顶栏（traffic lights + 品牌）
    rail.innerHTML = `
      <div class="v2cx-rail-traffic">
        <span data-rail-drawer-close title="收起侧栏">${ic("sidebar")}</span>
      </div>
      <div class="v2cx-rail-brand">
        <a class="v2cx-rail-brand-name" href="/">${escapeHtml(brandName())} ${ic("chevronDown")}</a>
        <div class="v2cx-rail-brand-actions">
          <span data-rail-search title="搜索">${ic("search")}</span>
          <span class="v2cx-rail-bell" title="通知" data-rail-notif>${ic("bell")}</span>
        </div>
      </div>
    `;

    const scroll = el("div", "v2cx-rail-scroll");
    rail.appendChild(scroll);

    // —— 导航 ——
    const nav = el("nav", "v2cx-rail-nav");
    const navItem = (href, icon, label, active) =>
      `<a class="v2cx-rail-item${active ? " active" : ""}" href="${escapeHtml(href)}">${icon}<span class="v2cx-label">${escapeHtml(label)}</span></a>`;
    nav.innerHTML = [
      navItem("/", ic("home"), "首页", activeKey === "home"),
      navItem("/recent", ic("clock"), "最近", activeKey === "recent"),
      navItem("/planes", ic("layers"), "全部节点", activeKey === "planes"),
      navItem("/?tab=hot", ic("fire"), "最热", activeKey === "hot")
    ].join("");
    scroll.appendChild(nav);

    // —— 版块（tab）——
    // 列表保留完整版块（含「技术」）以免看起来像漏了项；
    // 只有「最热」从列表里拿掉，因为它已经提到顶部导航，会出现两个入口。
    // 高亮按 URL 里的显式 ?tab= 判定：直接访问 / 时点亮「首页」而不是「技术」，
    // 保证任何时刻整条 rail 只有一项 active。
    const railTabs = TABS.filter((t) => t.key !== "hot");
    const tabBox = el("div", "v2cx-rail-section-items");
    tabBox.innerHTML = railTabs.map((t) =>
      `<a class="v2cx-rail-item${r.explicitTab === t.key ? " active" : ""}" href="/?tab=${t.key}">` +
      `${ic("folder")}<span class="v2cx-label">${escapeHtml(t.label)}</span></a>`
    ).join("");
    scroll.appendChild(el("div", "v2cx-rail-section", `<span>版块</span>`));
    scroll.appendChild(tabBox);

    // —— 常用节点 ——
    // 当前节点不在常用列表里时把它插到最前面，
    // 这样 rail 总能反映「你现在在哪」（否则 /go/xxx 会完全无高亮）。
    const nodes = QUICK_NODES.slice();
    if (onNode && !nodes.some((n) => "/go/" + n.name === onNode)) {
      const label = page.nodeHeader && page.nodeHeader.name ? page.nodeHeader.name : r.node;
      nodes.unshift({ name: r.node, label });
    }
    const shownNodes = quickNodesExpanded ? nodes : nodes.slice(0, 8);
    const nodeBox = el("div", "v2cx-rail-section-items");
    nodeBox.innerHTML = shownNodes.map((n) =>
      `<a class="v2cx-rail-item${onNode === "/go/" + n.name ? " active" : ""}" href="/go/${n.name}">` +
      `${ic("tag")}<span class="v2cx-label">${escapeHtml(n.label)}</span></a>`
    ).join("");
    scroll.appendChild(el("div", "v2cx-rail-section",
      `<span>常用节点</span><span class="v2cx-more" data-rail-nodes-toggle>${quickNodesExpanded ? "收起" : "全部"}</span>`));
    scroll.appendChild(nodeBox);

    // —— 本页话题（当前页解析出的线程，模拟 Codex 的线程列表）——
    const rows = page.list || [];
    if (rows.length) {
      const max = 12;
      const box = el("div", "v2cx-rail-section-items");
      box.innerHTML = rows.slice(0, max).map((t) =>
        `<a class="v2cx-rail-item" href="${escapeHtml(t.url)}" title="${escapeHtml(t.title)}">` +
        `<span class="v2cx-label">${escapeHtml(t.title)}</span>` +
        (t.replies && t.replies !== "0" ? `<span class="v2cx-count">${escapeHtml(t.replies)}</span>` : "") +
        `</a>`
      ).join("");
      scroll.appendChild(el("div", "v2cx-rail-section", `<span>本页话题</span>`));
      scroll.appendChild(box);
    }

    // —— 当前话题的标签 ——
    if (page.topic && page.topic.tags.length) {
      const box = el("div", "v2cx-rail-section-items");
      box.innerHTML = page.topic.tags.map((t) =>
        `<a class="v2cx-rail-item" href="${escapeHtml(t.url)}">${ic("tag")}<span class="v2cx-label">#${escapeHtml(t.label)}</span></a>`
      ).join("");
      scroll.appendChild(el("div", "v2cx-rail-section", `<span>标签</span>`));
      scroll.appendChild(box);
    }

    // —— 今日热榜（来自首页右栏 TopicsHot）——
    if (page.hot && page.hot.length) {
      const box = el("div", "v2cx-rail-section-items");
      box.innerHTML = page.hot.slice(0, 6).map((t) =>
        `<a class="v2cx-rail-item" href="${escapeHtml(t.url)}" title="${escapeHtml(t.title)}">` +
        `${ic("fire")}<span class="v2cx-label">${escapeHtml(t.title)}</span></a>`
      ).join("");
      scroll.appendChild(el("div", "v2cx-rail-section", `<span>今日热榜</span>`));
      scroll.appendChild(box);
    }

    // —— 底部：用户 / 明暗 ——
    const foot = el("div", "v2cx-rail-foot");
    const userHtml = page.user
      ? `<a class="v2cx-rail-foot-user" href="${escapeHtml(page.user.url)}" title="${escapeHtml(page.user.name)}">
           ${ic("user")}<span class="v2cx-label">${escapeHtml(page.user.name)}</span></a>`
      : `<a class="v2cx-rail-foot-user" href="/signin" title="登录">${ic("user")}<span class="v2cx-label">未登录 · Sign In</span></a>`;
    foot.innerHTML = `${userHtml}<button class="v2cx-mode-btn" data-mode-toggle title="切换明暗模式"></button>`;
    rail.appendChild(foot);

    // 右缘拖拽把手
    const rz = el("div", "v2cx-resizer");
    rz.dataset.resize = "rail";
    rz.title = "拖拽调整侧栏宽度";
    rail.appendChild(rz);

    // 事件
    rail.querySelector("[data-rail-nodes-toggle]")?.addEventListener("click", (e) => {
      e.preventDefault();
      quickNodesExpanded = !quickNodesExpanded;
      renderRail(rail, page);
    });
    rail.querySelector("[data-mode-toggle]")?.addEventListener("click", () => {
      setCfg("theme", isDarkMode() ? "light" : "dark", { visualOnly: true });
      syncMode();
      applyFavicon();
      syncModeBtn();
    });
    rail.querySelector("[data-rail-search]")?.addEventListener("click", openSearch);
    rail.querySelector("[data-rail-notif]")?.addEventListener("click", () => {
      // 未登录 → 去登录页；已登录 → 原生通知中心
      location.href = page.user ? "/notifications" : "/signin";
    });
    rail.querySelector("[data-rail-drawer-close]")?.addEventListener("click", () => {
      document.documentElement.classList.remove("v2cx-rail-open");
    });

    syncModeBtn();
  }

  /* ============================== 搜索 ============================== */

  /**
   * V2EX 站内搜索是 POST + CSRF 的，没有可用的 GET 端点
   * （/search?q=xxx 会 302 到 /go/search 并丢掉 query）。
   * 站点自己的前端在同样场景下也是回退到 site:v2ex.com 的 Google 搜索，
   * 这里沿用官方行为，避免自造不可用的搜索请求。
   */
  function openSearch() {
    const q = window.prompt("搜索 V2EX（回车打开结果）", "");
    if (!q) return;
    const url = "https://www.google.com/search?q=" +
      encodeURIComponent("site:v2ex.com/t ") + encodeURIComponent(q);
    window.open(url, "_blank", "noopener");
  }

  /* ============================== 主区骨架 ============================== */

  function ensureMain() {
    let main = document.querySelector(".v2cx-main");
    if (main) return main;

    main = el("main", "v2cx-main");
    main.innerHTML = `
      <div class="v2cx-thread-col">
        <header class="v2cx-topbar">
          <button class="v2cx-icon-btn v2cx-menu-btn" title="打开侧栏">${ic("menu")}</button>
          <a class="v2cx-icon-btn" href="/" title="返回列表">${ic("folder")}</a>
          <div class="v2cx-crumb">
            <span class="v2cx-proj"></span>
            <span class="v2cx-sep">/</span>
            <span class="v2cx-model"></span>
          </div>
          <div class="v2cx-spacer"></div>
          <div class="v2cx-icon-btn" data-settings-open title="设置（Ctrl+,）">${ic("gear")}</div>
          <div class="v2cx-icon-btn v2cx-panel-toggle" data-panel-toggle title="显示 / 隐藏代码面板">${ic("panel")}</div>
          <a class="v2cx-icon-btn" href="${escapeHtml(location.href)}" target="_blank" rel="noopener" title="在原生界面打开">${ic("external")}</a>
          <div class="v2cx-icon-btn" title="复制当前链接" data-copy-link>${ic("dots")}</div>
        </header>
        <div class="v2cx-thread">
          <div class="v2cx-thread-inner"></div>
        </div>
        <div class="v2cx-composer-wrap">
          <div class="v2cx-composer">
            <div class="v2cx-compose-target" hidden><span></span><button type="button" title="取消回复">×</button></div>
            <div class="v2cx-md-edit" data-compose contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="写点什么…"></div>
            <div class="v2cx-compose-preview" aria-live="polite"></div>
            <div class="v2cx-composer-toolbar">${composerToolbarHtml()}</div>
            <div class="v2cx-plus-pop" data-plus-pop>${PLUS_ITEMS.map((p, i) =>
              `<button type="button" data-plus-item="${i}">${escapeHtml(p.label)}</button>`).join("")}</div>
          </div>
        </div>
      </div>
      <aside class="v2cx-code-panel">
        <div class="v2cx-resizer" data-resize="panel" title="拖拽调整分栏宽度（双击重置）"></div>
        <div class="v2cx-code-tabs">
          <div class="v2cx-code-tab">
            <span class="v2cx-rs-ic" data-code-icon>RS</span>
            <span data-code-file-name>lib.rs</span>
            <span class="v2cx-close" title="关闭代码面板">×</span>
          </div>
          <span class="v2cx-code-add" title="新建标签（装饰）">＋</span>
          <div class="v2cx-code-tabs-actions">
            <span class="v2cx-icon-btn" title="放大（装饰）">${ic("expand")}</span>
            <span class="v2cx-icon-btn" title="分栏（装饰）">${ic("panel")}</span>
            <span class="v2cx-icon-btn" data-panel-toggle2 title="关闭面板">${ic("sidebar")}</span>
          </div>
        </div>
        <div class="v2cx-code-crumb">
          <div class="v2cx-crumbs">
            <span class="v2cx-seg" data-code-crumb-root>v2ex</span> ›
            <span class="v2cx-seg" data-code-crumb-cat>topics</span> ›
            <span class="v2cx-seg" data-code-crumb-dir>engine</span> ›
            <span class="v2cx-cur" data-code-crumb-file>lib.rs</span>
          </div>
          <span class="v2cx-spacer"></span>
          <div class="v2cx-code-view-toggle" data-code-view-toggle>
            <span class="on" data-v="code">代码</span><span data-v="diff">diff</span>
          </div>
          <button class="v2cx-open-btn" data-lang-menu-btn>
            <span data-lang-label>Rust</span>${ic("chevronDown")}
          </button>
        </div>
        <div class="v2cx-code-body" data-code-body></div>
        <div class="v2cx-lang-menu" data-lang-menu></div>
      </aside>
    `;
    document.body.appendChild(main);

    // 事件绑定
    main.addEventListener("click", (e) => {
      const t = e.target;

      if (t.closest(".v2cx-menu-btn")) {
        document.documentElement.classList.toggle("v2cx-rail-open");
        return;
      }
      if (t.closest("[data-copy-link]")) {
        copyText(location.href);
        return;
      }
      if (t.closest("[data-panel-toggle]") || t.closest("[data-panel-toggle2]") ||
        t.closest(".v2cx-code-tab .v2cx-close")) {
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
      if (t.closest(".v2cx-filter-btn")) {
        main.classList.toggle("filters-open");
        return;
      }
      // 引用卡片：跳到源楼层（点在按钮上时不折叠）
      const jump = t.closest("[data-jump-floor]");
      if (jump) {
        e.preventDefault();
        jumpToFloor(jump.dataset.jumpFloor);
        return;
      }
      // 引用卡片展开 / 折叠
      const quoteHead = t.closest(".v2cx-quote-head");
      if (quoteHead) {
        quoteHead.closest(".v2cx-quote")?.classList.toggle("open");
        return;
      }

      // 思考块展开 / 折叠
      const thinkHead = t.closest(".v2cx-think-head");
      if (thinkHead) {
        thinkHead.closest(".v2cx-think")?.classList.toggle("open");
        return;
      }

      // 楼层操作：回复 / 赞 / 收藏 / 复制链接
      const act = t.closest("[data-act]");
      if (act) {
        handleTurnAction(act);
        return;
      }
      // 感谢 / 反对：直接调 V2EX 自己的全局函数（原生 DOM 保留着，所以它们还在）
      const vote = t.closest("[data-vote]");
      if (vote) {
        const id = num(vote.dataset.topic);
        const up = vote.dataset.vote === "up";
        const fn = up ? window.upVoteTopic : window.downVoteTopic;
        if (typeof fn === "function" && id) {
          try {
            fn(id);
            toastNow(up ? "已感谢" : "已标记");
          } catch {
            toastNow("操作失败，试试原生页面");
          }
        } else {
          toastNow("原生脚本未就绪，已打开原生页面");
          window.open(location.href, "_blank", "noopener");
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

    // 节点页筛选
    main.addEventListener("input", (e) => {
      const f = e.target.closest("[data-node-filter]");
      if (!f) return;
      const q = String(f.value || "").trim().toLowerCase();
      let total = 0;
      main.querySelectorAll("[data-node-group]").forEach((g) => {
        let visible = 0;
        g.querySelectorAll("[data-node-item]").forEach((item) => {
          const hay = (item.textContent + " " + (item.getAttribute("href") || "")).toLowerCase();
          const hit = !q || hay.includes(q);
          item.style.display = hit ? "" : "none";
          if (hit) visible++;
        });
        g.style.display = visible ? "" : "none";
        total += visible;
      });
      const empty = main.querySelector("[data-node-empty]");
      if (empty) empty.style.display = total ? "none" : "";
    });

    // 点击面板外收起语言菜单
    document.addEventListener("click", (e) => {
      const menu = document.querySelector("[data-lang-menu]");
      if (!menu || !menu.classList.contains("on")) return;
      if (e.target.closest("[data-lang-menu]") || e.target.closest("[data-lang-menu-btn]")) return;
      menu.classList.remove("on");
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
    return document.querySelector(".v2cx-main .v2cx-thread-inner");
  }

  function syncChrome(page) {
    const main = document.querySelector(".v2cx-main");
    if (!main) return;
    const r = page.route;
    const proj = main.querySelector(".v2cx-proj");
    const model = main.querySelector(".v2cx-model");

    if (r.kind === "topic" && page.topic) {
      proj.textContent = page.topic.node ? page.topic.node.name : "话题";
      model.textContent = `${page.topic.title} · ${page.topic.repliesCount} 回复`;
      model.title = page.topic.title; // 截断时悬停看全称
    } else if (r.kind === "list") {
      const t = page.nodeHeader ? (page.nodeHeader.breadcrumb || listTitle(r)) : listTitle(r);
      proj.textContent = r.listKind === "node" ? (page.nodeHeader ? page.nodeHeader.name || r.node : r.node) : "V2EX";
      model.textContent = `${t} · ${(page.list || []).length} 个话题`;
    } else if (r.kind === "member" && page.memberHeader) {
      proj.textContent = "会员";
      model.textContent = page.memberHeader.username;
    } else if (r.kind === "planes") {
      proj.textContent = "V2EX";
      model.textContent = "全部节点";
    }
    syncComposer(page);
  }

  function render() {
    const page = collectPage();
    PAGE = page;
    const r = page.route;
    syncTitle();

    if (!isSupported(r)) {
      // 不接管：只保留 rail，原生页面照旧
      document.documentElement.classList.remove(LOCK_CLASS);
      document.querySelector(".v2cx-main")?.remove();
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

    if (r.kind === "topic") renderDetail(inner, page);
    else if (r.kind === "member") renderMember(inner, page);
    else if (r.kind === "planes") renderPlanes(inner, page);
    else renderList(inner, page);

    // 分页状态（列表 & 主题共用；由各 render 设置）
    renderCodePanel();
  }

  /* ---------- 列表视图 ---------- */

  function rowHtml(t) {
    // 副行对齐参考布局：分类 · 最后回复者（不是「…最后回复…」那种论坛腔）
    const who = t.lastReplyBy || t.author || "";
    const sub = [];
    if (t.node) sub.push('<span class="v2cx-node">#' + escapeHtml(t.node.name) + "</span>");
    if (who) sub.push("<span>@" + escapeHtml(who) + "</span>");
    // 状态圆点代替头像（列表行左侧只留一个小标记）
    const hasReplies = num(t.replies) > 0;
    return '<a class="v2cx-row" href="' + escapeHtml(t.url) + '" title="' +
      escapeHtml(t.title + (t.author ? "  ·  由 " + t.author + " 发布" : "")) + '">' +
      '<span class="v2cx-row-avatar' + (hasReplies ? " has-replies" : "") + '"></span>' +
      '<span class="v2cx-row-texts">' +
      '<span class="v2cx-row-title">' + escapeHtml(t.title) + "</span>" +
      '<span class="v2cx-row-sub">' + sub.join("") + "</span>" +
      "</span>" +
      '<span class="v2cx-row-meta">' +
      '<span class="v2cx-replies">' + escapeHtml(t.replies) + " 回复</span>" +
      '<span class="v2cx-time">' + escapeHtml(formatTime(t.timeIso) || t.timeText || "") + "</span>" +
      "</span>" +
      "</a>";
  }

  /**
   * 列表里的 agent 痕迹。列表页是最容易被一眼看穿的地方，
   * 所以在行与行之间按种子插入「思考行 / 工具调用行」，
   * 让整页读起来像一份 agent 会话日志，而不是论坛帖子流。
   *
   * 密度刻意压低（每行之间最多一条，且大部分位置仍是普通分隔线）：
   * 太密会盖住标题，反而更奇怪。
   */
  function listTraceHtml(t, idx, avoidRun) {
    const sep = { html: '<div class="v2cx-row-sep"></div>', run: avoidRun };
    if (!cfg("decorations")) return sep;
    const rate = Math.max(0, Math.min(100, Number(cfg("listTraceRate")) || 0));
    if (rate <= 0) return sep;

    const rnd = mulberry32((((idx + 1) * 2654435761) ^ Number(t.id || 0)) >>> 0);
    const roll = rnd() * 100;
    if (roll >= rate) return sep;
    // 半数位置放思考块，半数放工具调用行
    if (roll < rate / 2) {
      return { html: thinkingHtml(rnd, !!cfg("listThinkingOpen")), run: avoidRun };
    }
    const r = runlineParts(rnd, avoidRun);
    return { html: r.html, run: r.idx };
  }

  /** 把行和痕迹穿插成一段 HTML */
  function listRowsHtml(rows) {
    const out = [];
    let lastRun = -1; // 跨行跟踪，避免连续两条一样的工具调用
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

  function cardHtml(page) {
    const r = page.route;
    if (r.kind === "list" && page.nodeHeader) {
      const n = page.nodeHeader;
      return `
        <div class="v2cx-card">
          ${n.avatar ? `<img src="${escapeHtml(n.avatar)}" alt="">` : ""}
          <div class="v2cx-card-main">
            <div class="v2cx-card-title"><h1>${escapeHtml(n.name || r.node)}</h1></div>
            <div class="v2cx-card-sub">${escapeHtml(n.breadcrumb || "")}${
              n.topicCount ? ` · ${n.topicCount} 个主题` : ""}</div>
            ${n.intro ? `<div class="v2cx-card-intro">${escapeHtml(n.intro)}</div>` : ""}
            <div class="v2cx-card-links">
              <a class="v2cx-pill" href="/feed/${escapeHtml(r.node)}.xml" target="_blank" rel="noopener">RSS</a>
              <a class="v2cx-pill" href="/go/${escapeHtml(r.node)}?p=1">最新</a>
              <a class="v2cx-pill" href="https://www.v2ex.com${escapeHtml(r.path)}" target="_blank" rel="noopener">原生页面</a>
            </div>
          </div>
        </div>`;
    }
    return "";
  }

  function renderList(inner, page) {
    const r = page.route;
    const rows = page.list || [];
    MORE_PAGE = page.pagination ? page.pagination.current : 1;
    MORE_URL = page.pagination ? page.pagination.next : null;

    const title = r.listKind === "node"
      ? (page.nodeHeader ? (page.nodeHeader.name || r.node) : r.node)
      : listTitle(r);

    const desc = r.listKind === "node"
      ? (page.nodeHeader && page.nodeHeader.intro ? page.nodeHeader.intro : `共 ${rows.length} 个已加载话题`)
      : (r.listKind === "recent" ? "全站最新发布的主题"
        : r.listKind === "tag" ? `标签 ${r.tag} 下的主题`
          : `V2EX 版块 · ${rows.length} 个已加载话题`);

    const chips = TABS.map((t) =>
      `<a class="v2cx-fchip${r.listKind === "tab" && r.tab === t.key ? " on" : ""}" href="/?tab=${t.key}">${escapeHtml(t.label)}</a>`
    ).join("");

    inner.innerHTML = `
      ${cardHtml(page)}
      <div class="v2cx-head">
        <div class="v2cx-head-title">
          <button class="v2cx-filter-btn" title="展开 / 收起版块">${ic("filter")}</button>
          <h1>${escapeHtml(title)}</h1>
        </div>
        <a class="v2cx-new-topic-btn" href="/new" title="发布新主题">${ic("plus")}新主题</a>
      </div>
      <div class="v2cx-filter-row">${chips}</div>
      <div class="v2cx-head-desc">${escapeHtml(desc)}</div>
      <div class="v2cx-rows">${listRowsHtml(rows)}</div>
      <div class="v2cx-list-status${MORE_URL ? " link" : ""}" ${MORE_URL ? 'data-more="list"' : ""}>${
        rows.length ? (MORE_URL ? `点击加载更多（第 ${MORE_PAGE + 1} 页）` : "没有更多了") : "这个话题列表是空的"}</div>
    `;
  }

  /* ---------- 会员页 ---------- */

  function renderMember(inner, page) {
    const m = page.memberHeader;
    const rows = page.list || [];
    MORE_PAGE = page.pagination ? page.pagination.current : 1;
    MORE_URL = page.pagination ? page.pagination.next : null;

    if (!m) {
      inner.innerHTML = `<div class="v2cx-list-status">没能解析出会员信息</div>`;
      return;
    }

    inner.innerHTML = `
      <div class="v2cx-card">
        ${m.avatar ? `<img src="${escapeHtml(m.avatar)}" alt="">` : ""}
        <div class="v2cx-card-main">
          <div class="v2cx-card-title">
            <h1>${escapeHtml(m.username)}</h1>
            ${m.online ? `<span class="v2cx-pill on">ONLINE</span>` : ""}
          </div>
          <div class="v2cx-card-sub">${escapeHtml(m.bio || "")}</div>
          ${m.widgets.length ? `<div class="v2cx-card-links">${m.widgets.map((w) =>
            `<a class="v2cx-pill" href="${escapeHtml(w.url)}" target="_blank" rel="noopener nofollow">${escapeHtml(w.label)}</a>`
          ).join("")}</div>` : ""}
          ${m.tabs.length ? `<div class="v2cx-card-links">${m.tabs.map((t) =>
            `<a class="v2cx-pill${t.active ? " on" : ""}" href="${escapeHtml(t.url)}">${escapeHtml(t.label)}</a>`
          ).join("")}</div>` : ""}
        </div>
      </div>
      <div class="v2cx-head"><div class="v2cx-head-title"><h1>主题</h1></div></div>
      <div class="v2cx-head-desc">共 ${rows.length} 个已加载主题</div>
      <div class="v2cx-rows">${listRowsHtml(rows)}</div>
      <div class="v2cx-list-status${MORE_URL ? " link" : ""}" ${MORE_URL ? 'data-more="list"' : ""}>${
        rows.length ? (MORE_URL ? `点击加载更多（第 ${MORE_PAGE + 1} 页）` : "没有更多了") : "暂无主题"}</div>
    `;
  }

  /* ---------- 全部节点 ---------- */

  function renderPlanes(inner, page) {
    const groups = page.planes || [];
    const total = page.planesTotal || groups.reduce((n, g) => n + g.links.length, 0);

    inner.innerHTML = `
      <div class="v2cx-head">
        <div class="v2cx-head-title"><h1>全部节点</h1></div>
        <a class="v2cx-new-topic-btn" href="/planes" target="_blank" rel="noopener">${ic("external")}原生页面</a>
      </div>
      <div class="v2cx-head-desc">${total} 个节点 · ${groups.length} 个位面</div>
      <input class="v2cx-search-input" data-node-filter type="search" placeholder="筛选节点（名称或 slug）…" autocomplete="off">
      ${groups.map((g) => `
        <div data-node-group>
          <div class="v2cx-head" style="margin-top:18px">
            <div class="v2cx-head-title"><h1 style="font-size:14px">${escapeHtml(g.group)}</h1></div>
            <span class="v2cx-head-desc" style="margin:0">${escapeHtml(g.meta || g.links.length + " nodes")}</span>
          </div>
          <div class="v2cx-card-links">${g.links.map((l) =>
            `<a class="v2cx-pill" data-node-item href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`
          ).join("")}</div>
        </div>
      `).join("")}
      <div class="v2cx-list-status" data-node-empty style="display:none">没有匹配的节点</div>
    `;
  }

  /* ============================== 楼层伪装装饰 ==============================
   *
   * 这一段是给「上班摸鱼」用的核心伪装：
   *   1. 每条回复顶部混入一个 agent 思考块（✻ Worked for 27s），可折叠；
   *   2. 部分回复里穿插淡色的「工具调用」行（Running command / Applied changes…）；
   *   3. 鼠标停在楼层上时，右侧浮出操作胶囊（回复 / 赞 / 收藏 / 复制链接）。
   * 全部按 (话题 id, 楼层号) 播种，同一楼层每次刷新长得一样，不会闪。
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
    "Reproducing it locally would settle half of this thread instantly.",
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
    "Two people in this thread are describing the same symptom with different vocabularies."
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
    "Closing with a single question keeps the thread productive.",
    "That's enough analysis — the practical next step is obvious.",
    "I'll point at the trade-off and let them decide; it's their system."
  ];

  /** 楼内穿插的「工具调用」行（纯装饰，英文对齐 Codex CLI） */
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

  /** 每个楼层一个稳定种子：同一话题同一楼层永远得到同一套装饰 */
  function turnSeed(topicId, floor) {
    const n = Number(floor) || 0;
    return (((n * 7919 + 1) * 2654435761) ^ (Number(topicId) || 0)) >>> 0;
  }

  /** 思考块正文：随机 1-3 句（开头句必有，中段 65%，收尾句 60%） */
  function thinkSentences(rnd) {
    const pick = (pool) => pool[Math.floor(rnd() * pool.length)];
    const out = [pick(THINK_OPENERS)];
    if (rnd() < 0.65) out.push(pick(THINK_MIDS));
    if (rnd() < 0.60) out.push(pick(THINK_CLOSERS));
    return out;
  }

  /**
   * ✻ Worked for 27s —— 可折叠的思考块（HTML 字符串）。
   * 默认展开与否由调用方传（列表看 listThinkingOpen，详情看 detailThinkingOpen），
   * 两种状态都可以点标题行切换。
   */
  function thinkingHtml(rnd, openByDefault) {
    const secs = 2 + Math.floor(rnd() * 46);
    return '<div class="v2cx-think' + (openByDefault ? " open" : "") + '">' +
      '<div class="v2cx-think-head"><span class="v2cx-spin">' + ic("sparkle") + "</span>" +
      '<span>Worked for ' + secs + 's</span><span class="v2cx-think-chev"></span></div>' +
      '<div class="v2cx-think-body">' + escapeHtml(thinkSentences(rnd).join("\n\n")) + "</div>" +
      "</div>";
  }

  /**
   * 楼内 / 列表里穿插的「工具调用」淡色行。
   * avoidIdx 用来避开上一条用过的样式 —— 否则列表里会连着出现两个
   * 「Running command」，一眼就看出是生成的。
   */
  function runlineParts(rnd, avoidIdx) {
    let i = Math.floor(rnd() * RUN_LINES.length);
    if (avoidIdx != null && avoidIdx >= 0 && i === avoidIdx) i = (i + 1) % RUN_LINES.length;
    const [icon, text, withCmd] = RUN_LINES[i];
    return {
      idx: i,
      html: '<div class="v2cx-runline">' +
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
  function decorateTurns(container, topicId) {
    if (!container || !cfg("decorations")) return;
    container.querySelectorAll(".v2cx-turn-agent[data-floor]").forEach((turn) => {
      if (turn.dataset.decorated === "1") return;
      turn.dataset.decorated = "1";
      const cooked = turn.querySelector(".v2cx-cooked");
      if (!cooked) return;
      const rnd = mulberry32(turnSeed(topicId, turn.dataset.floor));
      // 思考块放内容最前面（要放在 runline 判断之前，否则覆盖率会掉）
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

  /**
   * 把一批回复里的「@某人」解析成引用目标。
   *
   * 返回 floor → { floor, username, html } 的映射：
   *   - 找「该用户在此楼之前最后一次发言」那一楼（V2EX 的楼中楼基本都是回最近那条）
   *   - 如果提到的是楼主、且楼主此前没发过回复，就指向主题正文（label 用「楼主」）
   * 解析不到的返回 null，调用方就保留原文里的 @，不丢信息。
   */
  function resolveMentions(topic, replies) {
    const map = new Map();
    if (!topic) return map;

    const opAuthor = topic.author || "";
    const opHtml = topic.contentHtml || "";
    const lastByUser = new Map(); // username → { floor, username, html }

    replies.forEach((p) => {
      const men = p.mention;
      if (men) {
        const key = p.floor;
        // 优先同名回复；比对不上再用 slug（显示名和 URL 名理论上一致，但不硬依赖）
        let hit = lastByUser.get(men.name);
        if (!hit) {
          for (const [name, v] of lastByUser) {
            if (name.toLowerCase() === men.name.toLowerCase()) { hit = v; break; }
          }
        }
        if (hit) map.set(key, hit);
        else if (opAuthor && men.name.toLowerCase() === opAuthor.toLowerCase()) {
          map.set(key, { floor: "", username: opAuthor, html: opHtml, isOp: true });
        }
      }
      lastByUser.set(p.username, { floor: p.floor, username: p.username, html: p.html });
    });

    return map;
  }

  /** 引用卡片：头部「引用 N 楼 · 用户名」+ 可折叠的原文 + 跳转按钮 */
  function quoteHtml(target) {
    // 引用里的图片不重复显示（原楼层已经有了），换个占位标记
    const body = String(target.html || "")
      .replace(/<img\b[^>]*>/gi, '<span class="v2cx-quote-img">[图片]</span>');
    const label = target.isOp
      ? "楼主"
      : '<b>' + escapeHtml(target.floor) + "</b> 楼";
    return '<div class="v2cx-quote' + (cfg("quoteOpen") ? " open" : "") + '">' +
      '<div class="v2cx-quote-head">' +
      '<span class="v2cx-quote-ic">' + ic("quote") + "</span>" +
      '<span class="v2cx-quote-title">引用 ' + label + " · " + escapeHtml(target.username) + "</span>" +
      (target.floor
        ? '<button type="button" class="v2cx-quote-jump" data-jump-floor="' + escapeHtml(target.floor) +
          '" title="跳到该楼层">' + ic("external") + "</button>"
        : "") +
      '<span class="v2cx-quote-chev"></span>' +
      "</div>" +
      '<div class="v2cx-quote-body">' + body + "</div>" +
      "</div>";
  }

  /** 滚到某一楼并闪一下；找不到就退化成 #replyN 锚点 */
  function jumpToFloor(floor) {
    const node = document.getElementById("reply" + floor);
    if (!node) { location.hash = "#reply" + floor; return; }
    // jsdom 之类的环境没实现 scrollIntoView，别让整个点击处理器炸掉
    if (typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    const turn = node.closest(".v2cx-turn") || node;
    turn.classList.remove("v2cx-flash");
    void turn.offsetWidth; // 强制重排，保证连点同一条也能重放动画
    turn.classList.add("v2cx-flash");
    setTimeout(() => turn.classList.remove("v2cx-flash"), 1300);
  }

  /* ---------- 详情视图 ---------- */

  /**
   * 楼层操作胶囊：回复 / 赞 / 收藏 / 复制链接。
   * 全部走站点原生能力，不自己发请求：
   *   回复     → 本地把 @用户名 前缀写进底部输入框（V2EX 就是这么引用的）
   *   赞       → 原生 thankReply(replyId)（V2EX 的「感谢」就是它的点赞）
   *   收藏     → /favorite/topic/{id}（V2EX 原生 GET 收藏入口）
   *   复制链接 → 本地
   */
  function turnActionsHtml(opts) {
    const floor = opts.floor, username = opts.username;
    const topicId = opts.topicId, replyId = opts.replyId;
    const link = location.origin + location.pathname.split("?")[0] + "#reply" + floor;
    return '' +
      '<span class="v2cx-actions">' +
      '<button class="v2cx-act" data-act="reply" data-user="' + escapeHtml(username || "") + '" title="回复（在底部输入框里 @ 该用户）">' + ic("reply") + "<span>回复</span></button>" +
      '<button class="v2cx-act" data-act="thanks" data-reply-id="' + escapeHtml(String(replyId || "")) + '" data-topic-id="' + escapeHtml(String(topicId || "")) + '" title="感谢该楼层（调用 V2EX 原生 thankReply）">' + ic("heart") + "<span>赞</span></button>" +
      '<button class="v2cx-act" data-act="fav" data-topic-id="' + escapeHtml(String(topicId || "")) + '" title="收藏主题（V2EX 原生 /favorite/topic）">' + ic("star") + "<span>收藏</span></button>" +
      '<button class="v2cx-act" data-act="copy-link" data-value="' + escapeHtml(link) + '" title="复制楼层链接">' + ic("link") + "<span>复制链接</span></button>" +
      "</span>";
  }

  /**
   * 楼层操作：全部转交站点原生能力，失败就老实说，不伪造成功。
   * 注意 V2EX 把「点赞」叫「感谢」；谢谢额度还受每日 V2EX 币限制，
   * 所以失败信息直接透出站点返回的 alert。
   */
  function handleTurnAction(act) {
    const kind = act.dataset.act;

    if (kind === "copy-link") {
      copyText(act.dataset.value || location.href);
      return;
    }

    if (kind === "reply") {
      const user = act.dataset.user || "";
      const edit = mdEditEl();
      if (!edit) return;
      const src = mdSource(edit);
      const prefix = user ? "@" + user + " " : "";
      if (prefix && !src.startsWith(prefix)) {
        edit.textContent = prefix + (src ? src + "\n" : "");
      }
      edit.focus();
      setCaret(edit, prefix.length);
      mdSyncState();
      setStatus("回复 " + (user || "楼主"), "ok");
      document.querySelector(".v2cx-composer")?.scrollIntoView({ block: "nearest" });
      return;
    }

    if (kind === "thanks") {
      const replyId = num(act.dataset.replyId);
      if (!replyId) {
        // OP 楼层没有独立的回复 id：退化成对主题「感谢」
        const tid = num(act.dataset.topicId);
        const fn = window.thankTopic;
        if (typeof fn === "function" && tid) { fn(tid, window.once); toastNow("已感谢主题"); }
        else { toastNow("需要登录才能感谢"); }
        return;
      }
      const fn = window.thankReply;
      if (typeof fn === "function") {
        act.classList.add("on");
        fn(replyId);
        setStatus("已发送感谢", "ok");
      } else {
        toastNow("原生脚本未就绪，需要登录");
      }
      return;
    }

    if (kind === "fav") {
      const tid = num(act.dataset.topicId);
      if (!tid) return;
      // V2EX 的收藏就是一个 GET 链接，导航过去它会自己跳回来（和点站点自己的星标一样）
      location.href = "/favorite/topic/" + tid;
      return;
    }
  }


  function renderDetail(inner, page) {
    const t = page.topic;
    if (!t) {
      inner.innerHTML = `<div class="v2cx-list-status">没能解析出主题内容</div>`;
      return;
    }
    MORE_PAGE = t.page || 1;
    MORE_URL = null; // 由 renderDetail 底部的分页按钮决定

    const metaBits = [];
    if (t.timeIso || t.timeText) {
      metaBits.push(`<span>${escapeHtml(formatTime(t.timeIso) || t.timeText)}</span>`);
    }
    if (t.views) metaBits.push(`<span class="v2cx-dotsep">·</span><span>${escapeHtml(t.views)} views</span>`);
    metaBits.push(`<span class="v2cx-dotsep">·</span><span>${t.repliesCount} 回复</span>`);
    if (t.page > 1) metaBits.push(`<span class="v2cx-dotsep">·</span><span>第 ${t.page} 页</span>`);

    // 感谢 / 反对：转调 V2EX 原生全局函数（页面被隐藏但 DOM 还在，函数仍然可用）
    const votes = `<span class="v2cx-votes" title="感谢 / 反对（调用 V2EX 原生逻辑）">
      <button class="v2cx-vote-btn" data-vote="up" data-topic="${escapeHtml(String(t.topicId || ""))}" title="感谢">${ic("chevronUp")}</button>
      <button class="v2cx-vote-btn" data-vote="down" data-topic="${escapeHtml(String(t.topicId || ""))}" title="反对">${ic("chevronDown")}</button>
    </span>`;

    // 不重复渲染大标题：顶栏面包屑（项目 / 标题 · N 回复）已经是标题了。
    // 对齐 Codex app 的做法 —— 内容区直接从消息开始。
    const head = `
      <div class="v2cx-detail-head">
        <div class="v2cx-detail-meta">
          ${t.authorUrl ? `<a href="${escapeHtml(t.authorUrl)}" style="color:inherit">${escapeHtml(t.author)}</a>` : `<span>${escapeHtml(t.author)}</span>`}
          ${t.node ? `<span class="v2cx-dotsep">·</span><a class="v2cx-node" href="${escapeHtml(t.node.url)}" style="color:var(--cx-text-secondary);background:var(--cx-chip-bg);border-radius:5px;padding:1px 6px;font-size:11.5px;text-decoration:none">${escapeHtml(t.node.name)}</a>` : ""}
          ${metaBits.join("")}
          ${votes}
        </div>
        ${t.tags.length ? `<div class="v2cx-detail-tags">${t.tags.map((x) =>
          `<a class="v2cx-pill" href="${escapeHtml(x.url)}">#${escapeHtml(x.label)}</a>`).join("")}</div>` : ""}
      </div>`;

    const opTurn = `
      <div class="v2cx-turn">
        <div class="v2cx-turn-user">
          <div class="v2cx-turn-user-bubble">${cleanContent(t.contentHtml) || '<span style="color:var(--cx-text-dim)">（正文为空）</span>'}</div>
        </div>
        <div class="v2cx-worked">
          <span class="v2cx-floor">OP</span>
          <span class="v2cx-user">${escapeHtml(t.author)}</span>
          <span>·</span><span>${escapeHtml(formatTime(t.timeIso) || t.timeText)}</span>
          <span>·</span><span>阅读 ${escapeHtml(t.views || "–")}</span>
          ${turnActionsHtml({ floor: "OP", username: t.author, topicId: t.topicId })}
        </div>
      </div>`;

    const supplements = t.supplements.map((s) => `
      <div class="v2cx-supplement">
        <div class="v2cx-cooked">${cleanContent(s.html)}</div>
        <div class="v2cx-worked">
          <span class="v2cx-floor">${escapeHtml(s.label.replace(/[^0-9]/g, "") || "＋")}</span>
          <span class="v2cx-user">${escapeHtml(s.label || "补充")}</span>
          <span>·</span><span>${escapeHtml(formatTime(s.timeIso))}</span>
        </div>
      </div>`).join("");

    const mentionMap = cfg("quoteCard") ? resolveMentions(t, t.replies) : new Map();
    const turns = t.replies.map((p) => `
      <div class="v2cx-turn">
        <div class="v2cx-turn-agent" id="reply${escapeHtml(p.floor)}" data-floor="${escapeHtml(p.floor)}">
          ${mentionMap.has(p.floor) ? quoteHtml(mentionMap.get(p.floor)) : ""}
          <div class="v2cx-cooked">${cleanContent(mentionMap.has(p.floor) ? p.html : (p.htmlRaw || p.html))}</div>
        </div>
        <div class="v2cx-worked">
          <span class="v2cx-floor">${escapeHtml(p.floor)}</span>
          <a class="v2cx-user" href="${escapeHtml(p.userUrl)}" style="color:var(--cx-text-secondary);text-decoration:none">${escapeHtml(p.username)}</a>
          ${p.isOp ? `<span class="v2cx-badge">OP</span>` : ""}
          <span>·</span><span>${escapeHtml(formatTime(p.timeIso) || p.timeText)}</span>
          ${p.via ? `<span>·</span><span>via ${escapeHtml(p.via)}</span>` : ""}
          ${turnActionsHtml({ floor: p.floor, username: p.username, topicId: t.topicId, replyId: p.id })}
        </div>
      </div>`).join("");

    // 分页：V2EX 主题每 100 楼一页
    let pagerHtml = "";
    if (t.totalPages > 1) {
      const base = location.pathname;
      const links = [];
      for (let i = 1; i <= Math.min(t.totalPages, 80); i++) {
        links.push(`<a class="v2cx-fchip${i === t.page ? " on" : ""}" href="${escapeHtml(base)}?p=${i}">${i}</a>`);
      }
      pagerHtml = `<div class="v2cx-card-links" style="margin-top:22px">${links.join("")}</div>`;
    }

    // 先在 detached 容器里渲染 + 加伪装装饰，再一次性写回：
    // decorateTurns 要动 DOM（prepend 思考块 / 插入工具调用行），
    // 在字符串上做不了这件事。
    const holder = document.createElement("div");
    holder.innerHTML = `
      ${head}
      ${opTurn}
      ${supplements}
      ${t.replies.length ? `<div class="v2cx-turn-divider">以下 ${t.repliesCount} 条回复 · 第 ${t.page} / ${t.totalPages} 页</div>` : `<div class="v2cx-turn-divider">还没有回复</div>`}
      ${turns}
      ${pagerHtml}
      <div class="v2cx-card-links" style="margin-top:18px;align-items:center">
        <a class="v2cx-new-topic-btn" href="/new">${ic("plus")}新主题</a>
        <a class="v2cx-pill" href="${escapeHtml(location.pathname)}" target="_blank" rel="noopener" title="在原站打开（回复框 / 楼层投票）">原生页面</a>
      </div>
    `;
    decorateTurns(holder, t.topicId);
    markSmallImages(holder);
    inner.replaceChildren(...holder.childNodes);
  }

  /* ---------- 加载更多（列表分页；同源 fetch 后解析） ---------- */

  async function loadMore(btn) {
    if (!PAGE) return;
    const r = PAGE.route;
    if (r.kind === "topic") return; // 主题用页码链接，不走这里

    const nextNum = MORE_PAGE + 1;
    const url = MORE_URL && MORE_URL !== location.pathname
      ? MORE_URL
      : `${location.pathname}?p=${nextNum}`;

    btn.dataset.busy = "1";
    btn.textContent = "加载中…";
    try {
      const resp = await fetch(url, { credentials: "same-origin" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, "text/html");

      const fresh = parse.listRows(doc);
      const have = new Set((PAGE.list || []).map((x) => x.id));
      const add = fresh.filter((x) => !have.has(x.id));

      const rowsBox = document.querySelector(".v2cx-rows");
      if (rowsBox && add.length) {
        rowsBox.insertAdjacentHTML("beforeend",
          '<div class="v2cx-row-sep"></div>' + listRowsHtml(add));
        PAGE.list = (PAGE.list || []).concat(add);
      }

      const pag = parse.pagination(doc);
      MORE_PAGE = pag.current;
      MORE_URL = pag.next;

      if (MORE_URL) {
        delete btn.dataset.busy;
        btn.textContent = `点击加载更多（第 ${MORE_PAGE + 1} 页）`;
      } else {
        btn.classList.remove("link");
        btn.removeAttribute("data-more");
        btn.textContent = "没有更多了";
      }
      renderRail(document.querySelector(".v2cx-rail"), PAGE);
    } catch (err) {
      delete btn.dataset.busy;
      btn.textContent = `加载失败（${err.message}），点击重试`;
    }
  }

  /* ============================== 右侧代码面板（纯氛围，移植自原脚本） ============================== */

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // V2EX 主题域改造的假代码块（原脚本是 TopicCache / Pipeline，这里换成论坛抓取/渲染）
  const CODE_LANGS = {
    rust: {
      label: "Rust", file: "topic_cache.rs", dir: "engine", icon: "RS", comment: "//",
      root: cfg("projectName"),
      kw: ["fn", "let", "mut", "impl", "pub", "use", "struct", "enum", "match", "if", "else", "for", "in", "return", "mod", "crate", "self", "Self", "async", "await", "move", "where", "const", "trait", "loop", "while", "Ok", "Err", "Some", "None", "Box", "Vec", "String", "Result", "Option"],
      blocks: [
        ["use std::collections::HashMap;", "use std::time::{Duration, Instant};", ""],
        ["pub struct TopicCache {", "    entries: HashMap<u64, CachedTopic>,", "    ttl: Duration,", "}", ""],
        ["pub struct CachedTopic {", "    id: u64,", "    title: String,", "    replies: usize,", "    fetched_at: Instant,", "}", ""],
        ["impl TopicCache {", "    pub fn new(ttl: Duration) -> Self {", "        Self { entries: HashMap::new(), ttl }", "    }", "}", ""],
        ["    pub fn get(&self, id: u64) -> Option<&CachedTopic> {", "        match self.entries.get(&id) {", "            Some(t) if !self.stale(t) => Some(t),", "            _ => None,", "        }", "    }", ""],
        ["    fn stale(&self, t: &CachedTopic) -> bool {", "        t.fetched_at.elapsed() > self.ttl", "    }", ""],
        ["    pub async fn refresh(&mut self, id: u64) -> Result<(), FetchError> {", "        let fresh = fetch_topic(id).await?;", "        self.entries.insert(id, fresh);", "        Ok(())", "    }", ""],
        ["#[derive(Debug, Clone, Copy)]", "pub enum ViewMode {", "    List,", "    Detail { topic_id: u64 },", "    Split { topic_id: u64, panel: PanelKind },", "}", ""],
        ["// 版面切换：只重渲染主区，rail 与代码面板保持不动", "// 注意与 V2EX 原生的分页 (100 楼/页) 对齐", ""],
        ["#[cfg(test)]", "mod tests {", "    use super::*;", "", "    #[test]", "    fn expired_entry_is_dropped() {", "        let mut c = TopicCache::new(Duration::from_secs(0));", "        c.entries.insert(1, CachedTopic::default());", "        assert!(c.get(1).is_none());", "    }", "}", ""]
      ]
    },
    python: {
      label: "Python", file: "crawler.py", dir: "workers", icon: "PY", comment: "#",
      root: cfg("projectName"),
      kw: ["def", "class", "return", "if", "else", "elif", "for", "while", "in", "import", "from", "as", "with", "try", "except", "finally", "raise", "lambda", "None", "True", "False", "async", "await", "yield", "pass", "self", "is", "not", "and", "or"],
      blocks: [
        ["import asyncio", "import hashlib", "from dataclasses import dataclass, field", "from typing import Optional", ""],
        ["@dataclass", "class TopicSnapshot:", "    topic_id: int", "    title: str", "    replies: list = field(default_factory=list)", "    fetched_at: float = 0.0", ""],
        ["class Crawler:", '    """V2EX 主题抓取：列表 -> 详情 -> 分页（100 楼/页）。"""', "", "    def __init__(self, workers: int = 8):", "        self.workers = workers", "        self.queue: asyncio.Queue = asyncio.Queue(maxsize=1024)", "        self.seen: set[int] = set()", ""],
        ["    async def run(self) -> None:", "        producers = [asyncio.create_task(self.produce(i)) for i in range(2)]", "        consumers = [asyncio.create_task(self.consume(i)) for i in range(self.workers)]", "        await asyncio.gather(*producers, *consumers)", ""],
        ["    async def consume(self, idx: int) -> None:", "        while True:", "            snap = await self.queue.get()", "            try:", "                await self.persist(snap)", "            except Exception as exc:", '                logger.warning("persist failed: %s", exc)', "            finally:", "                self.queue.task_done()", ""],
        ["    def fingerprint(self, snap: TopicSnapshot) -> str:", "        digest = hashlib.sha256(snap.title.encode()).hexdigest()", "        return digest[:16]", ""],
        ["    async def page_count(self, topic_id: int) -> int:", "        # V2EX 主题每页 100 楼", "        total = await self.fetch_reply_count(topic_id)", "        return max(1, -(-total // 100))", ""],
        ["def backoff(attempt: int, base: float = 0.5) -> float:", "    # 指数退避 + 抖动，避免触发站点限流", "    return base * (2 ** attempt) * (0.5 + random.random())", ""],
        ["async def main() -> None:", "    crawler = Crawler(workers=16)", "    await crawler.run()", "", 'if __name__ == "__main__":', "    asyncio.run(main())", ""]
      ]
    },
    typescript: {
      label: "TypeScript", file: "app.ts", dir: "web", icon: "TS", comment: "//",
      root: cfg("projectName"),
      kw: ["const", "let", "var", "function", "return", "if", "else", "for", "of", "in", "while", "import", "from", "export", "default", "class", "extends", "interface", "type", "enum", "new", "this", "async", "await", "try", "catch", "finally", "throw", "switch", "case", "break", "readonly", "public", "private", "void", "string", "number", "boolean", "Promise", "Map", "Set"],
      blocks: [
        ['import { EventEmitter } from "events";', 'import type { Topic, Reply, NodeInfo } from "./types";', ""],
        ["interface CacheEntry<T> {", "  value: T;", "  expiresAt: number;", "}", ""],
        ["export class TopicStore extends EventEmitter {", "  private cache = new Map<number, CacheEntry<Topic>>();", "  private readonly ttl = 30_000;", "", "  constructor(private readonly client: ApiClient) {", "    super();", "  }", ""],
        ["  async get(id: number): Promise<Topic | null> {", "    const hit = this.cache.get(id);", "    if (hit && hit.expiresAt > Date.now()) return hit.value;", "    const fresh = await this.client.fetchTopic(id);", "    this.cache.set(id, { value: fresh, expiresAt: Date.now() + this.ttl });", '    this.emit("update", fresh);', "    return fresh;", "  }", ""],
        ["  async replies(id: number, page: number): Promise<Reply[]> {", "    // V2EX 主题分页：每页 100 楼", "    return this.client.fetchReplies(id, page);", "  }", ""],
        ["  invalidate(id?: number): void {", "    if (id === undefined) this.cache.clear();", "    else this.cache.delete(id);", "  }", ""],
        ["export function renderRow(topic: Topic): string {", '  const node = topic.node ? `[${topic.node.name}]` : "";', "  return `${node} ${topic.title} (${topic.replies} 回复)`;", "}", ""],
        ["// 状态机：idle -> loading -> ready | error", "type ViewState =", '  | { kind: "idle" }', '  | { kind: "loading" }', '  | { kind: "ready"; replies: Reply[] }', '  | { kind: "error"; message: string };', ""],
        ["export function reduce(state: ViewState, ev: ViewEvent): ViewState {", "  switch (ev.type) {", '    case "load": return { kind: "loading" };', '    case "ok":   return { kind: "ready", replies: ev.replies };', '    case "err":  return { kind: "error", message: ev.message };', "    default:     return state;", "  }", "}", ""],
        ["const store = new TopicStore(new ApiClient(BASE_URL));", 'store.on("update", (t) => console.log("topic updated", t.id));', ""]
      ]
    },
    go: {
      label: "Go", file: "main.go", dir: "cmd", icon: "GO", comment: "//",
      root: cfg("projectName"),
      kw: ["func", "package", "import", "return", "if", "else", "for", "range", "go", "chan", "select", "case", "default", "type", "struct", "interface", "map", "var", "const", "defer", "nil", "err", "string", "int", "bool", "error", "true", "false"],
      blocks: [
        ["package main", "", "import (", '    "context"', '    "fmt"', '    "sync"', '    "time"', ")", ""],
        ["type TopicCache struct {", "    mu      sync.RWMutex", "    entries map[uint64]CachedTopic", "    ttl     time.Duration", "}", ""],
        ["func NewTopicCache(ttl time.Duration) *TopicCache {", "    return &TopicCache{entries: make(map[uint64]CachedTopic), ttl: ttl}", "}", ""],
        ["func (c *TopicCache) Get(id uint64) (CachedTopic, bool) {", "    c.mu.RLock()", "    defer c.mu.RUnlock()", "    t, ok := c.entries[id]", "    if !ok || t.Expired(c.ttl) {", "        return CachedTopic{}, false", "    }", "    return t, true", "}", ""],
        ["func (c *TopicCache) Refresh(ctx context.Context, id uint64) error {", "    fresh, err := FetchTopic(ctx, id)", "    if err != nil {", '        return fmt.Errorf("refresh topic %d: %w", id, err)', "    }", "    c.mu.Lock()", "    defer c.mu.Unlock()", "    c.entries[id] = fresh", "    return nil", "}", ""],
        ["// V2EX 主题每页 100 楼，按总分页拉取剩余回复", "func (c *TopicCache) TotalPages(replies int) int {", "    if replies <= 100 {", "        return 1", "    }", "    return (replies + 99) / 100", "}", ""],
        ["func main() {", "    ctx, cancel := context.WithCancel(context.Background())", "    defer cancel()", "    cache := NewTopicCache(30 * time.Second)", '    fmt.Println("listening on :8080")', "}", ""]
      ]
    },
    java: {
      label: "Java", file: "TopicService.java", dir: "src/main/java", icon: "JV", comment: "//",
      root: cfg("projectName"),
      kw: ["public", "private", "protected", "class", "interface", "enum", "static", "final", "void", "return", "if", "else", "for", "while", "new", "this", "import", "package", "extends", "implements", "try", "catch", "finally", "throw", "throws", "int", "long", "boolean", "String", "List", "Map", "Optional", "var"],
      blocks: [
        ["package com.example.v2ex;", "", "import java.time.Duration;", "import java.util.Map;", "import java.util.Optional;", "import java.util.concurrent.ConcurrentHashMap;", ""],
        ["public class TopicService {", "", "    private final Map<Long, CachedTopic> cache = new ConcurrentHashMap<>();", "    private final Duration ttl;", "    private final TopicClient client;", ""],
        ["    public TopicService(TopicClient client, Duration ttl) {", "        this.client = client;", "        this.ttl = ttl;", "    }", ""],
        ["    public Optional<CachedTopic> get(long id) {", "        CachedTopic hit = cache.get(id);", "        if (hit == null || hit.expired(ttl)) {", "            return Optional.empty();", "        }", "        return Optional.of(hit);", "    }", ""],
        ["    public CachedTopic refresh(long id) throws FetchException {", "        CachedTopic fresh = client.fetchTopic(id);", "        cache.put(id, fresh);", "        return fresh;", "    }", ""],
        ["    // V2EX 主题每页 100 楼", "    public int totalPages(int replies) {", "        return replies <= 100 ? 1 : (replies + 99) / 100;", "    }", ""],
        ["    public CacheStats stats() {", "        return new CacheStats(cache.size(), hits.get(), misses.get());", "    }", "}", ""]
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
    const main = document.querySelector(".v2cx-main");
    if (!main) return;
    main.classList.toggle("panel-hidden", hidden);
    if (persist) {
      // 顶栏那个按钮和设置面板里的开关是同一件事，改完要把面板里的状态同步过去
      setCfg("codePanel", !hidden, { visualOnly: true });
      syncSettingControls();
    }
  }

  /** 面板种子：详情 = 话题 id；列表 = 路径字符串哈希 */
  function panelSeed() {
    const r = route();
    if (r.kind === "topic" && r.topicId) return r.topicId | 0;
    const s = r.path + (r.node || r.tab || r.tag || "");
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  function renderCodePanel() {
    const main = document.querySelector(".v2cx-main");
    if (!main) return;
    const L = CODE_LANGS[getLang()];
    const mode = getCodeMode();
    const seed = panelSeed();
    const r = route();

    // tab / 面包屑
    const iconEl = main.querySelector("[data-code-icon]");
    const fileEl = main.querySelector("[data-code-file-name]");
    if (iconEl) iconEl.textContent = L.icon;
    if (fileEl) fileEl.textContent = L.file;

    const setSeg = (sel, text) => {
      const n = main.querySelector(sel);
      if (n) n.textContent = text;
    };
    setSeg("[data-code-crumb-root]", L.root);
    setSeg("[data-code-crumb-cat]", r.kind === "topic" ? "topics" : (r.listKind || "topics"));
    setSeg("[data-code-crumb-dir]", r.kind === "topic" ? "detail" : L.dir);
    setSeg("[data-code-crumb-file]", L.file);

    const langLabel = main.querySelector("[data-lang-label]");
    if (langLabel) langLabel.textContent = L.label;

    // 语言菜单
    const menu = main.querySelector("[data-lang-menu]");
    if (menu) {
      menu.innerHTML = Object.entries(CODE_LANGS).map(([k, v]) =>
        `<div class="${k === getLang() ? "on" : ""}" data-code-lang-item="${k}">
           <span>${escapeHtml(v.label)}</span><span style="color:var(--cx-text-faint)">${escapeHtml(v.file)}</span>
         </div>`).join("");
    }

    // 代码 / diff
    const body = main.querySelector("[data-code-body]");
    if (!body) return;
    const lines = genCodeLines(getLang(), seed);

    let html = "";
    if (mode === "diff") {
      // 装饰性 diff：把代码行按种子切成 增/删/hunk
      const rnd = mulberry32((seed * 7919 + 13) | 0);
      let ln = 0;
      lines.forEach((line, i) => {
        if (i % 17 === 0) {
          html += `<div class="v2cx-code-line hunk"><span class="v2cx-ln"></span><span class="v2cx-src">@@ -${ln + 1},9 +${ln + 1},11 @@</span></div>`;
        }
        const roll = rnd();
        const cls = roll < 0.14 ? " del" : roll < 0.30 ? " add" : "";
        if (cls !== " del") ln++;
        const src = cls === " del" ? line : (cls === " add" ? line + "_patched();" : line);
        html += `<div class="v2cx-code-line${cls}"><span class="v2cx-ln">${ln || ""}</span><span class="v2cx-src">${highlightCode(src, L)}</span></div>`;
      });
    } else {
      lines.forEach((line, i) => {
        html += `<div class="v2cx-code-line"><span class="v2cx-ln">${i + 1}</span><span class="v2cx-src">${highlightCode(line, L)}</span></div>`;
      });
    }
    body.innerHTML = html;
    body.scrollTop = 0;
    setPanelHidden(panelHidden(), false);
    syncTitle();
    if (bossOn()) renderBoss();
  }

  /* ============================== 底部输入框（composer）逻辑 ============================== */

  /*
   * 编辑区是 contenteditable，但内容按「纯文本 + \n」维护：
   *   - 容器 white-space: pre-wrap，所以 \n 直接就是换行；
   *   - Enter 被改写成「发送」，Shift+Enter 插入字面 \n。
   * 这样所有编辑操作都可以在字符串上做，不用处理 contenteditable 那套
   * <div>/<br> 混排的脏 DOM（原脚本为此写了 ~800 行的块级编辑器，没必要）。
   */

  function mdEditEl() {
    return document.querySelector(".v2cx-md-edit");
  }

  function mdSource(edit) {
    return (edit ? edit.textContent : "").replace(/\u00a0/g, " ");
  }

  function mdSyncState() {
    const edit = mdEditEl();
    if (!edit) return;
    const src = mdSource(edit);
    edit.classList.toggle("has-content", src.trim().length > 0);
    mdSyncPreview(src);
    mdSyncSend();
    if (COMPOSER.draftKey) lsSet(COMPOSER.draftKey, src);
  }

  function mdSyncSend() {
    const edit = mdEditEl();
    const btn = document.querySelector(".v2cx-send");
    if (!btn || !edit) return;
    btn.disabled = mdSource(edit).trim().length === 0;
  }

  function setStatus(text, kind) {
    const el = document.querySelector(".v2cx-composer-status");
    if (!el) return;
    el.textContent = text || "";
    el.className = "v2cx-composer-status" + (kind ? " " + kind : "");
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
  function mdApply(fn) {
    const edit = mdEditEl();
    if (!edit) return;
    const src = mdSource(edit);
    // 优先用 mousedown 时快照下来的选区（见 bindComposer），否则读当前光标
    const off = COMPOSER.sel || caretOffsets(edit) || { start: src.length, end: src.length };
    COMPOSER.sel = null;
    const out = fn(src, off.start, off.end);
    if (!out) return;
    edit.textContent = out.text;
    setCaret(edit, typeof out.caret === "number" ? out.caret : out.text.length);
    mdSyncState();
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

  /** 代码：单行→行内围栏；多行选中→围栏代码块 */
  function opCode() {
    return (src, s, e) => {
      const picked = src.slice(s, e);
      if (picked.includes("\n")) {
        return { text: src.slice(0, s) + "```\n" + picked + "\n```" + src.slice(e), caret: s + 4 + picked.length + 4 };
      }
      return opWrap("`", "`")(src, s, e);
    };
  }

  /** 标题循环：## → ### → #### → 无 */
  function opHeading() {
    return (src, s) => {
      const ls = src.lastIndexOf("\n", s - 1) + 1;
      let le = src.indexOf("\n", s);
      if (le < 0) le = src.length;
      const line = src.slice(ls, le);
      const m = line.match(/^(#{2,4}) /);
      const next = !m ? "## " : (m[1].length >= 4 ? "" : "#".repeat(m[1].length + 1) + " ");
      const stripped = line.replace(/^#{2,4} /, "");
      const newLine = next + stripped;
      const delta = newLine.length - line.length;
      return { text: src.slice(0, ls) + newLine + src.slice(le), caret: Math.max(ls, s + delta) };
    };
  }

  function opSnippet(snippet) {
    return (src, s) => ({
      text: src.slice(0, s) + snippet + src.slice(s),
      caret: s + snippet.length
    });
  }

  /* ---- 实时预览（极简 markdown 渲染） ---- */

  function mdToHtml(src) {
    const fences = [];
    let s = String(src).replace(/```[^\n]*\n?([\s\S]*?)```/g, (m, code) => {
      fences.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
      return `\u0000${fences.length - 1}\u0000`;
    });

    const inline = (text) => {
      let out = escapeHtml(text);
      out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
      out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<img src="$2" alt="$1">');
      out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2" target="_blank" rel="noopener nofollow">$1</a>');
      out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
      out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => fences[+i] || "");
      return out;
    };

    const out = [];
    let list = null;
    const flush = () => { if (list) { out.push(`</${list}>`); list = null; } };

    for (const raw of s.split("\n")) {
      const fenceRef = raw.match(/^\u0000\d+\u0000$/);
      const h = raw.match(/^(#{1,4}) (.*)$/);
      const ul = raw.match(/^[-*] (.*)$/);
      const ol = raw.match(/^\d+\. (.*)$/);
      const bq = raw.match(/^> ?(.*)$/);
      if (/^\s*---+\s*$/.test(raw)) { flush(); out.push("<hr>"); continue; }
      if (fenceRef) { flush(); out.push(inline(raw)); continue; }
      if (h) { flush(); const t = Math.min(3, h[1].length + 1); out.push(`<h${t}>${inline(h[2])}</h${t}>`); continue; }
      if (ul) { if (list !== "ul") { flush(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
      if (ol) { if (list !== "ol") { flush(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
      if (bq) { flush(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }
      if (!raw.trim()) { flush(); continue; }
      flush();
      out.push(`<p>${inline(raw)}</p>`);
    }
    flush();
    return out.join("");
  }

  function mdSyncPreview(src) {
    const box = document.querySelector(".v2cx-compose-preview");
    if (!box) return;
    const on = box.closest(".v2cx-composer")?.classList.contains("preview-on");
    if (!on) return;
    const text = src == null ? mdSource(mdEditEl()) : src;
    box.innerHTML = text.trim() ? mdToHtml(text) : `<span style="color:var(--cx-text-faint)">（还没有内容）</span>`;
  }

  /* ---- 发送 ---- */

  /** V2EX 主题页的原生回复框（登录后才有） */
  function nativeReplyBox() {
    const box = document.querySelector("#reply-box");
    if (!box) return null;
    const ta = box.querySelector("textarea");
    if (!ta) return null;
    const submit = box.querySelector('input[type="submit"], button[type="submit"], a.super.normal.button, .super.normal.button');
    return { ta, submit };
  }

  /** 发送目标：主题页→原生回复框；列表页→/new[/node] */
  function nativeComposeTarget() {
    const r = route();
    if (r.kind === "topic") return { kind: "reply", url: location.pathname + location.search };
    if (r.kind === "list" && r.listKind === "node") return { kind: "new", url: `/new/${r.node}` };
    return { kind: "new", url: "/new" };
  }

  function mdSend() {
    const edit = mdEditEl();
    if (!edit) return;
    const text = mdSource(edit).trim();
    if (!text) { setStatus("写点什么先", "err"); return; }

    const target = nativeComposeTarget();

    if (target.kind === "reply") {
      const native = nativeReplyBox();
      if (native) {
        // 直接驱动 V2EX 自己的回复框（保留它的校验 / CSRF / once 逻辑）
        try {
          native.ta.value = text;
          native.ta.dispatchEvent(new Event("input", { bubbles: true }));
          native.ta.dispatchEvent(new Event("change", { bubbles: true }));
          if (native.submit) {
            native.submit.click();
            setStatus("已提交回复…", "ok");
            lsSet(COMPOSER.draftKey, "");
            edit.textContent = "";
            mdSyncState();
          } else {
            setStatus("已填入原生回复框，请手动提交", "ok");
          }
        } catch (err) {
          setStatus("提交失败：" + (err && err.message || err), "err");
        }
        return;
      }
      // 未登录 / 原生框不存在：不伪造提交，老实复制草稿并给原生入口
      copyText(text);
      setStatus("未登录或无回复框，草稿已复制", "err");
      window.open(target.url, "_blank", "noopener");
      return;
    }

    copyText(text);
    setStatus("草稿已复制，正在打开原生编辑页", "ok");
    window.open(target.url, "_blank", "noopener");
  }

  /* ---- 草稿 + 占位符随路由同步 ---- */

  const COMPOSER = { draftKey: "", sel: null };

  function syncComposer(page) {
    const edit = mdEditEl();
    if (!edit) return;
    const r = page.route;

    let placeholder = "发新话题…";
    let key = "v2cx:draft:new";
    if (r.kind === "topic" && page.topic) {
      placeholder = `回复「${page.topic.title}」…`;
      key = `v2cx:draft:t:${r.topicId}`;
    } else if (r.kind === "list") {
      const t = r.listKind === "node"
        ? (page.nodeHeader && page.nodeHeader.name) || r.node
        : listTitle(r);
      placeholder = `在 ${t} 发新话题…`;
      key = `v2cx:draft:l:${r.listKind}:${r.node || r.tab || r.tag || ""}`;
    }

    edit.dataset.placeholder = placeholder;

    // 只在真正换了目标时恢复草稿（否则会覆盖用户正在写的内容）
    if (COMPOSER.draftKey !== key) {
      COMPOSER.draftKey = key;
      edit.textContent = lsGet(key, "");
      setStatus("");
    }
    mdSyncState();
  }

  /* ---- 事件绑定（在 ensureMain 里调一次） ---- */

  function bindComposer(main) {
    const edit = main.querySelector(".v2cx-md-edit");
    const composer = main.querySelector(".v2cx-composer");
    if (!edit || !composer) return;

    edit.addEventListener("input", mdSyncState);

    // Enter 发送 / Shift+Enter 换行（对齐原脚本的「发送（Enter）」）
    edit.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        mdSend();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const k = (e.key || "").toLowerCase();
      if (k === "b") { e.preventDefault(); mdApply(opWrap("**", "**")); }
      else if (k === "i") { e.preventDefault(); mdApply(opWrap("*", "*")); }
      else if (k === "e") { e.preventDefault(); mdApply(opCode()); }
    });

    // 粘贴一律落成纯文本，避免把外部 HTML 带进编辑区
    edit.addEventListener("paste", (e) => {
      const text = (e.clipboardData || window.clipboardData)?.getData("text/plain");
      if (text == null) return;
      e.preventDefault();
      mdApply(opSnippet(text));
    });

    // 工具条按下时：先快照选区，再阻止默认行为。
    // 否则按钮会抢走 contenteditable 的焦点，选区在 click 处理器运行前就已经塔陷，
    // 包裹/引用会全部退化成「在末尾插入」。快照比依赖 focus 后的选区更可靠。
    composer.addEventListener("mousedown", (e) => {
      if (e.target.closest("[data-tool], [data-send], [data-emoji], [data-plus-item]")) {
        const box = mdEditEl();
        COMPOSER.sel = box ? caretOffsets(box) : null;
        e.preventDefault();
      }
    });

    // 工具条
    composer.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tool]");
      if (btn) {
        const tool = btn.dataset.tool;
        const pop = composer.querySelector("[data-plus-pop]");
        if (tool === "plus") {
          pop?.classList.toggle("on");
          return;
        }
        pop?.classList.remove("on");
        edit.focus();
        switch (tool) {
          case "bold": mdApply(opWrap("**", "**")); break;
          case "italic": mdApply(opWrap("*", "*")); break;
          case "strike": mdApply(opWrap("~~", "~~")); break;
          case "heading": mdApply(opHeading()); break;
          case "link": mdApply(opWrap("[", "](https://)")); break;
          case "quote": mdApply(opInsertAtLineStart("> ")); break;
          case "code": mdApply(opCode()); break;
          case "listUl": mdApply(opInsertAtLineStart("- ")); break;
          case "listOl": mdApply(opInsertAtLineStart("1. ")); break;
          case "image": mdApply(opSnippet("![](https://)")); break;
          case "emoji": {
            const picker = composer.querySelector("[data-emoji-pop]");
            if (picker) { picker.classList.toggle("on"); break; }
            const pop = el("div", "v2cx-plus-pop");
            pop.dataset.emojiPop = "1";
            pop.style.minWidth = "0";
            pop.style.width = "280px";
            pop.style.left = "auto";
            pop.style.right = "40px";
            pop.style.display = "block";
            pop.style.gridTemplateColumns = "repeat(8, 1fr)";
            pop.style.display = "grid";
            pop.innerHTML = EMOJIS.map((em) =>
              `<button type="button" data-emoji="${em}" style="font-size:16px;text-align:center;padding:4px 0">${em}</button>`).join("");
            composer.appendChild(pop);
            pop.classList.add("on");
            break;
          }
          case "preview": {
            composer.classList.toggle("preview-on");
            btn.classList.toggle("on", composer.classList.contains("preview-on"));
            mdSyncPreview();
            break;
          }
          default: break;
        }
        return;
      }

      const em = e.target.closest("[data-emoji]");
      if (em) {
        edit.focus();
        mdApply(opSnippet(em.dataset.emoji));
        composer.querySelector("[data-emoji-pop]")?.classList.remove("on");
        return;
      }

      const plus = e.target.closest("[data-plus-item]");
      if (plus) {
        const item = PLUS_ITEMS[Number(plus.dataset.plusItem)];
        if (item) { edit.focus(); mdApply(opSnippet(item.snippet)); }
        composer.querySelector("[data-plus-pop]")?.classList.remove("on");
        return;
      }

      if (e.target.closest("[data-send]")) { mdSend(); return; }

      const cancel = e.target.closest(".v2cx-compose-target button");
      if (cancel) {
        const box = composer.querySelector(".v2cx-compose-target");
        if (box) box.hidden = true;
        return;
      }

      // 点空白处收起弹层
      if (!e.target.closest("[data-plus-pop], [data-emoji-pop]")) {
        composer.querySelectorAll("[data-plus-pop], [data-emoji-pop]").forEach((p) => p.classList.remove("on"));
      }
    });
  }

  /* ============================== 三栏拖拽调宽 ============================== */

  /**
   * 两个拖拽把手：rail 右缘、代码面板左缘。
   *
   * 宽度在这里是「直接改 CSS 变量」而不是走 setCfg()，因为 mousemove 频率很高，
   * 每次都序列化写 localStorage 没必要；松手时才落到设置里。
   * 双击 = 重置回 DEFAULTS 里的默认宽度（不是回到当前设置值）。
   */
  function bindResizers(main) {
    document.querySelectorAll(".v2cx-resizer").forEach((rz) => {
      if (rz.dataset.bound === "1") return;
      rz.dataset.bound = "1";

      const isRail = rz.dataset.resize === "rail";
      const apply = (w) => {
        if (isRail) {
          document.documentElement.style.setProperty("--cx-rail-w", w + "px");
          const rail = document.querySelector(".v2cx-rail");
          if (rail) rail.style.width = w + "px";
        } else {
          document.documentElement.style.setProperty("--v2cx-panel-w", w + "px");
          if (main) main.style.setProperty("--v2cx-panel-w", w + "px");
        }
      };

      // 双击重置
      rz.addEventListener("dblclick", () => {
        const def = isRail ? RAIL_W : PANEL_DEFAULT_W;
        apply(def);
        setCfg(isRail ? "railWidth" : "panelWidth", def, { visualOnly: true });
        toastNow(isRail ? "侧栏宽度已重置" : "面板宽度已重置");
      });

      rz.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const rail = document.querySelector(".v2cx-rail");
        const startRail = rail ? rail.getBoundingClientRect().width : RAIL_W;
        const panelEl = (main || document).querySelector(".v2cx-code-panel");
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
          // 松手才持久化
          if (isRail) {
            const w = rail ? Math.round(rail.getBoundingClientRect().width) : RAIL_W;
            setCfg("railWidth", w, { visualOnly: true });
            syncSettingControls();
          } else {
            const el2 = (main || document).querySelector(".v2cx-code-panel");
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
    document.querySelector(".v2cx-lightbox")?.remove();
    lightboxOpen = false;
    document.removeEventListener("keydown", onLightboxKey);
  }

  function onLightboxKey(e) {
    if (e.key === "Escape") closeLightbox();
  }

  function openLightbox(src, alt) {
    hideImgPreview(); // 灯箱和悬浮预览别叠在一起
    closeLightbox();
    const box = el("div", "v2cx-lightbox");
    box.innerHTML = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt || "")}">
      <a class="v2cx-lb-open" href="${escapeHtml(src)}" target="_blank" rel="noopener">在新标签打开原图</a>`;
    box.addEventListener("click", (e) => {
      if (e.target === box) closeLightbox();
    });
    document.body.appendChild(box);
    lightboxOpen = true;
    document.addEventListener("keydown", onLightboxKey);
  }

  /** 委托：点击正文里的图片开灯箱 */
  function bindLightbox() {
    document.addEventListener("click", (e) => {
      const img = e.target.closest(".v2cx-cooked img, .v2cx-turn-user-bubble img");
      if (!img) return;
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
   * 原图 URL 优先取外层 <a href>（V2EX 会把原图放在那里），没有就用 src。
   * ================================================================= */

  let imgPreviewEl = null;
  let imgPreviewTarget = null;
  let imgPreviewTimer = null;

  const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)(\?|#|$)/i;

  function contentImgs(root) {
    return root.querySelectorAll(".v2cx-cooked img, .v2cx-turn-user-bubble img");
  }

  function fullImageUrl(img) {
    // 优先用 <img> 自己的 URL：缩略图就是同一张原图（只是被 CSS 缩小了），
    // 浏览器已经下载过，所以悬浮预览是零延迟、也不会多发一个请求。
    // 只有 src 缺失时才退回外层 <a href>（V2EX 把原图链接放在那里）。
    // 用 IDL 的 img.src：它返回浏览器实际请求的绝对 URL，
    // 与正文缩略图完全一致 → 保证命中缓存（currentSrc 要等加载完才有值）
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
    imgPreviewEl = el("div", "v2cx-imgpreview");
    imgPreviewEl.innerHTML =
      '<img alt="">' +
      '<span class="v2cx-ipv-load">载入中…</span>' +
      '<div class="v2cx-ipv-cap"><span class="v2cx-ipv-name" data-ipv-name></span>' +
      '<span class="v2cx-ipv-size" data-ipv-size></span></div>';
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

    // 优先放右侧，右侧放不下就放左侧，再放不下就夹在视口内
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
    // 大图还没到位时给个占位尺寸，否则盒子会塌成一个小胶囊还带破图图标
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
      // 尺寸已知，等一帧让布局稳定后校正位置
      requestAnimationFrame(() => { if (box.classList.contains("on")) placeImgPreview(img); });
    }
  }

  function hideImgPreview() {
    imgPreviewTarget = null;
    if (imgPreviewEl) imgPreviewEl.classList.remove("on");
  }

  /** 太小的图（表情、分割线）没必要缩略也没必要预览 */
  function markSmallImages(root) {
    contentImgs(root || document).forEach((img) => {
      if (img.dataset.sized === "1") return;
      img.dataset.sized = "1";
      const mark = () => {
        if (img.naturalWidth && img.naturalWidth <= 300 && img.naturalHeight <= 200) {
          img.dataset.noPreview = "1";
        }
      };
      if (img.complete) mark();
      else img.addEventListener("load", mark, { once: true });
    });
  }

  function bindImgPreview() {
    // 用捕获阶段 + mouseover：img 没有子节点，所以每个 img 只会触发一次
    document.addEventListener("mouseover", (e) => {
      const img = e.target && e.target.closest
        ? e.target.closest(".v2cx-cooked img, .v2cx-turn-user-bubble img") : null;
      if (!img || img.dataset.noPreview === "1") return;
      clearTimeout(imgPreviewTimer);
      showImgPreview(img);
    }, true);

    document.addEventListener("mouseout", (e) => {
      const img = e.target && e.target.closest
        ? e.target.closest(".v2cx-cooked img, .v2cx-turn-user-bubble img") : null;
      if (!img) return;
      clearTimeout(imgPreviewTimer);
      // 留一点延迟，方便鼠标从缩略图移到预览上（虽然预览 pointer-events:none）
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
   *   1. 标签页标题伪装成源码文件名（stealth 模式下不再出现 V2EX / 主题 字样）
   *   2. 应急伪装键：整个视口瞬间变成「代码编辑器 + 正在跑测试的终端」
   *
   * 伪装视图沿用同一套 token 和同一份假代码生成器，所以切换时看起来像
   * 在同一个 IDE 里换了个面板，而不是「网页变了」。
   * ================================================================= */

  /** 标签页标题 → "<文件名> — <项目名>"，和代码面板/伪装视图保持一致 */
  function syncTitle() {
    if (!cfg("stealth")) return;
    const L = CODE_LANGS[getLang()];
    const want = L.file + " \u2014 " + L.root;
    if (document.title !== want) document.title = want;
  }

  function bossOn() {
    return document.documentElement.classList.contains("v2cx-boss-on");
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
    out.push('<span class="dim">   Compiling ' + L.root + '-engine v0.9.3 (/Users/dev/work/' + L.root + '-engine)</span>');
    out.push('<span class="dim">   Compiling topic-cache v0.2.4</span>');
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
    out.push('<span class="cmd">$ <span class="v2cx-boss-caret"></span></span>');
    return out.join("\n");
  }

  function ensureBoss() {
    let box = document.querySelector(".v2cx-boss");
    if (box) return box;
    box = el("div", "v2cx-boss");
    box.hidden = true;
    box.innerHTML = '' +
      '<div class="v2cx-boss-bar">' +
      '  <span data-boss-tabs style="display:flex;align-items:center;gap:2px"></span>' +
      '  <span class="v2cx-boss-spacer"></span>' +
      '  <span class="v2cx-boss-shell" data-boss-shell></span>' +
      "</div>" +
      '<div class="v2cx-boss-editor" data-boss-code></div>' +
      '<div class="v2cx-boss-term">' +
      '  <div class="v2cx-boss-term-head"><span>Terminal</span><span>zsh</span><span>cargo</span></div>' +
      '  <pre class="v2cx-boss-term-body" data-boss-log></pre>' +
      "</div>";
    document.body.appendChild(box);
    return box;
  }

  function renderBoss() {
    const box = document.querySelector(".v2cx-boss");
    if (!box) return;
    const cur = getLang();
    const others = Object.keys(CODE_LANGS).filter((k) => k !== cur).slice(0, 2);
    const tabs = [cur].concat(others);

    const tabsEl = box.querySelector("[data-boss-tabs]");
    if (tabsEl) {
      tabsEl.innerHTML = tabs.map((k, i) => {
        const l = CODE_LANGS[k];
        return '<span class="v2cx-boss-tab' + (i === 0 ? " on" : "") + '">' +
          '<span class="ic">' + escapeHtml(l.icon) + "</span>" + escapeHtml(l.file) + "</span>";
      }).join("");
    }

    const L = CODE_LANGS[cur];
    const seed = panelSeed();
    const codeEl = box.querySelector("[data-boss-code]");
    if (codeEl) {
      const lines = genCodeLines(cur, seed);
      codeEl.innerHTML = lines.map((line, i) =>
        '<div class="v2cx-code-line"><span class="v2cx-ln">' + (i + 1) + '</span>' +
        '<span class="v2cx-src">' + highlightCode(line, L) + "</span></div>").join("");
      codeEl.scrollTop = 0;
    }
    const logEl = box.querySelector("[data-boss-log]");
    if (logEl) {
      logEl.innerHTML = bossLogHtml(seed);
      // 滚到底 —— 让末尾那个光标可见（布局可能晚一拍，所以补两次）
      const toBottom = () => { logEl.scrollTop = logEl.scrollHeight; };
      toBottom();
      requestAnimationFrame(toBottom);
    }
    const shellEl = box.querySelector("[data-boss-shell]");
    if (shellEl) shellEl.textContent = "~/work/" + L.root + "-engine";
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
    document.documentElement.classList.toggle("v2cx-boss-on", !!on);
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
        // 灯箱开着时 Esc 属于灯箱（Esc 要能关灯箱）
        if (lightboxOpen) return;
        // 其余情况一律允许：应急键的价值就在于「任何时候一按就藏」，
        // 所以即使在底部输入框里打字也照样生效。想在输入框里取消输入按 Ctrl+Shift+H 之外
        // 的单次 Esc 即可（单次 Esc 本来也不触发）。
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
   * 控件用一张声明式表描述（SETTING_SPEC），加新设置只需要往表里加一行 ——
   * 不用改 HTML、不用改事件绑定。
   *
   * 交互细节：拖滑块时只改 CSS 变量（previewSetting），松手才 setCfg() 落盘 +
   * 完整重渲染；否则每动一格都要重排整个列表。
   * ================================================================= */

  /** 该设置对应哪个 CSS 变量（拖拽时用来做即时预览） */
  const SETTING_CSS_VAR = {
    railWidth: "--cx-rail-w",
    panelWidth: "--v2cx-panel-w",
    threadMaxWidth: "--v2cx-thread-max",
    thumbWidth: "--v2cx-thumb-w",
    thumbHeight: "--v2cx-thumb-h"
  };

  const SETTING_SPEC = [
    { section: "外观", items: [
      { key: "theme", type: "select", label: "主题", hint: "「跟随站点」会读 V2EX 自己的明暗设置",
        options: [["auto", "跟随站点"], ["dark", "深色"], ["light", "浅色"]] },
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
        hint: "品牌名 → Codex、标签页标题 → 源码文件名、启用下面的应急键" },
      { key: "brandName", type: "text", label: "左栏品牌名",
        placeholder: "留空 = 跟随伪装模式" },
      { key: "projectName", type: "text", label: "项目名",
        hint: "出现在代码面板面包屑和标签页标题里（如 \"topic_cache.rs — platform\"）" },
      { key: "stealthKey", type: "select", label: "应急伪装键", hint: "Ctrl+Shift+H 始终有效",
        options: [["esc2", "连按两下 Esc"], ["f2", "F2"], ["ctrl+shift+h", "Ctrl+Shift+H"]] },
      { key: "favicon", type: "select", label: "标签页图标",
        options: [["codex", "Codex 风格圆角图标"], ["site", "保留 V2EX 原图标"]] }
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
    { section: "楼中楼", items: [
      { key: "quoteCard", type: "toggle", label: "把「@某人」渲染成引用卡片",
        hint: "V2EX 的楼中楼就是回复开头 @对方。开启后会在回复上方显示引用的是哪一楼、内容摘要，可折叠、可跳转" },
      { key: "quoteOpen", type: "toggle", label: "引用卡片默认展开" }
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
      return '<button type="button" class="v2cx-switch' + (v ? " on" : "") + '"' +
        ' role="switch" aria-checked="' + (v ? "true" : "false") + '"' +
        ' data-set-toggle="' + it.key + '" aria-label="' + escapeHtml(it.label) + '"><span></span></button>';
    }
    if (it.type === "range") {
      return '<input type="range" class="v2cx-range" data-set-range="' + it.key + '"' +
        ' min="' + it.min + '" max="' + it.max + '" step="' + it.step + '" value="' + v + '">' +
        '<span class="v2cx-set-val" data-set-val="' + it.key + '">' + v + (it.unit || "") + "</span>";
    }
    if (it.type === "select") {
      const opts = typeof it.options === "function" ? it.options() : it.options;
      return '<select class="v2cx-select" data-set-select="' + it.key + '">' +
        opts.map(([val, text]) =>
          '<option value="' + escapeHtml(val) + '"' +
          (String(v) === String(val) ? " selected" : "") + ">" + escapeHtml(text) + "</option>").join("") +
        "</select>";
    }
    return '<input type="text" class="v2cx-text" data-set-text="' + it.key + '" value="' +
      escapeHtml(v) + '" placeholder="' + escapeHtml(it.placeholder || "") + '">';
  }

  function settingsOpen() {
    const m = document.querySelector(".v2cx-modal");
    return !!m && !m.hidden;
  }

  function closeSettings() {
    const m = document.querySelector(".v2cx-modal");
    if (m) m.hidden = true;
  }

  /** 拖滑块时的即时预览：只改 CSS 变量，不写存储、不重渲染 */
  function previewSetting(key, value) {
    const varName = SETTING_CSS_VAR[key];
    if (varName) document.documentElement.style.setProperty(varName, value + "px");
  }

  /**
   * 把面板里所有控件的状态刷成 cfg() 的当前值。
   * 用于「别处改了设置」的场景（顶栏的面板开关、拖拽把手、恢复默认），
   * 面板没打开时直接跳过。
   */
  function syncSettingControls() {
    const m = document.querySelector(".v2cx-modal");
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
    let m = document.querySelector(".v2cx-modal");
    if (!m) {
      m = el("div", "v2cx-modal");
      m.hidden = true;
      document.body.appendChild(m);
    }
    const rows = SETTING_SPEC.map((g) =>
      '<div class="v2cx-set-section">' + escapeHtml(g.section) + "</div>" +
      g.items.map((it) =>
        '<div class="v2cx-set-row" data-row="' + it.key + '">' +
        '<div class="v2cx-set-label"><span>' + escapeHtml(it.label) + "</span>" +
        (it.hint ? '<div class="v2cx-set-hint">' + escapeHtml(it.hint) + "</div>" : "") +
        "</div>" +
        '<div class="v2cx-set-ctrl">' + settingControlHtml(it) + "</div>" +
        "</div>").join("")
    ).join("");

    m.innerHTML =
      '<div class="v2cx-modal-card" role="dialog" aria-modal="true" aria-label="设置">' +
      '<div class="v2cx-modal-head">' +
      '<span class="v2cx-modal-title">设置</span>' +
      '<span class="v2cx-modal-sub">改动即时生效并存在本机</span>' +
      '<button type="button" class="v2cx-modal-x" data-settings-close title="关闭（Esc）">×</button>' +
      "</div>" +
      '<div class="v2cx-modal-body">' + rows + "</div>" +
      '<div class="v2cx-modal-foot">' +
      '<button type="button" class="v2cx-modal-btn" data-settings-reset>恢复默认</button>' +
      '<span>设置存在 localStorage 的 <code>v2cx:settings</code>，清掉就回到初始状态</span>' +
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
    // 面板是常驻 DOM（懒建），所以事件只绑一次
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest && t.closest("[data-settings-open]")) { openSettings(); return; }
      if (!settingsOpen()) return;

      const m = document.querySelector(".v2cx-modal");
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
      if (!r.dataset || !r.dataset.setRange) return;
      const key = r.dataset.setRange;
      const it = specItem(key);
      previewSetting(key, Number(r.value));
      const out = document.querySelector('[data-set-val="' + key + '"]');
      if (out) out.textContent = r.value + ((it && it.unit) || "");
      // 文本类输入也需要即时反馈（品牌名 / 项目名 → 标题、rail）
      if (key === "brandName" || key === "projectName") {
        if (!SETTINGS) SETTINGS = loadSettings();
        SETTINGS[key] = r.value;
        applyVisualSettings();
      }
    });

    document.addEventListener("input", (e) => {
      const r = e.target;
      if (!r.dataset || !r.dataset.setText) return;
      const key = r.dataset.setText;
      if (!SETTINGS) SETTINGS = loadSettings();
      SETTINGS[key] = r.value;
      applyVisualSettings();
    });

    // 落盘：range / select / text 都在 change 时做完整应用
    document.addEventListener("change", (e) => {
      const r = e.target;
      if (!r.dataset) return;
      if (r.dataset.setRange) {
        setCfg(r.dataset.setRange, Number(r.value));
      } else if (r.dataset.setSelect) {
        setCfg(r.dataset.setSelect, r.value);
      } else if (r.dataset.setText) {
        setCfg(r.dataset.setText, r.value);
      }
    });
  }

  /* ============================== 编排 ============================== */

  /** 其他 Codex 风格脚本在跑时避让（原脚本的互斥约定） */
  function otherThemeActive() {
    const root = document.documentElement;
    return root.classList.contains("codex-theme") ||
      root.classList.contains("feishu-im-theme") ||
      root.classList.contains("idea-ide-theme") ||
      !!document.getElementById("linuxdo-codex-theme") ||
      !!document.getElementById("linuxdo-idea-theme");
  }

  let scheduled = false;
  function scheduleApply() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        if (otherThemeActive()) {
          document.documentElement.classList.remove(ROOT_CLASS, LOCK_CLASS, "v2cx-rail-open");
          document.querySelector(".v2cx-main")?.remove();
          document.querySelector(".v2cx-rail")?.remove();
          return;
        }
        document.documentElement.classList.add(ROOT_CLASS);
        syncMode();
        render();
      } catch (err) {
        // 解析失败时绝不破坏原站：撤掉接管，回退原生页面
        console.error("[v2ex-codex] 渲染失败，已回退原生页面", err);
        document.documentElement.classList.remove(ROOT_CLASS, LOCK_CLASS, "v2cx-rail-open");
        document.querySelector(".v2cx-main")?.remove();
        document.querySelector(".v2cx-rail")?.remove();
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
      // 尽早加 LOCK_CLASS，避免原生页面闪一下
      if (isSupported(route())) document.documentElement.classList.add(LOCK_CLASS);
      applyFavicon();
    }
    applyVisualSettings();

    // 标签重新可见时再刷一次 favicon（部分浏览器未聚焦时会缓存旧图标）
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !otherThemeActive()) applyFavicon();
    });

    bindLightbox();
    bindImgPreview();
    bindSettingsPanel();
    bindStealthKeys();
    bindSettingsKeys();

    domReady().then(() => {
      scheduleApply();

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
    });
  }

  bootstrap();
})();
