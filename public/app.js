'use strict';
// AA 账本前端：无框架。/ = 管理员首页，/t/<key> = 某次游玩（凭分享链接）
const $app = document.getElementById('app');
const { computeShares, splitExpense, unitOf, roundTo } = window.AASettle;

const CATS = [
  { key: 'food', name: '餐饮', icon: '🍜' },
  { key: 'transport', name: '交通', icon: '🚗' },
  { key: 'lodging', name: '住宿', icon: '🏨' },
  { key: 'ticket', name: '门票', icon: '🎫' },
  { key: 'fun', name: '娱乐', icon: '🎤' },
  { key: 'shopping', name: '购物', icon: '🛍️' },
  { key: 'other', name: '其他', icon: '📦' },
];
const CAT = Object.fromEntries(CATS.map((c) => [c.key, c]));
// 币种（顺序即选择顺序）。每次游玩有一个结算币种（默认人民币），其他币种折算成它
const CURS = [
  { key: 'CNY', name: '人民币', short: '人民币', sym: '¥' },
  { key: 'HKD', name: '港币', short: '港币', sym: 'HK$' },
  { key: 'TWD', name: '新台币', short: '新台币', sym: 'NT$' },
  { key: 'JPY', name: '日元', short: '日元', sym: 'JP¥' },
  { key: 'SGD', name: '新加坡元', short: '新币', sym: 'S$' },
  { key: 'MYR', name: '马来西亚令吉', short: '马币', sym: 'RM' },
  { key: 'AUD', name: '澳元', short: '澳元', sym: 'A$' },
  { key: 'USD', name: '美元', short: '美元', sym: 'US$' },
];
const CUR = Object.fromEntries(CURS.map((c) => [c.key, c]));
// 当前页面的结算币种：游玩页 = 这次游玩的结算币种；管理员页 = 人民币
let BASE = 'CNY';
const BN = () => CUR[BASE].name;
const fmtRate = (r) => String(Number(r.toPrecision(6)));
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

// ---------- 工具 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function money(c, { sign = false, cur = true } = {}) {
  const neg = c < 0; const a = Math.abs(c);
  const s = (a / 100).toFixed(a % 100 === 0 ? 0 : 2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : sign && c > 0 ? '+' : '') + (cur ? CUR[BASE].sym : '') + s;
}
// 指定币种的金额（带该币种符号）
const curMoney = (cur, c) => (c < 0 ? '-' : '') + CUR[cur || BASE].sym + money(Math.abs(c), { cur: false });
const amountInput = (c) => (c / 100).toFixed(c % 100 === 0 ? 0 : 2);
const md = (day) => `${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`;
const wk = (day) => '周' + WEEK[new Date(day + 'T00:00:00Z').getUTCDay()];
function addDays(day, n) { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
function range(t) {
  if (!t.endDay || t.endDay === t.startDay) return `${t.startDay.slice(0, 4)}年${md(t.startDay)}`;
  return `${md(t.startDay)} – ${t.endDay.slice(0, 4) !== t.startDay.slice(0, 4) ? t.endDay.slice(0, 4) + '年' : ''}${md(t.endDay)}`;
}
const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

function toast(msg, err = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.className = err ? 'err' : ''; }, err ? 3200 : 1800);
}

async function api(method, url, body, { raw = false } = {}) {
  const headers = {};
  if (S.trip && S.me) headers['X-Actor'] = String(S.me);
  let payload;
  if (raw) { payload = body; headers['Content-Type'] = body.type; }
  else if (body !== undefined || (method !== 'GET' && method !== 'DELETE')) {
    // 写操作一律带 JSON（哪怕是空的 {}）：服务器只接受 application/json，没有 body 的 POST 会被拒（415）
    payload = JSON.stringify(body ?? {}); headers['Content-Type'] = 'application/json';
  }
  let res;
  try { res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' }); }
  catch { throw new Error('网络不通，请稍后再试'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `出错了（${res.status}）`); e.status = res.status; throw e; }
  return data;
}

// ---------- 弹层 ----------
const $sheet = document.getElementById('sheet');
const $back = document.getElementById('sheet-backdrop');
function openSheet(html, onMount) {
  $sheet.innerHTML = `<div class="grab"></div>${html}`;
  $sheet.hidden = false; $back.hidden = false;
  document.body.style.overflow = 'hidden';
  $sheet.scrollTop = 0;
  onMount && onMount($sheet);
}
function closeSheet() {
  $sheet.hidden = true; $back.hidden = true; $sheet.innerHTML = '';
  document.body.style.overflow = '';
}
$back.addEventListener('click', closeSheet);
const sheetHead = (title) => `<div class="sh-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="关闭">✕</button></div>`;
$sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });

function confirmSheet(title, text, okText = '确定', danger = false) {
  return new Promise((resolve) => {
    openSheet(`${sheetHead(title)}<p class="muted" style="margin-top:-4px">${text}</p>
      <div class="btns" style="margin-top:16px"><button class="btn" data-no>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okText)}</button></div>`, (el) => {
      el.querySelector('[data-no]').onclick = () => { closeSheet(); resolve(false); };
      el.querySelector('[data-yes]').onclick = () => { closeSheet(); resolve(true); };
      el.querySelector('[data-close]').onclick = () => { closeSheet(); resolve(false); };
    });
  });
}

const $viewer = document.getElementById('viewer');
function viewImage(src) {
  $viewer.innerHTML = `<img src="${esc(src)}" alt="图片"><button class="icon-btn close" aria-label="关闭">✕</button>`;
  $viewer.hidden = false;
}
$viewer.addEventListener('click', () => { $viewer.hidden = true; $viewer.innerHTML = ''; });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$viewer.hidden) { $viewer.hidden = true; return; }
  if (!$sheet.hidden) closeSheet();
});

// 图片压缩：长截图保留清晰度（宽 ≤1200、高 ≤2800），转成 JPEG
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(1, 1200 / w, 2800 / h);
    if (s === 1 && file.size < 900 * 1024 && /^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  } catch { throw new Error('这张图片读不出来，换一张试试'); }
  finally { URL.revokeObjectURL(url); }
}
function pickFiles(multiple = true) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = multiple;
    inp.onchange = () => resolve([...inp.files]);
    inp.click();
  });
}

// ---------- 状态与路由 ----------
const S = { me: null, admin: null, today: null, trip: null, key: null, tab: 'bills', adminTab: 'trips', statYear: null };

function go(path, replace = false) {
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  route();
}
window.addEventListener('popstate', () => { closeSheet(); route(); });
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a) { e.preventDefault(); go(a.getAttribute('href')); }
});

async function route() {
  const m = location.pathname.match(/^\/t\/([A-Za-z0-9_-]{16,32})\/?$/);
  try {
    const meRes = await api('GET', '/api/me');
    S.admin = meRes.admin; S.today = meRes.today;
  } catch (e) { $app.innerHTML = `<div class="wrap"><div class="empty"><div class="e">📡</div>${esc(e.message)}</div></div>`; return; }
  if (m) {
    if (S.key !== m[1]) { S.key = m[1]; S.tab = 'bills'; S.trip = null; }
    return loadTrip(true);
  }
  S.trip = null; S.key = null;
  if (!S.admin) return renderLogin();
  return renderAdmin();
}

// ---------- 登录 ----------
// 最近打开过的游玩（只存在这台设备上）
function recentTrips() {
  try { return JSON.parse(store.get('aa:recent') || '[]').filter((x) => x && /^[A-Za-z0-9_-]{16,32}$/.test(x.key)); } catch { return []; }
}
function rememberTrip(key, t) {
  const list = recentTrips().filter((x) => x.key !== key);
  list.unshift({ key, name: t.name, range: range(t), at: Date.now() });
  store.set('aa:recent', JSON.stringify(list.slice(0, 20)));
}
function forgetTrip(key) { store.set('aa:recent', JSON.stringify(recentTrips().filter((x) => x.key !== key))); }

function renderLogin() {
  BASE = 'CNY';
  document.title = 'AA 账本';
  const recent = recentTrips();
  $app.innerHTML = `<div class="login">
    <div class="logo">AA</div>
    <h1>AA 账本</h1>
    <p class="muted" style="margin:0 0 18px">出去玩花的钱，记下来，自动算谁该给谁多少。<br>朋友直接打开群里分享的链接就行，不用登录。</p>
    ${recent.length ? `<div class="section-title" style="margin-top:0"><span>最近打开的游玩</span></div>
      ${recent.map((x) => `<a class="trip" href="/t/${esc(x.key)}" data-link><div class="r1"><b>${esc(x.name)}</b></div><div class="r2"><span>${esc(x.range)}</span><span>${fmtTime(x.at)} 打开过</span></div></a>`).join('')}` : ''}
    <button class="btn block" id="inv-new" style="margin:6px 0 18px">🎟️ 有邀请码？自己新建一次游玩</button>
    <details ${recent.length ? '' : 'open'}><summary class="muted small" style="cursor:pointer;margin-bottom:12px">管理员登录</summary>
    <form id="lf">
      <div class="field"><label for="lu">管理员账号</label><input class="input" id="lu" name="username" autocomplete="username" required></div>
      <div class="field"><label for="lp">密码</label><input class="input" id="lp" name="password" type="password" autocomplete="current-password" required></div>
      <div class="err" id="le"></div>
      <button class="btn primary block">登录</button>
    </form></details></div>`;
  document.getElementById('inv-new').onclick = () => newTripSheet(true);
  document.getElementById('lf').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { await api('POST', '/api/login', { username: f.get('username'), password: f.get('password') }); route(); }
    catch (err) { document.getElementById('le').textContent = err.message; }
  };
}

// ======================================================================
// 管理员首页
// ======================================================================
async function renderAdmin() {
  BASE = 'CNY';
  document.title = 'AA 账本';
  $app.innerHTML = `<div class="wrap">
    <div class="top"><h1>AA 账本</h1>
      <button class="btn primary small" id="new-trip">＋ 新建游玩</button>
      <button class="icon-btn" id="admin-menu" aria-label="菜单">⋯</button></div>
    <div class="seg"><button data-at="trips" class="${S.adminTab === 'trips' ? 'on' : ''}">游玩</button><button data-at="stats" class="${S.adminTab === 'stats' ? 'on' : ''}">年度统计</button></div>
    <button class="health" id="health" hidden></button>
    <div id="admin-body"><div class="empty">加载中…</div></div></div>`;
  loadHealth();
  $app.querySelectorAll('[data-at]').forEach((b) => b.onclick = () => { S.adminTab = b.dataset.at; renderAdmin(); });
  document.getElementById('new-trip').onclick = () => newTripSheet(false);
  document.getElementById('admin-menu').onclick = adminMenu;
  const body = document.getElementById('admin-body');
  try {
    if (S.adminTab === 'trips') body.innerHTML = tripListHtml((await api('GET', '/api/admin/trips')).trips);
    else body.innerHTML = adminStatsHtml(await api('GET', '/api/admin/stats' + (S.statYear ? `?year=${S.statYear}` : '')));
  } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  body.querySelectorAll('[data-year]').forEach((b) => b.onclick = () => { S.statYear = Number(b.dataset.year); renderAdmin(); });
  bindBars(body);
}

function tripListHtml(trips) {
  if (!trips.length) return `<div class="empty"><div class="e">🏕️</div>还没有游玩记录<br><span class="small">点右上角「新建游玩」开始，然后把链接发到群里</span></div>`;
  let html = '', lastMonth = '';
  for (const t of trips) {
    const mon = t.startDay.slice(0, 7);
    if (mon !== lastMonth) { html += `<div class="section-title"><span>${mon.slice(0, 4)} 年 ${Number(mon.slice(5))} 月</span></div>`; lastMonth = mon; }
    const status = t.locked ? '<span class="tag">已锁定</span>'
      : t.unsettled > 0 ? `<span class="tag warn">待结清 ${curMoney(t.base, t.unsettled)}</span>`
      : t.count ? '<span class="tag good">已结清</span>' : '<span class="tag">还没记账</span>';
    html += `<a class="trip" href="/t/${esc(t.key)}" data-link>
      <div class="r1"><b>${esc(t.name)}</b><span class="amt num">${curMoney(t.base, t.total)}</span></div>
      <div class="r2"><span>${range(t)} · ${t.members} 人 · ${t.count} 笔${t.inviteNote ? ` · 🎟️${esc(t.inviteNote)}` : ''}</span>${status}</div></a>`;
  }
  return html;
}

function adminStatsHtml(d) {
  const total = d.trips.reduce((a, t) => a + t.total, 0);
  const years = d.years.length ? d.years : [d.year];
  let html = `<div class="chips" style="margin-bottom:12px">${years.map((y) => `<button class="chip ${y === d.year ? 'on' : ''}" data-year="${y}">${y}</button>`).join('')}</div>`;
  if (!d.trips.length) return html + `<div class="empty">${d.year} 年还没有游玩</div>`;
  const avg = Math.round(total / d.trips.length);
  html += `<div class="tiles">
    <div class="tile"><div class="l">出去玩了</div><div class="v num">${d.trips.length}<small> 次</small></div></div>
    <div class="tile"><div class="l">一共花了</div><div class="v num">${money(total)}</div></div>
    <div class="tile"><div class="l">平均每次</div><div class="v num">${money(avg)}</div></div>
    <div class="tile"><div class="l">一起玩过的人</div><div class="v num">${d.people.length}<small> 人</small></div></div></div>`;
  // 每月
  const months = Array.from({ length: 12 }, (_, i) => d.months.find((m) => m.m === i + 1) || { m: i + 1, cents: 0, trips: 0 });
  html += `<div class="card"><h2>每月花费<span class="sp"></span><small>按出发月份</small></h2>${vbars(months.map((m) => ({ label: `${m.m}月`, short: String(m.m), v: m.cents, tip: `${m.m}月 · ${m.trips} 次 · ${money(m.cents)}` })))}</div>`;
  // 类别
  html += `<div class="card"><h2>花在哪了</h2>${catBars(d.categories.map((c) => ({ key: c.category, cents: c.cents })), total)}</div>`;
  // 每人
  const maxP = Math.max(1, ...d.people.map((p) => Math.max(p.paid, p.share)));
  html += `<div class="card"><h2>每个人</h2><div class="legend"><span><i></i>垫付</span><span><i class="b2"></i>应摊（自己花的）</span></div>
    ${d.people.map((p) => `<div class="hbar" title="${esc(p.name)}：参加 ${p.trips} 次，垫付 ${money(p.paid)}，应摊 ${money(p.share)}">
      <div class="lab"><span>${esc(p.name)} <span class="faint small">${p.trips} 次</span></span><span class="num">垫付 ${money(p.paid)} · 应摊 ${money(p.share)}</span></div>
      <div class="track"><div class="fill" style="width:${(p.paid / maxP) * 100}%"></div></div>
      <div class="track"><div class="fill b2" style="width:${(p.share / maxP) * 100}%"></div></div></div>`).join('')}</div>`;
  // 每次
  html += `<div class="card"><h2>每次游玩</h2>${d.trips.slice().reverse().map((t) => `<div class="kv"><span>${md(t.startDay)} ${esc(t.name)}</span><span class="num">${money(t.total)} <span class="faint">· ${t.members} 人</span></span></div>`).join('')}</div>`;
  return html;
}

function adminMenu() {
  openSheet(`${sheetHead('管理员')}
    <div class="list">
      <button class="item" id="am-inv"><span class="cat">🎟️</span><span class="main"><span class="t">邀请码</span><span class="s">发给朋友，他们就能自己新建游玩</span></span></button>
      <button class="item" id="am-safe"><span class="cat">🛡️</span><span class="main"><span class="t">数据安全</span><span class="s">数据校验、备份情况、下载备份</span></span></button>
      <button class="item" id="am-trash"><span class="cat">🗑️</span><span class="main"><span class="t">回收站</span><span class="s">删除的游玩保留 30 天，可以恢复</span></span></button>
      <button class="item" id="am-pw"><span class="cat">🔑</span><span class="main"><span class="t">修改密码</span></span></button>
      <button class="item" id="am-out"><span class="cat">↩︎</span><span class="main"><span class="t">退出登录</span><span class="s">${esc(S.admin.username)}</span></span></button>
    </div>`, (el) => {
    el.querySelector('#am-inv').onclick = invitesSheet;
    el.querySelector('#am-safe').onclick = () => healthSheet();
    el.querySelector('#am-trash').onclick = tripTrashSheet;
    el.querySelector('#am-out').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); closeSheet(); route(); };
    el.querySelector('#am-pw').onclick = () => openSheet(`${sheetHead('修改密码')}
      <form id="pwf"><div class="field"><label>原密码</label><input class="input" type="password" name="old" autocomplete="current-password" required></div>
      <div class="field"><label>新密码（至少 6 位）</label><input class="input" type="password" name="new" autocomplete="new-password" minlength="6" required></div>
      <div class="err"></div><button class="btn primary block">保存</button></form>`, (el2) => {
      el2.querySelector('form').onsubmit = async (e) => {
        e.preventDefault(); const f = new FormData(e.target);
        try { await api('POST', '/api/password', { old: f.get('old'), new: f.get('new') }); closeSheet(); toast('密码已修改'); }
        catch (err) { el2.querySelector('.err').textContent = err.message; }
      };
    });
  });
}

// 数据安全：管理员首页顶部一行状态；有问题时变红
let HEALTH = null;
const ago = (h) => h < 1 ? '不到 1 小时前' : h < 48 ? `${Math.round(h)} 小时前` : `${Math.round(h / 24)} 天前`;
async function loadHealth() {
  const el = document.getElementById('health');
  try { HEALTH = await api('GET', '/api/admin/health'); } catch { return; }
  if (!el || !el.isConnected) return;
  const { check, backup } = HEALTH;
  const backupOk = backup && backup.ageHours < 30;
  el.hidden = false;
  el.className = 'health' + (check.ok && backupOk ? '' : ' bad');
  el.innerHTML = `${check.ok ? '✅ 账目校验通过' : `⚠️ 校验发现 ${check.problems.length} 个问题`} · ${backup ? `${backupOk ? '' : '⚠️ '}最近备份 ${ago(backup.ageHours)}` : '⚠️ 还没有备份'}<span class="faint"> ›</span>`;
  el.onclick = () => healthSheet();
}
async function healthSheet() {
  try { HEALTH = await api('GET', '/api/admin/health'); } catch (e) { return toast(e.message, true); }
  const { check, backup } = HEALTH, c = check.counts;
  openSheet(`${sheetHead('数据安全')}
    <div class="card"><b>${check.ok ? '✅ 账目校验全部正确' : `⚠️ 发现 ${check.problems.length} 个问题`}</b>
      <p class="muted small" style="margin:6px 0 0">把 ${c.trips} 次游玩、${c.expenses} 笔账、${c.payments} 笔转账按存下的份数和汇率重新算了一遍，逐分比对；并检查每次游玩收支平衡、${c.files} 个图片文件都在。</p>
      ${check.problems.length ? `<ul class="small neg" style="padding-left:18px">${check.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><p class="small muted">请截图发给维护的人（处理方法见 docs/MAINTENANCE.md「数据校验报错」）。</p>` : ''}</div>
    <div class="card"><b>${backup ? `${backup.ageHours < 30 ? '✅' : '⚠️'} 最近备份：${fmtTime(backup.at)}（${ago(backup.ageHours)}）` : '⚠️ 还没有备份'}</b>
      <p class="muted small" style="margin:6px 0 0">服务器每天自动备份数据库（保留 60 天）、截图和代码。备份在同一台服务器上，建议隔一段时间下载一份存到自己电脑或网盘，万一服务器整个坏了也能恢复。</p>
      ${backup ? `<a class="btn block" style="margin-top:10px" href="/api/admin/backup/latest" download>下载最新数据库备份（${(backup.bytes / 1024).toFixed(0)} KB）</a>` : ''}</div>
    <div class="card"><b>其他保护</b><p class="muted small" style="margin:6px 0 0">删除的账目、截图、游玩都先进回收站，30 天内可以恢复；每次改动都写进操作记录；数据库会拒绝保存分摊加起来不等于总额的账。</p></div>`);
}
async function tripTrashSheet() {
  let r;
  try { r = await api('GET', '/api/admin/trash'); } catch (e) { return toast(e.message, true); }
  openSheet(`${sheetHead('回收站')}
    <p class="muted small" style="margin-top:-6px">删除的游玩在这里保留 ${r.days} 天，之后连同截图永久删除。</p>
    <div class="list">${r.trips.length ? r.trips.map((t) => `<div class="mem"><span class="main"><b>${esc(t.name)}</b>
      <div class="s">${range(t)} · ${t.count} 笔 · 删于 ${fmtTime(t.deletedAt)}，${fmtTime(t.purgeAt)} 后永久删除</div></span>
      <button class="btn small" data-tr="${t.id}">恢复</button></div>`).join('') : '<div class="empty small">回收站是空的</div>'}</div>`, (el) => {
    el.querySelectorAll('[data-tr]').forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try { await api('POST', `/api/admin/trips/${b.dataset.tr}/restore`); toast('已恢复'); closeSheet(); renderAdmin(); }
      catch (e) { b.disabled = false; toast(e.message, true); }
    });
  });
}

const fmtCode = (c) => c.replace(/(.{5})(?=.)/, '$1-');
async function copyText(text, okMsg = '已复制') {
  try { await navigator.clipboard.writeText(text); toast(okMsg); return true; }
  catch { toast('复制失败，请长按文字手动复制', true); return false; }
}
async function invitesSheet() {
  let list = [];
  try { list = (await api('GET', '/api/admin/invites')).invites; } catch (e) { return toast(e.message, true); }
  const inviteText = (c) => `AA 账本邀请码：${fmtCode(c)}\n打开 ${location.origin} ，点「有邀请码？自己新建一次游玩」，填入邀请码就能开一个新的游玩记账。`;
  openSheet(`${sheetHead('邀请码')}
    <p class="muted small" style="margin-top:-6px">拿到邀请码的人可以自己新建游玩（只能新建，看不到别的游玩）。不想让谁用了就停用。</p>
    <div class="row2" style="margin-bottom:12px"><input class="input" id="iv-note" maxlength="30" placeholder="给谁用的（备注，可选）"><button class="btn primary" id="iv-add" style="flex:none">生成</button></div>
    <div class="list">${list.length ? list.map((i) => `<div class="mem" style="${i.revoked ? 'opacity:.5' : ''}">
      <span class="main"><b class="num" style="letter-spacing:.04em">${fmtCode(i.code)}</b>${i.revoked ? ' <span class="tag">已停用</span>' : ''}
        <div class="s">${esc(i.note || '无备注')} · 用过 ${i.uses} 次</div></span>
      ${i.revoked ? '' : `<button class="btn small" data-copy="${esc(i.code)}">复制</button><button class="btn small danger" data-off="${i.id}">停用</button>`}</div>`).join('')
      : '<div class="empty small">还没有邀请码</div>'}</div>`, (el) => {
    el.querySelector('#iv-add').onclick = async () => {
      try { const r = await api('POST', '/api/admin/invites', { note: el.querySelector('#iv-note').value }); await copyText(inviteText(r.code), '已生成并复制，发给朋友吧'); invitesSheet(); }
      catch (e) { toast(e.message, true); }
    };
    el.querySelectorAll('[data-copy]').forEach((b) => b.onclick = () => copyText(inviteText(b.dataset.copy), '已复制邀请文字'));
    el.querySelectorAll('[data-off]').forEach((b) => b.onclick = async () => {
      if (!confirm('停用这个邀请码？已经建好的游玩不受影响。')) return;
      try { await api('DELETE', `/api/admin/invites/${b.dataset.off}`); toast('已停用'); invitesSheet(); } catch (e) { toast(e.message, true); }
    });
  });
}

const baseChips = (sel) => CURS.map((c) => `<button type="button" class="chip small-chip ${sel === c.key ? 'on' : ''}" data-base="${c.key}">${c.short}</button>`).join('');

// 新建游玩：管理员直接建；朋友凭邀请码建
async function newTripSheet(viaInvite) {
  let known = [];
  if (!viaInvite) { try { known = (await api('GET', '/api/admin/people')).people; } catch {} }
  const picked = new Set();
  let base = 'CNY';
  openSheet(`${sheetHead(viaInvite ? '用邀请码新建游玩' : '新建游玩')}
    <form id="ntf">
      ${viaInvite ? `<div class="field"><label>邀请码</label><input class="input num" name="code" autocomplete="off" autocapitalize="characters" placeholder="XXXXX-XXXXX" required></div>
        <div class="field"><label>你的名字</label><input class="input" name="creator" maxlength="20" placeholder="会自动把你加进成员" required></div>` : ''}
      <div class="field"><label>去哪玩 / 叫什么</label><input class="input" name="name" maxlength="40" placeholder="例如：周末千岛湖" required></div>
      <div class="row2">
        <div class="field"><label>开始</label><input class="input" type="date" name="startDay" value="${S.today}" required></div>
        <div class="field"><label>结束（可空）</label><input class="input" type="date" name="endDay"></div>
      </div>
      <div class="field"><div class="lab"><span>结算币种</span><span class="faint">分摊和转账都按它算</span></div><div class="chips" id="nt-base">${baseChips(base)}</div></div>
      <div class="field"><div class="lab"><span>${viaInvite ? '还有谁一起去' : '谁一起去'}</span><span class="faint">之后也能随时加人</span></div>
        <div class="chips" id="nt-people"></div>
        <div class="row2" style="margin-top:8px"><input class="input" id="nt-name" maxlength="20" placeholder="输入名字，回车添加"><button type="button" class="btn" id="nt-add" style="flex:none">添加</button></div>
      </div>
      <div class="err"></div>
      <button class="btn primary block">创建并打开</button>
    </form>`, (el) => {
    el.querySelector('#nt-base').onclick = (e) => { const b = e.target.closest('[data-base]'); if (b) { base = b.dataset.base; el.querySelector('#nt-base').innerHTML = baseChips(base); } };
    const box = el.querySelector('#nt-people');
    const names = [...known];
    const draw = () => { box.innerHTML = names.map((n) => `<button type="button" class="chip ${picked.has(n) ? 'on' : ''}" data-n="${esc(n)}">${esc(n)}</button>`).join('') || '<span class="faint small">下面输入名字添加</span>'; };
    draw();
    box.onclick = (e) => { const b = e.target.closest('[data-n]'); if (!b) return; const n = b.dataset.n; picked.has(n) ? picked.delete(n) : picked.add(n); draw(); };
    const inp = el.querySelector('#nt-name');
    const add = () => { const n = inp.value.trim().slice(0, 20); if (!n) return; if (!names.includes(n)) names.unshift(n); picked.add(n); inp.value = ''; draw(); inp.focus(); };
    el.querySelector('#nt-add').onclick = add;
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
    el.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      if (inp.value.trim()) add();
      const f = new FormData(e.target);
      const payload = { name: f.get('name'), startDay: f.get('startDay'), endDay: f.get('endDay') || null, members: [...picked], baseCurrency: base };
      try {
        let r;
        if (viaInvite) {
          r = await api('POST', '/api/invite/trips', { ...payload, code: f.get('code'), creator: f.get('creator') });
          if (r.meId) store.set('aa:me:' + r.key, String(r.meId));
        } else r = await api('POST', '/api/admin/trips', payload);
        closeSheet(); go(`/t/${r.key}`);
        setTimeout(() => shareLink(true), 400);
      } catch (err) { el.querySelector('.err').textContent = err.message; }
    };
  });
}

// ======================================================================
// 游玩页
// ======================================================================
async function loadTrip(first = false) {
  try {
    S.trip = await api('GET', `/api/t/${S.key}`);
    BASE = S.trip.trip.base;
    rememberTrip(S.key, S.trip.trip);
  } catch (e) {
    if (e.status === 404) forgetTrip(S.key);
    $app.innerHTML = `<div class="wrap"><div class="empty"><div class="e">🔗</div>${esc(e.message)}<br><br><a href="/" data-link>返回首页</a></div></div>`;
    return;
  }
  const saved = Number(store.get('aa:me:' + S.key));
  S.me = S.trip.members.some((m) => m.id === saved) ? saved : null;
  renderTrip();
  if (first && !S.me && !store.get('aa:skip:' + S.key)) whoAmISheet();
}
const T = () => S.trip;
const member = (id) => T().members.find((m) => m.id === id);
const nameOf = (id) => member(id)?.name ?? '已移除';
const editable = () => !T().trip.locked;
const balOf = (id) => T().balances.find((b) => b.memberId === id) || { paid: 0, share: 0, sent: 0, received: 0, net: 0 };

async function refresh() { await loadTrip(false); }
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); await refresh(); return r; }
  catch (e) { toast(e.message, true); if (e.status === 423 || e.status === 404) await refresh(); throw e; }
}

function renderTrip() {
  const d = T(), t = d.trip;
  document.title = `${t.name} · AA 账本`;
  const total = d.expenses.reduce((a, e) => a + e.cents, 0);
  const me = S.me && member(S.me);
  let mine = '';
  if (me) {
    const b = balOf(me.id);
    mine = `<div><span class="label">我花的（应摊）</span><b class="num">${money(b.share)}</b></div>
      <div><span class="label">${b.net > 0 ? '还应收回' : b.net < 0 ? '还要付出' : '我的账'}</span><b class="num">${b.net === 0 ? '已结清' : money(Math.abs(b.net))}</b></div>`;
  } else {
    mine = `<div><span class="label">笔数</span><b class="num">${d.expenses.length}</b></div><div><span class="label">待转账</span><b class="num">${d.transfers.length} 笔</b></div>`;
  }
  const tabs = [['bills', '🧾', '账单'], ['settle', '💸', '结算'], ['stats', '📊', '统计'], ['people', '👥', '成员']];
  $app.innerHTML = `<div class="wrap">
    <div class="top">
      <a class="icon-btn" href="/" data-link aria-label="返回首页">‹</a>
      <h1>${esc(t.name)}</h1>
      <button class="chip-me" id="whoami">${me ? `我是 <b>${esc(me.name)}</b>` : '我是谁？'} ▾</button>
    </div>
    <div class="hero">
      <div class="label">一共花了</div>
      <div class="big num">${money(total)}</div>
      <div class="meta">${range(t)} · ${d.members.length} 人${t.base !== 'CNY' ? ` · ${BN()}结算${t.toCny ? `，约合人民币 ${curMoney('CNY', Math.round(total * t.toCny))}` : ''}` : ''}</div>
      <div class="row">${mine}</div>
    </div>
    ${t.locked ? `<div class="banner lock">🔒<span class="sp">账单已锁定${t.lockedAt ? '（' + fmtTime(t.lockedAt) + '）' : ''}，只能查看${S.admin ? '' : '。需要改的话请找管理员解锁'}</span></div>` : ''}
    <div id="tab-body"></div>
  </div>
  ${editable() && S.tab === 'bills' ? '<button class="fab" id="fab">＋ 记一笔</button>' : ''}
  <nav class="tabbar"><div class="in">${tabs.map(([k, i, n]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}"><span class="i">${i}</span>${n}</button>`).join('')}</div></nav>`;
  document.getElementById('whoami').onclick = whoAmISheet;
  const fab = document.getElementById('fab');
  if (fab) fab.onclick = () => expenseForm(null);
  $app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { S.tab = b.dataset.tab; renderTrip(); window.scrollTo(0, 0); });
  const body = document.getElementById('tab-body');
  ({ bills: renderBills, settle: renderSettle, stats: renderStats, people: renderPeople })[S.tab](body);
}

// ---------- 我是谁 ----------
function whoAmISheet() {
  const d = T();
  openSheet(`${sheetHead('你是谁？')}
    <p class="muted small" style="margin-top:-6px">选一下，记账时默认是你付的钱，也方便大家看到是谁记的。只保存在这台手机上。</p>
    <div class="chips" id="who-list">${d.members.map((m) => `<button class="chip ${m.id === S.me ? 'on' : ''}" data-id="${m.id}">${esc(m.name)}</button>`).join('')}</div>
    ${editable() ? `<div class="field" style="margin-top:16px"><label>名单里没有我</label>
      <div class="row2"><input class="input" id="who-new" maxlength="20" placeholder="输入你的名字"><button class="btn primary" id="who-add" style="flex:none">加入</button></div></div>` : ''}
    <button class="btn ghost block" id="who-skip" style="margin-top:6px">先随便看看</button>`, (el) => {
    el.querySelector('#who-list').onclick = (e) => {
      const b = e.target.closest('[data-id]'); if (!b) return;
      S.me = Number(b.dataset.id); store.set('aa:me:' + S.key, String(S.me));
      closeSheet(); renderTrip();
    };
    el.querySelector('#who-skip').onclick = () => { store.set('aa:skip:' + S.key, '1'); closeSheet(); };
    const add = el.querySelector('#who-add');
    if (add) add.onclick = async () => {
      const name = el.querySelector('#who-new').value.trim();
      if (!name) return;
      try {
        const r = await api('POST', `/api/t/${S.key}/members`, { name });
        S.me = r.id; store.set('aa:me:' + S.key, String(r.id));
        closeSheet(); toast(`欢迎，${name}`); await refresh();
      } catch (e) { toast(e.message, true); }
    };
  });
}

// ---------- 账单 ----------
function renderBills(body) {
  const d = T();
  if (!d.expenses.length) {
    body.innerHTML = `<div class="empty"><div class="e">🧾</div>还没有账目<br><span class="small">谁付了钱，就点右下角「记一笔」</span></div>`;
    return;
  }
  const groups = new Map();
  for (const e of d.expenses) { if (!groups.has(e.day)) groups.set(e.day, []); groups.get(e.day).push(e); }
  let html = '';
  for (const [day, list] of groups) {
    const sum = list.reduce((a, e) => a + e.cents, 0);
    html += `<div class="day-head"><span>${md(day)} ${wk(day)}</span><span class="num">${money(sum)}</span></div><div class="list">`;
    for (const e of list) {
      const mineShare = S.me ? e.shares.find((s) => s.memberId === S.me) : null;
      const sub = `${e.currency !== BASE ? `<b class="cur-tag">${esc(curMoney(e.currency, e.origCents))}</b> · ` : ''}${esc(nameOf(e.payerId))} 付 · ${e.shares.length === d.members.length ? '全员' : e.shares.length + ' 人'}分${e.images.length ? ` · 📷${e.images.length}` : ''}${e.note ? ' · 📝' : ''}`;
      html += `<button class="item" data-exp="${e.id}"><span class="cat">${CAT[e.category]?.icon || '📦'}</span>
        <span class="main"><span class="t">${esc(e.title || CAT[e.category]?.name || '其他')}</span><span class="s">${sub}</span></span>
        <span class="amt"><b class="num">${money(e.cents)}</b>${mineShare ? `<span class="num">我 ${money(mineShare.cents)}</span>` : S.me ? '<span>我不参与</span>' : ''}</span></button>`;
    }
    html += '</div>';
  }
  body.innerHTML = html;
  body.querySelectorAll('[data-exp]').forEach((b) => b.onclick = () => expenseDetail(Number(b.dataset.exp)));
}

function expenseDetail(id) {
  const e = T().expenses.find((x) => x.id === id);
  if (!e) return;
  const imgs = e.images.map((i) => `<button class="thumb" data-img="${i}"><img src="/api/t/${S.key}/images/${i}" alt="截图" loading="lazy"></button>`).join('');
  const mode = e.shares.some((s) => s.fixed != null) ? '含指定金额' : e.shares.every((s) => s.weight === e.shares[0].weight) ? '平均分' : '按份数';
  openSheet(`${sheetHead(e.title || CAT[e.category].name)}
    <div style="font-size:32px;font-weight:700;margin:-6px 0 ${e.currency !== BASE ? 0 : 10}px" class="num">${curMoney(e.currency, e.origCents)}</div>
    ${e.currency !== BASE ? `<div class="muted num" style="margin:0 0 12px">≈ ${money(e.cents)} · ${e.baseOverride ? `按实付${BN()}` : `1 ${CUR[e.currency].name} = ${fmtRate(e.rate)}`}</div>` : ''}
    <div class="card">
      <div class="kv"><span>类别</span><span>${CAT[e.category]?.icon} ${CAT[e.category]?.name}</span></div>
      <div class="kv"><span>日期</span><span>${md(e.day)} ${wk(e.day)}</span></div>
      <div class="kv"><span>谁付的</span><span><b>${esc(nameOf(e.payerId))}</b></span></div>
      <div class="kv"><span>怎么分</span><span>${e.shares.length} 人 · ${mode}</span></div>
    </div>
    <div class="card"><h2>每人分摊</h2>
      ${e.shares.map((s) => `<div class="kv"><span>${esc(nameOf(s.memberId))}${s.fixed != null ? ' <span class="tag">指定</span>' : s.weight !== 1 ? ` <span class="tag">${s.weight} 份</span>` : ''}</span><span class="num">${e.currency !== BASE ? `${curMoney(e.currency, s.origCents)} <span class="faint">≈${money(s.cents)}</span>` : money(s.cents)}</span></div>`).join('')}
    </div>
    ${e.note ? `<div class="section-title"><span>备注</span></div><div class="note-box">${esc(e.note)}</div>` : ''}
    ${e.images.length ? `<div class="section-title"><span>截图</span></div><div class="thumbs">${imgs}</div>` : ''}
    <p class="faint tiny" style="margin:14px 2px">${esc(e.createdBy || '未署名')} 记于 ${fmtTime(e.createdAt)}${e.updatedAt && new Date(e.updatedAt) - new Date(e.createdAt) > 2000 ? ` · 修改于 ${fmtTime(e.updatedAt)}` : ''}</p>
    ${editable() ? `<div class="btns"><button class="btn danger" id="ed-del">删除</button><button class="btn primary" id="ed-edit">修改</button></div>` : ''}`, (el) => {
    el.querySelectorAll('[data-img]').forEach((b) => b.onclick = () => viewImage(`/api/t/${S.key}/images/${b.dataset.img}`));
    const del = el.querySelector('#ed-del');
    if (del) del.onclick = async () => {
      if (!(await confirmSheet('删除这笔账？', `${esc(e.title || CAT[e.category].name)} ${money(e.cents)}，连同截图一起删除。30 天内可以在「成员 → 最近删除」里恢复。`, '删除', true))) return expenseDetail(id);
      await act(() => api('DELETE', `/api/t/${S.key}/expenses/${id}`), '已删除').catch(() => {});
    };
    const ed = el.querySelector('#ed-edit');
    if (ed) ed.onclick = () => expenseForm(e);
  });
}

// 记一笔 / 修改
function expenseForm(exp) {
  const d = T();
  if (!d.members.length) { toast('先在「成员」里加人', true); S.tab = 'people'; return renderTrip(); }
  const f = {
    amount: exp ? amountInput(exp.origCents) : '',
    currency: exp?.currency || store.get('aa:cur:' + S.key) || BASE,
    cny: exp?.baseOverride ? amountInput(exp.cents) : '',
    title: exp?.title || '', note: exp?.note || '',
    category: exp?.category || 'food',
    payerId: exp?.payerId ?? S.me ?? d.members[0].id,
    day: exp?.day || (d.trip.endDay && S.today > d.trip.endDay ? d.trip.startDay : S.today < d.trip.startDay ? d.trip.startDay : S.today),
    parts: new Map(), // memberId -> {weight, fixed(string|'')}
    detail: false,
  };
  if (exp) {
    for (const s of exp.shares) f.parts.set(s.memberId, { weight: s.fixed != null ? 1 : s.weight, fixed: s.fixed != null ? amountInput(s.fixed) : '' });
    f.detail = exp.shares.some((s) => s.fixed != null || s.weight !== (member(s.memberId)?.weight ?? 1));
  } else {
    for (const m of d.members) f.parts.set(m.id, { weight: m.weight, fixed: '' });
  }
  const newFiles = []; // 待上传
  let saving = false;

  openSheet(`${sheetHead(exp ? '修改这笔' : '记一笔')}
    <div class="chips" id="f-cur" style="margin-bottom:10px"></div>
    <div class="field amount-wrap cur"><span class="sym" id="f-sym"></span><input class="amount-input num" id="f-amount" inputmode="decimal" placeholder="0" value="${esc(f.amount)}" autocomplete="off"></div>
    <div id="f-fx"></div>
    <div class="field"><input class="input" id="f-title" maxlength="40" placeholder="花在什么上？例如：晚饭火锅" value="${esc(f.title)}"></div>
    <div class="field"><div class="lab">类别</div><div class="chips" id="f-cat"></div></div>
    <div class="field"><div class="lab">谁付的钱</div><div class="chips" id="f-payer"></div></div>
    <div class="field"><div class="lab"><span>谁参与 AA</span><span><button type="button" class="btn ghost small" id="f-all">全选</button><button type="button" class="btn ghost small" id="f-detail"></button></span></div>
      <div class="chips" id="f-who"></div>
      <div id="f-split" style="margin-top:10px"></div>
      <div class="preview num" id="f-preview"></div>
    </div>
    <div class="field"><label for="f-day">日期</label><input class="input" type="date" id="f-day" value="${f.day}"></div>
    <div class="field"><label for="f-note">备注</label><textarea class="input" id="f-note" maxlength="500" placeholder="可选，例如：含服务费；小明没吃辣锅">${esc(f.note)}</textarea></div>
    <div class="field"><div class="lab"><span>截图 / 小票</span><span class="faint">最多 9 张</span></div><div class="thumbs" id="f-imgs"></div></div>
    <div class="err" id="f-err"></div>
    <button class="btn primary block" id="f-save">${exp ? '保存修改' : '记下来'}</button>`, (el) => {
    const $ = (s) => el.querySelector(s);
    const tripRate = () => (f.currency === BASE ? 1 : d.rates[f.currency]?.rate);
    const drawCur = () => {
      $('#f-cur').innerHTML = CURS.map((c) => `<button type="button" class="chip small-chip ${f.currency === c.key ? 'on' : ''}" data-cur="${c.key}">${c.short}</button>`).join('');
      $('#f-sym').textContent = CUR[f.currency].sym;
      $('#f-amount').style.paddingLeft = (CUR[f.currency].sym.length * 15 + 12) + 'px';
      const box = $('#f-fx');
      if (f.currency === BASE) { box.innerHTML = ''; return preview(); }
      const tr = tripRate(), live = d.fx?.rates?.[f.currency];
      const name = CUR[f.currency].name;
      box.innerHTML = `<div class="fx-box">
        ${tr ? `<div class="small">汇率：1 ${name} = <b>${fmtRate(tr)}</b> ${BN()} <span class="faint">· 本次游玩统一汇率，可在「成员」页修改</span></div>`
          : `<div class="field" style="margin:0"><label>汇率（第一次用${name}，之后本次游玩都按这个算）</label>
              <div class="row2" style="align-items:center"><span class="small" style="flex:none">1 ${name} =</span><input class="input" id="f-rate" inputmode="decimal" value="${live ? fmtRate(live) : ''}" placeholder="例如 ${f.currency === 'JPY' ? '0.047' : '0.9'}"><span class="small" style="flex:none">${BN()}</span></div>
              <div class="faint tiny" style="margin-top:4px">${live ? `已填入今日市场汇率${d.fx.at ? '（' + fmtTime(d.fx.at) + ' 更新）' : ''}，可以改成你们实际换汇的汇率` : '暂时拿不到市场汇率，请手动填写'}</div></div>`}
        <div class="field" style="margin:10px 0 0"><label>实付${BN()}（可选）</label>
          <input class="input" id="f-cny" inputmode="decimal" placeholder="刷卡的话填账单上的${BN()}金额，以它为准" value="${esc(f.cny)}"></div>
      </div>`;
      const ri = $('#f-rate'); if (ri) ri.oninput = preview;
      $('#f-cny').oninput = (e) => { f.cny = e.target.value; preview(); };
      preview();
    };
    const drawCats = () => { $('#f-cat').innerHTML = CATS.map((c) => `<button type="button" class="chip ${f.category === c.key ? 'on' : ''}" data-c="${c.key}">${c.icon} ${c.name}</button>`).join(''); };
    const drawPayer = () => { $('#f-payer').innerHTML = d.members.map((m) => `<button type="button" class="chip ${f.payerId === m.id ? 'on' : ''}" data-p="${m.id}">${esc(m.name)}</button>`).join(''); };
    const drawWho = () => {
      $('#f-who').innerHTML = d.members.map((m) => `<button type="button" class="chip ${f.parts.has(m.id) ? 'on' : ''}" data-w="${m.id}">${esc(m.name)}${m.weight !== 1 ? ` ×${m.weight}` : ''}</button>`).join('');
      $('#f-all').textContent = f.parts.size === d.members.length ? '全不选' : '全选';
      $('#f-detail').textContent = f.detail ? '收起细调' : '按份数 / 指定金额';
      drawSplit();
    };
    const drawSplit = () => {
      const box = $('#f-split');
      if (!f.detail) { box.innerHTML = ''; return preview(); }
      box.innerHTML = f.parts.size ? `<div class="split-rows">${d.members.filter((m) => f.parts.has(m.id)).map((m) => {
        const p = f.parts.get(m.id);
        return `<div class="split-row" data-row="${m.id}"><span class="n">${esc(m.name)}</span>
          <input data-k="weight" inputmode="decimal" value="${esc(p.weight)}" aria-label="${esc(m.name)}的份数" ${p.fixed !== '' ? 'disabled' : ''}><span class="faint small">份</span>
          <input class="money" data-k="fixed" inputmode="decimal" placeholder="${f.currency === BASE ? '或金额' : '或' + CUR[f.currency].sym}" value="${esc(p.fixed)}" aria-label="${esc(m.name)}的指定金额">
          <span class="r num" data-r></span></div>`;
      }).join('')}</div><p class="faint tiny" style="margin:6px 2px 0">填了金额的人按金额算，剩下的钱按份数分给其他人</p>` : '';
      preview();
    };
    const curRate = () => {
      if (f.currency === BASE) return 1;
      const tr = tripRate(); if (tr) return tr;
      const v = String($('#f-rate')?.value ?? '').trim();
      return /^\d{1,4}(\.\d{1,8})?$/.test(v) && Number(v) > 0 ? Number(v) : null;
    };
    const calc = () => {
      const cents = parseCents($('#f-amount').value);
      if (!cents || !f.parts.size) return { cents, shares: null };
      let cny;
      if (f.currency !== BASE && String(f.cny).trim() !== '') {
        cny = parseCents(f.cny);
        if (!cny) return { cents, error: `实付${BN()}金额不对` };
      } else {
        const rate = curRate();
        if (!rate) return { cents, error: '请填写汇率' };
        cny = roundTo(cents * rate, unitOf(BASE));
        if (cny < 1) return { cents, error: `折合${BN()}金额太小` };
      }
      const parts = [];
      for (const [memberId, p] of f.parts) {
        if (f.detail && String(p.fixed).trim() !== '') {
          const fx = parseCents(p.fixed, true);
          if (fx == null || fx % unitOf(f.currency)) return { cents, error: `${nameOf(memberId)} 的金额不对` };
          parts.push({ memberId, weight: 0, fixed: fx });
        } else {
          const w = Number(p.weight);
          if (!(w > 0 && w < 100)) return { cents, error: `${nameOf(memberId)} 的份数要大于 0` };
          parts.push({ memberId, weight: w, fixed: null });
        }
      }
      if (cents % unitOf(f.currency)) return { cents, error: `${CUR[f.currency].name}金额不能有小数` };
      try { return { cents, cny, parts, shares: splitExpense(cents, cny, parts, unitOf(f.currency), unitOf(BASE)) }; }
      catch (e) { return { cents, error: e.message }; }
    };
    const preview = () => {
      const r = calc();
      const pv = $('#f-preview');
      el.querySelectorAll('[data-r]').forEach((x) => { x.textContent = ''; });
      if (r.error) { pv.innerHTML = `<span class="neg">${esc(r.error)}</span>`; return; }
      if (!r.shares) { pv.textContent = f.parts.size ? '' : '至少选一个人'; return; }
      const foreign = f.currency !== BASE;
      const one = (s) => foreign ? `${curMoney(f.currency, s.origCents)}（≈${money(s.cents)}）` : money(s.cents);
      const head = foreign ? `折合${BN()} <b>${money(r.cny)}</b>${String(f.cny).trim() ? '（按实付）' : ''}<br>` : '';
      if (f.detail) {
        for (const s of r.shares) { const x = el.querySelector(`[data-row="${s.memberId}"] [data-r]`); if (x) x.textContent = foreign ? '≈' + money(s.cents) : money(s.cents); }
        pv.innerHTML = head;
      } else {
        const same = r.shares.every((s) => s.origCents === r.shares[0].origCents);
        pv.innerHTML = head + esc(same ? `${r.shares.length} 人平分，每人 ${one(r.shares[0])}` : r.shares.map((s) => `${nameOf(s.memberId)} ${one(s)}`).join(' · '));
      }
    };
    const drawImgs = () => {
      const old = exp ? (T().expenses.find((x) => x.id === exp.id)?.images || []) : [];
      const urls = newFiles.map((fl) => fl.url);
      const n = old.length + newFiles.length;
      $('#f-imgs').innerHTML = old.map((i) => `<div class="thumb"><img src="/api/t/${S.key}/images/${i}" alt="截图" data-view="/api/t/${S.key}/images/${i}"><button type="button" class="del" data-delimg="${i}" aria-label="删除图片">✕</button></div>`).join('')
        + urls.map((u, i) => `<div class="thumb"><img src="${u}" alt="待上传" data-view="${u}"><button type="button" class="del" data-delnew="${i}" aria-label="移除">✕</button></div>`).join('')
        + (n < 9 ? '<button type="button" class="thumb add" id="f-addimg" aria-label="添加图片">＋</button>' : '');
    };
    drawCats(); drawPayer(); drawWho(); drawImgs(); drawCur();
    $('#f-cur').onclick = (e) => { const b = e.target.closest('[data-cur]'); if (b) { f.currency = b.dataset.cur; drawCur(); } };

    $('#f-amount').oninput = preview;
    $('#f-cat').onclick = (e) => { const b = e.target.closest('[data-c]'); if (b) { f.category = b.dataset.c; drawCats(); } };
    $('#f-payer').onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) { f.payerId = Number(b.dataset.p); drawPayer(); } };
    $('#f-who').onclick = (e) => {
      const b = e.target.closest('[data-w]'); if (!b) return;
      const id = Number(b.dataset.w);
      if (f.parts.has(id)) f.parts.delete(id); else f.parts.set(id, { weight: member(id).weight, fixed: '' });
      drawWho();
    };
    $('#f-all').onclick = () => {
      if (f.parts.size === d.members.length) f.parts.clear();
      else for (const m of d.members) if (!f.parts.has(m.id)) f.parts.set(m.id, { weight: m.weight, fixed: '' });
      drawWho();
    };
    $('#f-detail').onclick = () => { f.detail = !f.detail; drawWho(); };
    $('#f-split').oninput = (e) => {
      const row = e.target.closest('[data-row]'); if (!row) return;
      const p = f.parts.get(Number(row.dataset.row));
      p[e.target.dataset.k] = e.target.value;
      if (e.target.dataset.k === 'fixed') row.querySelector('[data-k="weight"]').disabled = e.target.value.trim() !== '';
      preview();
    };
    $('#f-imgs').onclick = async (e) => {
      const v = e.target.closest('[data-view]');
      if (v) return viewImage(v.dataset.view);
      const dn = e.target.closest('[data-delnew]');
      if (dn) { const [x] = newFiles.splice(Number(dn.dataset.delnew), 1); URL.revokeObjectURL(x.url); return drawImgs(); }
      const di = e.target.closest('[data-delimg]');
      if (di) {
        if (!confirm('删除这张图片？30 天内可以在「最近删除」里恢复。')) return;
        try { await api('DELETE', `/api/t/${S.key}/images/${di.dataset.delimg}`); await refresh(); drawImgs(); toast('图片已删除'); }
        catch (err) { toast(err.message, true); }
        return;
      }
      if (e.target.closest('#f-addimg')) {
        const files = await pickFiles(true);
        const room = 9 - (exp ? (T().expenses.find((x) => x.id === exp.id)?.images.length || 0) : 0) - newFiles.length;
        for (const file of files.slice(0, room)) {
          try { const blob = await compressImage(file); newFiles.push({ blob, url: URL.createObjectURL(blob) }); }
          catch (err) { toast(err.message, true); }
        }
        if (files.length > room) toast(`最多 9 张，多出的 ${files.length - room} 张没加`, true);
        drawImgs();
      }
    };
    $('#f-save').onclick = async () => {
      if (saving) return;
      const r = calc();
      const err = $('#f-err');
      if (!r.cents) { err.textContent = '请输入金额'; return $('#f-amount').focus(); }
      if (!f.parts.size) { err.textContent = '至少选一个人参与 AA'; return; }
      if (r.error) { err.textContent = r.error; return; }
      saving = true; $('#f-save').disabled = true; $('#f-save').textContent = '保存中…';
      const payload = {
        amount: $('#f-amount').value.trim(), title: $('#f-title').value, note: $('#f-note').value,
        category: f.category, payerId: f.payerId, day: $('#f-day').value,
        currency: f.currency,
        rate: f.currency !== BASE && !tripRate() ? $('#f-rate')?.value.trim() : undefined,
        baseAmount: f.currency !== BASE ? String(f.cny).trim() || null : null,
        shares: r.parts.map((p) => ({ memberId: p.memberId, weight: p.fixed != null ? 1 : p.weight, fixed: p.fixed != null ? amountInput(p.fixed) : null })),
      };
      try {
        store.set('aa:cur:' + S.key, f.currency);
        const res = exp ? await api('PUT', `/api/t/${S.key}/expenses/${exp.id}`, payload) : await api('POST', `/api/t/${S.key}/expenses`, payload);
        let failed = 0;
        for (let i = 0; i < newFiles.length; i++) {
          $('#f-save').textContent = `上传图片 ${i + 1}/${newFiles.length}…`;
          try { await api('POST', `/api/t/${S.key}/expenses/${res.id}/images`, newFiles[i].blob, { raw: true }); }
          catch (e2) { failed++; console.warn(e2); }
        }
        newFiles.forEach((x) => URL.revokeObjectURL(x.url));
        closeSheet();
        toast(failed ? `已保存，但有 ${failed} 张图片没传上去` : exp ? '已修改' : '记好了', !!failed);
        S.tab = 'bills';
        await refresh();
      } catch (e2) {
        err.textContent = e2.message; saving = false;
        $('#f-save').disabled = false; $('#f-save').textContent = exp ? '保存修改' : '记下来';
        if (e2.status === 423) { closeSheet(); await refresh(); }
      }
    };
    if (!exp) setTimeout(() => $('#f-amount').focus(), 250);
  });
}
function parseCents(v, allowZero = false) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [i, fr = ''] = s.split('.');
  const c = Number(i) * 100 + Number((fr + '00').slice(0, 2));
  return c === 0 && !allowZero ? null : c;
}

// ---------- 结算 ----------
function renderSettle(body) {
  const d = T();
  if (!d.expenses.length) { body.innerHTML = `<div class="empty"><div class="e">💸</div>还没有账目，记了账之后这里会算出谁该转给谁</div>`; return; }
  let html = '';
  if (d.transfers.length) {
    html += `<div class="card" style="padding:16px 0 4px"><h2 style="padding:0 16px">还需要转账<span class="sp"></span><small>最少 ${d.transfers.length} 笔就能结清</small></h2>
      ${d.transfers.map((x, i) => {
        const to = member(x.toId);
        const hasCode = to && (to.codes.wechat || to.codes.alipay);
        const mine = S.me && (x.fromId === S.me || x.toId === S.me);
        return `<div class="xfer ${mine ? 'me' : ''}"><div class="who" data-remind="${i}" role="button" tabindex="0" title="复制提醒文字"><b>${esc(nameOf(x.fromId))}</b><span class="arrow">→</span><b>${esc(nameOf(x.toId))}</b><div class="amt num">${money(x.cents)}</div></div>
          <div class="acts"><button class="btn small" data-remind="${i}" aria-label="复制提醒">📋</button>${hasCode ? `<button class="btn small" data-code="${x.toId}">收款码</button>` : ''}${editable() ? `<button class="btn small primary" data-paid="${i}">已转</button>` : ''}</div></div>`;
      }).join('')}
      <div style="padding:10px 16px 12px"><button class="btn block" id="remind-all">📋 复制催款消息（发到群里）</button></div></div>`;
  } else {
    html += `<div class="card done-big"><div class="e">🎉</div><b>已全部结清</b><span class="muted small">没有人欠钱了</span>
      ${editable() ? '<div style="margin-top:12px"><button class="btn primary" id="lock">锁定账单</button></div>' : ''}</div>`;
  }
  // 每人
  html += `<div class="card"><h2>每人明细</h2><table class="bal-table num"><thead><tr><th>成员</th><th>垫付</th><th>应摊</th><th>结果</th></tr></thead><tbody>
    ${d.balances.filter((b) => member(b.memberId)).map((b) => {
      const diff = b.paid - b.share;
      const state = b.net > 0 ? `<span class="pos">应收 ${money(b.net)}</span>` : b.net < 0 ? `<span class="neg">应付 ${money(-b.net)}</span>` : diff !== 0 ? '<span class="muted">已结清</span>' : '<span class="muted">—</span>';
      return `<tr><td>${esc(nameOf(b.memberId))}${b.memberId === S.me ? ' <span class="tag ink">我</span>' : ''}</td><td>${money(b.paid)}</td><td>${money(b.share)}</td><td>${state}</td></tr>`;
    }).join('')}</tbody></table>
    <p class="faint tiny" style="margin:10px 0 0">垫付 = 替大家付的钱；应摊 = 自己该承担的部分；结果已扣除下面「已转账」的金额</p></div>`;
  if (d.payments.length) {
    html += `<div class="card"><h2>已转账</h2>${d.payments.slice().reverse().map((p) => `<div class="kv"><span>✓ ${esc(nameOf(p.fromId))} → ${esc(nameOf(p.toId))} <span class="faint tiny">${fmtTime(p.createdAt)}</span></span>
      <span class="num">${money(p.cents)}${editable() ? ` <button class="btn ghost small" data-undo="${p.id}">撤销</button>` : ''}</span></div>`).join('')}</div>`;
  }
  html += `<div class="btns" style="margin-top:4px"><button class="btn" id="poster">🖼️ 生成结算长图</button>${editable() && d.transfers.length ? '<button class="btn" id="lock">🔒 锁定账单</button>' : ''}</div>`;
  body.innerHTML = html;
  body.querySelectorAll('[data-code]').forEach((b) => b.onclick = () => showCodes(Number(b.dataset.code)));
  body.querySelectorAll('[data-paid]').forEach((b) => b.onclick = () => paidSheet(d.transfers[Number(b.dataset.paid)]));
  body.querySelectorAll('[data-undo]').forEach((b) => b.onclick = async () => {
    if (!(await confirmSheet('撤销这条转账？', '撤销后这笔钱会重新算作没转。', '撤销', true))) return;
    act(() => api('DELETE', `/api/t/${S.key}/payments/${b.dataset.undo}`), '已撤销').catch(() => {});
  });
  body.querySelector('#poster').onclick = posterSheet;
  const ra = body.querySelector('#remind-all'); if (ra) ra.onclick = () => remindSheet(null);
  body.querySelectorAll('[data-remind]').forEach((b) => b.onclick = () => remindSheet(d.transfers[Number(b.dataset.remind)]));
  body.querySelectorAll('#lock').forEach((b) => b.onclick = lockTrip);
}

// 催款文字：x 为空 = 发群里的汇总；否则 = 私聊提醒某一个人
function remindText(x) {
  const d = T(), t = d.trip, url = `${location.origin}/t/${S.key}`;
  const total = d.expenses.reduce((a, e) => a + e.cents, 0);
  const codeHint = (id) => { const m = member(id); return m && (m.codes.wechat || m.codes.alipay) ? '（链接里有收款码）' : ''; };
  if (x) return `${nameOf(x.fromId)}，「${t.name}」的 AA 算好了：你需要转给 ${nameOf(x.toId)} ${money(x.cents)}${codeHint(x.toId)}。\n转完在链接里点一下「已转」就行：${url}`;
  return `【${t.name}】AA 结算\n一共 ${money(total)}，${d.members.length} 人，${d.expenses.length} 笔\n还需要转账：\n`
    + d.transfers.map((y) => `· ${nameOf(y.fromId)} → ${nameOf(y.toId)} ${money(y.cents)}`).join('\n')
    + `\n明细、收款码都在这里，转完点「已转」：${url}`;
}
function remindSheet(x) {
  const text = remindText(x);
  openSheet(`${sheetHead(x ? `提醒 ${nameOf(x.fromId)}` : '催款消息')}
    <div class="note-box" style="user-select:text">${esc(text)}</div>
    <div class="btns" style="margin-top:12px"><button class="btn primary" id="rm-copy">复制</button>${navigator.share ? '<button class="btn" id="rm-share">分享…</button>' : ''}</div>`, (el) => {
    el.querySelector('#rm-copy').onclick = async () => { if (await copyText(text, x ? '已复制，发给他吧' : '已复制，去群里粘贴吧')) closeSheet(); };
    const sh = el.querySelector('#rm-share'); if (sh) sh.onclick = () => navigator.share({ text }).catch(() => {});
  });
}

function paidSheet(x) {
  openSheet(`${sheetHead('标记已转账')}
    <p style="margin-top:-4px"><b>${esc(nameOf(x.fromId))}</b> 已经转给 <b>${esc(nameOf(x.toId))}</b></p>
    <div class="field amount-wrap"><span class="sym">¥</span><input class="amount-input num" id="pd-amt" inputmode="decimal" value="${amountInput(x.cents)}"></div>
    <p class="faint small">只转了一部分也可以改金额。</p>
    <div class="err"></div>
    <button class="btn primary block" id="pd-ok">确认已转</button>`, (el) => {
    el.querySelector('#pd-ok').onclick = async () => {
      try {
        await api('POST', `/api/t/${S.key}/payments`, { fromId: x.fromId, toId: x.toId, amount: el.querySelector('#pd-amt').value.trim() });
        closeSheet(); toast('已标记');
        await refresh();
        if (!T().transfers.length && editable()) {
          if (await confirmSheet('全部结清了 🎉', '要现在锁定账单吗？锁定后所有人都不能再修改，需要改时管理员可以解锁。', '锁定')) lockTrip(true);
        }
      } catch (e) { el.querySelector('.err').textContent = e.message; }
    };
  });
}

async function lockTrip(skipConfirm = false) {
  const left = T().transfers.length;
  if (skipConfirm !== true && !(await confirmSheet('锁定账单？', left ? `还有 ${left} 笔转账没标记完成。锁定后所有人都不能再记账或修改，只有管理员能解锁。` : '锁定后所有人都不能再记账或修改，只有管理员能解锁。', '锁定'))) return;
  act(() => api('POST', `/api/t/${S.key}/lock`), '已锁定').catch(() => {});
}

function showCodes(memberId) {
  const m = member(memberId);
  const kinds = [['wechat', '微信'], ['alipay', '支付宝']].filter(([k]) => m.codes[k]);
  let cur = kinds[0][0];
  const draw = (el) => {
    el.querySelector('#code-body').innerHTML = `<img src="/api/t/${S.key}/paycode/${m.id}/${cur}?v=${m.codes[cur]}" alt="${esc(m.name)}的收款码">
      <p class="faint small">长按图片可识别二维码或保存</p>`;
    el.querySelectorAll('[data-k]').forEach((b) => b.classList.toggle('on', b.dataset.k === cur));
  };
  openSheet(`${sheetHead(`${m.name} 的收款码`)}
    ${kinds.length > 1 ? `<div class="seg">${kinds.map(([k, n]) => `<button data-k="${k}">${n}</button>`).join('')}</div>` : ''}
    <div class="code-box" id="code-body"></div>`, (el) => {
    draw(el);
    el.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => { cur = b.dataset.k; draw(el); });
  });
}

// ---------- 结算长图 ----------
function posterSheet() {
  openSheet(`${sheetHead('结算长图')}<div class="code-box" id="pos-box"><p class="muted">生成中…</p></div>`, async (el) => {
    try {
      const canvas = drawPoster();
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const url = URL.createObjectURL(blob);
      const fname = `${T().trip.name}-结算.png`;
      const canShare = navigator.canShare && navigator.canShare({ files: [new File([blob], fname, { type: 'image/png' })] });
      el.querySelector('#pos-box').innerHTML = `<img src="${url}" alt="结算长图" style="max-height:none;box-shadow:var(--shadow)">
        <p class="faint small">手机上长按图片可以保存或直接发给朋友</p>
        <div class="btns"><a class="btn" href="${url}" download="${esc(fname)}">下载图片</a>${canShare ? '<button class="btn primary" id="pos-share">分享</button>' : ''}</div>`;
      const sh = el.querySelector('#pos-share');
      if (sh) sh.onclick = () => navigator.share({ files: [new File([blob], fname, { type: 'image/png' })], title: fname }).catch(() => {});
    } catch (e) { el.querySelector('#pos-box').innerHTML = `<p class="neg">${esc(e.message)}</p>`; }
  });
}

function drawPoster() {
  const d = T(), t = d.trip;
  const W = 390, P = 22, scale = 3;
  const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
  const C = { bg: '#f4f4f1', card: '#ffffff', text: '#1c1c1a', muted: '#6f6e69', faint: '#a3a29c', line: '#e8e7e2', ink: '#1f1f22', good: '#16794c', bad: '#cf3f36' };
  const total = d.expenses.reduce((a, e) => a + e.cents, 0);
  const rows = d.balances.filter((b) => member(b.memberId));
  const cats = CATS.map((c) => ({ ...c, cents: d.expenses.filter((e) => e.category === c.key).reduce((a, e) => a + e.cents, 0) })).filter((c) => c.cents > 0).sort((a, b) => b.cents - a.cents);
  const usedCurs = [...new Set(d.expenses.map((e) => e.currency))].filter((c) => c !== BASE && d.rates[c]);
  const rateLine = usedCurs.length ? '汇率：' + usedCurs.map((c) => `1 ${CUR[c].name}=${fmtRate(d.rates[c].rate)}`).join('，') : '';
  // 先算高度
  const H = (rateLine ? 20 : 0) + 22 + 128 + 18 + (44 + rows.length * 34 + 12) + 18
    + (44 + Math.max(1, d.transfers.length) * 34 + (d.payments.length ? 30 + d.payments.length * 26 : 0) + 12) + 18
    + (cats.length ? 44 + Math.ceil(cats.length / 2) * 28 + 12 + 18 : 0) + 40;
  const c = document.createElement('canvas');
  c.width = W * scale; c.height = H * scale;
  const g = c.getContext('2d');
  g.scale(scale, scale);
  g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
  const font = (size, weight = 400) => { g.font = `${weight} ${size}px ${FONT}`; };
  const text = (s, x, y, { size = 14, weight = 400, color = C.text, align = 'left', max } = {}) => {
    font(size, weight); g.fillStyle = color; g.textAlign = align; g.textBaseline = 'alphabetic';
    let str = String(s);
    if (max) while (g.measureText(str).width > max && str.length > 1) str = str.slice(0, -2) + '…';
    g.fillText(str, x, y);
  };
  const rr = (x, y, w, h, r, fill) => { g.beginPath(); g.roundRect(x, y, w, h, r); g.fillStyle = fill; g.fill(); };
  let y = 22;
  // 头部
  const grad = g.createLinearGradient(0, y, W, y + 128);
  grad.addColorStop(0, '#1f1f22'); grad.addColorStop(1, '#2b2b30');
  rr(P - 6, y, W - 2 * (P - 6), 128, 18, grad);
  text(t.name, P + 10, y + 32, { size: 18, weight: 700, color: '#fff', max: W - 2 * P - 20 });
  text(`${range(t)} · ${d.members.length} 人 · ${d.expenses.length} 笔`, P + 10, y + 54, { size: 12.5, color: 'rgba(255,255,255,.65)' });
  text('一共花了', P + 10, y + 82, { size: 12, color: 'rgba(255,255,255,.65)' });
  text(money(total), P + 10, y + 112, { size: 28, weight: 700, color: '#fff' });
  const perHead = rows.filter((b) => b.share > 0).length;
  if (perHead) {
    text('人均', W - P - 10, y + 82, { size: 12, color: 'rgba(255,255,255,.65)', align: 'right' });
    text(money(Math.round(total / perHead)), W - P - 10, y + 112, { size: 20, weight: 600, color: '#fff', align: 'right' });
  }
  y += 128 + 18;
  // 每人明细
  const cardTop = (h, title) => { rr(P - 6, y, W - 2 * (P - 6), h, 16, C.card); text(title, P + 8, y + 28, { size: 15, weight: 600 }); };
  let h = 44 + rows.length * 34 + 12;
  cardTop(h, '每人明细');
  const col = [W - P - 8 - 170, W - P - 8 - 95, W - P - 8];
  text('垫付', col[0], y + 28, { size: 11.5, color: C.muted, align: 'right' });
  text('应摊', col[1], y + 28, { size: 11.5, color: C.muted, align: 'right' });
  text('差额', col[2], y + 28, { size: 11.5, color: C.muted, align: 'right' });
  let ry = y + 44;
  for (const b of rows) {
    g.fillStyle = C.line; g.fillRect(P + 8, ry, W - 2 * P - 16, 1);
    const diff = b.paid - b.share;
    text(nameOf(b.memberId), P + 8, ry + 22, { size: 14, weight: 500, max: col[0] - P - 70 });
    text(money(b.paid), col[0], ry + 22, { size: 13.5, align: 'right' });
    text(money(b.share), col[1], ry + 22, { size: 13.5, align: 'right' });
    text(diff === 0 ? '0' : money(diff, { sign: true }), col[2], ry + 22, { size: 13.5, weight: 600, align: 'right', color: diff > 0 ? C.good : diff < 0 ? C.bad : C.muted });
    ry += 34;
  }
  y += h + 18;
  // 转账
  h = 44 + Math.max(1, d.transfers.length) * 34 + (d.payments.length ? 30 + d.payments.length * 26 : 0) + 12;
  cardTop(h, d.transfers.length ? `转账方案（${d.transfers.length} 笔）` : '转账方案');
  ry = y + 44;
  if (!d.transfers.length) { text('🎉 已全部结清', P + 8, ry + 22, { size: 14, color: C.good, weight: 600 }); ry += 34; }
  for (const x of d.transfers) {
    g.fillStyle = C.line; g.fillRect(P + 8, ry, W - 2 * P - 16, 1);
    text(`${nameOf(x.fromId)}  →  ${nameOf(x.toId)}`, P + 8, ry + 22, { size: 14, weight: 500, max: W - 2 * P - 120 });
    text(money(x.cents), W - P - 8, ry + 22, { size: 15, weight: 700, align: 'right' });
    ry += 34;
  }
  if (d.payments.length) {
    text('已转账', P + 8, ry + 22, { size: 12, color: C.muted }); ry += 30;
    for (const p of d.payments) {
      text(`✓ ${nameOf(p.fromId)} → ${nameOf(p.toId)}`, P + 8, ry + 16, { size: 13, color: C.muted, max: W - 2 * P - 120 });
      text(money(p.cents), W - P - 8, ry + 16, { size: 13, color: C.muted, align: 'right' });
      ry += 26;
    }
  }
  y += h + 18;
  // 类别
  if (cats.length) {
    h = 44 + Math.ceil(cats.length / 2) * 28 + 12;
    cardTop(h, '花在哪了');
    cats.forEach((ct, i) => {
      const cx = i % 2 ? W / 2 + 4 : P + 8, cy = y + 44 + Math.floor(i / 2) * 28 + 18;
      text(`${ct.icon} ${ct.name}`, cx, cy, { size: 13.5 });
      text(money(ct.cents), cx + (W / 2 - P - 16), cy, { size: 13.5, weight: 600, align: 'right' });
    });
    y += h + 18;
  }
  if (rateLine) { text(rateLine, W / 2, y + 12, { size: 11.5, color: C.muted, align: 'center', max: W - 2 * P }); y += 20; }
  text(`AA 账本 · 金额均为${BN()} · 生成于 ${fmtTime(Date.now())}`, W / 2, y + 12, { size: 11.5, color: C.faint, align: 'center' });
  return c;
}

// ---------- 统计 ----------
function vbars(items) {
  const max = Math.max(1, ...items.map((i) => i.v));
  return `<div class="vbars">${items.map((i) => `<div class="col" title="${esc(i.tip)}" tabindex="0"><span class="tip num">${money(i.v)}</span><div class="b" style="height:${i.v ? Math.max(2, (i.v / max) * 100) : 0}%"></div></div>`).join('')}</div>
    <div class="vlabels">${items.map((i) => `<span>${esc(i.short ?? i.label)}</span>`).join('')}</div>`;
}
function catBars(list, total) {
  if (!list.length) return '<p class="muted small">没有数据</p>';
  const max = Math.max(1, ...list.map((c) => c.cents));
  return list.map((c) => {
    const ct = CAT[c.key] || CAT.other;
    return `<div class="hbar" title="${ct.name}：${money(c.cents)}（${Math.round((c.cents / total) * 100)}%）"><div class="lab"><span>${ct.icon} ${ct.name}</span><span class="num">${money(c.cents)} · ${Math.round((c.cents / total) * 100)}%</span></div>
      <div class="track"><div class="fill" style="width:${(c.cents / max) * 100}%"></div></div></div>`;
  }).join('');
}
function bindBars(root) {
  // 触屏上点一下柱子显示数值
  root.querySelectorAll('.vbars .col').forEach((col) => col.onclick = () => {
    const on = col.classList.contains('on');
    col.parentElement.querySelectorAll('.col').forEach((x) => x.classList.remove('on'));
    if (!on) col.classList.add('on');
  });
}

function renderStats(body) {
  const d = T();
  if (!d.expenses.length) { body.innerHTML = `<div class="empty"><div class="e">📊</div>记了账之后这里会有统计</div>`; return; }
  const total = d.expenses.reduce((a, e) => a + e.cents, 0);
  const days = [...new Set(d.expenses.map((e) => e.day))].sort();
  const first = days[0], last = days[days.length - 1];
  const span = daysBetween(first, last) + 1;
  const sharers = d.balances.filter((b) => b.share > 0).length || 1;
  let html = `<div class="tiles">
    <div class="tile"><div class="l">总花费</div><div class="v num">${money(total)}</div></div>
    <div class="tile"><div class="l">人均</div><div class="v num">${money(Math.round(total / sharers))}</div></div>
    <div class="tile"><div class="l">笔数</div><div class="v num">${d.expenses.length}<small> 笔</small></div></div>
    <div class="tile"><div class="l">${span > 1 ? `${span} 天，日均` : '天数'}</div><div class="v num">${span > 1 ? money(Math.round(total / span)) : '1<small> 天</small>'}</div></div></div>`;

  // 每人：垫付 vs 应摊
  const rows = d.balances.filter((b) => member(b.memberId)).sort((a, b) => b.share - a.share);
  const maxP = Math.max(1, ...rows.map((b) => Math.max(b.paid, b.share)));
  html += `<div class="card"><h2>每个人</h2><div class="legend"><span><i></i>垫付</span><span><i class="b2"></i>应摊（自己花的）</span></div>
    ${rows.map((b) => `<div class="hbar" title="${esc(nameOf(b.memberId))}：垫付 ${money(b.paid)}，应摊 ${money(b.share)}，占总花费 ${Math.round((b.share / total) * 100)}%">
      <div class="lab"><span>${esc(nameOf(b.memberId))}${b.memberId === S.me ? ' <span class="tag ink">我</span>' : ''}</span><span class="num">垫付 ${money(b.paid)} · 应摊 ${money(b.share)}</span></div>
      <div class="track"><div class="fill" style="width:${(b.paid / maxP) * 100}%"></div></div>
      <div class="track"><div class="fill b2" style="width:${(b.share / maxP) * 100}%"></div></div></div>`).join('')}</div>`;

  // 类别
  const cats = CATS.map((c) => ({ key: c.key, cents: d.expenses.filter((e) => e.category === c.key).reduce((a, e) => a + e.cents, 0) })).filter((c) => c.cents).sort((a, b) => b.cents - a.cents);
  html += `<div class="card"><h2>花在哪了</h2>${catBars(cats, total)}</div>`;
  const byCur = CURS.map((c) => {
    const list = d.expenses.filter((e) => e.currency === c.key);
    return { c, n: list.length, orig: list.reduce((a, e) => a + e.origCents, 0), cny: list.reduce((a, e) => a + e.cents, 0) };
  }).filter((x) => x.n);
  if (byCur.length > 1 || (byCur[0] && byCur[0].c.key !== BASE)) {
    html += `<div class="card"><h2>按币种<span class="sp"></span><small>统一折算成${BN()}</small></h2>${byCur.map((x) => `<div class="kv"><span>${x.c.name} <span class="faint tiny">${x.n} 笔</span></span><span class="num">${x.c.key === BASE ? money(x.cny) : `${curMoney(x.c.key, x.orig)} <span class="faint">≈${money(x.cny)}</span>`}</span></div>`).join('')}</div>`;
  }

  // 每天
  if (span > 1 && span <= 31) {
    const items = [];
    for (let i = 0; i < span; i++) {
      const day = addDays(first, i);
      const v = d.expenses.filter((e) => e.day === day).reduce((a, e) => a + e.cents, 0);
      items.push({ label: md(day), short: span > 10 ? String(Number(day.slice(8))) : md(day), v, tip: `${md(day)} ${wk(day)}：${money(v)}` });
    }
    html += `<div class="card"><h2>每天花了多少</h2>${vbars(items)}</div>`;
  }

  // 最大的几笔
  const top = d.expenses.slice().sort((a, b) => b.cents - a.cents).slice(0, 5);
  html += `<div class="card"><h2>最大的 ${top.length} 笔</h2>${top.map((e) => `<div class="kv" data-exp="${e.id}" style="cursor:pointer"><span>${CAT[e.category]?.icon} ${esc(e.title || CAT[e.category]?.name)} <span class="faint tiny">${md(e.day)} · ${esc(nameOf(e.payerId))} 付${e.currency !== BASE ? ' · ' + esc(curMoney(e.currency, e.origCents)) : ''}</span></span><span class="num">${money(e.cents)}</span></div>`).join('')}</div>`;

  // 谁垫钱最多
  const payer = rows.slice().sort((a, b) => b.paid - a.paid)[0];
  if (payer && payer.paid > 0) html += `<p class="muted small" style="text-align:center">💪 本次垫钱最多的是 <b>${esc(nameOf(payer.memberId))}</b>，替大家先付了 ${money(payer.paid)}</p>`;
  body.innerHTML = html;
  body.querySelectorAll('[data-exp]').forEach((b) => b.onclick = () => expenseDetail(Number(b.dataset.exp)));
  bindBars(body);
}

// ---------- 成员 / 设置 ----------
function renderPeople(body) {
  const d = T(), t = d.trip;
  const ed = editable();
  let html = `<div class="list">${d.members.map((m) => {
    const codes = [m.codes.wechat && '微信', m.codes.alipay && '支付宝'].filter(Boolean);
    return `<div class="mem"><span class="avatar">${esc([...m.name][0])}</span>
      <span class="main"><b>${esc(m.name)}</b>${m.id === S.me ? ' <span class="tag ink">我</span>' : ''}${m.weight !== 1 ? ` <span class="tag">${m.weight} 份</span>` : ''}
        <div class="s">${codes.length ? `收款码：${codes.join('、')}` : '还没有收款码'}</div></span>
      <button class="btn small" data-mem="${m.id}">${ed ? '设置' : '查看'}</button></div>`;
  }).join('') || '<div class="empty small">还没有成员</div>'}</div>`;
  if (ed) html += `<div class="row2" style="margin-top:10px"><input class="input" id="pm-new" maxlength="20" placeholder="临时加人：输入名字"><button class="btn primary" id="pm-add" style="flex:none">添加</button></div>`;

  html += `<div class="section-title"><span>这次游玩</span></div>
    <div class="list">
      <button class="item" id="pm-share"><span class="cat">🔗</span><span class="main"><span class="t">分享链接</span><span class="s">发到群里，大家打开就能记账</span></span></button>
      <button class="item" id="pm-base"><span class="cat">🪙</span><span class="main"><span class="t">结算币种：${BN()}</span><span class="s">${ed ? (d.payments.length ? '已有转账记录，不能再换' : '分摊和转账都按它算，点击更换') : '分摊和转账都按它算'}</span></span></button>
      ${ed ? `<button class="item" id="pm-edit"><span class="cat">✏️</span><span class="main"><span class="t">修改名称和日期</span><span class="s">${esc(t.name)} · ${range(t)}</span></span></button>` : ''}
      ${Object.keys(d.rates).length ? Object.entries(d.rates).sort().map(([c, r]) => `<button class="item" data-rate="${c}"><span class="cat">💱</span><span class="main"><span class="t">汇率：1 ${CUR[c]?.name || c} = ${fmtRate(r.rate)} ${BN()}</span><span class="s">${d.fx?.rates?.[c] ? `今日市场 ${fmtRate(d.fx.rates[c])}` : '本次游玩统一按这个汇率折算'}${ed ? ' · 点击修改' : ''}</span></span></button>`).join('') : ''}
      <a class="item" id="pm-export" href="/api/t/${esc(S.key)}/export" download><span class="cat">📑</span><span class="main"><span class="t">导出 Excel</span><span class="s">账目明细、每人汇总、转账记录</span></span></a>
      <button class="item" id="pm-trash"><span class="cat">🗑️</span><span class="main"><span class="t">最近删除</span><span class="s">误删的账目和截图 30 天内可以恢复</span></span></button>
      <button class="item" id="pm-log"><span class="cat">🕘</span><span class="main"><span class="t">操作记录</span><span class="s">谁在什么时候记了、改了、删了哪一笔</span></span></button>
      ${ed ? '<button class="item" id="pm-lock"><span class="cat">🔒</span><span class="main"><span class="t">锁定账单</span><span class="s">结清后锁定，防止误改</span></span></button>' : ''}
    </div>
    ${t.note ? `<div class="section-title"><span>说明</span></div><div class="note-box">${esc(t.note)}</div>` : ''}`;
  if (d.isAdmin) {
    html += `<div class="section-title"><span>管理员</span></div><div class="list">
      ${t.locked ? '<button class="item" id="pa-unlock"><span class="cat">🔓</span><span class="main"><span class="t">解锁账单</span><span class="s">解锁后大家可以继续修改</span></span></button>' : ''}
      <button class="item" id="pa-rekey"><span class="cat">♻️</span><span class="main"><span class="t">重置分享链接</span><span class="s">旧链接立即失效，适合链接外泄时</span></span></button>
      <button class="item" id="pa-del"><span class="cat">🗑️</span><span class="main"><span class="t" style="color:var(--danger)">删除这次游玩</span><span class="s">先放进回收站，30 天内可以恢复</span></span></button></div>`;
  }
  body.innerHTML = html;
  body.querySelectorAll('[data-mem]').forEach((b) => b.onclick = () => memberSheet(Number(b.dataset.mem)));
  const add = body.querySelector('#pm-add');
  if (add) {
    const inp = body.querySelector('#pm-new');
    const go2 = async () => {
      const name = inp.value.trim(); if (!name) return;
      await act(() => api('POST', `/api/t/${S.key}/members`, { name }), `已添加 ${name}`).catch(() => {});
    };
    add.onclick = go2;
    inp.onkeydown = (e) => { if (e.key === 'Enter') go2(); };
  }
  body.querySelector('#pm-share').onclick = () => shareLink(false);
  body.querySelector('#pm-log').onclick = logSheet;
  body.querySelector('#pm-trash').onclick = trashSheet;
  if (ed && !d.payments.length) body.querySelector('#pm-base').onclick = baseSheet;
  if (ed) body.querySelectorAll('[data-rate]').forEach((b) => b.onclick = () => rateSheet(b.dataset.rate));
  const pe = body.querySelector('#pm-edit'); if (pe) pe.onclick = tripEditSheet;
  const pl = body.querySelector('#pm-lock'); if (pl) pl.onclick = lockTrip;
  const pu = body.querySelector('#pa-unlock');
  if (pu) pu.onclick = () => act(() => api('POST', `/api/t/${S.key}/unlock`), '已解锁').catch(() => {});
  const pr = body.querySelector('#pa-rekey');
  if (pr) pr.onclick = async () => {
    if (!(await confirmSheet('重置分享链接？', '旧链接会立即失效，已经打开过的朋友需要你重新发新链接。', '重置', true))) return;
    try { const r = await api('POST', `/api/admin/trips/${t.id}/rekey`); S.key = r.key; history.replaceState(null, '', `/t/${r.key}`); await refresh(); shareLink(true); }
    catch (e) { toast(e.message, true); }
  };
  const pd = body.querySelector('#pa-del');
  if (pd) pd.onclick = async () => {
    if (!(await confirmSheet(`删除「${esc(t.name)}」？`, `${d.expenses.length} 笔账目连同截图会放进回收站，分享链接立即打不开。<b>30 天内</b>可以在管理员菜单「回收站」恢复，之后永久删除。`, '删除', true))) return;
    try { await api('DELETE', `/api/admin/trips/${t.id}`); toast('已删除'); go('/'); }
    catch (e) { toast(e.message, true); }
  };
}

function baseSheet() {
  const d = T(), from = BASE;
  let to = from;
  openSheet(`${sheetHead('更换结算币种')}
    <p class="muted small" style="margin-top:-6px">换了以后，所有账目都会按新币种重新折算，分摊和转账也都用新币种。</p>
    <div class="chips" id="bs-cur">${baseChips(to)}</div>
    <div id="bs-rate" style="margin-top:14px"></div>
    <div class="err"></div><button class="btn primary block" id="bs-save" disabled>更换并重算</button>`, (el) => {
    const draw = () => {
      el.querySelector('#bs-cur').innerHTML = baseChips(to);
      const box = el.querySelector('#bs-rate');
      el.querySelector('#bs-save').disabled = to === from;
      if (to === from) { box.innerHTML = ''; return; }
      const live = d.fx?.rates?.[to] ? 1 / d.fx.rates[to] : null; // 1 旧 = ? 新
      box.innerHTML = `<div class="field"><label>换算汇率</label>
        <div class="row2" style="align-items:center"><span style="flex:none">1 ${CUR[from].name} =</span><input class="input" id="bs-v" inputmode="decimal" value="${live ? fmtRate(live) : ''}"><span style="flex:none">${CUR[to].name}</span></div>
        <div class="faint tiny" style="margin-top:4px">${live ? '已填入今日市场汇率，可以改' : '暂时拿不到市场汇率，请手动填写'}。其他外币的汇率会自动跟着换算。</div></div>`;
    };
    draw();
    el.querySelector('#bs-cur').onclick = (e) => { const b = e.target.closest('[data-base]'); if (b) { to = b.dataset.base; draw(); } };
    el.querySelector('#bs-save').onclick = async () => {
      try {
        const r = await api('PUT', `/api/t/${S.key}/base`, { currency: to, rate: el.querySelector('#bs-v')?.value.trim() });
        store.set('aa:cur:' + S.key, null);
        closeSheet(); toast(`已换成${CUR[to].name}，重算了 ${r.recomputed} 笔`); await refresh();
      } catch (e) { el.querySelector('.err').textContent = e.message; }
    };
  });
}

function rateSheet(cur) {
  const d = T(), r = d.rates[cur], live = d.fx?.rates?.[cur], name = CUR[cur].name;
  const n = d.expenses.filter((e) => e.currency === cur && !e.baseOverride).length;
  openSheet(`${sheetHead(`${name}汇率`)}
    <div class="row2" style="align-items:center"><span style="flex:none">1 ${name} =</span><input class="input" id="rt-v" inputmode="decimal" value="${fmtRate(r.rate)}"><span style="flex:none">${BN()}</span></div>
    ${live ? `<button class="btn ghost small" id="rt-live" style="margin-top:6px">用今日市场汇率 ${fmtRate(live)}</button>` : ''}
    <p class="muted small">保存后，本次游玩里 ${n} 笔${name}账目会按新汇率重新折算（填了「实付${BN()}」的不受影响）。已标记的转账不会变，结算方案会自动更新。</p>
    <div class="err"></div><button class="btn primary block" id="rt-save">保存并重算</button>`, (el) => {
    const lv = el.querySelector('#rt-live'); if (lv) lv.onclick = () => { el.querySelector('#rt-v').value = fmtRate(live); };
    el.querySelector('#rt-save').onclick = async () => {
      try { const x = await api('PUT', `/api/t/${S.key}/rates/${cur}`, { rate: el.querySelector('#rt-v').value.trim() }); closeSheet(); toast(`已更新，重算了 ${x.recomputed} 笔`); await refresh(); }
      catch (e) { el.querySelector('.err').textContent = e.message; }
    };
  });
}

function shareLink(fresh) {
  const url = `${location.origin}/t/${S.key}`;
  const text = `「${T().trip.name}」AA 记账：${url}`;
  openSheet(`${sheetHead(fresh ? '把链接发到群里' : '分享链接')}
    <p class="muted small" style="margin-top:-4px">拿到链接的人都能查看和记账，不用注册。只发给一起玩的朋友。</p>
    <div class="note-box" style="word-break:break-all;user-select:all">${esc(url)}</div>
    <div class="btns" style="margin-top:12px"><button class="btn primary" id="sl-copy">复制链接</button>${navigator.share ? '<button class="btn" id="sl-share">分享…</button>' : ''}</div>`, (el) => {
    el.querySelector('#sl-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(text); toast('已复制，去群里粘贴吧'); }
      catch { toast('复制失败，请长按上面的链接手动复制', true); }
    };
    const sh = el.querySelector('#sl-share');
    if (sh) sh.onclick = () => navigator.share({ title: T().trip.name, text: `「${T().trip.name}」AA 记账`, url }).catch(() => {});
  });
}

function tripEditSheet() {
  const t = T().trip;
  openSheet(`${sheetHead('游玩信息')}
    <form id="te"><div class="field"><label>名称</label><input class="input" name="name" maxlength="40" value="${esc(t.name)}" required></div>
    <div class="row2"><div class="field"><label>开始</label><input class="input" type="date" name="startDay" value="${t.startDay}" required></div>
      <div class="field"><label>结束（可空）</label><input class="input" type="date" name="endDay" value="${t.endDay || ''}"></div></div>
    <div class="field"><label>说明（可选）</label><textarea class="input" name="note" maxlength="500" placeholder="例如：住宿按房间分；油费大家平摊">${esc(t.note)}</textarea></div>
    <div class="err"></div><button class="btn primary block">保存</button></form>`, (el) => {
    el.querySelector('form').onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      try {
        await api('PATCH', `/api/t/${S.key}`, { name: f.get('name'), startDay: f.get('startDay'), endDay: f.get('endDay') || null, note: f.get('note') });
        closeSheet(); toast('已保存'); await refresh();
      } catch (err) { el.querySelector('.err').textContent = err.message; }
    };
  });
}

function memberSheet(id) {
  const m = member(id); if (!m) return;
  const ed = editable();
  const b = balOf(id);
  const codeRow = (k, n) => `<div class="kv" style="align-items:center"><span>${n}收款码</span><span>
    ${m.codes[k] ? `<button class="btn small" data-view="${k}">查看</button>` : '<span class="faint small">未上传</span>'}
    ${ed ? `<button class="btn small" data-up="${k}">${m.codes[k] ? '更换' : '上传'}</button>${m.codes[k] ? `<button class="btn small danger" data-rm="${k}">删除</button>` : ''}` : ''}</span></div>`;
  openSheet(`${sheetHead(m.name)}
    <div class="card">
      <div class="kv"><span>垫付</span><span class="num">${money(b.paid)}</span></div>
      <div class="kv"><span>应摊</span><span class="num">${money(b.share)}</span></div>
      <div class="kv"><span>结果</span><span class="num">${b.net > 0 ? `<span class="pos">应收 ${money(b.net)}</span>` : b.net < 0 ? `<span class="neg">应付 ${money(-b.net)}</span>` : '已结清'}</span></div>
    </div>
    <div class="card">${codeRow('wechat', '微信')}${codeRow('alipay', '支付宝')}
      <p class="faint tiny" style="margin:8px 0 0">收款码跟着人走，以后的游玩也能直接用</p></div>
    ${ed ? `<div class="card"><div class="field" style="margin:0"><label>默认份数（带家属可以填 2；记账时可以单独改）</label>
      <div class="row2"><input class="input" id="ms-w" inputmode="decimal" value="${m.weight}"><button class="btn" id="ms-save" style="flex:none">保存</button></div></div></div>
      <button class="btn danger block" id="ms-del">从这次游玩中移除</button>` : ''}
    ${S.me !== id ? `<button class="btn ghost block" id="ms-me" style="margin-top:8px">这是我</button>` : ''}`, (el) => {
    el.querySelectorAll('[data-view]').forEach((x) => x.onclick = () => viewImage(`/api/t/${S.key}/paycode/${id}/${x.dataset.view}?v=${m.codes[x.dataset.view]}`));
    el.querySelectorAll('[data-up]').forEach((x) => x.onclick = async () => {
      const [file] = await pickFiles(false); if (!file) return;
      try {
        const blob = await compressImage(file);
        await api('PUT', `/api/t/${S.key}/paycode/${id}/${x.dataset.up}`, blob, { raw: true });
        toast('收款码已保存'); await refresh(); memberSheet(id);
      } catch (e) { toast(e.message, true); }
    });
    el.querySelectorAll('[data-rm]').forEach((x) => x.onclick = async () => {
      if (!confirm('删除这个收款码？')) return;
      try { await api('DELETE', `/api/t/${S.key}/paycode/${id}/${x.dataset.rm}`); toast('已删除'); await refresh(); memberSheet(id); }
      catch (e) { toast(e.message, true); }
    });
    const sv = el.querySelector('#ms-save');
    if (sv) sv.onclick = async () => {
      try { await api('PATCH', `/api/t/${S.key}/members/${id}`, { weight: el.querySelector('#ms-w').value.trim() }); closeSheet(); toast('已保存'); await refresh(); }
      catch (e) { toast(e.message, true); }
    };
    const del = el.querySelector('#ms-del');
    if (del) del.onclick = async () => {
      if (!(await confirmSheet(`移除 ${esc(m.name)}？`, '只有还没参与任何账目的人才能移除。', '移除', true))) return;
      try {
        await api('DELETE', `/api/t/${S.key}/members/${id}`);
        if (S.me === id) { S.me = null; store.set('aa:me:' + S.key, null); }
        toast('已移除'); await refresh();
      } catch (e) { toast(e.message, true); }
    };
    const mm = el.querySelector('#ms-me');
    if (mm) mm.onclick = () => { S.me = id; store.set('aa:me:' + S.key, String(id)); closeSheet(); renderTrip(); };
  });
}

// 最近删除：误删的账目 / 截图可以恢复
async function trashSheet() {
  let r;
  try { r = await api('GET', `/api/t/${S.key}/trash`); } catch (e) { return toast(e.message, true); }
  const ed = editable();
  openSheet(`${sheetHead('最近删除')}
    <p class="muted small" style="margin-top:-6px">删掉的账目和截图会在这里保留 ${r.days} 天，之后自动清除。${ed ? '' : '账单已锁定，解锁后才能恢复。'}</p>
    <div class="list">${r.items.length ? r.items.map((i) => `<div class="mem"><span class="main">${i.kind === 'image' ? '🖼️ ' : ''}${esc(i.label)}
      <div class="s">${esc(i.deletedBy || '未署名')} 删于 ${fmtTime(i.deletedAt)}</div></span>
      ${ed ? `<button class="btn small" data-restore="${i.id}">恢复</button>` : ''}</div>`).join('') : '<div class="empty small">没有删除过东西</div>'}</div>`, (el) => {
    el.querySelectorAll('[data-restore]').forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try { await api('POST', `/api/t/${S.key}/trash/${b.dataset.restore}/restore`); toast('已恢复'); await refresh(); trashSheet(); }
      catch (e) { b.disabled = false; toast(e.message, true); }
    });
  });
}
async function logSheet() {
  openSheet(`${sheetHead('操作记录')}<div class="card" id="log-body"><p class="muted">加载中…</p></div>`, async (el) => {
    try {
      const { items } = await api('GET', `/api/t/${S.key}/log`);
      el.querySelector('#log-body').innerHTML = items.length ? items.map((i) => `<div class="log-item"><b>${esc(i.actor)}</b> ${esc(i.detail)}<div class="when">${fmtTime(i.at)}</div></div>`).join('') : '<p class="muted">还没有记录</p>';
    } catch (e) { el.querySelector('#log-body').innerHTML = `<p class="neg">${esc(e.message)}</p>`; }
  });
}

route();
