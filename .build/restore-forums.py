#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 .build/forums.json 从**已生成的用户脚本**里恢复出来，并合并搜索发现的那些版面。

为什么会需要：crawl-forums.py 的 --search 模式一开始没加载已有表，
直接把 963 个版面的 forums.json 覆盖成了 15 个（脚本 bug，已修）。
而 nga-codex.user.js 是覆盖之前构建的，里面嵌着那份 963 的表 —— 从那儿捞回来。

用法：python .build/restore-forums.py
"""
import io
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
USER_JS = os.path.join(ROOT, 'nga-codex.user.js')
OUT = os.path.join(HERE, 'forums.json')
OUT_JS = os.path.join(HERE, 'forums.js')
SEARCH = os.path.join(HERE, 'forums-search.json')


def main():
    s = io.open(USER_JS, encoding='utf-8').read()
    i = s.index('const FORUMS = [')
    j = s.index('\n  ];', i)
    block = s[i:j]
    # name / sub 是 json.dumps 出来的，所以按 JSON 字符串语法反解
    pat = re.compile(r'\{ fid: (-?\d+), name: "((?:[^"\\]|\\.)*)"(?:, sub: "((?:[^"\\]|\\.)*)")? \}')
    entries = pat.findall(block)
    print('从用户脚本里捞回: %d 个版面' % len(entries))
    if not entries:
        raise SystemExit('没捞到 —— 用户脚本里没有 FORUMS 表？')

    boards = []
    for fid, name, sub in entries:
        boards.append({
            'fid': int(fid),
            'name': json.loads('"' + name + '"'),
            'sub': json.loads('"' + sub + '"') if sub else '',
        })
    m = {str(b['fid']): b for b in boards}

    if os.path.exists(SEARCH):
        extra = json.load(io.open(SEARCH, encoding='utf-8'))['boards']
        added = 0
        for b in extra:
            if str(b['fid']) not in m:
                m[str(b['fid'])] = b
                added += 1
        print('合并搜索发现: %d 个，其中新增 %d' % (len(extra), added))

    boards = sorted(m.values(), key=lambda x: (x['name'], x['fid']))
    with io.open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        json.dump({'source': 'crawl', 'count': len(boards), 'boards': boards},
                  f, ensure_ascii=False, indent=1)

    lines = []
    for b in boards:
        sub = b['sub'] or ''
        lines.append('    { fid: %s, name: %s%s },' % (
            b['fid'], json.dumps(b['name'], ensure_ascii=False),
            (', sub: ' + json.dumps(sub, ensure_ascii=False)) if sub else ''))
    with io.open(OUT_JS, 'w', encoding='utf-8', newline='\n') as f:
        f.write('  // 由 .build/crawl-forums.py 生成（三条路子合并）：\n')
        f.write('  //   ① 从各版面页 __ALL_FORUM_DATA 做 BFS；\n')
        f.write('  //   ② 拿 __UFICON / __UFIMGS 资源表里的 fid 当种子（游戏侧不在同一棵联合树里）；\n')
        f.write('  //   ③ --search 模式：按关键词搜帖子 → 读帖子属于哪个版面（补没图标的专版）。\n')
        f.write('  // 共 %d 个版面；名字全部来自站点自己，没有手抄\n' % len(boards))
        f.write('  const FORUMS = [\n' + '\n'.join(lines) + '\n  ];\n')
    print('恢复完成: %d 个版面 → %s' % (len(boards), OUT_JS))


if __name__ == '__main__':
    main()
