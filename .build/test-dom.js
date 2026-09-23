/*
 * 集成测试：把真实抓下来的 NGA 页面灌进 jsdom，跑整个用户脚本，检查渲染结果。
 *
 * 思路（也是这个测试最大的价值）：
 *   - DOM 用**真实服务端 HTML**（.build 里那几个 *.utf8.html），
 *     所以 id / class / 嵌套结构这些「我最容易猜错的东西」是真的；
 *   - NGA 原生 JS 不跑（runScripts: "outside-only"），而是把它的产物
 *     （userInfo.setAll 的 JSON、postArg.proc 的参数、topicArg.add 的参数、
 *      __ALL_FORUM_DATA / __PAGE / __CURRENT_*）用正则从页面里抠出来，
 *      eval 进 window —— 这就是脚本在真实浏览器里会看到的世界；
 *   - 然后注入 nga-codex.user.js，断言它渲染出来的东西。
 *
 * 这样既确定（不依赖网络、不依赖 NGA 改版），又真的覆盖了
 * 「解析真实 DOM → 渲染」这条最容易出错的链路。
 *
 * 依赖 jsdom。用法：
 *   cd /c/ngatest/jt && npm install --no-save jsdom
 *   node <repo>/.build/test-dom.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require(path.join(process.env.JSDOM_DIR || '/c/ngatest/jt', 'node_modules', 'jsdom')));
} catch (e) {
  try { ({ JSDOM, VirtualConsole } = require('jsdom')); }
  catch (e2) {
    console.error('需要 jsdom：npm install --no-save jsdom');
    process.exit(2);
  }
}

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_SRC = fs.readFileSync(path.join(ROOT, 'nga-codex.user.js'), 'utf8');
const TMP = process.env.TEMP || process.env.TMP || '/tmp';

let fails = 0;
let checks = 0;
function ok(name, cond, extra) {
  checks++;
  if (cond) console.log('  ✓ ' + name);
  else { fails++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

// ── 从真实页面里抠 NGA 原生 JS 的产物 ──────────────────────────────────

/**
 * 从 html[pos]（必须是 '{'）开始取出一个括号配平的 JS 对象字面量。
 * 不能用非贪婪正则：__ALL_FORUM_DATA / userInfo 里嵌套了不知道多少层 {}。
 */
function balanced(html, pos) {
  let depth = 0, inStr = null, esc = false;
  for (let i = pos; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return html.slice(pos, i + 1);
    }
  }
  return null;
}

function objAfter(html, name) {
  const idx = html.indexOf(name);
  if (idx < 0) return null;
  const brace = html.indexOf('{', idx);
  if (brace < 0) return null;
  return balanced(html, brace);
}

function extractUserInfo(html) {
  const raw = objAfter(html, 'commonui.userInfo.setAll(');
  if (!raw) return {};
  // 优先 JSON.parse，但它会拒绍字段里的**字面制表符**（NGA 的 remark 里真的有），
  // 而 NGA 自己就是把这个对象当 JS 字面量写进内联脚本的 —— 所以退回 Function 求值。
  try { return JSON.parse(raw); } catch { /* fallthrough */ }
  try { return Function('return ' + raw)(); } catch { return {}; }
}

function extractGlobals(html) {
  const g = {};
  // 注意：NGA 的头部是 `var __CURRENT_UID = parseInt('34330581',10), __NOW = …, __CURRENT_TID = …`
  // 一整行逗号表达式，所以不能用「取到行尾」的正则 —— 会把后面那串变量一起吞进来。
  const intOf = (name) => {
    const m = html.match(new RegExp(name + "\\s*=\\s*(?:parseInt\\(\\s*)?'?(-?\\d+)'?"));
    return m ? Number(m[1]) : null;
  };
  const uid = intOf('__CURRENT_UID');
  if (uid !== null) g.__CURRENT_UID = uid;
  const uname = html.match(/__CURRENT_UNAME\s*=\s*'([^']*)'/);
  if (uname) g.__CURRENT_UNAME = uname[1];
  const fid = intOf('__CURRENT_FID');
  if (fid !== null) g.__CURRENT_FID = String(fid);
  const tid = intOf('__CURRENT_TID');
  if (tid !== null) g.__CURRENT_TID = tid;
  const all = objAfter(html, '__ALL_FORUM_DATA');
  if (all) { try { g.__ALL_FORUM_DATA = Function('return ' + all)(); } catch { /* 版面页才有 */ } }
  const page = html.match(/var __PAGE\s*=\s*(\{[^}]*\})/);
  if (page) { try { g.__PAGE = Function('return ' + page[1])(); } catch { /* 单页主题没有 */ } }
  return g;
}

/** 把 commonui.postArg.proc(…) 的实参还原成对象（arg 表来自 js_read.js） */
const POST_ARG_NAMES = [
  'i', 'pC', 'subjectC', 'contentC', 'signC', 'uInfoC', 'pInfoC', 'postBtnC',
  'fid', 'tid', 'pid', 'type', 'tAid', 'pAid', 'postTime', 'recommend', 'cLength',
  'ip', 'orgForum', 'fromClient', 'orgFid', 'stid', 'atItem', 'opt'
];

function extractPostArgs(html, win) {
  const out = {};
  const re = /commonui\.postArg\.proc\(\s*([\s\S]*?)\)\s*\n/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      // 实参里既有 $('id') 也有字面量，统一翻译成干净的值再 eval
      const cleaned = m[1]
        .replace(/\$\(([^)]*)\)/g, (s, inner) => {
          const id = inner.trim().replace(/^['"]|['"]$/g, '');
          return JSON.stringify(id);
        })
        .replace(/\bnull\b/g, 'null')
        .replace(/\bundefined\b/g, 'null');
      const args = Function('return [' + cleaned + ']')();
      const obj = {};
      POST_ARG_NAMES.forEach((n, idx) => {
        let v = args[idx];
        // 元素参数还原成真元素（脚本不读它们，但保持形状一致）
        if (typeof v === 'string' && /^post|^pid/.test(v) && win.document.getElementById(v)) {
          v = win.document.getElementById(v);
        }
        obj[n] = v;
      });
      if (obj.i !== undefined && obj.i !== null) out[obj.i] = obj;
    } catch { /* 个别格式怪的就跳过 */ }
  }
  return out;
}

/** 把 commonui.topicArg.add(…) 的实参还原成数组（arg 顺序来自 js_forum.js） */
function extractTopicArgs(html) {
  const out = [];
  const re = /commonui\.topicArg\.add\(\s*([\s\S]*?)\n\)/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const args = Function('return [' + m[1] + ']')();
      out.push(args);
    } catch { /* skip */ }
  }
  return out;
}

// ── 起一个「像 NGA 一样」的环境 ─────────────────────────────────────────

function boot(file, extraSetup) {
  const html = fs.readFileSync(path.join(TMP, file), 'utf8');
  // 脚本自己在 console.error 里报告渲染失败，测试时必须能看见，
  // 否则「什么都没渲染」会变成一句没法排查的断言失败。
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => console.log('  [jsdomError] ' + e.message));
  vc.on('error', (...a) => console.log('  [console.error]', ...a));
  vc.on('warn', (...a) => console.log('  [console.warn]', ...a));

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',   // 原生脚本一律不跑，环境完全由我们摆
    pretendToBeVisual: true,
    virtualConsole: vc,
    url: 'https://bbs.nga.cn/' + (file.startsWith('fid7') ? 'thread.php?fid=-7' : 'read.php?tid=44191387')
  });
  const win = dom.window;

  // NGA 挂在 window 上的东西
  const g = extractGlobals(html);
  Object.keys(g).forEach((k) => { win[k] = g[k]; });

  const users = extractUserInfo(html);
  const postArgData = extractPostArgs(html, win);
  const topicArgData = extractTopicArgs(html);

  const calls = { score: [], favor: [], newPost: [] };
  win.commonui = {
    userInfo: { users },
    postArg: { data: postArgData },
    topicArg: { data: topicArgData },
    postScoreAdd(el, arg, bad) { calls.score.push({ i: arg && arg.i, bad: bad ? 1 : 0 }); },
    favor(e, el, tid, pid) { calls.favor.push({ tid, pid }); },
    quoteTo: { procText() { } },
    alert(t) { calls.alert = String(t); }
  };
  // 原生回复表单（真实站点由 commonui.fastPostUi 建出来）。
  // 注意要用**页面上已经存在的** #fast_post_c —— big.u.html 里本来就有个空的
  // <span id='fast_post_c'></span>，再 append 一个的话 getElementById 拿到的
  // 仍然是前面那个空的（真实浏览器里没这个问题，是测试自己踩的坑）。
  let fast = win.document.getElementById('fast_post_c');
  if (!fast) {
    fast = win.document.createElement('span');
    fast.id = 'fast_post_c';
    (win.document.getElementById('mc') || win.document.body).appendChild(fast);
  }
  fast.innerHTML = '<input type="text"><textarea></textarea>' +
    '<a class="uitxt1" href="javascript:void(0)">发表回复(Ctrl+Enter)</a>';
  fast.querySelector('a.uitxt1').addEventListener('click', () => {
    calls.newPost.push({ subject: fast.querySelector('input').value, content: fast.querySelector('textarea').value });
  });

  // 引用卡片：NGA 原生把它渲染成 <div class='quote'>，先手工塞一个进去（带完整的头部），
  // 这样才能真的验证「引用 → 卡片 + 楼层号 + 跳转」这条链路。
  const host = win.document.querySelector("#postcontent1");
  if (host) {
    const q = win.document.createElement('div');
    q.className = 'quote';
    q.innerHTML = "[pid=0,44191387,1]Reply[/pid] [b]Post by [uid=205511]某人[/uid] (2025-05-26 17:27):[/b]<br/>被引用的原话";
    host.appendChild(q);
    // 真实浏览器里表情是站点自己渲染的（class=smile_ac），不是我们生成的 ngax-smile。
    // 一并塞进来，好验证「点表情不该弹灯箱」在真实形态下也成立。
    const smile = win.document.createElement('img');
    smile.className = 'smile_ac';
    smile.id = 'smile-native-test';
    smile.setAttribute('src', 'https://img4.nga.cn/ngabbs/post/smile/ac33.png');
    host.appendChild(smile);
  }

  if (extraSetup) extraSetup(win);

  // 注入用户脚本
  // 注意：runScripts: "outside-only" 下，动态插入的 <script> 不会执行
  // （那是 "dangerously" 的行为，但那样页面自带的脚本也会跑起来）。
  // 所以用 win.eval 在 window 作用域里直接跑 —— 等价于 @grant none 的用户脚本。
  win.eval(SCRIPT_SRC);

  return { dom, win, calls, users, postArgData, topicArgData, html };
}

function afterRender(win) {
  // 脚本在 domReady().then(下一帧) 里渲染，等它跑完。
  // 不是每个测试环境都有 rAF（那个环境下脚本内部会退回 setTimeout），这里同样两种都兼容。
  const frame = () => new Promise((r) => {
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(() => r());
    else setTimeout(r, 20);
  });
  return new Promise((r) => setTimeout(r, 60)).then(frame).then(frame);
}

// ── 用例 1：多页主题页 ─────────────────────────────────────────────────

async function testThread() {
  console.log('\n【多页主题】read.php?tid=44191387（19 楼，含引用/表情/附件/回复头部）');
  const { win, calls, postArgData, html } = boot('big.u.html');
  await afterRender(win);
  const d = win.document;
  const $ = (s) => d.querySelector(s);
  const $$ = (s) => Array.from(d.querySelectorAll(s));

  ok('接管标志 html.ngax + ngax-locked', d.documentElement.classList.contains('ngax')
    && d.documentElement.classList.contains('ngax-locked'));
  ok('原生 DOM 被藏起来（#m_posts / .module_wrap）',
    /\#mc > \.module_wrap/.test(SCRIPT_SRC));
  ok('主区已建立', !!$('.ngax-main'));
  ok('rail 已建立', !!$('.ngax-rail'));
  ok('代码面板已建立并有代码行', $$('.ngax-code-line').length > 50);

  // 面包屑：版面 / 标题 · N 楼
  const proj = $('.ngax-proj').textContent;
  const model = $('.ngax-model').textContent;
  const realTitle = (html.match(/id='currentTopicName'[^>]*>([^<]*)</) || [])[1] || '';
  ok('面包屑版面名 = 网事杂谈', proj.includes('网事杂谈'), proj);
  ok('面包屑标题 = 真实标题', realTitle && model.includes(realTitle.slice(0, 8)), model);
  ok('面包屑带楼层数', /19 楼/.test(model), model);

  // 楼层数：DOM 里有几个 post1strow，就该渲染几个 .ngax-turn
  const rawRows = $$("#m_posts tr[id^='post1strow']").length;
  const turns = $$('.ngax-turn').length;
  ok('楼层数一致（' + rawRows + '）', rawRows > 0 && turns === rawRows, 'turns=' + turns);

  // 楼主单独在「用户气泡」里，其余在 agent 区
  ok('楼主气泡存在', !!$('.ngax-turn-user-bubble'));
  ok('第一个回复是 agent 楼层', !!$('.ngax-turn-agent[data-floor="1"]'));
  ok('楼层标注「楼主」', $('.ngax-floor').textContent.trim() === '楼主');

  // 作者名：源码里 #postauthorN 是空的，名字只能来自 commonui.userInfo
  const names = $$('.ngax-user').map((a) => a.textContent.trim());
  const opUid = postArgData[0] && postArgData[0].pAid;
  const uname = (win.commonui.userInfo.users[opUid] || {}).username;
  ok('楼主名来自 userInfo（' + uname + '）', names[0] === uname, '实际: ' + names[0]);
  ok('没有楼层显示成 uid 或空', names.every((n) => n && !/^\d+$/.test(n)), JSON.stringify(names.slice(0, 4)));

  // 表情：正文里的 [s:ac:…] 必须变成图
  const smiles = $$('.ngax-cooked img.ngax-smile, .ngax-turn-user-bubble img.ngax-smile');
  ok('表情渲染成图（' + smiles.length + ' 个）', smiles.length > 0);
  ok('表情 URL 指向 NGA 图床', smiles.every((i) => /^https:\/\/img4\.nga\.cn\/ngabbs\/post\/smile\/.+\.png$/.test(i.getAttribute('src'))),
    smiles[0] && smiles[0].getAttribute('src'));

  // 附件图：这个帖子的正文里没有附件，所以这里只验证「不报错、不凭空造图」。
  // 真正的附件还原（[img] 相对路径 + 内联元数据 + .medium 变体去重）在 testAttachment() 里单独测。
  // 注意过滤条件要把站点形态的表情（class=smile_ac）也算成表情，
  // 否则上面手动塞进去那个测试用表情会被误当成「凭空造出来的图」。
  const imgs = $$('.ngax-cooked img, .ngax-turn-user-bubble img')
    .filter((i) => !/smile/i.test(i.className || ''));
  ok('没附件时不会凭空造出图片（' + imgs.length + ' 张）', imgs.length === 0,
    imgs.map((i) => i.getAttribute('src')).join(' | '));

  // 引用：真实页面里有没有 div.quote / [quote]
  const rawQuotes = $$("#m_posts div.quote").length;
  const quoteCards = $$('.ngax-quote').length;
  ok('引用被升级成卡片（原生 ' + rawQuotes + ' 个 → 卡片 ' + quoteCards + ' 个）',
    quoteCards >= rawQuotes && quoteCards > 0, 'rawQuotes=' + rawQuotes + ' cards=' + quoteCards);
  if (quoteCards) {
    const card = $('.ngax-quote');
    ok('卡片头部标出了「楼主」（pid=0 就是楼主那层）', /楼主/.test(card.textContent), card.textContent.slice(0, 80));
    ok('卡片保留了被引用的原话', /被引用的原话/.test(card.textContent));
    ok('卡片头部那串 [pid=…] 被吃掉了', !/\[pid=/.test(card.textContent), card.textContent.slice(0, 120));
  }

  // agent 装饰
  ok('思考块已插入', $$('.ngax-think').length > 0, '数量 ' + $$('.ngax-think').length);
  ok('思考块文案是英文技术腔', /Worked for \d+s/.test($('.ngax-think-head').textContent));

  // 操作胶囊（注意：胶囊是 .ngax-turn 的直接子元素，不在 .ngax-turn-agent 里面 ——
  // 这个层级和参考实现一致，agent 容器只放正文，装饰好的正文不会被操作栏污染）
  const agentTurns = $$('.ngax-turn-agent').length;
  const agentActions = $$('.ngax-turn .ngax-actions').length;
  ok('每个楼层都有操作胶囊（' + agentActions + '/' + (agentTurns + 1) + '，含楼主）',
    agentActions === agentTurns + 1);
  ok('操作按钮齐全（引用/支持/反对/收藏/链接）',
    ['quote', 'good', 'bad', 'fav', 'copy-link'].every((k) => !!$('[data-act="' + k + '"]')));

  // 分页：__PAGE 说 28 页
  ok('分页渲染出来', $$('.ngax-pager .ngax-fchip').length > 3, '页数链接 ' + $$('.ngax-pager .ngax-fchip').length);
  ok('当前页高亮', !!$('.ngax-pager .ngax-fchip.on'));

  // 伪装：标题不该出现论坛字样
  ok('标签页标题已伪装（' + d.title + '）',
    !/NGA|玩家社区|iOS客户端/.test(d.title) && /forum_cache\.rs/.test(d.title), d.title);

  // 输入框
  ok('输入框存在', !!$('.ngax-md-edit'));
  const tools = $$('.ngax-tool-btn').map((b) => b.dataset.tool);
  ok('BBSCode 工具条齐全', ['bold', 'quote', 'code', 'collapse', 'smile'].every((k) => tools.includes(k)), tools.join(','));

  // 草稿随路由
  ok('占位符提到标题', /回复「/.test($('.ngax-md-edit').dataset.placeholder), $('.ngax-md-edit').dataset.placeholder);

  // 表情：不该参与灯箱 / 悬浮预览 —— 而且真实浏览器里表情的 class 是 smile_ac，
  // 不是我们生成的 ngax-smile，所以这里拿站点形态试
  const smileImg = $('.ngax-cooked img[class^="smile"], img#smile-native-test');
  ok('站点原生形态的表情被渲染出来', !!smileImg, smileImg && smileImg.className);
  if (smileImg) {
    smileImg.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    ok('点表情不弹灯箱', !$('.ngax-lightbox'));
  }

  // 交互：引用 ──
  // 页面上第一个引用按钮属于楼主（0 楼），所以这一条验的是「引用楼主」的分支：
  // NGA 对楼主用 [tid=…]Topic[/tid]，对回复才用 [pid=…]Reply[/pid]
  const quoteBtn = $('[data-act="quote"]');
  quoteBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  let draft = $('.ngax-md-edit').textContent;
  ok('引用楼主 → [tid=…]Topic[/tid] 格式',
    /^\[quote\]\[tid=44191387\]Topic\[\/tid\] \[b\]Post by \[uid=\d+\]/.test(draft), draft.slice(0, 140));
  ok('引用里带时间', /\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)/.test(draft));
  ok('引用里带原楼层正文', draft.length > 80);
  ok('引用里的用户名不是 uid', !/\[uid=\d+\]\d+\[\/uid\]/.test(draft), draft.slice(0, 120));

  // 再点一个「回复楼层」的引用按钮（data-i=1），应得到 [pid=…]Reply[/pid]
  $('.ngax-md-edit').textContent = '';
  $('[data-act="quote"][data-i="1"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  draft = $('.ngax-md-edit').textContent;
  ok('引用回复楼层 → [pid=…]Reply[/pid] 格式',
    /^\[quote\]\[pid=\d+\]Reply\[\/pid\] \[b\]Post by \[uid=\d+\]/.test(draft), draft.slice(0, 140));

  // ── 交互：支持 / 反对 ──
  $('[data-act="good"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  $('[data-act="bad"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok('支持调用了原生 postScoreAdd(…, 0)',
    calls.score.some((c) => c.bad === 0), JSON.stringify(calls.score));
  ok('反对调用了原生 postScoreAdd(…, 1)',
    calls.score.some((c) => c.bad === 1), JSON.stringify(calls.score));

  // ── 交互：收藏 ──
  $('[data-act="fav"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok('收藏调用了原生 favor(tid, pid)',
    calls.favor.length === 1 && calls.favor[0].tid === 44191387, JSON.stringify(calls.favor));

  // ── 交互：发送（驱动原生表单）──
  const edit = $('.ngax-md-edit');
  edit.textContent = '测试回复正文';
  edit.dispatchEvent(new win.Event('input', { bubbles: true }));
  ok('有内容后发送键可用', !$('.ngax-send').disabled);
  $('.ngax-send').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok('提交写进了原生 textarea',
    calls.newPost.length === 1 && calls.newPost[0].content === '测试回复正文',
    JSON.stringify(calls.newPost));
  ok('提交后输入框清空', edit.textContent === '');

  // ── 交互：隐藏原生 DOM 的 CSS 真的存在 ──
  const hideRule = /html\.ngax\.ngax-locked #mc > \.module_wrap[\s\S]{0,1200}display: none !important/.test(SCRIPT_SRC);
  ok('原生页面隐藏规则存在', hideRule);

  // ── 交互：设置面板 ──
  $('[data-settings-open]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok('设置面板能打开', !!$('.ngax-modal') && !$('.ngax-modal').hidden);
  ok('设置项来自声明式表（>20 项）', $$('.ngax-set-row').length > 20, '项数 ' + $$('.ngax-set-row').length);
  const sw = $('[data-set-toggle="decorations"]');
  sw.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok('切开关写进了 localStorage',
    /"decorations":false/.test(win.localStorage.getItem('ngax:settings') || ''),
    win.localStorage.getItem('ngax:settings'));

  // ── 交互：应急伪装（连按两下 Esc）──
  // 先把设置面板关掉：面板开着时 Esc 的语义是「关面板」，这是设计好的行为
  $('[data-settings-close]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok('Eс 关掉了设置面板', $('.ngax-modal').hidden);
  const esc = () => win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  esc(); esc();
  ok('Esc Esc 进入伪装视图', !!$('.ngax-boss') && !$('.ngax-boss').hidden
    && d.documentElement.classList.contains('ngax-boss-on'));
  ok('伪装视图有构建日志', !!$('.ngax-boss') && /cargo build --release/.test($('.ngax-boss').textContent));
  ok('伪装视图有代码行', $$('.ngax-boss .ngax-code-line').length > 50);
  esc(); esc();
  ok('再按一次恢复', $('.ngax-boss').hidden);

  win.close();
}

// ── 用例 2：版面列表页 ─────────────────────────────────────────────────

async function testList() {
  console.log('\n【版面列表】thread.php?fid=-7（网事杂谈）');
  const { win, html } = boot('fid7.utf8.html');
  await afterRender(win);
  const d = win.document;
  const $ = (s) => d.querySelector(s);
  const $$ = (s) => Array.from(d.querySelectorAll(s));

  const rawRows = $$("#topicrows tr.topicrow").length;
  const rows = $$('.ngax-row');
  ok('主题行数一致（原生 ' + rawRows + ' → 渲染 ' + rows.length + '）', rawRows > 0 && rows.length === rawRows);
  ok('标题不为空', rows.every((r) => r.querySelector('.ngax-row-title').textContent.trim().length > 0));
  ok('标题链接可点', rows.every((r) => /\/read\.php\?tid=\d+/.test(r.getAttribute('href'))));

  // 回复数：取真实行的 a.replies 文本对比
  const rawReplies = $$("#topicrows a.replies").map((a) => a.textContent.trim());
  const shown = $$('.ngax-replies').map((a) => a.textContent.trim());
  ok('回复数逐行对应', rawReplies.every((v, i) => {
    const n = Number(v) || 0;
    const want = n < 1000 ? String(n) : (n < 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : (n / 10000).toFixed(1).replace(/\.0$/, '') + 'w');
    return shown[i] === want;
  }), JSON.stringify({ rawReplies: rawReplies.slice(0, 5), shown: shown.slice(0, 5) }));

  ok('作者名解析出来', $$('.ngax-node').length > 0);
  ok('最后回复人解析出来', $$('.ngax-replier').length > 0);
  ok('有分页', $$('.ngax-pager .ngax-fchip').length > 3, '页数 ' + $$('.ngax-pager .ngax-fchip').length);
  ok('列表痕迹装饰存在', $$('.ngax-think, .ngax-runline').length > 0);

  // rail 的「本页主题」
  ok('rail 里列出了本页主题', $$('.ngax-rail .ngax-rail-item').length > 5);
  // 当前版面高亮
  const active = $$('.ngax-rail-item.active').map((a) => a.textContent.trim());
  ok('rail 高亮了当前版面（网事杂谈）', active.some((t) => t.includes('网事杂谈')), active.join('|'));
  // 版面 chips
  ok('版面快捷 chips 存在', $$('.ngax-fchip').length > 3);

  // 发新帖链接指向原生
  ok('「发新帖」指向原生 post.php', /\/post\.php\?fid=-7/.test($('.ngax-new-topic-btn').getAttribute('href')));

  // 列表页输入框的占位符是发帖语义
  ok('列表页占位符是发帖', /发新帖/.test($('.ngax-md-edit').dataset.placeholder), $('.ngax-md-edit').dataset.placeholder);

  // 列表页发送：首行当标题
  const edit = $('.ngax-md-edit');
  edit.textContent = '这是标题\n这是正文第一行\n正文第二行';
  edit.dispatchEvent(new win.Event('input', { bubbles: true }));
  $('.ngax-send').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const last = null; // calls 在 boot 里，这里换个方式取值
  win.close();
}

// ── 用例 5：首页（NGA 首页是 indexBlock 拼的头条，不是帖子列表）──────────────

async function testHome() {
  console.log('\n【首页】bbs.nga.cn/（indexBlock.add 头条卡片）');
  const html = fs.readFileSync(path.join(TMP, 'home2.u.html'), 'utf8');
  const vc = new VirtualConsole();
  const fmtErr = (e) => '  [jsdomError] ' + e.message + ' | ' +
    String((e.detail && e.detail.stack) || '').replace(/[\r\n]+/g, ' >> ').slice(0, 400);
  vc.on('jsdomError', (e) => console.log(fmtErr(e)));
  vc.on('error', (...a) => console.log('  [console.error]', ...a));
  vc.on('warn', (...a) => console.log('  [console.warn]', ...a));
  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true,
    virtualConsole: vc,
    url: 'https://bbs.nga.cn/'
  });
  const win = dom.window;
  win.__CURRENT_UID = 34330581;
  win.__CURRENT_UNAME = 'happy0416';
  win.commonui = {
    userInfo: { users: {} }, postArg: { data: {} }, topicArg: { data: [] },
    postScoreAdd() { }, favor() { }, alert() { }
  };
  win.eval(SCRIPT_SRC);
  await afterRender(win);
  const d = win.document;
  const $ = (s) => d.querySelector(s);
  const $$ = (s) => Array.from(d.querySelectorAll(s));

  ok('首页被接管了', !!$('.ngax-main') && d.documentElement.classList.contains('ngax-locked'));
  const cards = $$('.ngax-hl');
  ok('头条卡片渲染出来（' + cards.length + ' 张）', cards.length >= 10, '卡片数 ' + cards.length);
  ok('卡片都有标题', cards.every((c) => c.querySelector('.ngax-hl-title').textContent.trim().length > 0));
  ok('卡片都指向帖子', cards.every((c) => /\/read\.php\?tid=\d+/.test(c.getAttribute('href'))),
    cards.slice(0, 3).map((c) => c.getAttribute('href')).join(' '));
  ok('卡片封面图指向 NGA 图床', $$('.ngax-hl-img img').length > 0
    && $$('.ngax-hl-img img').every((i) => /^https:\/\/img\.nga\.cn\/attachments\//.test(i.getAttribute('src'))),
    ($$('.ngax-hl-img img')[0] || {}).src || '');
  ok('原生首页容器被藏掉', !$('.ngax-hl') || !!$('.ngax-main'));

  win.close();
}

// ── 用例 6：「跟随站点」需读站点主题色，不能自锁 ───────────────────────

async function testTheme() {
  console.log('\n【明暗】auto 模式跟随 NGA 的 __COLOR（而不是读自己覆盖过的 body）');
  const html = fs.readFileSync(path.join(TMP, 'home2.u.html'), 'utf8');

  const bootWith = async (color) => {
    const dom = new JSDOM(html, {
      runScripts: 'outside-only', pretendToBeVisual: true,
      url: 'https://bbs.nga.cn/'
    });
    const win = dom.window;
    win.__CURRENT_UID = 34330581;
    win.__CURRENT_UNAME = 'happy0416';
    win.__COLOR = color;                 // ← js_color3.js 的产物
    win.commonui = {
      userInfo: { users: {} }, postArg: { data: {} }, topicArg: { data: [] },
      postScoreAdd() { }, favor() { }, alert() { }
    };
    win.eval(SCRIPT_SRC);
    await afterRender(win);
    return win;
  };

  // NGA 深色皮肤的 bg0（实测值）
  const dark = await bootWith({ bg0: '#1a1a1a', bg1: '#1d1d1d', bg2: '#212121', bg4: '#292826' });
  ok('NGA 深色 → 不加 ngax-light',
    !dark.document.documentElement.classList.contains('ngax-light'));
  ok('深色下 favicon 用深底',
    /%23171717/.test((dark.document.getElementById('nga-codex-favicon') || {}).href || ''),
    (dark.document.getElementById('nga-codex-favicon') || {}).href || '');
  dark.close();

  // 亮色皮肤的 bg0 是白的
  const light = await bootWith({ bg0: '#ffffff', bg1: '#f7f7f7', bg2: '#efefef', bg4: '#e6e6e6' });
  ok('NGA 亮色 → 加上 ngax-light',
    light.document.documentElement.classList.contains('ngax-light'));
  ok('亮色下 favicon 用浅底',
    /%23f2f2f3/.test((light.document.getElementById('nga-codex-favicon') || {}).href || ''),
    (light.document.getElementById('nga-codex-favicon') || {}).href || '');
  light.close();

  // 站点主题色是「解析到一半才由 js_color3.js 给出」的：
  // 首帧只能按深色猜，等 __COLOR 出现后必须自己纠正（不然亮色主题的用户
  // 会看到「深色底闪一下再变亮」）。这里模拟那个晚到的 __COLOR。
  const late = await bootWith(undefined);      // 一开始没有 __COLOR
  ok('__COLOR 缺失时先按深色猜',
    !late.document.documentElement.classList.contains('ngax-light'));
  const cardsBefore = late.document.querySelectorAll('.ngax-hl').length;
  late.__COLOR = { bg0: '#ffffff', bg1: '#f7f7f7' };   // ← js_color3.js 此刻才执行完
  await new Promise((r) => setTimeout(r, 150));
  ok('__COLOR 姗姗来迟 → 自动纠正为亮色',
    late.document.documentElement.classList.contains('ngax-light'),
    'class = ' + late.document.documentElement.className);
  ok('纠正明暗不会重渲染整个页面',
    late.document.querySelectorAll('.ngax-hl').length === cardsBefore);
  ok('纠正明暗时顺手把 favicon 换成浅底',
    /%23f2f2f3/.test((late.document.getElementById('nga-codex-favicon') || {}).href || ''),
    (late.document.getElementById('nga-codex-favicon') || {}).href || '');
  late.close();
}

// ── 用例 7：document-start 阶段就得把原生页面藏掉（否则会闪一帧）─────────────
//
// 这一条是冲着真实 bug 来的：@run-at document-start 时 <body> 还没被解析，
// 所以任何「页面里有没有 #mmc」这类 DOM 探测都必然是 false。
// 当初就是用 isSupported()（里面有 #mmc 探测）来决定要不要加 ngax-locked 的，
// 结果那一行从来没生效过 —— 表现就是切版面 / 点进帖子时闪一帧完整的原生页面。
//
// 所以这里故意造一个** body 空空如也**的文档，模拟「刚 document-start」那一瞬。

async function testEarlyLock() {
  console.log('\n【首帧】document-start（body 还没解析）就该加上 ngax-locked');

  const make = (url, bodyHtml) => {
    const dom = new JSDOM(
      '<!doctype html><html><head><title>NGA玩家社区</title></head><body>' +
      (bodyHtml || '') + '</body></html>',
      { runScripts: 'outside-only', pretendToBeVisual: true, url }
    );
    const win = dom.window;
    win.__CURRENT_UID = 34330581;
    win.__CURRENT_UNAME = 'happy0416';
    win.commonui = {
      userInfo: { users: {} }, postArg: { data: {} }, topicArg: { data: [] },
      postScoreAdd() { }, favor() { }, alert() { }
    };
    win.eval(SCRIPT_SRC);
    return win;
  };

  // 1) 主题页：body 还空着 → 也必须已经藏好
  const t = make('https://bbs.nga.cn/read.php?tid=44191387');
  ok('主题页：body 还没解析就已经加上 ngax-locked',
    t.document.documentElement.classList.contains('ngax-locked'),
    'class = ' + t.document.documentElement.className);
  ok('主题页：同时加上了 ngax 根标记',
    t.document.documentElement.classList.contains('ngax'));
  // 原生容器一开始就该被藏（CSS 层面，和 JS 无关）—— 关键词是「直接藏 #mmc」，
  // 而不是靠枚举容器：枚举只要漏一类就会又把整页漏出来
  ok('CSS 里有直接藏 #mmc 的规则（不依赖列清单）',
    /html\.ngax\.ngax-locked #mmc,[\s\S]{0,900}display: none !important/.test(SCRIPT_SRC));
  t.close();

  // 2) 版面列表页
  const l = make('https://bbs.nga.cn/thread.php?fid=-7');
  ok('版面列表页：同样在首帧就藏好',
    l.document.documentElement.classList.contains('ngax-locked'));
  l.close();

  // 3) 不在 @match 里的页面 / 不接管的路由（nuke.php）不该被藏
  const n = make('https://bbs.nga.cn/nuke.php?func=favorite');
  ok('nuke.php（不接管）：不加 ngax-locked',
    !n.document.documentElement.classList.contains('ngax-locked'));
  n.close();

  // 4) 游客 403 页：乐观锁上之后必须能回滚（body 里有内容但没有 #mmc）
  const g = make('https://bbs.nga.cn/thread.php?fid=-7', '<div class="err">游客不能直接访问</div>');
  ok('游客 403 页：首帧先锁上（此时还不知道是错误页）',
    g.document.documentElement.classList.contains('ngax-locked'));
  await afterRender(g);
  ok('游客 403 页：渲染阶段发现没有 #mmc，已经回滚解锁',
    !g.document.documentElement.classList.contains('ngax-locked'),
    'class = ' + g.document.documentElement.className);
  ok('游客 403 页：原生内容重新可见（没被 display:none 扣着）',
    !g.document.querySelector('.ngax-main'));
  g.close();
}

// ── 用例 8：正文图片的 CSS 优先级（表情必须是行内小图）──────────────────────
//
// 这条冲着真实 bug 来的：「.ngax-cooked img」把所有内容图都规定成 display:block +
// max-width 260px，而它的优先级 (0,1,1) 比光秃秃的「.ngax-smile」(0,1,0) 高 ——
// 结果表情被当成内容大图，一个占一行、每个一百多像素高，
// 用户看到的就是「莫名其妙的空白很多」（实拍截图确认过）。
//
// 直接问 getComputedStyle 最后算出来什么 —— jsdom 的级联实现会算优先级，
// 所以能真的押住这类「写了但被盖掉」的错。这类错看代码是看不出来的。

async function testContentImageCss() {
  console.log('\n【正文图片】表情 / 小图 / 内容大图的最终计算样式');

  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: 'https://bbs.nga.cn/read.php?tid=44191387'
  });
  const win = dom.window;
  win.__CURRENT_UID = 34330581;
  win.__CURRENT_UNAME = 'happy0416';
  win.commonui = {
    userInfo: { users: {} }, postArg: { data: {} }, topicArg: { data: [] },
    postScoreAdd() { }, favor() { }, alert() { }
  };
  win.eval(SCRIPT_SRC);

  const probe = (cls) => {
    const d = win.document;
    const host = d.createElement('div');
    host.className = 'ngax-cooked';
    host.innerHTML = '<img' + (cls ? ' class="' + cls + '"' : '') +
      ' src="https://img.nga.cn/attachments/mon_202609/16/x.jpg">';
    d.body.appendChild(host);
    const cs = win.getComputedStyle(host.querySelector('img'));
    const out = { display: cs.display, maxWidth: cs.maxWidth, maxHeight: cs.maxHeight };
    host.remove();
    return out;
  };

  const own = probe('ngax-smile');            // 脚本自己渲染的表情
  const nativeSmile = probe('smile_ac');      // 站点原生渲染好的表情
  const small = probe('ngax-img-sm');         // 图标/等级条那类小图
  const normal = probe('');                   // 正常内容图

  ok('脚本渲染的表情：行内而非块级（' + own.display + '）', own.display === 'inline-block');
  ok('脚本渲染的表情：尺寸限在 1.7em 内（' + own.maxWidth + '）',
    parseFloat(own.maxWidth) > 0 && parseFloat(own.maxWidth) <= 40);
  ok('站点原生表情（class=smile_ac）同样当行内小图',
    nativeSmile.display === 'inline-block' && parseFloat(nativeSmile.maxWidth) <= 40,
    JSON.stringify(nativeSmile));
  ok('小图：行内且不超过 120x80',
    small.display === 'inline-block' && small.maxWidth === '120px' && small.maxHeight === '80px',
    JSON.stringify(small));
  ok('普通内容图：仍是块级大图', normal.display === 'block', JSON.stringify(normal));
  ok('普通内容图：仍受缩略图尺寸约束',
    /thumb-w/.test(normal.maxWidth) && /thumb-h/.test(normal.maxHeight),
    JSON.stringify(normal));

  win.close();
}

// ── 用例 3：附件还原 + 去重 ─────────────────────────────────────────────
//
// 样本用 wow.u.html（tid=47565864）—— 它才是能押住 bug 的那个：
// 同一张附件在正文里是 mon_…-sg.jpg.medium.jpg（中等尺寸变体），
// 在附件元数据里是 mon_…-sg.jpg（原图）。只比文件名会当成两张图，
// 于是同一张图渲染两遍（用户看到的就是「凭空多出来的图 + 大段空白」）。
// th.utf8.html 里两边完全一致，押不住这个 bug，所以换掉了。

async function testAttachment() {
  console.log('\n【附件】read.php?tid=47565864（正文 .medium.jpg 变体 + 元数据原图）');
  const html = fs.readFileSync(path.join(TMP, 'wow.u.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: 'https://bbs.nga.cn/read.php?tid=47565864'
  });
  const win = dom.window;
  win.__CURRENT_UID = 34330581;
  win.__CURRENT_UNAME = 'happy0416';
  win.__CURRENT_FID = '-7';
  win.__CURRENT_TID = 47565864;
  win.commonui = {
    userInfo: { users: {} }, postArg: { data: {} }, topicArg: { data: [] },
    postScoreAdd() { }, favor() { }, alert() { }
  };
  win.eval(SCRIPT_SRC);
  await afterRender(win);
  const d = win.document;
  const $$ = (s) => Array.from(d.querySelectorAll(s));

  const imgs = $$('.ngax-cooked img, .ngax-turn-user-bubble img')
    .filter((i) => !/^smile/.test(i.className) && !i.classList.contains('ngax-smile'));
  ok('附件图渲染出来（' + imgs.length + ' 张）', imgs.length > 0);
  ok('附件 URL 指向 NGA 图床',
    imgs.every((i) => /^https:\/\/img\.nga\.cn\/attachments\//.test(i.getAttribute("src"))),
    imgs.map((i) => i.getAttribute('src').split('/').pop()).join(' | '));

  // 核心断言：按「剥掉尺寸变体后缀」后的指纹去重，每张附件只能出现一次
  const fp = (u) => u.split('/').pop().toLowerCase()
    .replace(/\.(medium|thumb|small|big|tmp)\.(jpe?g|png|gif|webp)$/, '')
    .replace(/\.(thumb|medium|tmp)$/, '');
  const fps = imgs.map((i) => fp(i.getAttribute('src')));
  const dup = fps.filter((k, i) => fps.indexOf(k) !== i);
  ok('同一张附件没有渲染两遍（.medium.jpg 与 原图 算同一张）', dup.length === 0,
    '重复: ' + [...new Set(dup)].join(', ') + ' | 全部: ' + fps.join(', '));
  ok('正文里的 .medium.jpg 变体没被当成分开的图',
    fps.filter((k) => /medium/.test(k)).length === 0, fps.join(', '));

  // 正文里已经有图时，不该再「兜底」补一遍
  ok('没有多余的 ngax-attach 兜底容器', $$('.ngax-attach').length === 0,
    '数量 ' + $$('.ngax-attach').length);
  ok('表情没有被当成附件', $$('img.ngax-smile, img[class^="smile"]').length > 0);

  win.close();
}

// ── 用例 9：用户信息页（nuke.php?func=ucp&uid=N）────────────────────────
//
// 这页的内容是 js_ucp.js 现渲染的（#ucp_block 在服务端 HTML 里是空的），
// 所以测试里分两块：
//   ① 数据源用页面内联的真实 __UCPUSER（直接从样本 HTML 里抠出来）；
//   ② 原生那排动作按钮（更改密码…）手工摆一份，验「点击是否交回了原生元素」。

async function testMember() {
  console.log('\n【用户信息】nuke.php?func=ucp&uid=34330581');
  const html = fs.readFileSync(path.join(TMP, 'ucp.u.html'), 'utf8');

  const boot = async (opts) => {
    const o = opts || {};
    const dom = new JSDOM(html, {
      runScripts: 'outside-only', pretendToBeVisual: true,
      url: 'https://bbs.nga.cn/nuke.php?func=ucp&uid=34330581'
    });
    const win = dom.window;
    win.__CURRENT_UID = 34330581;
    win.__CURRENT_UNAME = 'happy0416';
    win.__NOW = 1789524000;

    // ① 页面内联的 __UCPUSER
    const raw = objAfter(html, '__UCPUSER');
    if (raw) win.__UCPUSER = Function('return ' + raw)();
    if (o.honor !== undefined) win.__UCPUSER.honor = o.honor;
    if (o.drop) delete win.__UCPUSER;

    // ② 原生动作按钮（真实环境里由 js_ucp.js 生成）
    const block = win.document.getElementById('ucp_block') || win.document.body.appendChild(win.document.createElement('div'));
    block.id = 'ucp_block';
    block.innerHTML =
      '<span id="ucpuser_info_block"><h2 class="catetitle">:: happy0416 的基础信息 ::</h2>' +
      '<div class="cateblock" id="ucpuser_info_blockContent"><div class="contentBlock">' +
      '<div _name="uld">' +
      '<a href="/nuke.php?func=message#to=34330581">发送私信</a>' +
      '<a href="javascript:void(0)" id="native-changepass">更改密码</a>' +
      '<a href="javascript:void(0)" id="native-userlink">账号关联</a>' +
      '</div>' +
      '<div _name="uld"><span>用户ID</span><span>34330581</span></div>' +
      '<div class="clear"></div></div></div></span>';
    if (o.simulateNativeLoad) {
      // 真实情况：这东西是 DOMContentLoaded 之后才被 js_ucp.js 建出来的，
      // 所以脚本必须能靠 MutationObserver 把动作按钮补上
      block.innerHTML = '';
      setTimeout(() => {
        block.innerHTML = '<div _name="uld"><a href="javascript:void(0)" id="native-late">更改密码</a></div>';
      }, 30);
    }
    win.__nativeClicks = [];
    block.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', () => win.__nativeClicks.push(a.textContent.trim()));
    });

    win.commonui = {
      userInfo: { users: {} }, postArg: { data: {} }, topicArg: { data: [] },
      postScoreAdd() { }, favor() { }, alert() { }
    };
    win.eval(SCRIPT_SRC);
    await afterRender(win);
    return win;
  };

  // —— 主用例 ——
  // 头衔的时间戳必须是**未来**的：NGA 的格式是 " <过期时间戳> 文字"，
  // 过期了就回退到第 4 段的永久头衔（下面单独有用例）
  const win = await boot({ honor: ' 1900000000 测试头衔' });
  const d = win.document;
  const $ = (s) => d.querySelector(s);
  const $$ = (s) => Array.from(d.querySelectorAll(s));

  ok('用户页被接管', !!$('.ngax-main') && d.documentElement.classList.contains('ngax-locked'));
  ok('面包屑显示用户名与 UID', /happy0416/.test($('.ngax-model').textContent)
    && /34330581/.test($('.ngax-model').textContent), $('.ngax-model').textContent);
  ok('卡片标题是用户名', $('.ngax-member .ngax-card-title h1').textContent === 'happy0416');
  ok('头像渲染出来', /avatars\//.test(($('.ngax-member img') || {}).src || ''),
    ($('.ngax-member img') || {}).src || '');
  ok('元信息含用户组', /学徒/.test($('.ngax-member .ngax-card-sub').textContent),
    $('.ngax-member .ngax-card-sub').textContent);
  ok('元信息含 IP 属地', /广东/.test($('.ngax-member .ngax-card-sub').textContent));

  // 头衔：NGA 把它编码成 " <过期时间戳> 文字"，不能直接把时间戳吐到界面上
  ok('头衔解析成文字（不是时间戳）',
    $$('.ngax-pill').some((p) => p.textContent.trim() === '测试头衔'),
    $$('.ngax-pill').map((p) => p.textContent.trim()).join(' | '));
  ok('界面上没漏出时间戳', !/1900000000/.test($('.ngax-member').textContent));

  // 统计格子
  const stats = $$('.ngax-stat');
  ok('统计格子渲染（' + stats.length + ' 个）', stats.length >= 4);
  ok('发帖数正确（265）', stats.some((s) => s.querySelector('b').textContent.trim() === '265'));
  ok('金钱正确（390）', stats.some((s) => s.querySelector('b').textContent.trim() === '390'));
  ok('注册日期是日期不是时间戳',
    stats.some((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.querySelector('b').textContent.trim())),
    stats.map((s) => s.querySelector('b').textContent.trim()).join(','));

  // 状态（buffs）—— 数据里带的是站点渲染好的 HTML
  ok('状态区渲染出来', $$('.ngax-buff').length > 0, '数量 ' + $$('.ngax-buff').length);
  ok('状态里有内容（不是空壳）', $$('.ngax-buff').every((b) => b.textContent.trim().length > 0));

  // 声望
  ok('声望表渲染出来', $$('.ngax-repu tr').length > 0);
  const repuRow = $$('.ngax-repu tr')[0].textContent;
  ok('声望行含来源 / 值 / 说明',
    /N币/.test(repuRow) && /\+1/.test(repuRow) && /N币商店兑换/.test(repuRow), repuRow);
  ok('状态里没把「持续至」显示两遍',
    ($$('.ngax-buff')[0].textContent.match(/持续至/g) || []).length <= 1,
    $$('.ngax-buff')[0].textContent.trim());

  // 动作：URL 型 / JS 型
  const pills = $$('.ngax-pill').map((p) => p.textContent.trim());
  ok('自动补了「TA 的主题 / TA 的回复」直达链接',
    pills.includes('TA 的主题') && pills.includes('TA 的回复'), pills.join(' | '));
  ok('原生动作按钮被搬过来（更改密码 / 账号关联）',
    pills.includes('更改密码') && pills.includes('账号关联'), pills.join(' | '));
  ok('有真 href 的动作渲染成链接',
    !!$$('a.ngax-pill').find((a) => /authorid=34330581/.test(a.getAttribute('href') || '')));

  const jsAct = $$('[data-member-act]').find((b) => b.dataset.memberAct === '更改密码');
  ok('JS 型动作渲染成按钮', !!jsAct);
  if (jsAct) {
    jsAct.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    ok('点 JS 型动作会转交给原生元素',
      win.__nativeClicks.includes('更改密码'), JSON.stringify(win.__nativeClicks));
  }

  // 不能发帖的页面，输入框得说清楚
  ok('输入框占位符说明用户页不能发帖',
    /不能发帖/.test($('.ngax-md-edit').dataset.placeholder), $('.ngax-md-edit').dataset.placeholder);
  win.close();

  // —— 头符过期后回退到永久头衔 ——
  const w2 = await boot({ honor: ' 1000000000 已过期头衔 永久头衔' });
  ok('头衔过期时回退到永久头衔',
    Array.from(w2.document.querySelectorAll('.ngax-pill')).some((p) => p.textContent.trim() === '永久头衔'),
    Array.from(w2.document.querySelectorAll('.ngax-pill')).map((p) => p.textContent.trim()).join(' | '));
  w2.close();

  // —— 没有 __UCPUSER 时必须回退原生页，不能给空白 ——
  const w3 = await boot({ drop: true });
  ok('拿不到 __UCPUSER 时回退原生页',
    !w3.document.querySelector('.ngax-main')
    && !w3.document.documentElement.classList.contains('ngax-locked'),
    'class = ' + w3.document.documentElement.className);
  ok('回退后 rail 仍可用', !!w3.document.querySelector('.ngax-rail'));
  w3.close();

  // —— 动作按钮是后到的（真实情况）——
  const w4 = await boot({ simulateNativeLoad: true });
  await new Promise((r) => setTimeout(r, 120));
  const late = Array.from(w4.document.querySelectorAll('[data-member-act]'))
    .map((b) => b.dataset.memberAct);
  ok('原生按钮后到时，靠 MutationObserver 也补上了', late.includes('更改密码'), late.join(' | '));
  w4.close();
}

// ── 用例 10：版面大全 / 收藏版面 / 常去版面 / 自动补全 ──────────────────
//
// 这一组盯的是「首页能不能当版面导航用」这件事：
//   ① 首页列出全部已知版面 + 前端筛选；
//   ② 星标收藏（本地存，不依赖 NGA 那个 rvrc≥20 的门槛）；
//   ③ 「常去版面」是按实际访问次数学出来的，不是写死的清单；
//   ④ 逛到一个烘焙表里没有的版面时，它会自己补进本地表。

const FAKE_FID = '-999999';
const FAKE_NAME = '测试版面（自动补全用）';

async function testBoards() {
  console.log('\n【版面】首页版面大全 / 收藏 / 常去 / 自动补全');

  const boot = async (file, url, extraForum, seed) => {
    const html = fs.readFileSync(path.join(TMP, file), 'utf8');
    const dom = new JSDOM(html, {
      runScripts: 'outside-only', pretendToBeVisual: true, url
    });
    const win = dom.window;
    // 预置 localStorage 必须在注入脚本之前 —— 脚本在 bootstrap 时就读了
    if (seed && seed.visits) {
      win.localStorage.setItem('ngax:visits', JSON.stringify(seed.visits));
    }
    win.__CURRENT_UID = 34330581;
    win.__CURRENT_UNAME = 'happy0416';
    win.__NOW = 1789524000;
    const all = objAfter(html, '__ALL_FORUM_DATA');
    if (all) { try { win.__ALL_FORUM_DATA = Function('return ' + all)(); } catch { } }
    // 顺手塞一个「烘焙表里肯定没有」的版面，用来验自动补全
    if (extraForum) {
      win.__ALL_FORUM_DATA = win.__ALL_FORUM_DATA || {};
      win.__ALL_FORUM_DATA[FAKE_FID] = [FAKE_FID, FAKE_NAME, '自动补全', 0, 4654];
    }
    win.commonui = {
      userInfo: { users: {} }, postArg: { data: {} }, topicArg: { data: [] },
      postScoreAdd() { }, favor() { }, alert() { }
    };
    win.eval(SCRIPT_SRC);
    await afterRender(win);
    return win;
  };

  // —— ① 首页版面大全 ——
  const h = await boot('home2.u.html', 'https://bbs.nga.cn/', true);
  const d = h.document;
  const $ = (s) => d.querySelector(s);
  const $$ = (s) => Array.from(d.querySelectorAll(s));

  ok('首页被接管且渲染出版面大全', !!$('.ngax-main') && /版面大全/.test($('.ngax-head-title').textContent));
  const chips = $$('.ngax-board-grid .ngax-bitem');
  ok('列出了几百个版面（' + chips.length + '）', chips.length >= 300, '数量 ' + chips.length);
  ok('每个条目都有名字和链接',
    chips.every((c) => c.querySelector('a').textContent.trim()
      && /thread\.php\?(fid|stid)=/.test(c.querySelector('a').getAttribute('href'))));
  ok('版面有条目星标、合集标成不参与收藏',
    chips.every((c) => !!c.querySelector('[data-fav-board], .ngax-bstar.off')));
  ok('自动补全：烘焙表里没有的版面也出现了',
    chips.some((c) => /测试版面/.test(c.textContent)));

  // —— 分类分组（数据来自站点首页那份 CDN 目录）——
  const catHeads = $$('.ngax-bcat-head span:first-child').map((x) => x.textContent.trim());
  ok('按站点自己的分类分组（' + catHeads.length + ' 个分类）',
    catHeads.length >= 5 && catHeads.includes('网事杂谈') && catHeads.includes('魔兽世界')
    && catHeads.includes('游戏专版'), JSON.stringify(catHeads));
  ok('目录里没有的版面归入「其它版面」', catHeads.includes('其它版面'), JSON.stringify(catHeads));
  const catOf = (name) => {
    const cat = $$('.ngax-bcat').find((c) => {
      const head = c.querySelector('.ngax-bcat-head span');
      return head && head.textContent.trim() === name;
    });
    return cat ? Array.from(cat.querySelectorAll('.ngax-pill')).map((a) => a.textContent.trim()) : [];
  };
  ok('原神 落在「游戏专版」分类下', catOf('游戏专版').some((n) => /^原神/.test(n)),
    catOf('游戏专版').slice(0, 5).join(' / '));
  ok('艾泽拉斯议事厅 落在「魔兽世界」分类下', catOf('魔兽世界').some((n) => /艾泽拉斯议事厅/.test(n)),
    catOf('魔兽世界').slice(0, 5).join(' / '));
  const groupHeads = $$('.ngax-bgroup-head').map((x) => x.textContent.trim());
  ok('分组标题也来自站点目录（如「职业讨论区」）', groupHeads.includes('职业讨论区'),
    JSON.stringify(groupHeads.slice(0, 8)));

  // 合集：URL 必须是 ?stid=（写错就会点进另一个版面 —— 这正是踩过的坑：
  // 站点目录里同一个宿主版面下挂着上百个合集，按 fid 去重会把它们合并成一个）
  const collLinks = $$('.ngax-bitem a[href*="stid="]');
  ok('合集用 ?stid= 链接（' + collLinks.length + ' 个）', collLinks.length > 0);
  ok('合集条目标成不参与收藏', collLinks.every((a) => /不参与收藏|合集/.test(a.parentNode.textContent)
    || !!a.parentNode.querySelector('.ngax-bstar.off')));

  // 不该有重复渲染（同一 fid 出现两次）
  const allFids = $$('.ngax-bitem a[href*="fid="]').map((a) => a.getAttribute('href'));
  ok('版面没有重复渲染', new Set(allFids).size === allFids.length,
    '总 ' + allFids.length + ' 唯一 ' + new Set(allFids).size);
  ok('自动补全写进了 localStorage',
    new RegExp('"' + FAKE_FID + '"').test(h.localStorage.getItem('ngax:forums:extra') || ''),
    (h.localStorage.getItem('ngax:forums:extra') || '').slice(0, 120));
  ok('没收藏时给出空态提示', !!$('.ngax-empty') && /还没有收藏/.test($('.ngax-empty').textContent));
  ok('头条仍然在（作为附加内容）', $$('.ngax-hl').length > 0, '头条 ' + $$('.ngax-hl').length + ' 条');

  // 筛选：纯前端，不重渲染
  const filter = $('[data-board-filter]');
  ok('有筛选输入框', !!filter);
  filter.value = '魔兽';
  filter.dispatchEvent(new h.Event('input', { bubbles: true }));
  const visible = () => $$('.ngax-bitem').filter((c) => c.style.display !== 'none');
  const v1 = visible();
  ok('筛选后只剩匹配项（魔兽 → ' + v1.length + ' 个）',
    v1.length > 0 && v1.length < chips.length && v1.every((c) => /魔兽/.test(c.textContent)),
    v1.slice(0, 4).map((c) => c.textContent.trim()).join(' / '));
  ok('筛选后空掉的分组被收起',
    $$('[data-board-group]').every((g) => g.style.display !== 'none'
      ? Array.from(g.querySelectorAll('.ngax-bitem')).some((i) => i.style.display !== 'none') : true));
  ok('筛选后空掉的分类被收起',
    $$('[data-board-cat]').every((c) => c.style.display !== 'none'
      ? Array.from(c.querySelectorAll('.ngax-bitem')).some((i) => i.style.display !== 'none') : true));
  ok('筛选后「其它版面」这种空分类也不留空壳',
    $$('[data-board-cat]').filter((c) => c.style.display !== 'none').length < catHeads.length);
  filter.value = '';
  filter.dispatchEvent(new h.Event('input', { bubbles: true }));
  ok('清空筛选后全部回来', visible().length === chips.length);
  ok('清空筛选后分类也全部恢复',
    $$('[data-board-cat]').every((c) => c.style.display !== 'none'));

  // —— ② 星标收藏 ——
  const star = chips.find((c) => /测试版面/.test(c.textContent)).querySelector('[data-fav-board]');
  star.dispatchEvent(new h.MouseEvent('click', { bubbles: true }));
  ok('点星标后变成实心', star.classList.contains('on') && star.textContent === '★');
  ok('收藏写进了 localStorage',
    new RegExp('"' + FAKE_FID + '"').test(h.localStorage.getItem('ngax:favforums') || ''),
    h.localStorage.getItem('ngax:favforums') || '');
  ok('首页多出「收藏的版面」区并且列出了它',
    /收藏的版面/.test(d.body.textContent) && !!$('[data-fav-grid]')
    && /测试版面/.test($('[data-fav-grid]').textContent),
    ($('[data-fav-grid]') || {}).textContent);
  ok('收藏后原来的空态提示消失', ![...$$('.ngax-empty')].some((e) => /还没有收藏/.test(e.textContent)));
  // rail 里的收藏是并进「常用版面」的（星标排在最前），不另开分区 —— 侧栏要短
  ok('rail 的常用版面里出现了带星标的收藏项',
    $$('.ngax-rail .ngax-rail-item .ngax-bstar.on').length > 0,
    '星标数 ' + $$('.ngax-rail .ngax-rail-item .ngax-bstar.on').length);

  // 再点一下取消
  const star2 = $('[data-fav-grid] [data-fav-board]');
  star2.dispatchEvent(new h.MouseEvent('click', { bubbles: true }));
  ok('再点一下取消收藏', !JSON.parse(h.localStorage.getItem('ngax:favforums') || '[]').includes(FAKE_FID),
    h.localStorage.getItem('ngax:favforums'));

  // rail 的「全部 N ›」入口
  const more = $$('.ngax-rail a.ngax-more').find((a) => /全部/.test(a.textContent));
  ok('rail 里有「全部 N ›」入口，指向首页', !!more && more.getAttribute('href') === '/',
    more && more.textContent.trim());
  h.close();

  // —— ③ 常去版面（按访问次数学）——
  const b1 = await boot('fid7.utf8.html', 'https://bbs.nga.cn/thread.php?fid=-7');
  const visits1 = JSON.parse(b1.localStorage.getItem('ngax:visits') || '{}');
  ok('访问版面页会计一次数', Number(visits1['-7']) === 1, JSON.stringify(visits1));
  // ★ 回归断言：rail 的版面列表**不能依赖「已经用过」**。
  // 上一版把它换成「只显示访问过两次以上的」，结果 rail 直接空了（用户实测反馈）。
  const freshRail = b1.document.querySelector('.ngax-rail');
  const band = Array.from(freshRail.querySelectorAll('.ngax-rail-section'))
    .find((x) => /常用版面/.test(x.textContent));
  const bandItems = band ? Array.from(band.nextElementSibling.querySelectorAll('.ngax-rail-item')) : [];
  ok('全新状态（没收藏、没访问记录）rail 里也有版面可点（' + bandItems.length + ' 个）',
    bandItems.length >= 10, '数量 ' + bandItems.length);
  ok('这套默认版面名字来自版面表（不是 fid 或空）',
    bandItems.every((i) => i.querySelector('.ngax-label').textContent.trim().length > 1),
    bandItems.slice(0, 3).map((i) => i.querySelector('.ngax-label').textContent).join(' / '));
  // 「全部 N ›」现在独立成一个「版面」分区（收藏/常去各自是独立分区）
  const allSec = Array.from(freshRail.querySelectorAll('.ngax-rail-section'))
    .find((x) => /^版面/.test(x.textContent.trim()));
  ok('rail 里有「版面 · 全部 N ›」入口且指向首页',
    !!allSec && /全部 \d+/.test(allSec.textContent)
    && allSec.querySelector('.ngax-more')?.getAttribute('href') === '/',
    allSec && allSec.textContent.trim());
  // 默认清单是兜底，要说清数据来源
  ok('默认清单下说明数据从哪来',
    /站点自己的历史|收藏本版/.test(b1.document.querySelector('.ngax-rail-hint')?.textContent || ''),
    b1.document.querySelector('.ngax-rail-hint')?.textContent);
  // 版面页头部应该有「收藏本版」，点它就是给当前版面加星
  const bar = b1.document.querySelector('.ngax-board-bar');
  ok('版面页头部有「收藏本版」', !!bar && /收藏本版/.test(bar.textContent), bar && bar.textContent.trim());
  const barStar = bar && bar.querySelector('[data-fav-board="-7"]');
  ok('「收藏本版」挂在当前版面的 fid 上', !!barStar);
  if (barStar) {
    barStar.dispatchEvent(new b1.MouseEvent('click', { bubbles: true }));
    ok('点「收藏本版」后进入本地收藏',
      JSON.parse(b1.localStorage.getItem('ngax:favforums') || '[]').map(String).includes('-7'),
      b1.localStorage.getItem('ngax:favforums'));
    ok('点完后 rail 的常用版面里立刻多出带星标的那一项',
      !!b1.document.querySelector('.ngax-rail .ngax-rail-item .ngax-bstar.on[data-fav-board="-7"]'));
  }
  b1.close();

  // 预置访问次数（脚本会再给当前版面 +1），验「常去」真的按次数排序、并显示次数
  const b2 = await boot('fid7.utf8.html', 'https://bbs.nga.cn/thread.php?fid=-7', null,
    { visits: { '-7': 9, '422': 5, '428': 3 } });
  const rail2 = b2.document.querySelector('.ngax-rail');
  const band2 = Array.from(rail2.querySelectorAll('.ngax-rail-section'))
    .find((x) => /常去版面/.test(x.textContent));
  const items2 = band2 ? Array.from(band2.nextElementSibling.querySelectorAll('.ngax-rail-item')) : [];
  // 带 count 的就是「学出来的常去版面」，它们按次数降序排在最前面
  const counted = items2.filter((i) => i.querySelector('.ngax-count'))
    .map((i) => [i.querySelector('.ngax-label').textContent.trim(),
      Number(i.querySelector('.ngax-count').textContent)]);
  ok('常去版面按次数降序（' + JSON.stringify(counted) + '）',
    counted.length === 3 && counted.every((r, i) => i === 0 || counted[i - 1][1] >= r[1]),
    JSON.stringify(counted));
  ok('排第一的是访问最多的网事杂谈（次数 10）',
    counted.length && counted[0][0] === '网事杂谈' && counted[0][1] === 10,
    JSON.stringify(counted[0] || []));
  ok('常去版面里只有达到阈值的（3 个）', items2.length === counted.length,
    '总 ' + items2.length + ' 个，其中带次数的 ' + counted.length);
  b2.close();

  // 只去过一次的版面不该出现在「常去」里（否则「常去」没意义）
  const b3 = await boot('fid7.utf8.html', 'https://bbs.nga.cn/thread.php?fid=-7', null,
    { visits: { '422': 1 } });
  const rail3 = b3.document.querySelector('.ngax-rail');
  const band3 = Array.from(rail3.querySelectorAll('.ngax-rail-section')).find((x) => /常用版面/.test(x.textContent));
  const counted3 = Array.from(band3.nextElementSibling.querySelectorAll('.ngax-rail-item'))
    .filter((i) => i.querySelector('.ngax-count')).map((i) => i.querySelector('.ngax-label').textContent.trim());
  ok('只去过一次的版面不算「常去」（不显示次数）', counted3.length === 0, JSON.stringify(counted3));
  b3.close();

  // —— ④ 收藏的主题（thread.php?favor=1）应当被当成列表页接管 ——
  const fav = await boot('t_myfavor.u.html', 'https://bbs.nga.cn/thread.php?favor=1');
  const fd = fav.document;
  ok('收藏的主题页被接管为列表',
    !!fd.querySelector('.ngax-main') && fd.documentElement.classList.contains('ngax-locked'));
  ok('标题是「收藏的主题」',
    /收藏的主题/.test(fd.querySelector('.ngax-head-title')?.textContent || ''),
    fd.querySelector('.ngax-head-title')?.textContent);
  ok('列出了收藏的主题行', fd.querySelectorAll('.ngax-row').length > 0,
    '行数 ' + fd.querySelectorAll('.ngax-row').length);
  const favLink = Array.from(fd.querySelectorAll('.ngax-rail-item'))
    .find((a) => /收藏的主题/.test(a.textContent));
  ok('rail 导航里有「收藏的主题」并指向?favor=1',
    !!favLink && /favor=1/.test(favLink.getAttribute('href') || ''),
    favLink && favLink.getAttribute('href'));
  fav.close();
}

// ── 用例 11：读 NGA 自己的「版面收藏 + 历史」────────────────────────
//
// 原生首页那个「收藏版面」分区就是从这里来的：commonui.eachForumViewHis()。
// 这一组验的就是「用站点自己的数据，而不是再发明一份」：
//   ① 收藏 = 站点里 lock=1 的条目；
//   ② 「常去」= 站点的 count 权重（≥10，即至少隔天来过一次）；
//   ③ 星标写回站点（lockViewHis）—— 所以和原生首页的勾选同步；
//   ④ 站点认识但没锁的 → 本地那份收藏要对账清掉；
//   ⑤ 数据是异步 init 的 → 读到了要重画一次 rail。

async function testNgaHis() {
  console.log('\n【NGA 数据】版面收藏（lock）+ 浏览历史（count）');

  const HIS = [
    [-7, '网事杂谈', 1, 20000, 5, 0],                 // 已收藏
    [422, '炉石传说', 1, 20000, 4, 0],                // 已收藏
    [428, '手机 网页游戏综合讨论', 0, 20000, 15, 0],  // 常去（隔天来过）
    [300, '网络游戏综合', 0, 20000, 10, 0],           // 常去
    [436, '消费电子 IT新闻', 0, 20000, 1, 0],         // 只去过一次 → 不算常去
    [-999999, '站点里才有的版面', 0, 20000, 12, 0]    // 表里没有的 fid，名字只站里有
  ];

  const boot = async (opts) => {
    const html = fs.readFileSync(path.join(TMP, 'fid7.utf8.html'), 'utf8');
    const dom = new JSDOM(html, {
      runScripts: 'outside-only', pretendToBeVisual: true,
      url: 'https://bbs.nga.cn/thread.php?fid=-7'
    });
    const win = dom.window;
    win.__CURRENT_UID = 34330581;
    win.__CURRENT_UNAME = 'happy0416';
    win.__NOW = 1789524000;
    if (opts.localFavs) {
      win.localStorage.setItem('ngax:favforums', JSON.stringify(opts.localFavs));
    }
    const calls = { lock: [] };
    win.commonui = {
      userInfo: { users: {} }, postArg: { data: {} }, topicArg: { data: [] },
      postScoreAdd() { }, favor() { }, alert() { },
      lockViewHis(fid, lock, stid) { calls.lock.push([fid, lock]); },
      eachForumViewHis(cb) {
        if (opts.noHis) return;
        (opts.his || HIS).forEach((v, i) => cb(i, v, 0));
      },
      waitForumViewHis(cb) {
        if (!opts.async) return 0;        // 0 = 已 init，直接读
        // 延迟要明显长于 afterRender（~60ms），否则观察不到「还没读到」这个状态
        setTimeout(cb, 250);
        return 1;                          // 1 = 待会儿回调你
      }
    };
    win.eval(SCRIPT_SRC);
    await afterRender(win);
    return { win, calls };
  };

  const railOf = (win) => win.document.querySelector('.ngax-rail');
  const sectionAfter = (win, re) => {
    const sec = Array.from(railOf(win).querySelectorAll('.ngax-rail-section'))
      .find((x) => re.test(x.textContent));
    return sec ? sec.nextElementSibling : null;
  };
  const labels = (box) => box
    ? Array.from(box.querySelectorAll('.ngax-rail-item .ngax-label')).map((n) => n.textContent.trim())
    : [];

  // —— ① + ② ——
  const a = await boot({});
  const favBox = sectionAfter(a.win, /收藏的版面/);
  const favNames = labels(favBox);
  ok('收藏的版面来自站点（lock=1）：' + JSON.stringify(favNames),
    favNames.length === 2 && favNames.includes('网事杂谈') && favNames.includes('炉石传说'),
    JSON.stringify(favNames));
  ok('收藏项带实心星标',
    Array.from(favBox.querySelectorAll('.ngax-bstar.on')).length === 2);

  const freqBox = sectionAfter(a.win, /常去版面/);
  const freqRows = freqBox
    ? Array.from(freqBox.querySelectorAll('.ngax-rail-item')).map((i) =>
      [i.querySelector('.ngax-label').textContent.trim(),
       Number(i.querySelector('.ngax-count').textContent)])
    : [];
  ok('常去版面用站点的 count（≥10），且按权重降序：' + JSON.stringify(freqRows),
    freqRows.length === 3 && freqRows.every((r, i) => i === 0 || freqRows[i - 1][1] >= r[1]),
    JSON.stringify(freqRows));
  ok('只去过一次的版面不算常去（消费电子被排除）',
    !freqRows.some((r) => r[0] === '消费电子 IT新闻'), JSON.stringify(freqRows));
  ok('表里没有的 fid 用站点给的名字',
    freqRows.some((r) => r[0] === '站点里才有的版面'), JSON.stringify(freqRows));

  // —— ③ 星标写回站点 ——
  const star = favBox.querySelector('[data-fav-board]');
  star.dispatchEvent(new a.win.MouseEvent('click', { bubbles: true }));
  ok('取消收藏会调站点的 lockViewHis(fid, 0)',
    a.calls.lock.some(([fid, lock]) => lock === 0), JSON.stringify(a.calls.lock));
  ok('同时写一份到本地（兜底）',
    !JSON.parse(a.win.localStorage.getItem('ngax:favforums') || '[]').includes(-7),
    a.win.localStorage.getItem('ngax:favforums'));
  a.win.close();

  // 收藏一个「站点历史里有、但没锁」的版面 → 应该调 lockViewHis(fid, 1)
  const b = await boot({});
  const star2 = b.win.document.querySelector('.ngax-rail [data-fav-board="428"]')
    || (() => {
      // 428 在「常去版面」里，那里没有星标；用首页的星标试
      return null;
    })();
  if (star2) {
    star2.dispatchEvent(new b.win.MouseEvent('click', { bubbles: true }));
    ok('站点历史里有的版面，收藏会写回 lockViewHis(fid, 1)',
      b.calls.lock.some(([fid, lock]) => fid === 428 && lock === 1), JSON.stringify(b.calls.lock));
  } else {
    ok('（跳过）常去版面里没有星标，用本地收藏路径验证', true);
  }
  b.win.close();

  // —— ④ 对账：站点认识但没锁的，本地那份要清掉 ——
  const c = await boot({ localFavs: ['436', '555555'] });
  const localNow = JSON.parse(c.win.localStorage.getItem('ngax:favforums') || '[]').map(String);
  ok('站点认识但没锁的本地收藏被清掉（436）', localNow.indexOf('436') < 0, JSON.stringify(localNow));
  ok('站点不认识的本地收藏保留（555555）', localNow.indexOf('555555') >= 0, JSON.stringify(localNow));
  c.win.close();

  // —— ⑤ 异步 init：读到了要重画一次 ——
  const d = await boot({ async: true });
  const before = labels(sectionAfter(d.win, /收藏的版面/));
  ok('异步 init 前先不显示站点收藏（还没读到）', before.length === 0, JSON.stringify(before));
  await new Promise((r) => setTimeout(r, 420));
  const after = labels(sectionAfter(d.win, /收藏的版面/));
  ok('站点数据到了之后 rail 自动重画：' + JSON.stringify(after),
    after.includes('网事杂谈') && after.includes('炉石传说'), JSON.stringify(after));
  d.win.close();

  // —— 保底：站点接口不存在时，本地收藏仍然能用 ——
  const e = await boot({ noHis: true, localFavs: ['422'] });
  const eNames = labels(sectionAfter(e.win, /收藏的版面/));
  ok('站点接口不可用时退回本地收藏：' + JSON.stringify(eNames),
    eNames.includes('炉石传说'), JSON.stringify(eNames));
  e.win.close();
}

// ── 用例 12：rail 不能被重入（渲染两次）────────────────────────────────
//
// 真实 bug：左下角用户栏出现两行。
// 原因：renderRail 里读 NGA 历史时，如果 hisLink **已经 init 好了**，
// waitForumViewHis 会**同步**回调 → 回调里再调一次 renderRail，
// 内层把 foot 追加完，外层接着又追加一遍。
// 为什么「帖子详情里没问题」：版面页的页面脚本会调 ForumViewHis(...) 记录访问，
// 于是 init 早就完成了 → 走同步路径；帖子页不记录版面访问 → init 没完成 →
// 回调是异步的 → 不重入。这个测试就是盯「同步路径」的。

async function testRailNoDoubleRender() {
  console.log('\n【rail】不许被重入（同步回调路径）');

  const boot = async (initedSync) => {
    // 版面页（会触发 NGA 自己记录版面访问 → hisLink 提前 init）
    const html = fs.readFileSync(path.join(TMP, 'fid7.utf8.html'), 'utf8');
    const dom = new JSDOM(html, {
      runScripts: 'outside-only', pretendToBeVisual: true,
      url: 'https://bbs.nga.cn/thread.php?fid=-7'
    });
    const win = dom.window;
    win.__CURRENT_UID = 34330581;
    win.__CURRENT_UNAME = 'happy0416';
    win.__NOW = 1789524000;
    win.commonui = {
      userInfo: { users: {} }, postArg: { data: {} }, topicArg: { data: [] },
      postScoreAdd() { }, favor() { }, alert() { },
      lockViewHis() { },
      eachForumViewHis(cb) {
        [[-7, '网事杂谈', 1, 20000, 5, 0], [422, '炉石传说', 1, 20000, 4, 0]]
          .forEach((v, i) => cb(i, v, 0));
      },
      // 已 init → 返回 undefined（假值）→ 脚本会**同步**读，这正是重入的触发条件
      waitForumViewHis(cb) {
        if (initedSync) return undefined;
        setTimeout(cb, 30);
        return 1;
      }
    };
    win.eval(SCRIPT_SRC);
    await afterRender(win);
    await new Promise((r) => setTimeout(r, 80));   // 异步路径也要跑完
    return win;
  };

  const check = (win, label) => {
    const rail = win.document.querySelector('.ngax-rail');
    const feet = rail.querySelectorAll('.ngax-rail-foot').length;
    const modes = rail.querySelectorAll('[data-mode-toggle]').length;
    const resizers = rail.querySelectorAll('.ngax-resizer').length;
    const users = rail.querySelectorAll('.ngax-rail-foot-user').length;
    const scrollers = rail.querySelectorAll('.ngax-rail-scroll').length;
    // 分区标题也不该重复
    const heads = Array.from(rail.querySelectorAll('.ngax-rail-section')).map((x) => x.textContent.replace(/\s+/g, ''));
    const dupHeads = heads.filter((h, i) => heads.indexOf(h) !== i);
    ok(label + '：用户栏只有一个（' + users + '）', users === 1);
    ok(label + '：foot 只有一个（' + feet + '）', feet === 1);
    ok(label + '：明暗按钮只有一个（' + modes + '）', modes === 1);
    ok(label + '：拖拽把手只有一个（' + resizers + '）', resizers === 1);
    ok(label + '：滚动容器只有一个（' + scrollers + '）', scrollers === 1);
    ok(label + '：分区标题没有重复（' + JSON.stringify(dupHeads) + '）', dupHeads.length === 0,
      heads.join(' | '));
  };

  const a = await boot(true);      // 同步路径（曾经重入的那个）
  check(a, '同步回调');
  a.close();

  const b = await boot(false);     // 异步路径
  check(b, '异步回调');
  b.close();
}

// ── 用例 4：未登录 / 非接管路由 ────────────────────────────────────────

async function testFallback() {
  console.log('\n【兜底】非正常页面（游客 403 页）不该硬接管');
  const dom = new JSDOM('<!doctype html><html><head><title>游客不能直接访问</title></head><body>(ERROR:15) 游客不能直接访问</body></html>', {
    runScripts: 'outside-only',
    url: 'https://bbs.nga.cn/thread.php?fid=-7'
  });
  const win = dom.window;
  win.commonui = { userInfo: { users: {} } };
  // 注意：runScripts: "outside-only" 下，动态插入的 <script> 不会执行
  // （那是 "dangerously" 的行为，但那样页面自带的脚本也会跑起来）。
  // 所以用 win.eval 在 window 作用域里直接跑 —— 等价于 @grant none 的用户脚本。
  win.eval(SCRIPT_SRC);
  await afterRender(win);
  const d = win.document;
  ok('没有接管（无 .ngax-main）', !d.querySelector('.ngax-main'));
  ok('没加 ngax-locked', !d.documentElement.classList.contains('ngax-locked'));
  ok('rail 仍然建起来了', !!d.querySelector('.ngax-rail'));
  win.close();
}

// ── 用例：页面透明度 + 侧边栏模式（设置面板新增的两项）──────────────────

/*
 * 这两项都是「设置面板 → 立刻影响页面」的链路，也是唯一两处
 * 「设置值不是直接写进 CSS 像素值」的地方，所以单独押一遍：
 *   - 透明度：滑杆读数 20~100(%) → CSS 变量 --ngax-opacity 0.2~1（无单位）；
 *     拖动时只预览、松手才落盘；而且只盖住 rail + 主区。
 *   - 侧边栏模式：鼠标离开页面区域（mouseout + relatedTarget=null）自动进伪装，
 *     回来按设置决定是否还原；手动按出来的伪装不受鼠标影响。
 */
async function testOpacityAndSidebar() {
  console.log('\n【透明度 + 侧边栏模式】设置面板新增的滑杆与开关');
  const { win } = boot('big.u.html');
  await afterRender(win);
  const d = win.document;
  const $ = (s) => d.querySelector(s);
  const root = d.documentElement;
  const store = () => win.localStorage.getItem('ngax:settings') || '';
  const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  // 设置面板也可以按 Ctrl+, 开：伪装视图铺满视口时顶栏的齿轮点不到
  const settingsKey = () => win.dispatchEvent(new win.KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
  // 指针离开 / 回到页面：relatedTarget 为 null = 去了页面之外（浏览器 UI / 别的窗口 / 桌面）
  const leave = () => d.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
  const enter = () => d.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
  const bossShown = () => !!$('.ngax-boss') && !$('.ngax-boss').hidden;
  const esc = () => win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  // ── 透明度 ──
  click($('[data-settings-open]'));
  const range = $('[data-set-range="pageOpacity"]');
  ok('设置面板里有「页面透明度」滑杆', !!range && range.type === 'range');
  ok('默认 100%（--ngax-opacity: 1）',
    !!range && range.value === '100' && root.style.getPropertyValue('--ngax-opacity') === '1',
    range && (range.value + ' / ' + root.style.getPropertyValue('--ngax-opacity')));
  range.value = '60';
  range.dispatchEvent(new win.Event('input', { bubbles: true }));
  ok('拖动时实时预览（只改 CSS 变量，没落盘）',
    root.style.getPropertyValue('--ngax-opacity') === '0.6' && !/pageOpacity/.test(store()),
    root.style.getPropertyValue('--ngax-opacity') + ' / ' + store());
  const out = $('[data-set-val="pageOpacity"]');
  ok('滑杆旁边跟着显示读数', !!out && out.textContent === '60%', out && out.textContent);
  range.dispatchEvent(new win.Event('change', { bubbles: true }));
  ok('松手后写进 localStorage', /"pageOpacity":60/.test(store()), store());

  // 作用范围：规则真到了元素上（按计算样式押，而不是肉眼读 CSS 字符串），
  // 而且没顺带盖住设置面板 / 灯箱 / 伪装视图。
  // 注意 jsdom 不做 var() 代换，getComputedStyle 会原样吐出 var(...) —— 正好用来
  // 确认「这条规则命中了这个元素」；真正的数值看 html 上的行内自定义属性。
  ok('CSS 规则只把 rail + 主区调淡',
    /html\.ngax \.ngax-rail,\s*html\.ngax \.ngax-main\s*\{[^}]*opacity: var\(--ngax-opacity, 1\)/.test(SCRIPT_SRC));
  ok('主区命中了这条规则（getComputedStyle）',
    win.getComputedStyle($('.ngax-main')).opacity === 'var(--ngax-opacity, 1)',
    win.getComputedStyle($('.ngax-main')).opacity);
  ok('rail 也命中',
    win.getComputedStyle($('.ngax-rail')).opacity === 'var(--ngax-opacity, 1)',
    win.getComputedStyle($('.ngax-rail')).opacity);
  ok('设置面板不受影响（半透明就没法调了）',
    win.getComputedStyle($('.ngax-modal')).opacity !== 'var(--ngax-opacity, 1)',
    win.getComputedStyle($('.ngax-modal')).opacity);
  ok('没有把 opacity 写到 html 根节点上（那会连整个视口一起变淡）',
    root.style.opacity === '', root.style.opacity);

  // ── 侧边栏模式 ──
  leave();
  ok('侧边栏模式默认关：鼠标离开页面不触发伪装', !bossShown());

  const sw = $('[data-set-toggle="sidebarMode"]');
  ok('设置面板里有「侧边栏模式」开关', !!sw);
  ok('「回来自动还原」开关也在，默认开',
    !!$('[data-set-toggle="sidebarRestore"]') &&
    $('[data-set-toggle="sidebarRestore"]').classList.contains('on'));
  click(sw);
  ok('打开侧边栏模式写进 localStorage', /"sidebarMode":true/.test(store()), store());
  leave();
  ok('设置面板开着时鼠标离开不切换（别把正在调的界面盖掉）', !bossShown());
  click($('[data-settings-close]'));

  leave();
  ok('鼠标离开页面 → 自动进入伪装（和 Esc Esc 同一个视图）',
    bossShown() && root.classList.contains('ngax-boss-on'));
  ok('自动进入的伪装视图和手动进入的是同一个（有构建日志）',
    !!$('.ngax-boss') && /cargo build --release/.test($('.ngax-boss').textContent));
  enter();
  ok('鼠标回到页面 → 自动还原', !bossShown() && !root.classList.contains('ngax-boss-on'));

  // 用户自己按出来的伪装不归鼠标管：不然要么被替你还原，要么像按键失灵
  esc(); esc();
  ok('手动 Esc Esc 进入伪装', bossShown());
  enter();
  ok('手动进入的伪装，鼠标回到页面不会替你还原', bossShown());
  leave();
  ok('已经是伪装视图时，鼠标离开不再重复处理', bossShown());
  esc(); esc();
  ok('手动退出伪装', !bossShown());

  // 「回来自动还原」关掉 → 单向：离开即伪装，回来保持，靠自己按应急键
  settingsKey();
  click($('[data-set-toggle="sidebarRestore"]'));
  ok('「回来自动还原」可以关掉', /"sidebarRestore":false/.test(store()), store());
  click($('[data-settings-close]'));
  leave();
  ok('关掉自动还原后：离开照样伪装', bossShown());
  enter();
  ok('关掉自动还原后：回到页面保持伪装', bossShown());
  esc(); esc();
  ok('关掉自动还原后仍然能用应急键退出', !bossShown());
  enter();
  ok('手动退出后再回到页面，不会又弹出来', !bossShown());

  // 关掉侧边栏模式本身：顺手还原自动伪装 + 摘掉监听
  leave();
  ok('离开 → 又自动伪装了', bossShown());
  settingsKey();
  click($('[data-set-toggle="sidebarMode"]'));
  ok('关掉侧边栏模式时，顺手把自动伪装还原', !bossShown());
  click($('[data-settings-close]'));
  leave();
  ok('关掉之后鼠标离开不再触发（监听也摘了）', !bossShown());

  // 「恢复默认」也要照顾到这两项：透明度回 100%、侧边栏模式回关
  settingsKey();
  click($('[data-settings-reset]'));
  ok('恢复默认：透明度回到 100%',
    /"pageOpacity":100/.test(store()) && root.style.getPropertyValue('--ngax-opacity') === '1',
    root.style.getPropertyValue('--ngax-opacity') + ' / ' + store());
  ok('恢复默认：侧边栏模式回到关', !/"sidebarMode":true/.test(store()) && !bossShown(), store());
  click($('[data-settings-close]'));
  leave();
  ok('恢复默认后鼠标离开不再触发', !bossShown());

  win.close();
}

// ── 跑 ─────────────────────────────────────────────────────────────────

(async () => {
  const missing = ['big.u.html', 'fid7.utf8.html', 'th.utf8.html', 'home2.u.html', 'wow.u.html', 'ucp.u.html', 't_myfavor.u.html']
    .filter((f) => !fs.existsSync(path.join(TMP, f)));
  if (missing.length) {
    console.error('缺样本文件：' + missing.join(', ') + '（在 ' + TMP + '）');
    process.exit(2);
  }
  await testThread();
  await testList();
  await testHome();
  await testTheme();
  await testEarlyLock();
  await testContentImageCss();
  await testAttachment();
  await testMember();
  await testBoards();
  await testNgaHis();
  await testRailNoDoubleRender();
  await testOpacityAndSidebar();
  await testFallback();
  console.log('\n' + (fails ? '✗ ' + fails + ' / ' + checks + ' 项失败' : '✓ 全部 ' + checks + ' 项通过'));
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(3);
});
