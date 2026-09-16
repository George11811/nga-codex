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

  /*__SMILES__*/

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
