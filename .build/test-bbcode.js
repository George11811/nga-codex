/*
 * BBSCode 渲染器的离线回归测试。
 *
 * 做法：从生成的 nga-codex.user.js 里把 `#region bbcode` 那一段抠出来，
 * 在 node 里配几个 shim 跑起来，然后喂**真实抓下来的 NGA 帖子正文**
 * （服务端原始 HTML，也就是 BBSCode 最原始、最丑的形态）。
 *
 * 断言的是「不丢信息」而不是「长得对」：
 *   - 认识的标签必须被消化掉（输出里不该再有它们）；
 *   - 认不出来的 [xxx] 必须原样保留（宁可难看，也不能把正文吃掉）；
 *   - 表情/图片必须变成 <img>，而且 URL 要能拼对。
 *
 * 用法：node .build/test-bbcode.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'nga-codex.user.js');

// ── 1. 抠出 bbcode 区 ────────────────────────────────────────────────────
const src = fs.readFileSync(SCRIPT, 'utf8');
const region = src.slice(
  src.indexOf('/* #region bbcode */'),
  src.indexOf('/* #endregion bbcode */')
);
if (!region) {
  console.error('没找到 #region bbcode 标记');
  process.exit(1);
}

// NGA_SMILES 已经在 region 里（p2.js 的 /*__SMILES__*/ 标记就在 bbcode 区内）

// ── 2. shim + 求值 ───────────────────────────────────────────────────────
const shims = `
const ATTACH_BASE = "https://img.nga.cn/attachments/";
const SMILE_BASE = "https://img4.nga.cn/ngabbs/post/smile/";
function escapeHtml(t) {
  return String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function el(tag, cls, html) { return { innerHTML: html || "" }; }
function cfg() { return true; }
`;

const factory = new Function(shims + '\n' + region + `
  return { bbscodeToHtml, smileTagHtml, resolveAttachUrl, SMILE_MAP };
`);
const B = factory();

// ── 3. 拿真实正文 ────────────────────────────────────────────────────────
const TMP = process.env.TEMP || process.env.TMP || '/tmp';
const samples = [];
for (const f of ['th.utf8.html', 'big.u.html', 'fid7.utf8.html']) {
  const p = path.join(TMP, f);
  if (!fs.existsSync(p)) continue;
  const html = fs.readFileSync(p, 'utf8');
  const re = /<(?:p|span)[^>]*id=['"]postcontent\d+['"][^>]*>([\s\S]*?)<\/(?:p|span)>/g;
  let m, n = 0;
  while ((m = re.exec(html)) && n < 40) {
    samples.push({ file: f, html: m[1] });
    n++;
  }
}
if (!samples.length) {
  console.error('没找到测试样本（临时目录里的 *.utf8.html 不在了？）');
  process.exit(1);
}

// ── 4. 跑 ────────────────────────────────────────────────────────────────
// 认识的标签：渲染完不该再以 [xxx] 形式出现
const HANDLED = ['b', 'i', 'u', 'del', 'code', 'quote', 'collapse', 'url', 'img',
  'list', 'table', 'tr', 'td', 'uid', 'tid', 'pid', 'color', 'size', 'font', 'align'];

let fails = 0;
let stats = { smiles: 0, imgs: 0, quotes: 0, collapses: 0, codes: 0, unknown: new Set() };

// 和脚本里的 RE_REPLY_HEAD 同构（这里只要源码字符串，用来把头部从样本里摘掉）
const RE_REPLY_HEAD_SRC =
  /(?:\[b\])?\s*(?:Reply to\s*)?\[(?:pid|tid)=[\d,]+\]\s*(?:Reply|Topic)\s*\[\/(?:pid|tid)\]\s*(?:\[b\])?\s*Post\s+by\s*(?:\[uid=\d*\]?[^\[\]]{0,40}?\[\/uid\]?)?\s*\([^)]{0,30}\)\s*:?\s*(?:\[\/b\])?/gi;

for (const s of samples) {
  let out;
  try {
    out = B.bbscodeToHtml(s.html, { tid: 1 });
  } catch (e) {
    console.log('✗ 抛异常:', e.message, '\n  输入:', s.html.slice(0, 120));
    fails++;
    continue;
  }

  // 4a. 认识的标签必须被消化
  for (const tag of HANDLED) {
    const open = new RegExp('\\[' + tag + '(=[^\\]]*)?\\]', 'i');
    if (open.test(out)) {
      console.log('✗ [' + tag + '] 没被消化\n  输入:', s.html.slice(0, 140), '\n  输出:', out.slice(0, 200));
      fails++;
    }
  }

  // 4b. 认不出来的方括号必须原样留下来。
  // 注意要剥掉标签再找 —— 表情的 title 属性里就写着 [s:ac:哭笑]（当 tooltip用），
  // 直接扫全文会把它们当成「没识别」而误报。
  const textOnly = out.replace(/<[^>]*>/g, '');
  const unknown = (textOnly.match(/\[[a-z@*\/][^\]]{0,40}\]/gi) || []);
  for (const u of unknown) {
    if (!/^\[\/?[a-z]{1,12}\]$/i.test(u)) stats.unknown.add(u);
  }

  // 4b-2. 样本里每一个 [s:…] 都要真的变成表情图
  const smileIn = (s.html.match(/\[s:[^\]]{1,24}\]/g) || []).length;
  const smileOut = (out.match(/class="ngax-smile"/g) || []).length;
  if (smileIn !== smileOut) {
    console.log('✗ 表情没全部转成图：输入 ' + smileIn + ' 个，输出 ' + smileOut + ' 个');
    fails++;
  }

  // 4c. 统计
  stats.smiles += (out.match(/class="ngax-smile"/g) || []).length;
  stats.imgs += (out.match(/<img/g) || []).length;
  stats.quotes += (out.match(/class="quote"/g) || []).length;
  stats.collapses += (out.match(/ngax-collapse/g) || []).length;
  stats.codes += (out.match(/ngax-code/g) || []).length;

  // 4d. 正文一个字都不能丢：把标签都剥掉后，肉眼可见的字符应基本保留。
  // 两类例外要先去干净，否则会误报：
  //   - [img]…[/img] 的路径会变成 <img src>（属性，剥标签时一并没了）
  //   - 「回复某楼」头部会被压成「回复 名字 时间」，那串英文是故意丢的
  const visibleIn = s.html
    .replace(/\[img(=[^\]]*)?\][\s\S]*?\[\/img\]/gi, '')
    .replace(/\[url(=[^\]]*)?\][\s\S]*?\[\/url\]/gi, '')
    .replace(RE_REPLY_HEAD_SRC, '')
    .replace(/<[^>]+>/g, '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '');
  const visibleOut = out.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  const inSet = new Set(visibleIn.split(''));
  const outSet = new Set(visibleOut.split(''));
  const lost = [...inSet].filter((c) => !outSet.has(c));
  if (lost.length > 3) {
    console.log('✗ 有字符丢失:', lost.slice(0, 20).join(''), '\n  输入:', s.html.slice(0, 140));
    fails++;
  }
}

console.log('样本数:', samples.length);
console.log('表情:', stats.smiles, ' 图片:', stats.imgs, ' 引用:', stats.quotes,
  ' 折叠:', stats.collapses, ' 代码块:', stats.codes);
if (stats.unknown.size) {
  console.log('未识别的方括号（原样保留，属预期）:',
    [...stats.unknown].slice(0, 14).join(' '));
}

// ── 5. 定点断言 ──────────────────────────────────────────────────────────
const cases = [
  {
    name: '表情 [s:ac:哭笑]',
    // title 属性里会故意带上 [s:ac:哭笑]（当 tooltip 用），所以剥标签后再断言
    in: '太黑暗了[s:ac:哭笑]',
    check: (o) => o.includes('ac15.png') && o.includes('ngax-smile')
      && !o.replace(/<[^>]*>/g, '').includes('[s:')
  },
  {
    name: '附件相对路径 [img]',
    in: '[img]./mon_202609/16/-7Q40-68ejZfT3cSlc-sg.jpg[/img]',
    check: (o) => o.includes('src="https://img.nga.cn/attachments/mon_202609/16/-7Q40-68ejZfT3cSlc-sg.jpg"')
  },
  {
    name: '外部图片直链',
    in: '[img]https://example.com/a.png[/img]',
    check: (o) => o.includes('https://example.com/a.png')
  },
  {
    name: '粗体 / 删除线',
    in: '[b]粗[/b]和[del]删[/del]',
    check: (o) => o.includes('<b>粗</b>') && o.includes('<del>删</del>')
  },
  {
    name: '引用（含 pid 头部）',
    in: '[quote][pid=881891670]Reply[/pid] [b]Post by [uid=123]某人[/uid] (2026-09-16 10:07):[/b]\n\n原话[/quote]',
    check: (o) => o.includes('class="quote"') && o.includes('原话')
  },
  {
    name: '嵌套引用',
    in: '[quote]外层[quote]内层[/quote]尾[/quote]',
    check: (o) => (o.match(/class="quote"/g) || []).length === 2
  },
  {
    name: '代码块里的方括号不当标签',
    in: '[code]let a = [1,2];[/code]',
    check: (o) => o.includes('ngax-code') && o.includes('[1,2]')
  },
  {
    name: '折叠',
    in: '[collapse=点我]藏起来[/collapse]',
    check: (o) => o.includes('<summary>点我</summary>') && o.includes('藏起来')
  },
  {
    name: '折叠标题里的中文不炸',
    in: '[collapse=点我]x[/collapse]',
    check: (o) => !o.includes('[/collapse]')
  },
  {
    name: '链接 [url=…]',
    in: '[url=https://bbs.nga.cn/]NGA[/url]',
    check: (o) => o.includes('href="https://bbs.nga.cn/"') && o.includes('>NGA</a>')
  },
  {
    name: '危险的 url=javascript: 不能变成链接',
    in: '[url=javascript:alert(1)]点我[/url]',
    // 关键不是「输出里没有 javascript: 这几个字」（原文就有），
    // 而是它绝不能出现在 href 里
    check: (o) => !/href\s*=\s*["']?javascript:/i.test(o)
  },
  {
    name: 'NGA「回复某楼」头部（pid 带逗号分段）',
    in: '[b]Reply to [pid=824921217,44191387,1]Reply[/pid] Post by [uid=360579]迷惘中的骑士[/uid] (2025-05-26 17:37)[/b]\n\n正文',
    // 每个字段都要单独断言 —— 只查「名字出现过」是不够的：
    // 之前捕获组错位（uid 拿到名字、name 拿到时间）就是这么漏过去的
    check: (o) => o.includes('ngax-replyhead')
      && o.includes('data-pid="824921217"')
      && o.includes('data-uid="360579"')
      && o.includes('data-name="迷惘中的骑士"')
      && o.includes('data-time="2025-05-26 17:37"')
      && !o.includes('[pid=') && !o.includes('[/b]')
  },
  {
    name: '引用头部的 [pid=..]Reply[/pid] 也能消化',
    in: '[pid=1,2,3]Reply[/pid] [b]Post by [uid=4]名字[/uid] (2026-09-16 10:07):[/b]\n\n内容',
    check: (o) => o.includes('ngax-replyhead') && o.includes('data-pid="1"') && !o.includes('[pid=')
  },
  {
    // 真实形态：内容已经是 HTML，头部被包在站点的 <div class='quote'> 里
    name: 'div.quote 包裹的头部（pid=0 即楼主）',
    in: '<div class="quote">[pid=0,44191387,1]Reply[/pid] [b]Post by [uid=205511]某人[/uid] (2025-05-26 17:27):[/b]<br/>被引用的原话</div>',
    check: (o) => o.includes('ngax-replyhead')
      && o.includes('data-pid="0"')
      && o.includes('data-uid="205511"')
      && o.includes('data-name="某人"')
      && o.includes('data-time="2025-05-26 17:27"')
      && o.includes('被引用的原话')
      && !o.includes('[pid=')
  },
  {
    name: '用户名提及 [uid=] / [@名字]',
    in: '[uid=42]老王[/uid] 和 [@张三]',
    check: (o) => o.includes('uid=42') && o.includes('data-user="张三"')
  },
  {
    name: '列表 [list][*]',
    in: '[list][*]一[*]二[/list]',
    check: (o) => (o.match(/<li>/g) || []).length === 2
  },
  {
    name: '表格',
    in: '[table][tr][td]a[/td][td]b[/td][/tr][/table]',
    check: (o) => o.includes('<td>a</td>') && o.includes('<td>b</td>')
  },
  {
    name: '已经是 HTML 的部分不能被二次处理',
    in: '正常<a href="https://x.com/?a=1&b=2">链接</a>结尾',
    check: (o) => o.includes('<a href="https://x.com/?a=1&b=2">链接</a>')
  },
  {
    name: '认不出来的标签原样保留',
    in: '[randomblock=1]x[/randomblock]',
    check: (o) => o.includes('[randomblock=1]')
  },
  {
    name: '换行转 <br>',
    in: '第一行\n第二行',
    check: (o) => o.includes('第一行<br>第二行')
  },
  {
    name: 'smiley 表长度',
    in: '',
    check: () => B.SMILE_MAP.size >= 200
  }
];

console.log('\n── 定点断言 ──');
for (const c of cases) {
  const out = B.bbscodeToHtml(c.in, { tid: 1 });
  const ok = c.check(out);
  console.log((ok ? '✓ ' : '✗ ') + c.name + (ok ? '' : '\n    → ' + out.slice(0, 220)));
  if (!ok) fails++;
}

console.log('\n' + (fails ? '✗ 失败 ' + fails + ' 项' : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
