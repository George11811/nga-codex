/*
 * 把脚本渲染出来的真实 DOM 落成一个 HTML 文件，交给无头 Edge 截图。
 *
 * 为什么需要它：jsdom 没有排版引擎，断言只能验「结构对不对」，
 * 验不了「看起来对不对」。而这是个换皮肤的脚本 —— 「看起来对不对」才是重点。
 * 这个脚本负责把 jsdom 里的渲染结果（含注入的 CSS）序列化出来，
 * 截图那一步由 .build/shot.sh 调 msedge --headless 完成。
 *
 * 用法：node .build/render-preview.js <页面样本文件名> [输出名] [宽]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('C:/ngatest/jt/node_modules/jsdom');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'nga-codex.user.js'), 'utf8');
const TMP = process.env.TEMP || process.env.TMP || '/tmp';

const file = process.argv[2] || 'wow.u.html';
const outName = process.argv[3] || 'preview.html';
const isUcp = /^ucp/.test(file);
const url = /^fid7/.test(file) ? 'https://bbs.nga.cn/thread.php?fid=-7'
  : /^home2/.test(file) ? 'https://bbs.nga.cn/'
    : isUcp ? 'https://bbs.nga.cn/nuke.php?func=ucp&uid=34330581'
      : 'https://bbs.nga.cn/read.php?tid=' + (/wow/.test(file) ? '47565864' : '44191387');

const html = fs.readFileSync(path.join(TMP, file), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url });
const win = dom.window;

// 模拟 NGA 原生 JS 的产物（和 test-dom.js 里同一套做法）
win.__CURRENT_UID = 34330581;
win.__CURRENT_UNAME = 'happy0416';
win.__COLOR = { bg0: '#1a1a1a', bg1: '#1d1d1d', bg2: '#212121', bg4: '#292826' };

const balanced = (s, pos) => {
  let d = 0, q = null, esc = false;
  for (let i = pos; i < s.length; i++) {
    const c = s[i];
    if (q) { if (esc) { esc = false; continue; } if (c === '\\') { esc = true; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '{') d++;
    else if (c === '}') { d--; if (!d) return s.slice(pos, i + 1); }
  }
  return null;
};
const objAfter = (s, name) => {
  const i = s.indexOf(name);
  if (i < 0) return null;
  const b = s.indexOf('{', i);
  return b < 0 ? null : balanced(s, b);
};
let users = {};
const rawUsers = objAfter(html, 'commonui.userInfo.setAll(');
if (rawUsers) { try { users = JSON.parse(rawUsers); } catch { try { users = Function('return ' + rawUsers)(); } catch { } } }

// postArg / topicArg 参数还原（只要 uid / 时间 / pid 这些脚本真的会读的字段）
const POST_ARG_NAMES = ['i', 'pC', 'subjectC', 'contentC', 'signC', 'uInfoC', 'pInfoC', 'postBtnC',
  'fid', 'tid', 'pid', 'type', 'tAid', 'pAid', 'postTime', 'recommend', 'cLength',
  'ip', 'orgForum', 'fromClient', 'orgFid', 'stid', 'atItem', 'opt'];
const postArgData = {};
{
  const re = /commonui\.postArg\.proc\(\s*([\s\S]*?)\)\s*\n/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const cleaned = m[1].replace(/\$\(([^)]*)\)/g, (s, inner) => JSON.stringify(inner.trim().replace(/^['"]|['"]$/g, '')));
      const args = Function('return [' + cleaned + ']')();
      const o = {};
      POST_ARG_NAMES.forEach((n, i) => { o[n] = args[i]; });
      if (o.i !== undefined && o.i !== null) postArgData[o.i] = o;
    } catch { /* 跳过个别格式怪的 */ }
  }
}
const topicArgData = [];
{
  const re = /commonui\.topicArg\.add\(\s*([\s\S]*?)\n\)/g;
  let m;
  while ((m = re.exec(html))) { try { topicArgData.push(Function('return [' + m[1] + ']')()); } catch { } }
}
const g = (name, re) => { const m = html.match(re); return m ? Number(m[1]) : 0; };
win.__CURRENT_FID = String(g('fid', /__CURRENT_FID\s*=\s*(?:parseInt\()?'?(-?\d+)/) || (/-7/.test(html) ? -7 : 0));
win.__CURRENT_TID = g('tid', /__CURRENT_TID\s*=\s*(\d+)/);
{
  const p = html.match(/var __PAGE\s*=\s*(\{[^}]*\})/);
  if (p) { try { win.__PAGE = Function('return ' + p[1])(); } catch { } }
  const all = objAfter(html, '__ALL_FORUM_DATA');
  if (all) { try { win.__ALL_FORUM_DATA = Function('return ' + all)(); } catch { } }
}

// 用户页：真实环境下 #ucp_block 是 js_ucp.js 现渲染的（这里跑不了站点 JS），
// 所以手工摆一份等价的结构，否则预览里看不到那排动作按钮。
if (isUcp) {
  const raw = objAfter(html, '__UCPUSER');
  if (raw) { try { win.__UCPUSER = Function('return ' + raw)(); } catch { } }
  win.__NOW = 1789524000;
  const block = win.document.getElementById('ucp_block');
  if (block) {
    block.innerHTML =
      '<span id="ucpuser_info_block"><h2 class="catetitle">:: ' +
      ((win.__UCPUSER && win.__UCPUSER.username) || '') + ' 的基础信息 ::</h2>' +
      '<div class="cateblock" id="ucpuser_info_blockContent"><div class="contentBlock">' +
      '<div _name="uld">' +
      '<a href="javascript:void(0)">更改密码</a>' +
      '<a href="javascript:void(0)">重置密码</a>' +
      '<a href="javascript:void(0)">绑定手机号</a>' +
      '<a href="javascript:void(0)">更换手机号</a>' +
      '<a href="javascript:void(0)">账号关联</a>' +
      '</div>' +
      '<div _name="uld"><span>用户ID</span><span>' +
      ((win.__UCPUSER && win.__UCPUSER.uid) || '') + '</span></div>' +
      '<div class="clear"></div></div></div></span>';
  }
}

win.commonui = {
  userInfo: { users },
  postArg: { data: postArgData },
  topicArg: { data: topicArgData },
  postScoreAdd() { }, favor() { }, alert() { }
};

// 原生快速回复表单（真实站点由 commonui.fastPostUi 建）
{
  let fast = win.document.getElementById('fast_post_c');
  if (!fast) {
    fast = win.document.createElement('span');
    fast.id = 'fast_post_c';
    (win.document.getElementById('mc') || win.document.body).appendChild(fast);
  }
  fast.innerHTML = '<input type="text"><textarea></textarea><a class="uitxt1">发表回复</a>';
}

win.eval(SRC);

setTimeout(() => {
  const d = win.document;
  // ① 强制 UTF-8：NGA 页面自带 <meta charset=GBK>，而我们已经把文件转成 UTF-8 了，
  //    不覆盖它的话浏览器会按 GBK 解 UTF-8 字节 → 满屏乱码（踩过）
  const exists = d.querySelector('meta[charset], meta[http-equiv="Content-Type"]');
  const cs = d.createElement('meta');
  cs.setAttribute('charset', 'utf-8');
  d.head.insertBefore(cs, d.head.firstChild);

  // ② 注入 base：截的是本地文件，相对链接和图片得知道去哪儿找
  if (!d.querySelector('base')) {
    const b = d.createElement('base');
    b.href = 'https://bbs.nga.cn/';
    d.head.insertBefore(b, d.head.firstChild);
  }
  // 藏掉原生 DOM（预览里不需要，还能省一半体积）；真实环境是靠 CSS 藏的
  const mmc = d.getElementById('mmc');
  if (mmc) mmc.remove();

  const out = '<!doctype html>\n' + d.documentElement.outerHTML;
  fs.writeFileSync(path.join(__dirname, outName), out, 'utf8');

  const counts = {
    '楼层': d.querySelectorAll('.ngax-turn').length,
    '正文块': d.querySelectorAll('.ngax-cooked, .ngax-turn-user-bubble').length,
    '图片': d.querySelectorAll('.ngax-cooked img, .ngax-turn-user-bubble img').length,
    '兜底附件图': d.querySelectorAll('.ngax-attach img').length,
    '表情': d.querySelectorAll('img.ngax-smile').length,
    '引用卡': d.querySelectorAll('.ngax-quote').length,
    '思考块': d.querySelectorAll('.ngax-think').length,
    '工具行': d.querySelectorAll('.ngax-runline').length
  };
  console.log(outName + ' 已生成：' + Object.keys(counts).map((k) => k + '=' + counts[k]).join('  '));
  win.close();
}, 250);
