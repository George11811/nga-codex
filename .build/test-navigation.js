'use strict';
// 离线导航回归：运行完整用户脚本；不依赖登录、网络或抓取的页面样本。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require(path.join(process.env.JSDOM_DIR || path.join(__dirname, 'jt'), 'node_modules/jsdom'));
const source = process.env.NGA_BASELINE
  ? require('node:child_process').execFileSync('git', ['show', 'HEAD:nga-codex.user.js'], { encoding: 'utf8' })
  : fs.readFileSync(path.join(__dirname, '../nga-codex.user.js'), 'utf8');
let checks = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log('PASS ' + name);
  checks++;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 80));
const microtasks = async () => { await Promise.resolve(); await Promise.resolve(); };
async function boot(url = '/thread.php?fid=-7', body = '<div id="mmc"><div id="m_threads"></div></div>', setup) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('error', (...args) => errors.push(args));
  vc.on('jsdomError', error => errors.push(error));
  const win = new JSDOM('<!doctype html><html><head><title>NGA</title></head><body>' + body + '</body></html>', {
    url: 'https://bbs.nga.cn' + url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc
  }).window;
  win.scrollTo = () => {};
  win.__COLOR = { bg0: '#ffffff' };
  if (setup) setup(win);
  win.eval(source);
  await settle();
  return { win, errors };
}
function show(win) {
  win.dispatchEvent(new win.PageTransitionEvent('pageshow', { persisted: true }));
}
(async () => {
  const { win, errors } = await boot();
  try {
    const d = win.document, root = d.documentElement;
    const locked = () => root.classList.contains('ngax') && root.classList.contains('ngax-locked');
    check('初次渲染成功', locked() && d.querySelector('.ngax-main'));
    const inner = d.querySelector('.ngax-thread-inner');
    const marker = d.createElement('details');
    marker.open = true;
    marker.textContent = '已展开的内容';
    (inner || d.querySelector('.ngax-main')).appendChild(marker);
    const edit = d.querySelector('.ngax-md-edit');
    edit.textContent = '尚未发送的草稿';
    root.className = 'native-theme';
    d.getElementById('nga-codex-theme').remove();
    show(win);
    check('pageshow 同步恢复锁定，不等 rAF', locked());
    check('pageshow 同步恢复样式表', !!d.getElementById('nga-codex-theme'));
    check('原生容器仍隐藏', win.getComputedStyle(d.getElementById('mmc')).display === 'none');
    win.dispatchEvent(new win.PopStateEvent('popstate'));
    await settle();
    check('pageshow + popstate 不重建已有内容', marker.isConnected && marker.open);
    check('保留编辑节点和草稿', d.querySelector('.ngax-md-edit') === edit && edit.textContent === '尚未发送的草稿');
    check('保留站点 class 并恢复亮色', root.classList.contains('native-theme') && root.classList.contains('ngax-light'));

    root.className = 'native-reset';
    await microtasks();
    check('没有导航事件时也能修复 class 重置', locked());
    d.getElementById('nga-codex-theme').remove();
    await microtasks();
    check('样式表被移除后微任务内补回', !!d.getElementById('nga-codex-theme'));
    const style = d.getElementById('nga-codex-theme');
    const styleText = style.firstChild;
    show(win); show(win);
    check('重复恢复不重写未变化的样式表', style.firstChild === styleText);

    root.className = '';
    win.dispatchEvent(new win.PageTransitionEvent('pagehide', { persisted: true }));
    check('pagehide 保留伪装以供缓存', locked());
    const oldHead = d.head;
    oldHead.replaceWith(d.createElement('head'));
    await microtasks();
    check('替换 head 后补回样式', !!d.getElementById('nga-codex-theme'));
    d.getElementById('nga-codex-theme').remove();
    await microtasks();
    check('新 head 也受保护', !!d.getElementById('nga-codex-theme'));

    win.history.pushState({}, '', '/thread.php?fid=-7#anchor');
    win.dispatchEvent(new win.PopStateEvent('popstate'));
    await settle();
    check('锚点历史不重建页面', marker.isConnected);
    win.history.pushState({}, '', '/nuke.php?func=favorite');
    win.dispatchEvent(new win.PopStateEvent('popstate'));
    check('切换到未接管 URL 立即解锁', !root.classList.contains('ngax-locked'));
    await settle();
    check('未接管 URL 显示原生内容', win.getComputedStyle(d.getElementById('mmc')).display !== 'none');
    win.history.pushState({}, '', '/thread.php?fid=-7');
    win.dispatchEvent(new win.PopStateEvent('popstate'));
    check('返回受支持 URL 立即锁定', locked());
    await settle();
    check('返回后重新建好界面', !!d.querySelector('.ngax-main'));
    check('正常导航没有脚本异常', errors.length === 0);
  } finally { win.close(); }

  for (const [name, url, body] of [
    ['游客页', '/thread.php?fid=-7', '<p>游客不能直接访问</p>'],
    ['未接管页', '/nuke.php?func=favorite', '<div id="mmc">收藏</div>'],
    ['缺少用户数据的个人页', '/nuke.php?func=ucp&uid=123', '<div id="mmc">未知用户</div>']
  ]) {
    const { win, errors } = await boot(url, body);
    try {
      show(win);
      win.dispatchEvent(new win.PopStateEvent('popstate'));
      await settle();
      check(name + '恢复后不会被重新锁住', !win.document.documentElement.classList.contains('ngax-locked'));
      check(name + '无异常', errors.length === 0);
    } finally { win.close(); }
  }
  const conflict = await boot(undefined, undefined, w => w.document.documentElement.classList.add('codex-theme'));
  try {
    show(conflict.win);
    await settle();
    check('其他主题启用时仍避让', !conflict.win.document.documentElement.classList.contains('ngax-locked') && !conflict.win.document.querySelector('.ngax-main'));
  } finally { conflict.win.close(); }
  console.log('全部 ' + checks + ' 项导航回归通过（事件模拟，不等同浏览器 bfcache 实测）');
})().catch(error => { console.error(error); process.exitCode = 1; });
