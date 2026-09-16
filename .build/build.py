#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 .build/ 下的三个片段拼成 nga-codex.user.js。

之所以用「生成」而不是手写一个大文件：
  - 视觉设计系统（CSS）是从 reference/v2ex-codex.user.js 里搬的，
    1700 行没必要重敲一遍，机械改名（v2cx → ngax）比复制粘贴靠谱；
  - 表情表（NGA_SMILES）是从 NGA 自己的 js_bbscode_core.js 里抽出来的
    官方数据，同样不该手抄。

生成结果是**自包含**的单文件用户脚本，之后改需求直接改 .build/*.js 再跑本脚本。
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REF = os.path.join(ROOT, 'reference', 'v2ex-codex.user.js')
OUT = os.path.join(ROOT, 'nga-codex.user.js')

ROOT_CLASS = 'ngax'
LOCK_CLASS = 'ngax-locked'
LIGHT_CLASS = 'ngax-light'
RAIL_W = '306'


def read(path):
    with io.open(path, encoding='utf-8') as f:
        return f.read()


def extract_ref_css():
    src = read(REF)
    start = src.index('const RAW_CSS = String.raw`') + len('const RAW_CSS = String.raw`')
    end = src.index('\n  `;', start)
    return src[start:end]


def transform_css(css):
    # 1) 类名前缀 / CSS 变量前缀一起换（--v2cx-panel-w → --ngax-panel-w）
    css = css.replace('v2cx', 'ngax')

    # 2) 模板字面量插值换成实际值 —— 生成出来的 CSS 是普通字符串，不能留 ${}
    css = css.replace('${ROOT_CLASS}', ROOT_CLASS)
    css = css.replace('${LOCK_CLASS}', LOCK_CLASS)
    css = css.replace('${LIGHT_CLASS}', LIGHT_CLASS)
    css = css.replace('${RAIL_W}', RAIL_W + 'px')

    # 3) 「隐藏原生页面」那一整段换成 NGA 版
    old_hide = """    /* ---------- 隐藏原生页面（仅被接管的路由） ---------- */
    html.ngax.ngax-locked #Top,
    html.ngax.ngax-locked #Wrapper,
    html.ngax.ngax-locked #Bottom,
    html.ngax.ngax-locked .scroll-top {
      display: none !important;
    }"""
    new_hide = """    /* ---------- 隐藏原生页面（仅被接管的路由） ----------
     *
     * 主力规则是直接藏 #mmc —— 它是 NGA 所有内容的根（#mc 就在里面）。
     *
     * 一开始这里只列了具体的 .module_wrap / #m_posts 之类，想着「不藏将来
     * 可能想用的东西」；但那样只要 NGA 多出一类容器就会漏出来 —— 而漏出来的
     * 代价是「整帧原生页面闪一下」（用户实际碰到的就是这个问题），
     * 比偶尔多藏一个新模块严重得多。
     *
     * 藏了也不影响功能：原生 DOM 仍在内存里，站点自己的 JS 照跑，
     * 我们照样能读写它（比如快速回复框的 textarea）。
     *
     * 为什么用 display:none 而不是「移出视口」：NGA 的「跳到指定楼层」
     * （commonui.afterPostProc 里的 scrollIntoView）会把移出视口的元素当目标，
     * 视口就被横向拖到 -99999px 去了；display:none 的元素没有盒子，
     * scrollIntoView 是空操作，反而安全。
     *
     * 下面的具体选择器保留作为冗余（万一某个页面没有 #mmc 但有这些容器），
     * 同时兼作「到底藏了什么」的文档。
     */
    html.ngax.ngax-locked #mmc,
    html.ngax.ngax-locked #minWidthSpacer,
    html.ngax.ngax-locked #mc > .module_wrap,
    html.ngax.ngax-locked #mainmenu,
    html.ngax.ngax-locked #currentTopicName,
    html.ngax.ngax-locked #currentForumName,
    html.ngax.ngax-locked #currentSetName,
    html.ngax.ngax-locked #topicAuthorName,
    html.ngax.ngax-locked #fast_post_c,
    html.ngax.ngax-locked #footer,
    html.ngax.ngax-locked #m_posts,
    html.ngax.ngax-locked #m_threads {
      display: none !important;
    }

    /*
     * NGA 自己的弹窗（收藏夹选择、报错提示、图片查看器…）挂在 body 下、
     * 不在 #mc 里，所以不会被上面藏掉 —— 但会被我们的 rail / 主区盖住。
     * 单独把层级抬起来，让站点的弹窗永远在最上面。
     */
    html.ngax .commonwindow,
    html.ngax #adminwindow,
    html.ngax .single_ttip2 {
      z-index: 3000 !important;
    }"""
    if old_hide not in css:
        sys.exit('构建失败：找不到「隐藏原生页面」那一段，参考文件可能变了')
    css = css.replace(old_hide, new_hide)

    # 4) 未接管页面的偏移：V2EX 的 #Wrapper → NGA 的 #mmc
    css = css.replace(
        """    html.ngax:not(.ngax-locked) #Wrapper {
      margin-left: var(--cx-rail-w) !important;
    }""",
        """    html.ngax:not(.ngax-locked) #mmc {
      margin-left: var(--cx-rail-w) !important;
      min-width: 0 !important;
    }""")

    # 5) 注释里残留的 V2EX 字样清掉，免得读代码的人以为走错了片场
    css = css.replace('V2EX 的 i.v2ex.co 没有 _thumb 变体，', 'NGA 的附件不带缩略图变体，')
    css = css.replace('移植自原脚本的 .codex-composer', '移植自参考实现的 .codex-composer')

    return css


# NGA 专属补充样式：只加参考实现里没有的东西（NGA 的正文元素、表情、表格…）
EXTRA_CSS = """
    /* ================= NGA 专属：正文里的站点元素 ================= */

    /*
     * NGA 的正文是站点自己渲染的 HTML，会带一堆内联样式和站点 class。
     * 这里只做「收拢」不做「重绘」：宽度、换行、图片尺寸这些交给下面统一管，
     * 颜色/字号一律继承我们的 token，免得深色模式下出现黑字灰底。
     */
    .ngax-cooked, .ngax-turn-user-bubble { color: var(--cx-text); }

    /* 站点正文里的表格（[table] 渲染出来的那种） */
    .ngax-cooked table, .ngax-table {
      border-collapse: collapse;
      margin: 8px 0;
      max-width: 100%;
      font-size: 13px;
    }
    .ngax-cooked table td, .ngax-cooked table th, .ngax-table td {
      border: 1px solid var(--cx-border);
      padding: 4px 8px;
      vertical-align: top;
    }
    .ngax-cooked table.quote { border: 0; }

    /* 引用：原生渲染成 div.quote，脚本会把它升级成 .ngax-quote 卡片；
       万一升级没跑到（解析不出来），至少别是一片灰底黑字 */
    .ngax-cooked div.quote, .ngax-turn-user-bubble div.quote {
      border-left: 2px solid var(--cx-border);
      padding-left: 10px;
      color: var(--cx-text-secondary);
      margin: 6px 0;
    }

    /* NGA 表情：站点默认尺寸不一，统一成行内小图。
     *
     * 这里的优先级很关键：上面那条「.ngax-cooked img」（把内容图当大图约束的）
     * 是 (0,1,1)，而光秃秃的「.ngax-smile」只有 (0,1,0) —— 比不过它。
     * 结果就是：表情被当成内容大图，width/height 被改成 auto、
     * 再被 max-width 撑到 260px，三个表情竖着占满一屏（实拍确认过）。
     * 所以这里得写成 (0,2,1) 把它压下去。
     *
     * 两种 class 都要盖：脚本自己渲染的用 ngax-smile，
     * 站点原生渲染好的用 smile / smile_ac / smile_a2 …（见 js_bbscode_core.js 里
     * 那个 img class 拼接），后者只靠 [class^="smile"] 匹配。
     */
    .ngax-cooked img.ngax-smile,
    .ngax-turn-user-bubble img.ngax-smile,
    .ngax-cooked img[class^="smile"],
    .ngax-turn-user-bubble img[class^="smile"] {
      display: inline-block;
      width: auto;
      height: auto;
      max-width: 1.7em;
      max-height: 1.7em;
      margin: 0 1px;
      vertical-align: -0.35em;
      border: 0;
      border-radius: 0;
      box-shadow: none;
      background: none;
    }

    /* 正文里的小图（图标/等级条）：不缩略、不预览。
     * 同样要写成 (0,2,1) 才压得住上面那条。
     */
    .ngax-cooked img.ngax-img-sm,
    .ngax-turn-user-bubble img.ngax-img-sm {
      display: inline-block;
      vertical-align: middle;
      max-width: 120px;
      max-height: 80px;
      box-shadow: none;
    }

    /* 代码块 */
    .ngax-code {
      background: var(--cx-bg-inset);
      border: 1px solid var(--cx-border);
      border-radius: 6px;
      padding: 10px 12px;
      overflow-x: auto;
      font-family: var(--cx-font-mono);
      font-size: 12.5px;
      line-height: 1.55;
      white-space: pre;
      margin: 8px 0;
    }

    /* 折叠 [collapse] */
    .ngax-collapse {
      border: 1px solid var(--cx-border);
      border-radius: var(--cx-radius);
      margin: 8px 0;
      overflow: hidden;
    }
    .ngax-collapse > summary {
      cursor: pointer;
      padding: 6px 10px;
      font-size: 12.5px;
      color: var(--cx-text-secondary);
      background: var(--cx-wash);
      list-style: none;
    }
    .ngax-collapse > summary::-webkit-details-marker { display: none; }
    .ngax-collapse-body { padding: 8px 10px; }

    /* 列表 */
    .ngax-list { margin: 6px 0 6px 20px; padding: 0; }

    /* @某人 / [uid] 提及：按钮或链接，都做得像正文的一部分 */
    .ngax-mention {
      color: var(--cx-blue);
      background: none;
      border: 0;
      padding: 0;
      font: inherit;
      cursor: pointer;
      text-decoration: none;
    }
    .ngax-mention:hover { text-decoration: underline; }

    /* 楼层里的附带信息 */
    .ngax-dim { color: var(--cx-text-faint); }
    .ngax-mark {
      color: var(--cx-text-secondary);
      background: var(--cx-chip-bg);
      border-radius: 4px;
      padding: 0 4px;
      font-size: 11px;
    }
    .ngax-no-avatar .ngax-user { margin-left: 0; }

    /* 附件区（原生异步渲染出来的图，脚本会搬到正文后面） */
    .ngax-attach { margin-top: 8px; }
    .ngax-attach img { margin-right: 6px; }

    /* 置顶主题 */
    .ngax-sticky-box {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin: 0 0 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--cx-border);
    }
    .ngax-sticky {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 5px 8px;
      border-radius: 6px;
      color: var(--cx-text-secondary);
      font-size: 13px;
      text-decoration: none;
    }
    .ngax-sticky:hover { background: var(--cx-wash); color: var(--cx-text); }
    .ngax-sticky svg { width: 13px; height: 13px; flex: none; opacity: .7; }

    /* 分页（页数可能很多，允许换行） */
    .ngax-pager { flex-wrap: wrap; gap: 4px; }

    /* ================= NGA 专属：版面大全 / 星标 / rail 提示 ================= */

    /* 版面大全的分类 / 分组标题：分类是「主标题」级别，分组是小一号的灰标题 */
    .ngax-bcat { margin-top: 18px; }
    .ngax-bcat-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--cx-border-soft);
      font-size: 14px;
      font-weight: 600;
    }
    .ngax-bcat-count {
      font-size: 11.5px;
      font-weight: 400;
      color: var(--cx-text-faint);
      font-family: var(--cx-font-mono);
    }
    .ngax-bgroup { margin: 8px 0 0; }
    .ngax-bgroup-head {
      font-size: 12px;
      color: var(--cx-text-secondary);
      margin: 6px 0 0;
    }

    .ngax-board-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 5px 6px;
      margin: 8px 0 4px;
    }
    /* 一个版面条目 = 链接 + 星标按钮。星标不能放进 <a> 里（嵌套交互元素非法），
       所以外面套一层 inline-flex 的框。 */
    .ngax-bitem {
      display: inline-flex;
      align-items: center;
      gap: 0;
    }
    .ngax-bitem > a.ngax-pill {
      border-top-right-radius: 0;
      border-bottom-right-radius: 0;
      border-right: 0;
    }
    .ngax-bstar {
      flex: none;
      font-size: 11px;
      line-height: 1;
      padding: 0.38em 0.5em;
      color: var(--cx-text-faint);
      background: var(--cx-chip-bg);
      border: 1px solid var(--cx-border);
      border-left: 0;
      border-radius: 0 999px 999px 0;
      cursor: pointer;
      font-family: inherit;
    }
    .ngax-bstar:hover { color: var(--cx-text); background: var(--cx-btn-hover); }
    .ngax-bstar.on { color: #e8b339; }
    /* rail 里的星标：贴在行首，没有背景框 */
    .ngax-rail-item .ngax-bstar {
      border: 0;
      background: none;
      padding: 0 4px 0 0;
      border-radius: 0;
      font-size: 12px;
    }
    .ngax-rail-item .ngax-bstar:hover { background: none; }
    .ngax-rail-hint {
      font-size: 11.5px;
      line-height: 1.6;
      color: var(--cx-rail-text-faint);
      padding: 2px 12px 6px;
    }
    .ngax-board-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .ngax-hl-sub {
      font-size: 12px;
      color: var(--cx-text-faint);
      margin: 14px 0 0;
      font-family: var(--cx-font-mono);
    }

    /* ================= NGA 专属：首页头条卡片 ================= */

    .ngax-hl-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 10px;
      margin: 6px 0 2px;
    }
    .ngax-hl {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px;
      border: 1px solid var(--cx-border);
      border-radius: var(--cx-radius);
      background: var(--cx-panel-bg);
      color: var(--cx-text);
      text-decoration: none;
      transition: background 0.12s, border-color 0.12s;
    }
    .ngax-hl:hover { background: var(--cx-wash); border-color: var(--cx-border-strong); }
    .ngax-hl-img {
      display: block;
      aspect-ratio: 16 / 9;
      overflow: hidden;
      border-radius: 7px;
      background: var(--cx-bg-inset);
    }
    .ngax-hl-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .ngax-hl-title {
      font-size: 13px;
      line-height: 1.45;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    /* ================= NGA 专属：楼层行内小头像 / 签名 / 改动 ================= */

    .ngax-ava {
      width: 18px;
      height: 18px;
      border-radius: 4px;
      object-fit: cover;
      vertical-align: -4px;
      margin-right: 5px;
      background: var(--cx-wash);
      flex: none;
    }
    .ngax-worked { flex-wrap: wrap; }
    /* 头像去掉时（设置里可关）不用留空 */
    html.ngax-no-avatar .ngax-ava { display: none; }

    .ngax-sign, .ngax-alert {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px dashed var(--cx-border);
      font-size: 12px;
      color: var(--cx-text-faint);
      max-height: 160px;
      overflow: hidden;
    }
    .ngax-sign img, .ngax-alert img { max-height: 60px; width: auto; }

    /* ================= NGA 专属：用户信息页 ================= */

    .ngax-member { align-items: flex-start; }
    .ngax-member .ngax-card-title h1 { font-size: 19px; }
    .ngax-member .ngax-card-sub { line-height: 1.7; }

    /* 统计格子：数字为主、标题为辅（对齐 Codex 里那些指标块的观感） */
    .ngax-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
      gap: 8px;
      margin: 14px 0 4px;
    }
    .ngax-stat {
      border: 1px solid var(--cx-border);
      border-radius: var(--cx-radius);
      background: var(--cx-panel-bg);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .ngax-stat b {
      font-size: 17px;
      font-weight: 600;
      font-family: var(--cx-font-mono);
      letter-spacing: -0.01em;
    }
    .ngax-stat span { font-size: 11.5px; color: var(--cx-text-faint); }

    /* 状态（buffs）：站点已经把每一项渲染成 HTML 了，只负责排版 */
    .ngax-buff-list { display: flex; flex-direction: column; gap: 6px; }
    .ngax-buff {
      border: 1px solid var(--cx-border);
      border-left: 2px solid var(--cx-blue);
      border-radius: 0 8px 8px 0;
      background: var(--cx-panel-bg);
      padding: 7px 11px;
      font-size: 13px;
      display: flex;
      align-items: baseline;
      gap: 10px;
      flex-wrap: wrap;
    }
    .ngax-buff img { max-height: 22px; width: auto; vertical-align: middle; }
    .ngax-buff-until {
      margin-left: auto;
      font-size: 11.5px;
      color: var(--cx-text-faint);
      font-family: var(--cx-font-mono);
      white-space: nowrap;
    }

    /* 头像 / 签名 */
    .ngax-avatar-box { margin: 2px 0; }
    img.ngax-member-avatar-lg {
      max-width: 160px;
      max-height: 160px;
      width: auto;
      height: auto;
      border-radius: var(--cx-radius);
      border: 1px solid var(--cx-border);
      background: var(--cx-bg-inset);
      display: block;
    }
    .ngax-sign-box {
      border-left: 2px solid var(--cx-border-strong);
      padding: 2px 0 2px 12px;
      color: var(--cx-text-secondary);
      font-size: 13px;
    }
    .ngax-sign-box img { max-height: 80px; width: auto; }

    .ngax-empty { font-size: 13px; color: var(--cx-text-faint); padding: 4px 0; }

    /* 声望表：来源 / 值 / 说明 */
    .ngax-repu {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .ngax-repu td {
      border-bottom: 1px solid var(--cx-border-soft);
      padding: 7px 10px;
      vertical-align: top;
    }
    .ngax-repu tr:last-child td { border-bottom: 0; }
    .ngax-repu td:first-child { white-space: nowrap; color: var(--cx-text-secondary); }
    .ngax-repu td:last-child { color: var(--cx-text-secondary); }
    .ngax-repu-val {
      width: 1%;
      white-space: nowrap;
      text-align: right;
      font-family: var(--cx-font-mono);
      font-weight: 600;
      color: var(--cx-blue);
    }
    /* 负声望 / 禁言这类「坏消息」用固定红：两套主题下都要看得清，
       而 token 里没有语义红，用 filter 凑颜色是自找麻烦 */
    .ngax-repu-val.neg { color: #e5484d; }

    /* 动作胶囊：<button> 的默认样式压掉，长成和 <a class="ngax-pill"> 一样 */
    button.ngax-pill {
      font: inherit;
      cursor: pointer;
      border: 1px solid var(--cx-border);
    }
    button.ngax-pill:hover { background: var(--cx-btn-hover); }
    .ngax-pill.ngax-bad { color: #e5484d; border-color: currentColor; }

    /* ================= NGA 专属：表情面板 ================= */

    .ngax-smile-pop {
      position: absolute;
      left: 12px;
      right: 12px;
      bottom: calc(100% + 6px);
      max-height: 240px;
      overflow-y: auto;
      background: var(--cx-bg-raised);
      border: 1px solid var(--cx-border);
      border-radius: var(--cx-radius);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
      padding: 8px 10px 10px;
      display: none;
      z-index: 40;
    }
    .ngax-smile-pop.on { display: block; }
    .ngax-smile-title {
      font-size: 11px;
      color: var(--cx-text-faint);
      margin: 6px 0 4px;
      font-family: var(--cx-font-mono);
    }
    .ngax-smile-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(30px, 1fr));
      gap: 3px;
    }
    .ngax-smile-grid button {
      background: none;
      border: 0;
      padding: 3px;
      border-radius: 5px;
      cursor: pointer;
      line-height: 0;
    }
    .ngax-smile-grid button:hover { background: var(--cx-btn-hover); }
    .ngax-smile-grid img { width: 22px; height: 22px; }
"""


def main():
    css = transform_css(extract_ref_css())
    css += EXTRA_CSS

    # CSS 是用 String.raw`…` 包起来的，里面出现反引号或 ${ 都会把整个脚本搞坏 ——
    # 这坑踩过一次（注释里写了 `#mc > *`），所以这里硬性拦一道。
    if '`' in css:
        sys.exit('构建失败：CSS 里出现了反引号，会截断 String.raw 模板')
    if '${' in css:
        sys.exit('构建失败：CSS 里出现了 ${ 插值，会当成模板表达式求值')

    smiles = read(os.path.join(HERE, 'smiles.js')).rstrip()

    p1 = read(os.path.join(HERE, 'p1.js')).rstrip() + '\n'
    p2 = read(os.path.join(HERE, 'p2.js')).rstrip() + '\n'
    p3 = read(os.path.join(HERE, 'p3.js')).rstrip() + '\n'

    # 表情表插进 BBSCode 区（标记在 p2 里）
    if '/*__SMILES__*/' not in p2:
        sys.exit('构建失败：p2.js 里找不到 /*__SMILES__*/ 标记')
    p2 = p2.replace('/*__SMILES__*/', smiles)

    # 版面表 + 分类表（由 crawl-forums.py / extract-cats.py 生成）插进 p1
    if '/*__FORUMS__*/' not in p1:
        sys.exit('构建失败：p1.js 里找不到 /*__FORUMS__*/ 标记')
    p1 = p1.replace('/*__FORUMS__*/', read(os.path.join(HERE, 'forums.js')).rstrip())
    if '/*__CATS__*/' not in p1:
        sys.exit('构建失败：p1.js 里找不到 /*__CATS__*/ 标记')
    p1 = p1.replace('/*__CATS__*/', read(os.path.join(HERE, 'index-cats.js')).rstrip())

    # CSS 常量插进 p3（标记在 p3 里）
    if '/*__RAW_CSS__*/' not in p3:
        sys.exit('构建失败：p3.js 里找不到 /*__RAW_CSS__*/ 标记')
    css_block = (
        '  const RAW_CSS = String.raw`\n'
        + css.rstrip() + '\n'
        + '  `;\n'
    )
    p3 = p3.replace('/*__RAW_CSS__*/', css_block)

    out = p1 + '\n' + p2 + '\n' + p3
    # 收尾：确保只有一个结尾换行
    out = out.rstrip() + '\n'

    # 同名函数声明会**静默**让后一个覆盖前一个（renderHome 就这样被一份旧实现
    # 顶掉过一次：首页白屏、无任何报错，node --check 也查不出来），所以在这里
    # 静态查一遍 —— 只查 IIFE 顶层（两个空格缩进）的 function 声明。
    names = re.findall(r'^  function ([A-Za-z_$][\w$]*)\(', out, re.M)
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        sys.exit('构建失败：函数重复声明（后者会静默覆盖前者）：' + ', '.join(dupes))
    with io.open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(out)

    print('已生成 %s（%d 行 / %d 字节）' % (OUT, out.count('\n') + 1, len(out.encode('utf-8'))))


if __name__ == '__main__':
    main()
