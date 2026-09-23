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
    // 进不进伪装由「伪装模式」开关说了算，但**退出永远允许** ——
    // 否则在伪装视图里关掉 stealth 会卡在那个假界面上出不来。
    if (on && !cfg("stealth")) return;
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

  /**
   * 用户自己按的应急键 → 清掉「自动」标记。
   * 否则鼠标回到页面时会把用户手动按出来的这次伪装替你还原掉
   * （或者反过来：手动退出后鼠标一离开又被自动切进去，看着像失灵）。
   */
  function toggleBossManual() {
    autoBoss = false;
    setBoss(!bossOn());
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
          toggleBossManual();
        } else {
          lastEscAt = now;
        }
        return;
      }
      if (bossKeyMatch(e, spec) || bossKeyMatch(e, "ctrl+shift+h")) {
        e.preventDefault();
        e.stopPropagation();
        toggleBossManual();
      }
    }, true);
  }

  /* ============================== 侧边栏模式 ==============================
   *
   * 「侧边栏模式」：实时盯着鼠标，指针一离开页面区域（浏览器视口）就自动切到
   * 应急伪装 —— 用的就是上面 setBoss() 那套视图，跟连按两下 Esc 完全同一个东西。
   *
   * 为什么用 mouseout/mouseover + relatedTarget，而不用 window.blur：
   *   relatedTarget 为 null 表示指针去的是页面之外（浏览器地址栏/书签栏、
   *   别的窗口、桌面）。blur 太宽了 —— 点一下地址栏、开一下 devtools、
   *   在 iframe 里点一下都可能 blur，但鼠标其实还停在页面上，
   *   那不是「离开页面区域」。
   *
   * 三处刻意的取舍：
   *   1. 只自动还原「自动触发」的那次（autoBoss 标记）。用户自己按应急键进出的
   *      伪装一律不碰：手动进入的不会被鼠标回来还原，手动退出后也不会被
   *      鼠标一离开又切进去（那看起来就像按键失灵）。
   *   2. 设置面板开着时不触发 —— 调滑杆时鼠标很容易扫出窗口，
   *      那时候整屏切成伪装会把正在调的面板盖住。
   *   3. 「回来自动还原」是个开关（sidebarRestore）：关掉就变单向，
   *      离开即伪装，只能自己按应急键还原。
   *
   * 监听本身随设置挂 / 摘（见 syncSidebarMode），关掉时页面在事件层面
   * 和没有这个功能完全一样。
   * ===================================================================== */

  /** 当前这次伪装是不是「鼠标离开」自动触发的 */
  let autoBoss = false;
  let sidebarMouseBound = false;

  function sidebarModeWanted() {
    return !!cfg("sidebarMode") && !!cfg("stealth");
  }

  function onSidebarMouseOut(e) {
    if (e.relatedTarget) return;          // 还在文档里，只是从一个元素挪到另一个
    if (!sidebarModeWanted()) return;
    if (bossOn()) return;                 // 已经是伪装视图（自动的或手动的）
    if (settingsOpen()) return;           // 别把用户正在调的设置面板盖掉
    autoBoss = true;
    setBoss(true);
  }

  function onSidebarMouseOver(e) {
    if (e.relatedTarget) return;          // 文档内部移动，不是从外面回来
    if (!autoBoss) return;                // 手动进入的伪装不归这里管
    if (!cfg("sidebarRestore")) return;   // 用户选了「不自动还原」
    autoBoss = false;
    if (bossOn()) setBoss(false);
  }

  function bindSidebarMode() {
    if (sidebarMouseBound) return;
    sidebarMouseBound = true;
    document.addEventListener("mouseout", onSidebarMouseOut, true);
    document.addEventListener("mouseover", onSidebarMouseOver, true);
  }

  function unbindSidebarMode() {
    if (!sidebarMouseBound) return;
    sidebarMouseBound = false;
    document.removeEventListener("mouseout", onSidebarMouseOut, true);
    document.removeEventListener("mouseover", onSidebarMouseOver, true);
  }

  /** 让监听状态跟上设置：开着就挂，关掉就摘（顺手把自动伪装还原掉） */
  function syncSidebarMode() {
    if (sidebarModeWanted()) { bindSidebarMode(); return; }
    unbindSidebarMode();
    if (autoBoss) {
      autoBoss = false;
      if (bossOn()) setBoss(false);
    }
  }

  /* ============================== 设置面板 ==============================
   *
   * 控件用一张声明式表描述（SETTING_SPEC），加新设置只需要往表里加一行。
   * 交互细节：拖滑块时只改 CSS 变量（previewSetting），松手才 setCfg() 落盘 +
   * 完整重渲染；否则每动一格都要重排整个列表。
   * =================================================================== */

  /**
   * 哪些设置直接落在 CSS 变量上（拖滑杆时只改这些，不重渲染）。
   * unit 是直接拼在数字后面的单位；to 是自定义换算（透明度是 20~100% 的读数 →
   * 0~1 的无单位数，见 p1 的 opacityVar）。
   */
  const SETTING_CSS_VAR = {
    railWidth: { name: "--cx-rail-w", unit: "px" },
    panelWidth: { name: "--ngax-panel-w", unit: "px" },
    threadMaxWidth: { name: "--ngax-thread-max", unit: "px" },
    thumbWidth: { name: "--ngax-thumb-w", unit: "px" },
    thumbHeight: { name: "--ngax-thumb-h", unit: "px" },
    pageOpacity: { name: "--ngax-opacity", to: opacityVar }
  };

  /** 设置值 → CSS 变量值（没登记在这张表里的设置返回 null） */
  function cssVarValue(key, value) {
    const m = SETTING_CSS_VAR[key];
    if (!m) return null;
    return m.to ? m.to(value) : String(value) + (m.unit || "");
  }

  const SETTING_SPEC = [
    { section: "外观", items: [
      { key: "theme", type: "select", label: "主题", hint: "「跟随 NGA」会读站点自己的夜间模式设置",
        options: [["auto", "跟随 NGA"], ["dark", "深色"], ["light", "浅色"]] },
      { key: "railWidth", type: "range", label: "左栏宽度", min: 200, max: 520, step: 2, unit: "px" },
      { key: "panelWidth", type: "range", label: "代码面板宽度", min: 240, max: 900, step: 4, unit: "px" },
      { key: "threadMaxWidth", type: "range", label: "正文最大宽度", min: 560, max: 1100, step: 10, unit: "px" },
      { key: "pageOpacity", type: "range", label: "页面透明度", min: 20, max: 100, step: 1, unit: "%",
        hint: "只把脚本自绘的界面（左栏 + 主区）调淡；设置面板 / 灯箱 / 伪装视图保持不透明" },
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
      { key: "sidebarMode", type: "toggle", label: "侧边栏模式",
        hint: "鼠标一离开页面区域就自动切到应急伪装（和连按两下 Esc 同一个视图）；需要「伪装模式」开着" },
      { key: "sidebarRestore", type: "toggle", label: "侧边栏模式：回来自动还原",
        hint: "只还原「鼠标离开」触发的那次；关掉后离开即伪装，要自己按应急键还原" },
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
    const v = cssVarValue(key, value);
    if (v === null) return;
    document.documentElement.style.setProperty(SETTING_CSS_VAR[key].name, v);
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

/*__RAW_CSS__*/

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
