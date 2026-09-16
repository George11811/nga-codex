#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 NGA 的版面表爬下来，产出 .build/forums.json（fid → 名字）。

为什么要爬：NGA 没有一个「全部版面」页面 —— 首页只有头条，顶部菜单里是用户菜单，
真正的版面关系是**分散在每个版面页的 `__ALL_FORUM_DATA` 里**（本版 + 子版 + 联合版）。
所以只能从某个版面出发做宽度优先遍历，把这些数据合并起来。

产出直接烘焙进脚本（p1.js 的 FORUMS 常量），这样：
  - 首页的「全部版面」和 rail 的「常用版面」用的是**站点自己的名字**，不是手抄的；
  - 运行时零请求（不用为了列版面去发 API）。

礼貌起见：固定间隔 1.1s、带 Referer、出错就停、上限 200 个请求。
NGA 对高频请求会返回 302/403，所以间隔不能省。
"""
import html
import io
import json
import os
import re
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
COOKIE_FILE = os.path.join(ROOT, '.nga', 'cookies.txt')
OUT = os.path.join(HERE, 'forums.json')
OUT_JS = os.path.join(HERE, 'forums.js')

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
DELAY = 1.1
MAX_REQ = 360

# 种子。为什么不止 -7：NGA 的版面关系是分散的，综合侧（-7）和游戏侧
# 不在同一棵联合树里 —— 只从 -7 出发爬不到炉石/原神这类游戏版。
SEED = ['-7', '414', '422', '428', '300', '-7', '436', '510346', '-7955747']


def cookie_header():
    with io.open(COOKIE_FILE, encoding='utf-8') as f:
        raw = f.read().strip()
    pairs = []
    for part in raw.split(';'):
        part = part.strip()
        if not part or '=' not in part:
            continue
        k, v = part.split('=', 1)
        pairs.append(k.strip() + '=' + v.strip())
    return '; '.join(pairs)


def fetch(fid, cookie):
    url = 'https://bbs.nga.cn/thread.php?fid=' + urllib.parse.quote(str(fid))
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Cookie': cookie,
        'Referer': 'https://bbs.nga.cn/thread.php?fid=-7',
        'Accept-Language': 'zh-CN,zh;q=0.9',
    })
    with urllib.request.urlopen(req, timeout=25) as r:
        raw = r.read()
    # NGA 是 GBK；页面里的 __ALL_FORUM_DATA 是纯 ASCII 结构 + 中文名字
    return raw.decode('gb18030', 'replace'), url


def balanced(text, pos):
    """从 text[pos]（'{'）开始取一个括号配平的对象字面量"""
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


def parse_forum_data(html):
    i = html.find('__ALL_FORUM_DATA')
    if i < 0:
        return {}
    j = html.find('{', i)
    if j < 0:
        return {}
    raw = balanced(html, j)
    if not raw:
        return {}
    # 值是 [fid, 名字, 副标题, ?, bit表达式]，里面有 64|4|2 这种位运算，交给 JS 求值不方便，
    # 这里只用正则抠出前三项（名字里不会有 ' 或转义）。
    out = {}
    for m in re.finditer(r"'?\s*(-?\d+)\s*'\s*:\s*\[\s*'?(-?\d+)'?\s*,\s*'([^']*)'\s*,\s*'([^']*)'", raw):
        fid, _fid2, name, sub = m.group(1), m.group(2), m.group(3), m.group(4)
        # NGA 的 __ALL_FORUM_DATA 里名字是 HTML 转义过的（King&#39;s Raid、A&amp;B）
        out[str(fid)] = {'fid': int(fid), 'name': html.unescape(name), 'sub': html.unescape(sub)}
    # 没有引号的数字键 / 带 t 前缀的合集会漏，不要紧（合集不是版面）
    return out


def uficon_seeds():
    """__UFICON / __UFIMGS 里那些还没见过名字的 fid。

    游戏侧版面（原神 / 英雄联盟 / DOTA …）不在 -7 那棵联合树里，
    光靠 __ALL_FORUM_DATA 的 BFS 到不了；这份资源表里有它们，所以当种子用。
    （生成见 .build/extract-fids.js）
    """
    p = os.path.join(HERE, 'uficon-unknown.txt')
    if not os.path.exists(p):
        return []
    with io.open(p, encoding='utf-8') as f:
        return [l.strip() for l in f if l.strip()]


def load_done():
    """把上次的结果当已访问（fid 集合），只补没见过的。

    注意：**--search 也必须加载**。一开始只在 --resume 下加载，
    结果 `--search` 直接把 900 多个版面的表覆盖成了新发现的那十几个
    （有用的数据被一次「补漏」抹掉了）。现在默认加载，除非显式 --fresh。
    """
    if not os.path.exists(OUT) or '--fresh' in os.sys.argv:
        return {}, set()
    d = json.load(io.open(OUT, encoding='utf-8'))
    seen = {str(b['fid']): b for b in d['boards']}
    return seen, set(seen)


# ============================== 搜索发现 ==============================
# 有些热门专版的**版面本身没有自定义图标**，所以不在 __UFICON 里，光靠资源表抓不到
# （明日方舟 / 绝区零 / 鸣潮 …）。但搜索页能找到这些版面的帖子，
# 而帖子页里有 __CURRENT_FID + 面包屑里指向本版的 nav_link，
# 于是「搜关键词 → 挑第一个帖子 → 读它属于哪个版面」就能把版面补出来。
# 每个关键词 2 个请求。

GAMES = [
    '明日方舟', '绝区零', '鸣潮', '我的世界', '泰拉瑞亚', '双人成行',
    '勇者斗恶龙', '最终幻想14', '幻兽帕鲁', '死亡搁浅', '只狼', '荒野大镖客',
    'GTA', '巫师3', '生化危机', '战神', '光环', '帝国时代', '文明6',
    '三国志', '全面战争', '足球经理', '宝可梦', '赛马娘', '少女前线',
    '战双帕弥什', '无期迷途', '重返未来', '尘白禁区', '幻塔',
    '剑与远征', '天地劫', '第七史诗', '洛克王国', '跑跑卡丁车', '冒险岛',
]


def fetch_raw(url, cookie):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Cookie': cookie,
        'Referer': 'https://bbs.nga.cn/thread.php?fid=-7',
        'Accept-Language': 'zh-CN,zh;q=0.9',
    })
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read().decode('gb18030', 'replace')


def parse_thread_board(html):
    """帖子页 → (fid, 版面名)。用 __CURRENT_FID + 面包屑里指向本版的 nav_link。"""
    m = re.search(r"__CURRENT_FID\s*=\s*(?:parseInt\()?'?(-?\d+)", html)
    if not m:
        return None
    fid = m.group(1)
    for fm, name in re.findall(
            r"<a href='/thread\.php\?fid=(-?\d+)'[^>]*class='nav_link'[^>]*>([^<]*)</a>", html):
        if fm == fid:
            return fid, html.unescape(name).strip()
    return None


def search_discover(cookie, seen, delay=None, keywords=None, tries=4):
    # 搜索模式要更慢：一次多个请求，间隔不够 NGA 会回 302 重定向环（限流），
    # 表现就是「关键词明明有版面却报失败」。
    delay = DELAY if delay is None else delay
    added = 0
    for kw in (keywords or GAMES):
        try:
            html = fetch_raw('https://bbs.nga.cn/thread.php?key=' + urllib.parse.quote(kw), cookie)
            tids = re.findall(r"<a href='/read\.php\?tid=(\d+)'[^>]*id='t_tt\d+_\d+'", html)
            if not tids:
                print('  %-12s 搜索无结果' % kw)
                continue
            # 搜索排序靠相关度 + 新鲜度，第一个结果常常是**别的版面**的帖子
            # （实测：「文明6」命中网事杂谈、「幻塔」命中熔炉骑士）。
            # 所以多试几个，而且**要求版面名和关键词互相包含**才算命中 ——
            # 宁可少补一个，也不能写进去一条驴唇不对马嘴的映射。
            hit = None
            for tid in tids[:tries]:
                time.sleep(delay)
                got = parse_thread_board(fetch_raw('https://bbs.nga.cn/read.php?tid=' + tid, cookie))
                if got and (kw in got[1] or got[1] in kw):
                    hit = got
                    break
            if not hit:
                print('  %-12s 前 %d 个结果里没有匹配版面的帖子' % (kw, min(tries, len(tids))))
                continue
            fid, name = hit
            if str(fid) not in seen:
                seen[str(fid)] = {'fid': int(fid), 'name': name, 'sub': ''}
                added += 1
                print('  %-12s → 新增版面 %s(%s)' % (kw, name, fid))
            else:
                print('  %-12s → 已有 %s(%s)' % (kw, name, fid))
        except Exception as e:
            print('  %-12s 失败：%s' % (kw, e))
        finally:
            time.sleep(delay)
    return added


def write_outputs(boards):
    """把版面表落盘：forums.json（数据）+ forums.js（直接给 p1.js 用的常量）"""
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


def main():
    cookie = cookie_header()
    if '--search' in os.sys.argv:
        seen = load_done()[0]
        d = None
        only = None
        for a in os.sys.argv:
            if a.startswith('--delay='):
                d = float(a.split('=', 1)[1])
            if a.startswith('--only='):
                only = a.split('=', 1)[1].split(',')
        print('搜索发现：%d 个关键词，间隔 %s s' % (len(only or GAMES), d or DELAY))
        n = search_discover(cookie, seen, d, only)
        boards = sorted(seen.values(), key=lambda x: (x['name'], x['fid']))
        write_outputs(boards)
        print('\n新增 %d 个版面，现在共 %d 个' % (n, len(boards)))
        return
    seen, visited = load_done()
    if visited:
        print('续爬：已有 %d 个版面，继续找新的' % len(seen))
    queue = [s for s in SEED if s not in visited] + [s for s in uficon_seeds() if s not in visited]
    print('队列：%d 个待查（其中 %d 个来自 __UFICON 资源表）' % (len(queue), len(uficon_seeds())))
    for k in seen:
        if k not in queue:
            pass
    n = 0
    while queue and n < MAX_REQ:
        fid = queue.pop(0)
        if fid in visited:
            continue
        visited.add(fid)
        n += 1
        try:
            html, url = fetch(fid, cookie)
            if '<title>帐号权限不足' in html or 'ERROR' in html[:200]:
                print('  ! %-10s 无权限/出错，跳过' % fid)
                continue
            data = parse_forum_data(html)
            fresh = 0
            for k, v in data.items():
                if k.startswith('t'):
                    continue
                if k not in seen:
                    fresh += 1
                seen[k] = v
                if k not in visited and k not in queue:
                    queue.append(k)
            title = re.search(r'<title>([^<]*)</title>', html)
            print('  [%3d] fid=%-10s 本页 %2d 个版面，新增 %2d ｜ 累计 %3d ｜ 队列 %3d ｜ %s'
                  % (n, fid, len(data), fresh, len(seen), len(queue),
                     (title.group(1) if title else '').replace(' NGA玩家社区', '')[:20]))
        except Exception as e:
            print('  ! %-10s 请求失败：%s' % (fid, e))
        time.sleep(DELAY)

    # 补上种子（有些页面不含自己）
    seen.setdefault('-7', {'fid': -7, 'name': '网事杂谈', 'sub': ''})

    boards = sorted(seen.values(), key=lambda x: (x['name'], x['fid']))
    write_outputs(boards)
    print('\n完成：%d 个版面（共发起 %d 次请求）→ %s' % (len(boards), n, OUT_JS))


if __name__ == '__main__':
    main()
