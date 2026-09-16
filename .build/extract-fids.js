/*
 * 从 combine.js（NGA 的 cache_attach 合并数据）里抽出**版面 icon 表**里的 fid。
 *
 * 为什么需要它：爬版面表时只按 __ALL_FORUM_DATA 里的"本版 + 子版 + 联合版"走 BFS，
 * 综合侧和游戏侧不在同一棵联合树里，所以原神 / 英雄联盟 / DOTA 这类版根本到不了。
 * 而 combine.js 里的 __UFICON / __UFIMGS 是一份**资源表**：有自定义图标的版面都在里面
 * （实测 639=圣歌/Anthem、-349066=赛里斯文化交流 都是真版面），
 * 拿它当种子能把游戏侧补进来。
 *
 * 产出 .build/uficon-fids.txt（全部 fid）和 .build/uficon-unknown.txt（还不知道名字的）。
 *
 * 用法：node .build/extract-fids.js <combine.js 路径>
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const src = process.argv[2] ||
  path.join(process.env.TEMP || '/tmp', 'combine.u.js');
const text = fs.readFileSync(src, 'utf8');

const grab = (name) => {
  const m = text.match(new RegExp(name + '\\s*=\\s*\\[([\\s\\S]*?)\\]'));
  if (!m) return null;
  try { return eval('[' + m[1] + ']'); } catch { return null; }
};

const out = new Set();
// 只取 __UF**（Forum）；__US** 是用户图标表，里面是用户 id 不是版面
for (const name of ['__UFICON']) {
  const arr = grab(name);
  if (!arr) { console.log('  未找到 ' + name); continue; }
  let n = 0;
  for (let i = 0; i < arr.length; i += 2) {
    if (typeof arr[i] === 'number') { out.add(arr[i]); n++; }
  }
  console.log('  %s: %d 项 → %d 个 fid', name, arr.length, n);
}
for (const name of ['__UFIMGS']) {
  const arr = grab(name);
  if (!arr) { console.log('  未找到 ' + name); continue; }
  let n = 0;
  for (let i = 0; i < arr.length; i += 3) {
    const mm = String(arr[i] || '').match(/^fs(-?\d+)$/);
    if (mm) { out.add(Number(mm[1])); n++; }
  }
  console.log('  %s: %d 项 → %d 个 fid', name, arr.length, n);
}

const list = [...out];
fs.writeFileSync(path.join(HERE, 'uficon-fids.txt'), list.join('\n') + '\n', 'utf8');
console.log('合计 fid: %d → uficon-fids.txt', list.length);

const jsonPath = path.join(HERE, 'forums.json');
if (fs.existsSync(jsonPath)) {
  const known = new Set(JSON.parse(fs.readFileSync(jsonPath, 'utf8')).boards.map((b) => String(b.fid)));
  const unknown = list.filter((f) => !known.has(String(f)));
  fs.writeFileSync(path.join(HERE, 'uficon-unknown.txt'), unknown.join('\n') + '\n', 'utf8');
  console.log('已知 %d 个版面，其中还没见过名字的: %d 个 → uficon-unknown.txt', known.size, unknown.length);
}
