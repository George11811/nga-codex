'use strict';
/*
 * 离线回复栏回归：运行完整用户脚本，不依赖登录 / 网络 / 抓下来的页面样本
 * （和 test-navigation.js 同一套打法：自己搭一个最小的 NGA 壳子）。
 *
 * 押两件事：
 *   1. 自适应：工具条允许换行、状态文字允许被压到 0。jsdom 没有排版引擎，
 *      量不了真实宽度，所以押的是机制 —— 这两条不成立时，窄列（左栏 + 右侧
 *      代码面板都开着）必然把右边几个图标挤出可视区，也就是「图标显示不全」。
 *   2. 收起按钮：点击后压成一行（单行输入 + 发送 + 展开），状态记进设置；
 *      改设置 / 主区重建后保持；而且收起只切 class —— 不重渲染（草稿和节点都在）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require(path.join(process.env.JSDOM_DIR || path.join(__dirname, 'jt'), 'node_modules/jsdom'));
const source = fs.readFileSync(path.join(__dirname, '../nga-codex.user.js'), 'utf8');

let checks = 0;
function check(name, condition, extra) {
  assert.ok(condition, name + (extra === undefined ? '' : '  ← ' + extra));
  console.log('PASS ' + name);
  checks++;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

async function boot() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('error', (...args) => errors.push(args));
  vc.on('jsdomError', (error) => errors.push(error));
  const win = new JSDOM('<!doctype html><html><head><title>NGA</title></head><body>' +
    '<div id="mmc"><div id="m_threads"></div></div></body></html>', {
    url: 'https://bbs.nga.cn/thread.php?fid=-7', runScripts: 'outside-only',
    pretendToBeVisual: true, virtualConsole: vc
  }).window;
  win.scrollTo = () => {};
  win.__COLOR = { bg0: '#ffffff' };
  win.eval(source);
  await settle();
  return { win, errors };
}

(async () => {
  const { win, errors } = await boot();
  try {
    const d = win.document;
    const $ = (s) => d.querySelector(s);
    const $$ = (s) => Array.from(d.querySelectorAll(s));
    const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const box = () => $('.ngax-composer');
    const css = (el) => win.getComputedStyle(el);
    const stored = () => win.localStorage.getItem('ngax:settings') || '';
    const minBtn = () => $('[data-composer-min]');
    const shown = (el) => !!el && css(el).display !== 'none';

    check('回复栏建起来了', !!box() && !!$('.ngax-composer-toolbar') && !!$('.ngax-md-edit'));
    check('收起按钮在工具条里（收起后它得留在可见位置）',
      !!minBtn() && !!minBtn().closest('.ngax-composer-toolbar'));
    check('默认展开', !box().classList.contains('ngax-min'));
    check('展开态是上下堆叠（composer 列向 flex）',
      css(box()).display === 'flex' && css(box()).flexDirection === 'column',
      css(box()).display + ' / ' + css(box()).flexDirection);

    // ── 自适应机制 ──
    const tb = css($('.ngax-composer-toolbar'));
    check('工具条允许换行（窄列时按钮换行，而不是被挤出可视区）', tb.flexWrap === 'wrap', tb.flexWrap);
    check('工具条没有 overflow:hidden（裁了就是真的看不见）', tb.overflow !== 'hidden', tb.overflow);
    check('工具条带了 row-gap（换行后两行不贴在一起）', /^4px$/.test(tb.rowGap || ''), tb.rowGap);
    const st = css($('.ngax-composer-status'));
    check('状态文字可以被压缩（min-width: 0）', /^0(px)?$/.test(st.minWidth || ''), st.minWidth);

    // ── 收起 / 展开 ──
    const edit = $('.ngax-md-edit');
    edit.textContent = '还没发出去的草稿';
    const marker = d.createElement('details');
    marker.open = true;
    marker.textContent = '已展开的内容';
    ($('.ngax-thread-inner') || $('.ngax-main')).appendChild(marker);

    click(minBtn());
    check('点一下收起：composer 加上 ngax-min', box().classList.contains('ngax-min'));
    check('收起状态写进了 localStorage', /"composerCollapsed":true/.test(stored()), stored());
    check('按钮变成「展开」（title / aria-expanded / 箭头都换）',
      minBtn().title === '展开回复栏' &&
      minBtn().getAttribute('aria-expanded') === 'false' &&
      /points="7 15/.test(minBtn().innerHTML),
      minBtn().title + ' / ' + minBtn().getAttribute('aria-expanded'));
    check('收起态：composer 横过来（一行）',
      css(box()).flexDirection === 'row', css(box()).flexDirection);
    check('收起态：输入区压成单行（max-height 24px）',
      css(edit).maxHeight === '24px', css(edit).maxHeight);
    check('收起态：格式按钮藏起来，发送键还在',
      !shown($('[data-tool="bold"]')) && shown($('.ngax-send')),
      css($('[data-tool="bold"]')).display + ' / ' + css($('.ngax-send')).display);
    check('收起态：工具条里只剩发送 + 展开两个可见控件',
      $$('.ngax-composer-toolbar > *').filter(shown).length === 2,
      $$('.ngax-composer-toolbar > *').filter(shown).length + ' 个');
    check('收起不重渲染（草稿和已展开的内容都还在）',
      d.querySelector('.ngax-md-edit') === edit && edit.textContent === '还没发出去的草稿' &&
      marker.isConnected && marker.open);

    click(minBtn());
    check('再点一下展开（状态也落盘）',
      !box().classList.contains('ngax-min') && /"composerCollapsed":false/.test(stored()), stored());
    check('展开后格式按钮回来了', shown($('[data-tool="bold"]')));

    // ── 状态要跟着设置走，也要扛得住主区重建 ──
    click(minBtn());
    click($('[data-settings-open]'));
    click($('[data-set-toggle="avatars"]'));      // 触发一次 applySettings（完整重渲染）
    click($('[data-settings-close]'));
    await settle();
    check('改设置重渲染后仍然是收起的', box().classList.contains('ngax-min'));

    $('.ngax-main').remove();
    win.dispatchEvent(new win.PageTransitionEvent('pageshow', { persisted: true }));
    await settle();
    check('主区重建后回复栏仍然是收起的（新 composer 也刷了状态）',
      !!box() && box().classList.contains('ngax-min'));

    click($('[data-settings-open]'));
    click($('[data-settings-reset]'));
    click($('[data-settings-close]'));
    await settle();
    check('「恢复默认」把回复栏展开回来', !box().classList.contains('ngax-min'));

    check('整个流程没有脚本异常', errors.length === 0);
  } finally { win.close(); }
  console.log('全部 ' + checks + ' 项回复栏回归通过（jsdom 量不了真实排版宽度，自适应押的是 CSS 机制）');
})().catch((error) => { console.error(error); process.exitCode = 1; });
