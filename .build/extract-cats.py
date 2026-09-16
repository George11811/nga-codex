#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从 NGA 首页那份 CDN 版面目录里抽出**分类结构**，产出 .build/index-cats.js。

数据源：http://img4.nga.cn/proxy/cache_attach/bbs_index_data.js?7<floor(now/7200)>
（见 js_default.js 里的 __API.indexForumList；这份文件带不带 cookie 都一样，
 是 CDN 静态文件，所以能直接抓。首页的「收藏版面」分类在它是空占位，
 真正填进去的是用户浏览器里的本地历史 —— 那部分脚本运行时用
 commonui.eachForumViewHis 读。）

结构：data["0"]["all"] = { 分类id: {name, content: { 分组: {name, content: { 版面 } } } } }
      data["0"]["single"] / ["double"] = 分类的显示顺序（单栏 / 双栏两套布局）
版面字段：{fid, name, info(简介), nameS(短名), bit}

用法：python .build/extract-cats.py <bbs_index_data.js 路径>
"""
import html
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_JS = os.path.join(HERE, 'index-cats.js')
OUT_JSON = os.path.join(HERE, 'index-cats.json')


def balanced(text, pos):
    depth = 0
    quote = None
    esc = False
    for i in range(pos, len(text)):
        c = text[i]
        if quote:
            if esc:
                esc = False
                continue
            if c == '\\':
                esc = True
                continue
            if c == quote:
                quote = None
            continue
        if c in ('"', "'"):
            quote = c
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return text[pos:i + 1]
    return None


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.environ.get('TEMP', '/tmp'), 'idx.u.js')
    raw = io.open(src, encoding='utf-8', errors='ignore').read()
    i = raw.index('{', raw.index('script_muti_get_var_store'))
    data = json.loads(balanced(raw, i))
    root = data['data']['0']
    allsec = root['all']

    # 分类顺序：single（单栏）就是完整的线性顺序；它漏掉的按 all 里的出现顺序补上
    order = []
    for layout in ('single',):
        for k in (root.get(layout) or {}):
            for v in (root[layout][k] or {}).values():
                if v and v not in order:
                    order.append(v)
    for k in allsec:
        if k not in order:
            order.append(k)

    def boards_of(node):
        """
        一条目可能是「版面」也可能是「合集」：

          {fid: 863, name: '手机游戏资讯'}
          {fid: 428, name: '赛事/活动', stid: 29182350}   ← 合集！

        合集挂在某个版面上（fid 是它的宿主版面），真实身份是 stid，
        链接是 /thread.php?stid=NNN。一开始我只看 fid，
        结果同一个宿主版面下的 187 个合集全被当成同一个版面（实测 428 重复 187 次）。
        去重也得按 NGA 自己的 key 规则（hisLink.key：有 stid 就是 t+stid，否则 f+fid）。
        """
        out = []
        for key in node.get('content', {}):
            b = node['content'][key]
            if not isinstance(b, dict) or 'fid' not in b:
                continue
            fid = b.get('fid')
            if fid is None:
                continue
            stid = b.get('stid')
            out.append({
                'fid': int(fid),
                'stid': int(stid) if stid else 0,
                'name': html.unescape(str(b.get('name') or '')),
                'info': html.unescape(str(b.get('info') or '')),
                'short': html.unescape(str(b.get('nameS') or '')),
            })
        return out

    cats = []
    board_map = {}
    seen_keys = set()
    for cid in order:
        sec = allsec.get(cid)
        if not isinstance(sec, dict):
            continue
        groups = []
        for gkey in sec.get('content', {}):
            g = sec['content'][gkey]
            if not isinstance(g, dict):
                continue
            bs = boards_of(g)
            # 按 NGA 自己的 key 规则去重（同一个合集可能出现在多个分组里）
            uniq = []
            for b in bs:
                k = ('t%d' % b['stid']) if b['stid'] else ('f%d' % b['fid'])
                if k in seen_keys:
                    continue
                seen_keys.add(k)
                uniq.append(b)
            bs = uniq
            if not bs:
                continue
            gname = html.unescape(str(g.get('name') or ''))
            groups.append({'name': gname, 'boards': bs})
            for b in bs:
                if b['stid']:
                    continue        # 合集不是版面，不进版面表
                board_map[str(b['fid'])] = {
                    'cat': html.unescape(str(sec.get('name') or cid)),
                    'group': gname,
                    'info': b['info'],
                    'short': b['short'],
                }
        if not groups:
            continue
        cats.append({'id': cid, 'name': html.unescape(str(sec.get('name') or cid)), 'groups': groups})

    total = sum(len(g['boards']) for c in cats for g in c['groups'])
    with io.open(OUT_JSON, 'w', encoding='utf-8', newline='\n') as f:
        json.dump({'cats': cats, 'boards': board_map, 'count': total}, f,
                  ensure_ascii=False, indent=1)

    # 生成紧凑的 JS 常量：版面用 [fid, 名字, 简介] 三元组
    lines = []
    for c in cats:
        lines.append('    { name: %s, groups: [' % json.dumps(c['name'], ensure_ascii=False))
        for g in c['groups']:
            lines.append('      { name: %s, boards: [' % json.dumps(g['name'], ensure_ascii=False))
            for b in g['boards']:
                lines.append('        [%d, %d, %s, %s],' % (
                    b['fid'], b['stid'], json.dumps(b['name'], ensure_ascii=False),
                    json.dumps(b['info'], ensure_ascii=False)))
            lines.append('      ] },')
        lines.append('    ] },')
    with io.open(OUT_JS, 'w', encoding='utf-8', newline='\n') as f:
        f.write('  // 由 .build/extract-cats.py 从 NGA 首页那份 CDN 版面目录生成\n')
        f.write('  // 结构：分类 → 分组(可空) → 版面 [fid, 名字, 简介]，顺序就是站点自己的顺序\n')
        f.write('  // 共 %d 个分类 / %d 个版面\n' % (len(cats), total))
        f.write('  const INDEX_CATS = [\n' + '\n'.join(lines) + '\n  ];\n')

    print('分类 %d 个，版面 %d 个：' % (len(cats), total))
    for c in cats:
        print('   %-12s %2d 组 %3d 版' % (c['name'], len(c['groups']),
                                       sum(len(g['boards']) for g in c['groups'])))
    print('→ %s / %s' % (OUT_JS, OUT_JSON))


if __name__ == '__main__':
    main()
