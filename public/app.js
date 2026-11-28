'use strict';
// AA 账本前端：无框架。/ = 管理员首页，/t/<key> = 某次游玩（凭分享链接）
const $app = document.getElementById('app');
const { computeShares, splitExpense, exactShares, unitOf, roundTo } = window.AASettle;

// 类别分两级：6 个大类（记账时一排选完）+ 小类（选了大类才出现）。统计按大类汇总，不会因为类别多而变乱。
// 每个大类的第一个小类是默认值。新增类别时同时改 server.js 的 CATEGORIES
const GROUPS = [
  { key: 'eat', name: '吃喝', icon: '🍜' },
  { key: 'stay', name: '住宿', icon: '🏨' },
  { key: 'move', name: '交通', icon: '🚗' },
  { key: 'play', name: '玩乐', icon: '🎫' },
  { key: 'buy', name: '购物', icon: '🛍️' },
  { key: 'misc', name: '其他', icon: '📦' },
];
const CATS = [
  { key: 'food', name: '餐饮', icon: '🍜', g: 'eat' },
  { key: 'snack', name: '饮品零食', icon: '🧋', g: 'eat' },
  { key: 'grocery', name: '超市', icon: '🛒', g: 'eat' },
  { key: 'lodging', name: '住宿', icon: '🏨', g: 'stay' },
  { key: 'transport', name: '交通', icon: '🚗', g: 'move' },
  { key: 'taxi', name: '打车', icon: '🚕', g: 'move' },
  { key: 'flight', name: '机票火车', icon: '✈️', g: 'move' },
  { key: 'rental', name: '租车', icon: '🚙', g: 'move' },
  { key: 'fuel', name: '油费充电', icon: '⛽', g: 'move' },
  { key: 'parking', name: '停车过路', icon: '🅿️', g: 'move' },
  { key: 'ticket', name: '门票', icon: '🎫', g: 'play' },
  { key: 'fun', name: '娱乐', icon: '🎤', g: 'play' },
  { key: 'shopping', name: '购物', icon: '🛍️', g: 'buy' },
  { key: 'gift', name: '伴手礼', icon: '🎁', g: 'buy' },
  { key: 'other', name: '其他', icon: '📦', g: 'misc' },
];
const CAT = Object.fromEntries(CATS.map((c) => [c.key, c]));
const GROUP = Object.fromEntries(GROUPS.map((g) => [g.key, g]));
const groupOf = (key) => (CAT[key] || CAT.other).g;
// [{key, cents}] → 按大类汇总：[{g, cents, subs:[{key, cents}]}]，金额从大到小
function groupCats(list) {
  const m = new Map();
  for (const c of list) {
    if (!c.cents) continue;
    const g = groupOf(c.key);
    if (!m.has(g)) m.set(g, { g: GROUP[g], cents: 0, subs: new Map() });
    const x = m.get(g); x.cents += c.cents;
    const k = CAT[c.key] ? c.key : 'other';
    x.subs.set(k, (x.subs.get(k) || 0) + c.cents);
  }
  return [...m.values()].map((x) => ({ ...x, subs: [...x.subs].map(([key, cents]) => ({ key, cents })).sort((a, b) => b.cents - a.cents) })).sort((a, b) => b.cents - a.cents);
}
// 某大类下只有一个小类且名字跟大类一样时，不用再列小类
const showSubs = (x) => x.subs.length > 1 || CAT[x.subs[0].key].name !== x.g.name;
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
// c 一般是整数分；精确应摊可能带小数分（例如 25022.5 → 250.225），这时显示三位小数，除不尽的再加「≈」
function money(c, { sign = false, cur = true } = {}) {
  const neg = c < 0; let a = Math.abs(c), approx = '';
  if (Math.abs(a - Math.round(a)) < 1e-6) a = Math.round(a);
  let s;
  if (Number.isInteger(a)) s = (a / 100).toFixed(a % 100 === 0 ? 0 : 2);
  else { const t = Math.round(a * 10); if (Math.abs(a * 10 - t) > 1e-6) approx = '≈'; s = (t / 1000).toFixed(3); }
  s = s.replace(/^(\d+)/, (x) => x.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  return approx + (neg ? '-' : sign && c > 0 ? '+' : '') + (cur ? CUR[BASE].sym : '') + s;
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
// 动效：弹层关闭时先往下滑出再隐藏；系统开了「减少动态效果」就直接隐藏
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let closeTimer = null;
function openSheet(html, onMount) {
  clearTimeout(closeTimer); $sheet.classList.remove('closing'); $back.classList.remove('closing');
  $sheet.innerHTML = `<div class="grab"></div>${html}`;
  $sheet.hidden = false; $back.hidden = false;
  document.body.style.overflow = 'hidden';
  $sheet.scrollTop = 0;
  onMount && onMount($sheet);
}
function closeSheet() {
  document.body.style.overflow = '';
  const done = () => { $sheet.hidden = true; $back.hidden = true; $sheet.innerHTML = ''; $sheet.classList.remove('closing'); $back.classList.remove('closing'); };
  clearTimeout(closeTimer);
  if ($sheet.hidden || reduceMotion()) return done();
  $sheet.classList.add('closing'); $back.classList.add('closing');
  closeTimer = setTimeout(done, 180);
}
// 刚改过的那一行闪一下浅色，不在屏幕里就滚过去
function flash(sel) {
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  const r = el.getBoundingClientRect();
  if (r.top < 70 || r.bottom > window.innerHeight - 90) el.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
}
// 一行先滑出淡掉（约 0.22 秒），再继续
function foldAway(el) {
  if (!el || reduceMotion()) return Promise.resolve();
  el.classList.add('fold');
  return new Promise((r) => setTimeout(r, 220));
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
// 看大图。items：同一组的所有图，每项是网址字符串，或 { src, id, note }。
// 切换：左右滑 / 点底部缩略图 / 电脑上点两边箭头或按 ← →。
// 放大：双指捏合、双击（电脑上双击或滚轮），放大后单指拖动；缩回原大小才能左右滑。
// 关闭：✕、点图片外的黑色区域、Esc。
// opts.saveNote(id, note)：传了就能编辑图片备注（保存成功返回新备注）。
const V = { items: [], i: 0, opts: {}, z: null };
function viewImage(items, index = 0, opts = {}) {
  V.items = (Array.isArray(items) ? items : [items]).map((x) => typeof x === 'string' ? { src: x } : x);
  V.i = index; V.opts = opts;
  const many = V.items.length > 1;
  $viewer.innerHTML = `<div class="track">${V.items.map((x) => `<div class="slide"><img src="${esc(x.src)}" alt="图片" draggable="false"></div>`).join('')}</div>
    ${many ? `<div class="count"></div><button class="nav prev" data-step="-1" aria-label="上一张">‹</button><button class="nav next" data-step="1" aria-label="下一张">›</button>` : ''}
    <div class="vbottom"><div class="caption"></div>
      ${many ? `<div class="strip">${V.items.map((x, i) => `<button class="sthumb" data-go="${i}" aria-label="第 ${i + 1} 张"><img src="${esc(x.src)}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}</div>
    <button class="icon-btn close" aria-label="关闭">✕</button>`;
  $viewer.hidden = false;
  const track = $viewer.querySelector('.track');
  track.scrollLeft = index * track.clientWidth;
  track.addEventListener('scroll', () => {
    const i = Math.round(track.scrollLeft / track.clientWidth);
    if (i !== V.i) { V.i = i; viewerSync(); }
  }, { passive: true });
  viewerSync();
  zoomBind(track);
}
function viewerSync() {
  const n = V.items.length, x = V.items[V.i];
  if (n > 1) {
    $viewer.querySelector('.count').textContent = `${V.i + 1} / ${n}`;
    $viewer.querySelector('.prev').hidden = V.i === 0;
    $viewer.querySelector('.next').hidden = V.i === n - 1;
    $viewer.querySelectorAll('.sthumb').forEach((b, i) => b.classList.toggle('on', i === V.i));
    $viewer.querySelector('.sthumb.on')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }
  zoomReset();
  const cap = $viewer.querySelector('.caption');
  const can = V.opts.saveNote && x.id;
  cap.innerHTML = x.note ? `<p class="ctext">${esc(x.note)}</p>${can ? '<button class="cedit" data-note="1">✎ 改备注</button>' : ''}`
    : can ? '<button class="cedit" data-note="1">✎ 加备注</button>' : '';
}
function viewerNoteEdit() {
  const x = V.items[V.i], cap = $viewer.querySelector('.caption');
  cap.innerHTML = `<div class="cform"><textarea maxlength="200" rows="2" placeholder="比如：这张是团购券；左边是小票">${esc(x.note || '')}</textarea>
    <div class="cbtns"><button class="btn small" data-ncancel="1">取消</button><button class="btn primary small" data-nsave="1">保存</button></div></div>`;
  const ta = cap.querySelector('textarea'); ta.focus();
  cap.querySelector('[data-ncancel]').onclick = (e) => { e.stopPropagation(); viewerSync(); };
  cap.querySelector('[data-nsave]').onclick = async (e) => {
    e.stopPropagation(); e.target.disabled = true;
    try { x.note = await V.opts.saveNote(x.id, ta.value.trim()); toast('备注已保存'); viewerSync(); }
    catch (err) { toast(err.message, true); e.target.disabled = false; }
  };
}
function viewerGo(i) {
  const track = $viewer.querySelector('.track');
  if (track && i >= 0 && i < V.items.length) track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' });
}
const viewerStep = (d) => viewerGo(V.i + d);
function closeViewer() { $viewer.hidden = true; $viewer.innerHTML = ''; V.z = null; }
$viewer.addEventListener('click', (e) => {
  if (V.z?.moved) { V.z.moved = false; return; }
  const t = e.target;
  if (t.closest('[data-step]')) return viewerStep(Number(t.closest('[data-step]').dataset.step));
  if (t.closest('[data-go]')) return viewerGo(Number(t.closest('[data-go]').dataset.go));
  if (t.closest('[data-note]')) return viewerNoteEdit();
  if (t.closest('.close') || t.classList.contains('slide') || t.classList.contains('track')) return closeViewer();
});
document.addEventListener('keydown', (e) => {
  if (!$viewer.hidden && e.target.tagName !== 'TEXTAREA' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return viewerStep(e.key === 'ArrowLeft' ? -1 : 1);
  if (e.key !== 'Escape') return;
  if (!$viewer.hidden) return closeViewer();
  if (!$sheet.hidden) closeSheet();
});

// ----- 看大图：缩放 -----
// 当前这张图的 { img, s 倍数, x/y 平移, base 原始位置 }。图片用 transform 放大，左上角为原点。
function zoomReset() {
  const img = $viewer.querySelectorAll('.slide img')[V.i];
  $viewer.querySelectorAll('.slide img').forEach((im) => { im.style.transform = ''; });
  $viewer.classList.remove('zoomed');
  V.z = { img, s: 1, x: 0, y: 0, moved: false };
}
function zoomApply(s, x, y) {
  const z = V.z, b = z.base || (z.base = z.img.getBoundingClientRect());
  const vw = innerWidth, vh = innerHeight, w = b.width * s, h = b.height * s;
  // 放大后不让图片边缘离开屏幕；比屏幕小的方向保持居中
  x = w <= vw ? (vw - w) / 2 - b.left : Math.min(-b.left, Math.max(vw - b.left - w, x));
  y = h <= vh ? (vh - h) / 2 - b.top : Math.min(-b.top, Math.max(vh - b.top - h, y));
  Object.assign(z, { s, x, y });
  z.img.style.transform = s === 1 ? '' : `translate(${x}px, ${y}px) scale(${s})`;
  $viewer.classList.toggle('zoomed', s > 1);
}
// 以屏幕上 (px, py) 这个点为中心缩放到 s 倍
function zoomAt(s, px, py, from = V.z) {
  s = Math.min(5, Math.max(1, s));
  const b = V.z.base || (V.z.base = V.z.img.getBoundingClientRect());
  const ux = (px - b.left - from.x) / from.s, uy = (py - b.top - from.y) / from.s;
  zoomApply(s, px - b.left - ux * s, py - b.top - uy * s);
}
function zoomBind(track) {
  let g = null, lastTap = 0, lastTouch = 0;
  track.addEventListener('gesturestart', (e) => e.preventDefault());   // iOS：不让整个页面跟着缩放
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
  track.addEventListener('touchstart', (e) => {
    lastTouch = Date.now();
    if (!e.target.closest('.slide img') && V.z.s === 1) return;
    const t = e.touches, z = V.z;
    if (z.s === 1) z.base = null;
    if (t.length === 2) { const [mx, my] = mid(t); g = { pinch: true, d: dist(t), mx, my, from: { s: z.s, x: z.x, y: z.y } }; }
    else if (t.length === 1) g = { pinch: false, sx: t[0].clientX, sy: t[0].clientY, from: { s: z.s, x: z.x, y: z.y } };
  }, { passive: true });
  track.addEventListener('touchmove', (e) => {
    if (!g) return;
    const t = e.touches, z = V.z;
    if (g.pinch && t.length === 2) {
      e.preventDefault(); z.moved = true;
      const [mx, my] = mid(t);
      zoomAt(g.from.s * dist(t) / g.d, g.mx, g.my, g.from);
      zoomApply(z.s, z.x + mx - g.mx, z.y + my - g.my);
    } else if (!g.pinch && t.length === 1 && z.s > 1) {
      e.preventDefault(); z.moved = true;
      zoomApply(z.s, g.from.x + t[0].clientX - g.sx, g.from.y + t[0].clientY - g.sy);
    }
  }, { passive: false });
  track.addEventListener('touchend', (e) => {
    if (!g) return;
    const z = V.z;
    if (!g.pinch && e.changedTouches.length === 1 && !z.moved) {
      // 双击：在 300ms 内点两下同一处
      const now = Date.now(), c = e.changedTouches[0];
      if (now - lastTap < 300) {
        e.preventDefault();
        if (z.s > 1) zoomApply(1, 0, 0); else { z.base = null; zoomAt(2.5, c.clientX, c.clientY); }
        lastTap = 0;
      } else lastTap = now;
    }
    if (z.s < 1.05) zoomApply(1, 0, 0);
    if (!e.touches.length) { g = null; setTimeout(() => { if (V.z) V.z.moved = false; }, 0); }
    else if (e.touches.length === 1 && z.s > 1) g = { pinch: false, sx: e.touches[0].clientX, sy: e.touches[0].clientY, from: { s: z.s, x: z.x, y: z.y } };
  });
  // 电脑：双击放大 / 还原，滚轮缩放，放大后按住拖动
  track.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.slide img') || Date.now() - lastTouch < 1000) return;   // 手机上已经在 touchend 里处理过
    const z = V.z;
    if (z.s > 1) zoomApply(1, 0, 0); else { z.base = null; zoomAt(2.5, e.clientX, e.clientY); }
  });
  track.addEventListener('wheel', (e) => {
    if (!e.target.closest('.slide img') && V.z.s === 1) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;   // 触控板横向滑动 = 切换图片
    e.preventDefault();
    if (V.z.s === 1) V.z.base = null;
    zoomAt(V.z.s * Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
  }, { passive: false });
  track.addEventListener('mousedown', (e) => {
    const z = V.z; if (z.s === 1 || e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, fx = z.x, fy = z.y;
    const mv = (m) => { z.moved = true; zoomApply(z.s, fx + m.clientX - sx, fy + m.clientY - sy); };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); setTimeout(() => { z.moved = false; }, 0); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  });
}

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
    if (S.key !== m[1]) { S.key = m[1]; S.tab = 'bills'; S.trip = null; S.billFilter = 'all'; S.openDays = null; }
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
    html += `<a class="trip" href="/t/${esc(t.key)}" data-tid="${t.id}" data-link>
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
      try {
        await api('POST', `/api/admin/trips/${b.dataset.tr}/restore`); toast('已恢复');
        await foldAway(b.closest('.mem')); closeSheet();
        await renderAdmin(); flash(`.trip[data-tid="${b.dataset.tr}"]`);
      }
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

// 其他页的一行摘要：我还要付 / 还应收回
function heroMine(me) {
  if (!me) return `<span>${T().transfers.length ? `待转账 <b class="num">${T().transfers.length}</b> 笔` : '已全部结清'}</span>`;
  const b = balOf(me.id);
  return `<span>${b.net > 0 ? `我还应收回 <b class="num">${money(b.net)}</b>` : b.net < 0 ? `我还要付 <b class="num">${money(-b.net)}</b>` : '我已结清'}</span>`;
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
    ${S.tab === 'bills' ? `<div class="hero">
      <div class="label">一共花了</div>
      <div class="big num">${money(total)}</div>
      <div class="meta">${range(t)} · ${d.members.length} 人${t.base !== 'CNY' ? ` · ${BN()}结算${t.toCny ? `，约合人民币 ${curMoney('CNY', Math.round(total * t.toCny))}` : ''}` : ''}</div>
      <div class="row">${mine}</div>
    </div>` : `<div class="hero mini"><span>共 <b class="num">${money(total)}</b></span>${heroMine(me)}</div>`}
    ${t.locked ? `<div class="banner lock">🔒<span class="sp">账单已锁定${t.lockedAt ? '（' + fmtTime(t.lockedAt) + '）' : ''}，只能查看${S.admin ? '' : '。需要改的话请找管理员解锁'}</span></div>` : ''}
    <div id="tab-body"></div>
  </div>
  <nav class="tabbar"><div class="in">${tabs.map(([k, i, n], j) => (j === 2 && editable() ? '<button class="tab-add" id="fab" aria-label="记一笔"><span>＋</span>记一笔</button>' : '')
    + `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}"><span class="i">${i}</span>${n}</button>`).join('')}</div></nav>`;
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
    body.innerHTML = `<div class="empty"><div class="e">🧾</div>还没有账目<br><span class="small">谁付了钱，就点下面的「＋ 记一笔」</span></div>`;
    return;
  }
  // 账多了（≥6 笔）才显示筛选。第一行按人：全部 / 我参与的 / 我付的 / 某某付的；第二行按大类（只列出用到的）
  let html = '', list = d.expenses;
  const many = d.expenses.length >= 6;
  let fl = 'all';
  if (many) {
    const people = [['all', '全部']];
    if (S.me) people.push(['mine', '我参与的']);
    const payers = d.members.filter((m) => d.expenses.some((e) => e.payerId === m.id))
      .sort((a, b) => (b.id === S.me) - (a.id === S.me));
    for (const m of payers) people.push([`p${m.id}`, m.id === S.me ? '我付的' : `${esc(m.name)} 付的`]);
    const cats = [];
    for (const g of GROUPS) if (d.expenses.some((e) => groupOf(e.category) === g.key)) cats.push([g.key, `${g.icon} ${g.name}`]);
    if (![...people, ...cats].some(([k]) => k === S.billFilter)) S.billFilter = 'all';
    fl = S.billFilter || 'all';
    const pay = /^p(\d+)$/.exec(fl);
    list = fl === 'all' ? list : pay ? list.filter((e) => e.payerId === Number(pay[1]))
      : fl === 'mine' ? list.filter((e) => e.shares.some((s) => s.memberId === S.me)) : list.filter((e) => groupOf(e.category) === fl);
    const chips = (o) => `<div class="filter-row">${o.map(([k, n]) => `<button class="chip small-chip ${fl === k ? 'on' : ''}" data-f="${k}">${n}</button>`).join('')}</div>`;
    html += chips(people) + (cats.length > 1 ? chips(cats) : '');
    if (fl !== 'all') html += `<p class="muted small" style="margin:0 4px 8px">${list.length} 笔，共 <b class="num">${money(list.reduce((a, e) => a + e.cents, 0))}</b>${fl === 'mine' ? `，我的部分 <b class="num">${money(list.reduce((a, e) => a + (e.shares.find((s) => s.memberId === S.me)?.cents || 0), 0))}</b>` : ''}</p>`;
  }
  const groups = new Map();
  for (const e of list) { if (!groups.has(e.day)) groups.set(e.day, []); groups.get(e.day).push(e); }
  // 按天折叠：账多（≥6 笔）、不筛选、不止一天时，只展开最近一天，其他天收成一行摘要，点开看明细
  const fold = many && fl === 'all' && groups.size > 1;
  if (fold) {
    if (!S.openDays) S.openDays = new Set([[...groups.keys()][0]]);
    if (S.flashExp) { const fe = d.expenses.find((e) => e.id === S.flashExp); if (fe) S.openDays.add(fe.day); }
    const allOpen = [...groups.keys()].every((k) => S.openDays.has(k));
    html += `<div class="fold-all"><button class="link-btn" data-foldall="${allOpen ? 0 : 1}">${allOpen ? '全部收起' : '全部展开'}</button></div>`;
  }
  for (const [day, list] of groups) {
    const sum = list.reduce((a, e) => a + e.cents, 0);
    if (fold && !S.openDays.has(day)) {
      const who = [...new Set(list.map((e) => nameOf(e.payerId)))];
      html += `<button class="day-fold" data-day="${day}"><span class="main"><span class="t">${md(day)} ${wk(day)}</span>
        <span class="s">${list.length} 笔 · ${esc(who.slice(0, 3).join('、'))}${who.length > 3 ? ` 等 ${who.length} 人` : ''}付</span></span>
        <b class="num">${money(sum)}</b><span class="chev" aria-hidden="true">›</span></button>`;
      continue;
    }
    html += fold
      ? `<button class="day-head open" data-day="${day}"><span>${md(day)} ${wk(day)} <span class="chev" aria-hidden="true">›</span></span><span class="num">${money(sum)}</span></button><div class="list">`
      : `<div class="day-head"><span>${md(day)} ${wk(day)}</span><span class="num">${money(sum)}</span></div><div class="list">`;
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
  body.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { S.billFilter = b.dataset.f; renderBills(body); });
  body.querySelectorAll('[data-day]').forEach((b) => b.onclick = () => {
    const k = b.dataset.day; S.openDays.has(k) ? S.openDays.delete(k) : S.openDays.add(k); renderBills(body);
  });
  body.querySelectorAll('[data-foldall]').forEach((b) => b.onclick = () => {
    S.openDays = new Set(b.dataset.foldall === '1' ? groups.keys() : []); renderBills(body);
  });
  if (S.flashExp) { const id = S.flashExp; S.flashExp = null; requestAnimationFrame(() => flash(`[data-exp="${id}"]`)); }
}

// 除不尽时说明精确金额：单笔里零头先记给一个人（这样这笔加起来正好等于总额），结算时按精确值合计、最后四舍五入
function exactNote(e) {
  const ex = exactShares(e);
  if (ex.every((x) => x.n % x.d === 0n)) return '';
  const fmt = (x) => { const v = Number(x.n) / Number(x.d) / 100, t = Math.round(v * 1000) / 1000; return (Math.abs(v - t) > 1e-9 ? '约 ' : '') + t.toFixed(3).replace(/0$/, ''); };
  return `<p class="faint tiny" style="margin:8px 0 0">这笔除不尽，精确是 ${ex.map((x) => `${esc(nameOf(x.memberId))} ${fmt(x)}`).join('，')}。结算时按精确金额合计，最后四舍五入到分。</p>`;
}
function expenseDetail(id) {
  const e = T().expenses.find((x) => x.id === id);
  if (!e) return;
  const notes = e.imageNotes || {};
  const imgs = e.images.map((i) => `<button class="thumb" data-img="${i}"><img src="/api/t/${S.key}/images/${i}" alt="截图" loading="lazy">${notes[i] ? `<span class="tnote">${esc(notes[i])}</span>` : ''}</button>`).join('');
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
      ${exactNote(e)}
    </div>
    ${e.note ? `<div class="section-title"><span>备注</span></div><div class="note-box">${esc(e.note)}</div>` : ''}
    ${e.images.length ? `<div class="section-title"><span>截图</span></div><div class="thumbs">${imgs}</div>` : ''}
    <p class="faint tiny" style="margin:14px 2px">${esc(e.createdBy || '未署名')} 记于 ${fmtTime(e.createdAt)}${e.updatedAt && new Date(e.updatedAt) - new Date(e.createdAt) > 2000 ? ` · 修改于 ${fmtTime(e.updatedAt)}` : ''}</p>
    ${editable() ? `<div class="btns"><button class="btn danger" id="ed-del">删除</button><button class="btn primary" id="ed-edit">修改</button></div>` : ''}`, (el) => {
    el.querySelectorAll('[data-img]').forEach((b, i) => b.onclick = () => viewImage(
      e.images.map((id) => ({ src: `/api/t/${S.key}/images/${id}`, id, note: notes[id] || '' })), i,
      editable() ? { saveNote: async (id, note) => { await api('PATCH', `/api/t/${S.key}/images/${id}`, { note }); await refresh(); if (!$sheet.hidden) expenseDetail(e.id); return note; } } : {}));
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
    <div class="field"><div class="lab">类别</div><div id="f-cat"></div></div>
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
      // 平时只显示结算币种 + 这次游玩用过的币种，其他的收在「更多币种」里
      const used = new Set([BASE, f.currency, ...d.expenses.map((x) => x.currency)]);
      const list = f.allCur ? CURS : CURS.filter((c) => used.has(c.key));
      $('#f-cur').innerHTML = list.map((c) => `<button type="button" class="chip small-chip ${f.currency === c.key ? 'on' : ''}" data-cur="${c.key}">${c.short}</button>`).join('')
        + (list.length < CURS.length ? '<button type="button" class="chip small-chip more-chip" data-more="1">更多币种 ▾</button>' : '');
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
    const drawCats = () => {
      const g = groupOf(f.category), subs = CATS.filter((c) => c.g === g);
      $('#f-cat').innerHTML = `<div class="cat-groups">${GROUPS.map((G) => `<button type="button" class="${G.key === g ? 'on' : ''}" data-g="${G.key}"><span class="i">${G.icon}</span>${G.name}</button>`).join('')}</div>`
        + (subs.length > 1 ? `<div class="chips cat-subs">${subs.map((c) => `<button type="button" class="chip small-chip ${f.category === c.key ? 'on' : ''}" data-c="${c.key}">${c.icon} ${c.name}</button>`).join('')}</div>` : '');
    };
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
    $('#f-cur').onclick = (e) => {
      if (e.target.closest('[data-more]')) { f.allCur = true; return drawCur(); }
      const b = e.target.closest('[data-cur]'); if (b) { f.currency = b.dataset.cur; drawCur(); }
    };

    $('#f-amount').oninput = preview;
    $('#f-cat').onclick = (e) => {
      const b = e.target.closest('[data-c],[data-g]'); if (!b) return;
      if (b.dataset.c) f.category = b.dataset.c;
      else if (groupOf(f.category) !== b.dataset.g) f.category = CATS.find((c) => c.g === b.dataset.g).key;
      drawCats();
    };
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
      if (v) { const all = [...$('#f-imgs').querySelectorAll('[data-view]')]; return viewImage(all.map((x) => x.dataset.view), all.indexOf(v)); }
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
        S.tab = 'bills'; S.billFilter = 'all';
        await refresh();
        flash(`[data-exp="${res.id}"]`);
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
        return `<div class="xfer ${mine ? 'me' : ''}" data-ft="${x.fromId}-${x.toId}"><div class="who" data-remind="${i}" role="button" tabindex="0" title="复制提醒文字"><b>${esc(nameOf(x.fromId))}</b><span class="arrow">→</span><b>${esc(nameOf(x.toId))}</b><div class="amt num">${money(x.cents)}</div></div>
          <div class="acts"><button class="btn small" data-remind="${i}">催款</button>${hasCode ? `<button class="btn small" data-code="${x.toId}">收款码</button>` : ''}${editable() ? `<button class="btn small primary" data-paid="${i}">已转</button>` : ''}</div></div>`;
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
    <p class="faint tiny" style="margin:10px 0 0">垫付 = 替大家付的钱；应摊 = 自己该承担的部分；结果 = 垫付 − 应摊，再扣除「已转账」的金额${d.balances.some((b) => !Number.isInteger(b.share)) ? '。<br>有的账除不尽（比如 31.95 两人分，每人 15.975），应摊显示的是精确值，结果四舍五入到分' : ''}</p></div>`;
  if (d.payments.length) {
    html += `<div class="card"><h2>已转账</h2>${d.payments.slice().reverse().map((p) => `<div class="kv" data-pay="${p.id}"><span>✓ ${esc(nameOf(p.fromId))} → ${esc(nameOf(p.toId))} <span class="faint tiny">${fmtTime(p.createdAt)}</span></span>
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
        const pr = await api('POST', `/api/t/${S.key}/payments`, { fromId: x.fromId, toId: x.toId, amount: el.querySelector('#pd-amt').value.trim() });
        closeSheet(); toast('已标记');
        await foldAway(document.querySelector(`.xfer[data-ft="${x.fromId}-${x.toId}"]`));
        await refresh();
        flash(`[data-pay="${pr.id}"]`);
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
  // 长图里按大类（最多 6 个），不会太长
  const cats = groupCats(d.expenses.map((e) => ({ key: e.category, cents: e.cents }))).map((x) => ({ icon: x.g.icon, name: x.g.name, cents: x.cents }));
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
  const groups = groupCats(list), gmax = Math.max(1, ...groups.map((x) => x.cents));
  return groups.map((x) => {
    const pct = Math.round((x.cents / total) * 100);
    return `<div class="hbar" title="${x.g.name}：${money(x.cents)}（${pct}%）"><div class="lab"><span>${x.g.icon} ${x.g.name}</span><span class="num">${money(x.cents)} · ${pct}%</span></div>
      <div class="track"><div class="fill" style="width:${(x.cents / gmax) * 100}%"></div></div>
      ${showSubs(x) ? `<div class="hbar-subs">${x.subs.map((c) => `<span>${CAT[c.key].name} <span class="num">${money(c.cents)}</span></span>`).join('')}</div>` : ''}</div>`;
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
  let html = `<div class="tiles tiles-3">
    <div class="tile"><div class="l">人均</div><div class="v num">${money(Math.round(total / sharers))}</div></div>
    <div class="tile"><div class="l">${span > 1 ? `${span} 天·日均` : '天数'}</div><div class="v num">${span > 1 ? money(Math.round(total / span)) : '1<small> 天</small>'}</div></div>
    <div class="tile"><div class="l">笔数</div><div class="v num">${d.expenses.length}<small> 笔</small></div></div></div>`;

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
    el.querySelectorAll('[data-view]').forEach((x, i, all) => x.onclick = () => viewImage([...all].map((y) => `/api/t/${S.key}/paycode/${id}/${y.dataset.view}?v=${m.codes[y.dataset.view]}`), i));
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
      try {
        const r2 = await api('POST', `/api/t/${S.key}/trash/${b.dataset.restore}/restore`);
        toast(r2.expenseId ? '已恢复，回到账单可以看到' : '已恢复');
        S.flashExp = r2.expenseId || null; S.billFilter = 'all';
        await foldAway(b.closest('.mem'));
        await refresh(); trashSheet();
      }
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
