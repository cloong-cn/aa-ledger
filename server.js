'use strict';
// AA 账本服务：Node 内置 http + pg。只监听本机，由 nginx 反代。
// 朋友凭分享链接（/t/<key>）访问某次游玩；管理员用账号密码登录管理所有游玩。
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { settle, splitExpense, unitOf, roundTo } = require('./public/settle');
const { buildXlsx } = require('./xlsx');

const PORT = Number(process.env.PORT || 8792);
const HOST = '127.0.0.1';
const TZ = 'Asia/Shanghai';
const SESSION_DAYS = 30;
const UPLOADS = process.env.UPLOADS || '/srv/aa/uploads';
const MAX_IMAGE = 6 * 1024 * 1024;
const MAX_IMAGES_PER_EXPENSE = 9;
const MAX_CENTS = 1e9;          // 单笔上限（数据库 int 列能放下 21 亿分）
const TRASH_DAYS = 30;         // 删除的东西保留多少天
const BACKUPS = process.env.BACKUPS || '/srv/aa/backups';

const db = new Pool({ host: process.env.PGHOST || '/var/run/postgresql', database: process.env.PGDATABASE || 'aa', max: 5 });

// ---------- 工具 ----------
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function validDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
// "12.5" -> 1250；非法返回 null。allowZero 用于"指定金额 0 元"
function parseAmount(v, allowZero = false) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  const cents = Number(i) * 100 + Number((f + '00').slice(0, 2));
  if (cents === 0 && !allowZero) return null;
  return cents;
}
// 份数：0~99，最多两位小数
function parseWeight(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return null;
  return Number(s);
}
function cleanText(v, max) {
  return String(v ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
}
const CATEGORIES = { food: '餐饮', transport: '交通', lodging: '住宿', ticket: '门票', fun: '娱乐', shopping: '购物', other: '其他' };
// 支持的币种。每次游玩选一个结算币种（默认人民币），其他币种按汇率折算成它
const CURRENCIES = {
  CNY: { name: '人民币', sym: '¥' }, HKD: { name: '港币', sym: 'HK$' }, TWD: { name: '新台币', sym: 'NT$' },
  JPY: { name: '日元', sym: 'JP¥' }, SGD: { name: '新加坡元', sym: 'S$' }, MYR: { name: '马来西亚令吉', sym: 'RM' },
  AUD: { name: '澳元', sym: 'A$' }, USD: { name: '美元', sym: 'US$' },
};
// 市场参考汇率（open.er-api.com，免费、无需密钥，每天更新）。缓存 6 小时，拿不到就用旧的
let fxPending = null;
async function cachedRates() {
  const { rows } = await db.query(`SELECT currency, rate::float AS rate, source_at, fetched_at FROM fx_cache`);
  return {
    rates: Object.fromEntries(rows.map((r) => [r.currency, r.rate])),
    at: rows.reduce((a, r) => (!a || r.source_at > a ? r.source_at : a), null),
    stale: !rows.length || rows.some((r) => Date.now() - new Date(r.fetched_at) > 6 * 3600e3),
  };
}
async function refreshRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/CNY', { signal: AbortSignal.timeout(5000) });
    const d = await res.json();
    if (d.result !== 'success') throw new Error('fx ' + d.result);
    const at = new Date(d.time_last_update_unix * 1000);
    for (const cur of Object.keys(CURRENCIES)) {
      if (cur === 'CNY' || !(d.rates[cur] > 0)) continue;
      await db.query(`INSERT INTO fx_cache(currency,rate,source_at,fetched_at) VALUES($1,$2,$3,now())
        ON CONFLICT (currency) DO UPDATE SET rate=EXCLUDED.rate, source_at=EXCLUDED.source_at, fetched_at=now()`,
        [cur, Number((1 / d.rates[cur]).toFixed(8)), at]);
    }
  } catch (e) { console.error('拿汇率失败：', e.message); }
}
async function liveRates() {
  const c = await cachedRates();
  if (!c.stale) return { rates: c.rates, at: c.at };
  await (fxPending ||= refreshRates().finally(() => { fxPending = null; }));
  const n = await cachedRates();
  return { rates: n.rates, at: n.at };
}
const fmtY = (c) => '¥' + (c / 100).toFixed(c % 100 ? 2 : 0);
// 交叉汇率：1 单位 from 折合多少 to（市场汇率缓存里都是"折合人民币"）
function crossRate(live, from, to) {
  if (from === to) return 1;
  const f = from === 'CNY' ? 1 : live.rates[from], t = to === 'CNY' ? 1 : live.rates[to];
  return f && t ? Number((f / t).toFixed(8)) : null;
}
// 结算币种 → 人民币的折算系数（年度统计用）：优先用这次游玩里设定的人民币汇率，否则用市场汇率
function toCnyFactor(base, tripRates, live) {
  if (base === 'CNY') return 1;
  const r = tripRates.find((x) => x.currency === 'CNY');
  if (r) return 1 / r.rate;
  return crossRate(live, base, 'CNY') || 0;
}
const newKey = () => crypto.randomBytes(16).toString('base64url'); // 22 位

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);

async function tx(fn) {
  const c = await db.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}
// 改某次游玩的数据都走这里：先锁住这次游玩那一行（FOR UPDATE），同一次游玩的修改一个一个排队执行，
// 避免两个人同时改汇率 / 结算币种 / 记账时互相覆盖算错。锁住后重新读一遍状态（是否锁定、结算币种）
async function tripTx(trip, fn, { open = true } = {}) {
  return tx(async (q) => {
    const { rows: [t] } = await q.query(`SELECT locked, base_currency, deleted_at FROM trips WHERE id=$1 FOR UPDATE`, [trip.id]);
    if (!t || t.deleted_at) throw new HttpError(404, '这次游玩不存在（可能已被删除）');
    trip.locked = t.locked; trip.base_currency = t.base_currency;
    if (open) assertOpen(trip);
    return fn(q);
  });
}

// ---------- 图片 ----------
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}
function saveImage(buf) {
  const t = sniffImage(buf);
  if (!t) throw bad('只支持 JPG / PNG / WebP 图片');
  const file = `${crypto.randomBytes(16).toString('hex')}.${t.ext}`;
  fs.writeFileSync(path.join(UPLOADS, file), buf, { mode: 0o640 });
  return { file, mime: t.mime, bytes: buf.length };
}
function removeFiles(files) {
  for (const f of files) if (/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(f)) fs.unlink(path.join(UPLOADS, f), () => {});
}

// ---------- 管理员会话 ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
async function currentAdmin(req) {
  const token = parseCookies(req).aa_session;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const { rows: [a] } = await db.query(`
    SELECT a.id, a.username, s.expires_at < now() + interval '${SESSION_DAYS - 1} days' AS stale
    FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token=$1 AND s.expires_at > now()`, [sha(token)]);
  if (!a) return null;
  if (a.stale) {
    await db.query(`UPDATE sessions SET expires_at = now() + $2::interval WHERE token=$1`, [sha(token), `${SESSION_DAYS} days`]);
    a.renewToken = token;
  }
  return a;
}
const sessionCookie = (token, maxAge) => `aa_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const clientIp = (req) => String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');

// ---------- 路由 ----------
// :key = 分享密钥，:kind = wechat|alipay，其余 :xxx 为正整数
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => {
    keys.push(k);
    return k === 'key' ? '([A-Za-z0-9_-]{16,32})' : k === 'kind' ? '(wechat|alipay)' : k === 'cur' ? '([A-Z]{3})' : '(\\d{1,9})';
  }) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth || 'none', raw: !!opts.raw });
}

// ---------- 登录 ----------
route('POST', '/api/login', async ({ body, req, res }) => {
  const username = cleanText(body.username, 40).toLowerCase();
  const key = `${username}|${clientIp(req)}`;
  const { rows: [fail] } = await db.query(`SELECT count FROM login_fails WHERE key=$1 AND first_at > now() - interval '15 minutes'`, [key]);
  if (fail && fail.count >= 8) throw new HttpError(429, '尝试次数太多，请 15 分钟后再试');
  const { rows: [a] } = await db.query(`SELECT * FROM admins WHERE username=$1`, [username]);
  const ok = checkPassword(String(body.password ?? '').slice(0, 200), a ? a.pw_hash : DUMMY_HASH) && a;
  if (!ok) {
    await db.query(`
      INSERT INTO login_fails(key,count,first_at) VALUES($1,1,now())
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN login_fails.first_at > now() - interval '15 minutes' THEN login_fails.count+1 ELSE 1 END,
        first_at = CASE WHEN login_fails.first_at > now() - interval '15 minutes' THEN login_fails.first_at ELSE now() END`, [key]);
    throw new HttpError(401, '用户名或密码不对');
  }
  await db.query(`DELETE FROM login_fails WHERE key=$1`, [key]);
  const token = crypto.randomBytes(32).toString('hex');
  await db.query(`INSERT INTO sessions(token,admin_id,expires_at) VALUES($1,$2,now() + $3::interval)`, [sha(token), a.id, `${SESSION_DAYS} days`]);
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
  return { ok: true };
});
route('POST', '/api/logout', async ({ req, res }) => {
  const token = parseCookies(req).aa_session;
  if (token) await db.query(`DELETE FROM sessions WHERE token=$1`, [sha(token)]);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  return { ok: true };
});
route('GET', '/api/me', async ({ admin }) => ({ admin: admin ? { username: admin.username } : null, today: todayStr() }));
route('POST', '/api/password', async ({ admin, body }) => {
  const { rows: [a] } = await db.query(`SELECT pw_hash FROM admins WHERE id=$1`, [admin.id]);
  if (!checkPassword(String(body.old ?? ''), a.pw_hash)) throw bad('原密码不对');
  const pw = String(body.new ?? '');
  if (pw.length < 6 || pw.length > 100) throw bad('新密码至少 6 位');
  await db.query(`UPDATE admins SET pw_hash=$1 WHERE id=$2`, [hashPassword(pw), admin.id]);
  return { ok: true };
}, { auth: 'admin' });

// ---------- 游玩数据 ----------
async function loadTrip(key) {
  const { rows: [t] } = await db.query(`SELECT *, to_char(start_day,'YYYY-MM-DD') AS start_s, to_char(end_day,'YYYY-MM-DD') AS end_s FROM trips WHERE key=$1 AND deleted_at IS NULL`, [key]);
  if (!t) throw new HttpError(404, '链接无效：这次游玩不存在，或者链接已被重置');
  return t;
}
function assertOpen(trip) { if (trip.locked) throw new HttpError(423, '账单已锁定，不能再修改'); }

async function tripPayload(trip, admin) {
  const [{ rows: members }, { rows: exps }, { rows: shares }, { rows: imgs }, { rows: pays }, { rows: codes }, { rows: rates }] = await Promise.all([
    db.query(`SELECT m.id, m.person_id, p.name, m.weight::float AS weight FROM members m JOIN people p ON p.id=m.person_id WHERE m.trip_id=$1 ORDER BY m.id`, [trip.id]),
    db.query(`SELECT id, payer_id, cents, currency, orig_cents, rate::float AS rate, cny_override, category, title, note, to_char(day,'YYYY-MM-DD') AS day, created_by, created_at, updated_at FROM expenses WHERE trip_id=$1 ORDER BY day DESC, id DESC`, [trip.id]),
    db.query(`SELECT s.expense_id, s.member_id, s.weight::float AS weight, s.fixed_cents, s.orig_cents, s.cents FROM expense_shares s JOIN expenses e ON e.id=s.expense_id WHERE e.trip_id=$1 ORDER BY s.member_id`, [trip.id]),
    db.query(`SELECT i.id, i.expense_id FROM images i JOIN expenses e ON e.id=i.expense_id WHERE e.trip_id=$1 ORDER BY i.id`, [trip.id]),
    db.query(`SELECT id, from_id, to_id, cents, created_by, created_at FROM payments WHERE trip_id=$1 ORDER BY id`, [trip.id]),
    db.query(`SELECT c.person_id, c.kind, c.updated_at FROM pay_codes c JOIN members m ON m.person_id=c.person_id WHERE m.trip_id=$1`, [trip.id]),
    db.query(`SELECT currency, rate::float AS rate, updated_at FROM trip_rates WHERE trip_id=$1`, [trip.id]),
  ]);
  const base = trip.base_currency;
  const live = await liveRates();
  const byExp = new Map(exps.map((e) => [e.id, { shares: [], images: [] }]));
  for (const s of shares) byExp.get(s.expense_id)?.shares.push({ memberId: s.member_id, weight: s.weight, fixed: s.fixed_cents, origCents: s.orig_cents, cents: s.cents });
  for (const i of imgs) byExp.get(i.expense_id)?.images.push(i.id);
  const expenses = exps.map((e) => ({
    id: e.id, payerId: e.payer_id, cents: e.cents, currency: e.currency, origCents: e.orig_cents, rate: e.rate, baseOverride: e.cny_override, category: e.category, title: e.title, note: e.note, day: e.day,
    createdBy: e.created_by, createdAt: e.created_at, updatedAt: e.updated_at, ...byExp.get(e.id),
  }));
  const payments = pays.map((p) => ({ id: p.id, fromId: p.from_id, toId: p.to_id, cents: p.cents, createdBy: p.created_by, createdAt: p.created_at }));
  const { balances, transfers } = settle(members.map((m) => m.id), expenses, payments);
  const codeMap = {};
  for (const c of codes) (codeMap[c.person_id] ||= {})[c.kind] = new Date(c.updated_at).getTime();
  return {
    trip: { id: trip.id, name: trip.name, startDay: trip.start_s, endDay: trip.end_s, note: trip.note, locked: trip.locked, lockedAt: trip.locked_at,
      base, toCny: toCnyFactor(base, rates, live) },
    members: members.map((m) => ({ id: m.id, name: m.name, weight: m.weight, codes: codeMap[m.person_id] || {} })),
    expenses, payments, balances, transfers,
    rates: Object.fromEntries(rates.map((r) => [r.currency, { rate: r.rate, updatedAt: r.updated_at }])),
    // 市场参考汇率（已换算成"1 单位 X = ? 结算币种"）
    fx: { at: live.at, rates: Object.fromEntries(Object.keys(CURRENCIES).filter((c) => c !== base).map((c) => [c, crossRate(live, c, base)]).filter(([, r]) => r)) },
    currencies: CURRENCIES,
    isAdmin: !!admin, today: todayStr(), categories: CATEGORIES,
  };
}

// 操作人：前端在请求头 X-Actor 里带上"我是谁"的成员 id
async function actorName(q, trip, req, admin) {
  const id = Number(req.headers['x-actor']);
  if (id > 0 && id < 2147483647) {
    const { rows: [m] } = await q.query(`SELECT p.name FROM members m JOIN people p ON p.id=m.person_id WHERE m.id=$1 AND m.trip_id=$2`, [id, trip.id]);
    if (m) return m.name;
  }
  return admin ? '管理员' : '未署名';
}
const log = (q, tripId, actor, action, detail) =>
  q.query(`INSERT INTO audit(trip_id,actor,action,detail) VALUES($1,$2,$3,$4)`, [tripId, actor, action, detail]);

async function memberMap(q, tripId) {
  const { rows } = await q.query(`SELECT m.id, p.name, m.person_id FROM members m JOIN people p ON p.id=m.person_id WHERE m.trip_id=$1`, [tripId]);
  return new Map(rows.map((r) => [r.id, r]));
}

route('GET', '/api/t/:key', async ({ params, admin }) => tripPayload(await loadTrip(params.key), admin));

route('PATCH', '/api/t/:key', async ({ params, body, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  const name = cleanText(body.name, 40);
  if (!name) throw bad('名称不能为空');
  if (!validDay(body.startDay)) throw bad('开始日期不对');
  const end = body.endDay ? body.endDay : null;
  if (end && (!validDay(end) || end < body.startDay)) throw bad('结束日期不对');
  const note = cleanText(body.note, 500);
  await tripTx(trip, async (q) => {
    await q.query(`UPDATE trips SET name=$1,start_day=$2,end_day=$3,note=$4 WHERE id=$5`, [name, body.startDay, end, note, trip.id]);
    await log(q, trip.id, await actorName(q, trip, req, admin), 'trip.edit', `修改了游玩信息：${name}，${body.startDay}${end ? ' ~ ' + end : ''}`);
  });
  return { ok: true };
});

// ---------- 成员 ----------
async function findOrCreatePerson(q, name) {
  await q.query(`INSERT INTO people(name) VALUES($1) ON CONFLICT (name) DO NOTHING`, [name]);
  return (await q.query(`SELECT id FROM people WHERE name=$1`, [name])).rows[0].id;
}
route('POST', '/api/t/:key/members', async ({ params, body, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  const name = cleanText(body.name, 20);
  if (!name) throw bad('请输入名字');
  const weight = body.weight == null ? 1 : parseWeight(body.weight);
  if (!weight) throw bad('份数要大于 0');
  return tripTx(trip, async (q) => {
    const pid = await findOrCreatePerson(q, name);
    const { rows: [m] } = await q.query(`INSERT INTO members(trip_id,person_id,weight) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [trip.id, pid, weight]);
    if (!m) throw bad(`${name} 已经在名单里了`);
    const { rows: [{ n }] } = await q.query(`SELECT count(*)::int AS n FROM members WHERE trip_id=$1`, [trip.id]);
    if (n > 50) throw bad('一次游玩最多 50 人');
    await log(q, trip.id, await actorName(q, trip, req, admin), 'member.add', `添加了成员 ${name}${weight !== 1 ? `（${weight} 份）` : ''}`);
    return { id: m.id };
  });
});
route('PATCH', '/api/t/:key/members/:id', async ({ params, body, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  const weight = parseWeight(body.weight);
  if (!weight) throw bad('份数要大于 0');
  await tripTx(trip, async (q) => {
    const mm = await memberMap(q, trip.id);
    const m = mm.get(params.id);
    if (!m) throw new HttpError(404, '成员不存在');
    await q.query(`UPDATE members SET weight=$1 WHERE id=$2`, [weight, m.id]);
    await log(q, trip.id, await actorName(q, trip, req, admin), 'member.edit', `把 ${m.name} 的默认份数改为 ${weight}`);
  });
  return { ok: true };
});
route('DELETE', '/api/t/:key/members/:id', async ({ params, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  await tripTx(trip, async (q) => {
    const m = (await memberMap(q, trip.id)).get(params.id);
    if (!m) throw new HttpError(404, '成员不存在');
    const { rows: [{ used }] } = await q.query(`SELECT
      EXISTS(SELECT 1 FROM expenses WHERE payer_id=$1) OR EXISTS(SELECT 1 FROM expense_shares WHERE member_id=$1)
      OR EXISTS(SELECT 1 FROM payments WHERE from_id=$1 OR to_id=$1) AS used`, [m.id]);
    if (used) throw bad(`${m.name} 已经有账目了，不能移除。先把相关账目改掉再试`);
    await q.query(`DELETE FROM members WHERE id=$1`, [m.id]);
    await log(q, trip.id, await actorName(q, trip, req, admin), 'member.remove', `移除了成员 ${m.name}`);
  });
  return { ok: true };
});

// 收款码：挂在"人"身上，所有游玩共用
async function codeMember(trip, id) {
  const { rows: [m] } = await db.query(`SELECT m.person_id, p.name FROM members m JOIN people p ON p.id=m.person_id WHERE m.id=$1 AND m.trip_id=$2`, [id, trip.id]);
  if (!m) throw new HttpError(404, '成员不存在');
  return m;
}
const KIND_CN = { wechat: '微信', alipay: '支付宝' };
route('PUT', '/api/t/:key/paycode/:id/:kind', async ({ params, rawBody, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  const m = await codeMember(trip, params.id);
  const img = saveImage(rawBody);
  const old = await tripTx(trip, async (q) => {
    const { rows: [o] } = await q.query(`SELECT file FROM pay_codes WHERE person_id=$1 AND kind=$2`, [m.person_id, params.kind]);
    await q.query(`INSERT INTO pay_codes(person_id,kind,file,mime,updated_at) VALUES($1,$2,$3,$4,now())
      ON CONFLICT (person_id,kind) DO UPDATE SET file=EXCLUDED.file, mime=EXCLUDED.mime, updated_at=now()`, [m.person_id, params.kind, img.file, img.mime]);
    await log(q, trip.id, await actorName(q, trip, req, admin), 'paycode.set', `${o ? '更换' : '上传'}了 ${m.name} 的${KIND_CN[params.kind]}收款码`);
    return o;
  }).catch((e) => { removeFiles([img.file]); throw e; });
  if (old) removeFiles([old.file]);
  return { ok: true };
}, { raw: true });
route('DELETE', '/api/t/:key/paycode/:id/:kind', async ({ params, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  const m = await codeMember(trip, params.id);
  const old = await tripTx(trip, async (q) => {
    const { rows: [o] } = await q.query(`DELETE FROM pay_codes WHERE person_id=$1 AND kind=$2 RETURNING file`, [m.person_id, params.kind]);
    if (o) await log(q, trip.id, await actorName(q, trip, req, admin), 'paycode.remove', `删除了 ${m.name} 的${KIND_CN[params.kind]}收款码`);
    return o;
  });
  if (old) removeFiles([old.file]);
  return { ok: true };
});
route('GET', '/api/t/:key/paycode/:id/:kind', async ({ params }) => {
  const trip = await loadTrip(params.key);
  const m = await codeMember(trip, params.id);
  const { rows: [c] } = await db.query(`SELECT file, mime FROM pay_codes WHERE person_id=$1 AND kind=$2`, [m.person_id, params.kind]);
  if (!c) throw new HttpError(404, '没有收款码');
  return { __image: c };
});

// ---------- 账目 ----------
// 校验并算出每人分摊。返回 { payer, cents, category, title, note, day, shares:[{memberId,weight,fixed,cents}] }
// 校验并算出每人分摊。rate = 1 单位原币折合多少结算币种（同币种为 1）
// 返回 { payer, currency, origCents, rate, baseOverride, cents, category, title, note, day, shares }
function parseExpense(body, mm, today, rate, base) {
  const currency = CURRENCIES[body.currency] ? body.currency : base;
  const origCents = parseAmount(body.amount);
  if (!origCents) throw bad('金额不对（最多两位小数）');
  const ou = unitOf(currency), bu = unitOf(base);
  if (origCents % ou) throw bad(`${CURRENCIES[currency].name}金额不能有小数`);
  const payer = mm.get(Number(body.payerId));
  if (!payer) throw bad('请选择谁付的钱');
  const category = CATEGORIES[body.category] ? body.category : 'other';
  const title = cleanText(body.title, 40);
  const note = cleanText(body.note, 500);
  const day = body.day || today;
  if (!validDay(day)) throw bad('日期不对');
  if (!Array.isArray(body.shares) || !body.shares.length) throw bad('至少选一个人分摊');
  if (body.shares.length > 50) throw bad('分摊的人太多了');
  // 外币可以直接填"实付结算币种金额"（如信用卡账单金额），这时不按汇率算
  const paid = body.baseAmount ?? body.cny;
  let cents, baseOverride = false;
  if (currency !== base && paid != null && String(paid).trim() !== '') {
    cents = parseAmount(paid);
    if (!cents || cents % bu) throw bad(`实付${CURRENCIES[base].name}金额不对`);
    baseOverride = true;
  } else {
    cents = roundTo(origCents * rate, bu);
    if (cents < 1) throw bad(`折合${CURRENCIES[base].name}金额太小`);
  }
  if (cents > MAX_CENTS) throw bad('金额太大了');
  const seen = new Set();
  const parts = body.shares.map((s) => {
    const memberId = Number(s?.memberId);
    if (!mm.has(memberId) || seen.has(memberId)) throw bad('分摊名单不对');
    seen.add(memberId);
    const name = mm.get(memberId).name;
    if (s.fixed != null && s.fixed !== '') {
      const fixed = parseAmount(s.fixed, true);
      if (fixed == null || fixed % ou) throw bad(`${name} 的指定金额不对`);
      return { memberId, weight: 0, fixed };
    }
    const weight = parseWeight(s.weight ?? 1);
    if (!weight) throw bad(`${name} 的份数要大于 0`);
    return { memberId, weight, fixed: null };
  });
  let shares;
  try { shares = splitExpense(origCents, cents, parts, ou, bu); } catch (e) { if (e.status === 400) throw bad(e.message); throw e; }
  return { payer, currency, origCents, rate: baseOverride ? Number((cents / origCents).toFixed(8)) : rate, baseOverride, cents, category, title, note, day, shares };
}
const fmtMoney = (cur, c) => cur === 'CNY' ? fmtY(c) : `${CURRENCIES[cur].sym}${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
function describeExp(e, mm, base) {
  const amt = e.currency && e.currency !== base ? `${fmtMoney(e.currency, e.origCents)}（≈${fmtMoney(base, e.cents)}）` : fmtMoney(base, e.cents);
  return `${e.day.slice(5).replace('-', '/')} ${e.title || CATEGORIES[e.category]} ${amt}（${mm.get(e.payerId ?? e.payer.id)?.name ?? '?'} 付，${e.shares.length} 人分）`;
}
async function writeShares(q, expenseId, shares) {
  await q.query(`DELETE FROM expense_shares WHERE expense_id=$1`, [expenseId]);
  for (const s of shares) {
    await q.query(`INSERT INTO expense_shares(expense_id,member_id,weight,fixed_cents,orig_cents,cents) VALUES($1,$2,$3,$4,$5,$6)`,
      [expenseId, s.memberId, s.weight, s.fixed, s.origCents, s.cents]);
  }
}
async function loadExpense(q, trip, id) {
  const { rows: [e] } = await q.query(`SELECT id, payer_id AS "payerId", cents, currency, orig_cents AS "origCents", category, title, to_char(day,'YYYY-MM-DD') AS day FROM expenses WHERE id=$1 AND trip_id=$2`, [id, trip.id]);
  if (!e) throw new HttpError(404, '这笔账不存在（可能已被删除）');
  e.shares = (await q.query(`SELECT member_id FROM expense_shares WHERE expense_id=$1`, [id])).rows;
  return e;
}

// 这次游玩某币种的汇率：已有就用已有的；第一次用到时用前端传来的（或市场汇率）并记下来
const RATE_RE = /^\d{1,4}(\.\d{1,8})?$/;
function parseRate(v) {
  const s = String(v ?? '').trim();
  if (!RATE_RE.test(s) || !(Number(s) > 0)) return null;
  return Number(s);
}
async function tripRate(q, trip, currency, bodyRate, actor) {
  const base = trip.base_currency;
  if (!CURRENCIES[currency] || currency === base) return 1;
  const { rows: [r] } = await q.query(`SELECT rate::float AS rate FROM trip_rates WHERE trip_id=$1 AND currency=$2`, [trip.id, currency]);
  if (r) return r.rate;
  let rate = bodyRate != null && bodyRate !== '' ? parseRate(bodyRate) : null;
  if (bodyRate != null && bodyRate !== '' && !rate) throw bad('汇率不对');
  if (!rate) rate = crossRate(await liveRates(), currency, base);
  if (!rate) throw bad(`暂时拿不到${CURRENCIES[currency].name}汇率，请手动填写`);
  rate = Number(rate.toFixed(8));
  await q.query(`INSERT INTO trip_rates(trip_id,currency,rate) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [trip.id, currency, rate]);
  await log(q, trip.id, actor, 'rate.set', `设定汇率：1 ${CURRENCIES[currency].name} = ${rate} ${CURRENCIES[base].name}`);
  return rate;
}

route('POST', '/api/t/:key/expenses', async ({ params, body, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  return tripTx(trip, async (q) => {
    const mm = await memberMap(q, trip.id);
    const actor = await actorName(q, trip, req, admin);
    const rate = await tripRate(q, trip, body.currency, body.rate, actor);
    const e = parseExpense(body, mm, todayStr(), rate, trip.base_currency);
    const { rows: [r] } = await q.query(`INSERT INTO expenses(trip_id,payer_id,cents,category,title,note,day,created_by,currency,orig_cents,rate,cny_override)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [trip.id, e.payer.id, e.cents, e.category, e.title, e.note, e.day, actor, e.currency, e.origCents, e.rate, e.baseOverride]);
    await writeShares(q, r.id, e.shares);
    await log(q, trip.id, actor, 'expense.add', `记了一笔：${describeExp(e, mm, trip.base_currency)}`);
    return { id: r.id };
  });
});
route('PUT', '/api/t/:key/expenses/:id', async ({ params, body, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  return tripTx(trip, async (q) => {
    const mm = await memberMap(q, trip.id);
    const actor = await actorName(q, trip, req, admin);
    const old = await loadExpense(q, trip, params.id);
    const rate = await tripRate(q, trip, body.currency, body.rate, actor);
    const e = parseExpense(body, mm, todayStr(), rate, trip.base_currency);
    await q.query(`UPDATE expenses SET payer_id=$1,cents=$2,category=$3,title=$4,note=$5,day=$6,currency=$7,orig_cents=$8,rate=$9,cny_override=$10,updated_at=now() WHERE id=$11`,
      [e.payer.id, e.cents, e.category, e.title, e.note, e.day, e.currency, e.origCents, e.rate, e.baseOverride, old.id]);
    await writeShares(q, old.id, e.shares);
    await log(q, trip.id, actor, 'expense.edit', `修改了一笔：${describeExp(old, mm, trip.base_currency)} → ${describeExp(e, mm, trip.base_currency)}`);
    return { id: old.id };
  });
});

// 修改这次游玩某币种的汇率：该币种所有（没填实付金额的）账目按新汇率重算
route('PUT', '/api/t/:key/rates/:cur', async ({ params, body, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  const cur = params.cur;
  if (!CURRENCIES[cur] || cur === trip.base_currency) throw bad('币种不对');
  const rate = parseRate(body.rate);
  if (!rate) throw bad('汇率不对');
  return tripTx(trip, async (q) => {
    const { rows: [old] } = await q.query(`SELECT rate::float AS rate FROM trip_rates WHERE trip_id=$1 AND currency=$2`, [trip.id, cur]);
    await q.query(`INSERT INTO trip_rates(trip_id,currency,rate,updated_at) VALUES($1,$2,$3,now())
      ON CONFLICT (trip_id,currency) DO UPDATE SET rate=EXCLUDED.rate, updated_at=now()`, [trip.id, cur, rate]);
    const { rows: exps } = await q.query(`SELECT id, orig_cents FROM expenses WHERE trip_id=$1 AND currency=$2 AND NOT cny_override`, [trip.id, cur]);
    for (const e of exps) {
      const bu = unitOf(trip.base_currency);
      const cents = Math.max(bu, roundTo(e.orig_cents * rate, bu));
      if (cents > MAX_CENTS) throw bad('换算后有一笔金额太大了');
      const { rows: sh } = await q.query(`SELECT member_id, weight::float AS weight, fixed_cents FROM expense_shares WHERE expense_id=$1 ORDER BY member_id`, [e.id]);
      // 按原来的录入顺序无关紧要：分摊只取决于份数/指定金额
      const shares = splitExpense(e.orig_cents, cents, sh.map((x) => ({ memberId: x.member_id, weight: x.fixed_cents != null ? 0 : x.weight, fixed: x.fixed_cents })), unitOf(cur), bu);
      await q.query(`UPDATE expenses SET cents=$1, rate=$2 WHERE id=$3`, [cents, rate, e.id]);
      await writeShares(q, e.id, shares);
    }
    await log(q, trip.id, await actorName(q, trip, req, admin), 'rate.edit',
      `把汇率改为 1 ${CURRENCIES[cur].name} = ${rate} ${CURRENCIES[trip.base_currency].name}${old ? `（原 ${old.rate}）` : ''}，重算了 ${exps.length} 笔`);
    return { ok: true, recomputed: exps.length };
  });
});
route('GET', '/api/fx', async () => liveRates());

// 更换结算币种：所有账目换算到新币种。已有转账记录时不允许（避免转账金额换算出零头）
// body.rate = 1 旧结算币种 = ? 新结算币种（不填就用市场汇率）
route('PUT', '/api/t/:key/base', async ({ params, body, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  const from = trip.base_currency, to = body.currency;
  if (!CURRENCIES[to]) throw bad('币种不对');
  if (to === from) return { ok: true, recomputed: 0 };
  return tripTx(trip, async (q) => {
    const { rows: [{ n }] } = await q.query(`SELECT count(*)::int AS n FROM payments WHERE trip_id=$1`, [trip.id]);
    if (n) throw bad('已经有转账记录了，不能再换结算币种。先撤销所有「已转」再试');
    const conv = body.rate != null && body.rate !== '' ? parseRate(body.rate) : crossRate(await liveRates(), from, to);
    if (!conv) throw bad('汇率不对');
    // 新的各币种汇率：X→新 = X→旧 × 旧→新；旧结算币种自己 = conv；新结算币种不再需要汇率
    const { rows: old } = await q.query(`SELECT currency, rate::float AS rate FROM trip_rates WHERE trip_id=$1`, [trip.id]);
    const newRates = new Map(old.filter((r) => r.currency !== to).map((r) => [r.currency, Number((r.rate * conv).toFixed(8))]));
    newRates.set(from, conv);
    await q.query(`DELETE FROM trip_rates WHERE trip_id=$1`, [trip.id]);
    for (const [c, r] of newRates) await q.query(`INSERT INTO trip_rates(trip_id,currency,rate) VALUES($1,$2,$3)`, [trip.id, c, r]);
    const { rows: exps } = await q.query(`SELECT id, currency, orig_cents, cents, cny_override FROM expenses WHERE trip_id=$1`, [trip.id]);
    const bu = unitOf(to);
    for (const e of exps) {
      let cents, rate, override = e.cny_override;
      if (e.currency === to) { cents = e.orig_cents; rate = 1; override = false; }
      else if (override) { cents = Math.max(bu, roundTo(e.cents * conv, bu)); rate = Number((cents / e.orig_cents).toFixed(8)); }
      else { rate = newRates.get(e.currency); cents = Math.max(bu, roundTo(e.orig_cents * rate, bu)); }
      const { rows: sh } = await q.query(`SELECT member_id, weight::float AS weight, fixed_cents FROM expense_shares WHERE expense_id=$1 ORDER BY member_id`, [e.id]);
      const shares = splitExpense(e.orig_cents, cents, sh.map((x) => ({ memberId: x.member_id, weight: x.fixed_cents != null ? 0 : x.weight, fixed: x.fixed_cents })), unitOf(e.currency), bu);
      await q.query(`UPDATE expenses SET cents=$1, rate=$2, cny_override=$3 WHERE id=$4`, [cents, rate, override, e.id]);
      await writeShares(q, e.id, shares);
    }
    await q.query(`UPDATE trips SET base_currency=$1 WHERE id=$2`, [to, trip.id]);
    await log(q, trip.id, await actorName(q, trip, req, admin), 'trip.base',
      `把结算币种从${CURRENCIES[from].name}改为${CURRENCIES[to].name}（1 ${CURRENCIES[from].name} = ${conv} ${CURRENCIES[to].name}），重算了 ${exps.length} 笔`);
    return { ok: true, recomputed: exps.length };
  });
});

// 导出 Excel
route('GET', '/api/t/:key/export', async ({ params, admin }) => {
  const trip = await loadTrip(params.key);
  const d = await tripPayload(trip, admin);
  const base = trip.base_currency, B = CURRENCIES[base].name;
  const name = new Map(d.members.map((m) => [m.id, m.name]));
  const Y = (c) => Math.round(c) / 100;
  const exps = d.expenses.slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.id - b.id));
  const sheets = [];
  sheets.push({
    name: '账目明细',
    columns: [{ header: '日期', width: 11 }, { header: '类别', width: 7 }, { header: '内容', width: 18 }, { header: '付款人', width: 9 },
      { header: '币种', width: 8 }, { header: '原币金额', width: 12, type: 'money' }, { header: '汇率', width: 10 },
      { header: `金额（${B}）`, width: 13, type: 'money' },
      ...d.members.map((m) => ({ header: `${m.name} 应摊`, width: 11, type: 'money' })),
      { header: '备注', width: 24 }, { header: '记录人', width: 9 }],
    rows: exps.map((e) => [e.day, CATEGORIES[e.category], e.title, name.get(e.payerId) || '', CURRENCIES[e.currency]?.name || e.currency, Y(e.origCents),
      e.currency === base ? '' : e.baseOverride ? '按实付' : String(e.rate), Y(e.cents),
      ...d.members.map((m) => { const sh = e.shares.find((x) => x.memberId === m.id); return sh ? Y(sh.cents) : null; }),
      e.note, e.createdBy]),
    totalRow: ['合计', '', '', '', '', null, '', Y(exps.reduce((a, e) => a + e.cents, 0)),
      ...d.members.map((m) => Y(exps.reduce((a, e) => a + (e.shares.find((x) => x.memberId === m.id)?.cents || 0), 0))), '', ''],
  });
  sheets.push({
    name: '每人汇总',
    columns: [{ header: '成员', width: 10 }, { header: `垫付（${B}）`, width: 13, type: 'money' }, { header: `应摊（${B}）`, width: 13, type: 'money' },
      { header: '已转出', width: 11, type: 'money' }, { header: '已收到', width: 11, type: 'money' }, { header: '还应收(+)/应付(-)', width: 16, type: 'money' }],
    rows: d.balances.filter((b) => name.has(b.memberId)).map((b) => [name.get(b.memberId), Y(b.paid), Y(b.share), Y(b.sent), Y(b.received), Y(b.net)]),
  });
  sheets.push({
    name: '转账',
    columns: [{ header: '状态', width: 8 }, { header: '付款人', width: 10 }, { header: '收款人', width: 10 }, { header: `金额（${B}）`, width: 13, type: 'money' }, { header: '时间', width: 17 }],
    rows: [...d.payments.map((p) => ['已转', name.get(p.fromId), name.get(p.toId), Y(p.cents), new Date(p.createdAt).toLocaleString('zh-CN', { timeZone: TZ, hour12: false })]),
      ...d.transfers.map((t) => ['待转', name.get(t.fromId), name.get(t.toId), Y(t.cents), ''])],
  });
  const rates = Object.entries(d.rates);
  if (rates.length) sheets.push({
    name: '汇率',
    columns: [{ header: '币种', width: 12 }, { header: `1 单位折合${B}`, width: 16 }],
    rows: rates.map(([c, r]) => [CURRENCIES[c]?.name || c, String(r.rate)]),
  });
  return { __file: { name: `AA账本_${trip.name}.xlsx`, data: buildXlsx(sheets), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } };
});


route('DELETE', '/api/t/:key/expenses/:id', async ({ params, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  await tripTx(trip, async (q) => {
    const mm = await memberMap(q, trip.id);
    const old = await loadExpense(q, trip, params.id);
    const { rows: [row] } = await q.query(`SELECT *, to_char(day,'YYYY-MM-DD') AS day FROM expenses WHERE id=$1`, [old.id]);
    const { rows: shares } = await q.query(`SELECT * FROM expense_shares WHERE expense_id=$1`, [old.id]);
    const { rows: images } = await q.query(`SELECT * FROM images WHERE expense_id=$1 ORDER BY id`, [old.id]);
    const actor = await actorName(q, trip, req, admin);
    const label = describeExp(old, mm, trip.base_currency);
    // 删除前把完整内容放进回收站（图片文件不删），30 天内可以恢复
    await q.query(`INSERT INTO trash(trip_id,kind,label,data,files,deleted_by) VALUES($1,'expense',$2,$3,$4,$5)`,
      [trip.id, label, JSON.stringify({ base: trip.base_currency, expense: row, shares, images }), images.map((i) => i.file), actor]);
    await q.query(`DELETE FROM expenses WHERE id=$1`, [old.id]);
    await log(q, trip.id, actor, 'expense.remove', `删除了一笔：${label}（${TRASH_DAYS} 天内可在「最近删除」恢复）`);
  });
  return { ok: true };
});

// 截图
route('POST', '/api/t/:key/expenses/:id/images', async ({ params, rawBody, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  const img = saveImage(rawBody);
  return tripTx(trip, async (q) => {
    const e = await loadExpense(q, trip, params.id);
    const { rows: [{ n }] } = await q.query(`SELECT count(*)::int AS n FROM images WHERE expense_id=$1`, [e.id]);
    if (n >= MAX_IMAGES_PER_EXPENSE) throw bad(`每笔最多 ${MAX_IMAGES_PER_EXPENSE} 张图`);
    const { rows: [r] } = await q.query(`INSERT INTO images(expense_id,file,mime,bytes) VALUES($1,$2,$3,$4) RETURNING id`, [e.id, img.file, img.mime, img.bytes]);
    await log(q, trip.id, await actorName(q, trip, req, admin), 'image.add', `给「${e.title || CATEGORIES[e.category]} ${fmtMoney(trip.base_currency, e.cents)}」加了一张图`);
    return { id: r.id };
  }).catch((err) => { removeFiles([img.file]); throw err; });
}, { raw: true });
route('DELETE', '/api/t/:key/images/:id', async ({ params, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  await tripTx(trip, async (q) => {
    const { rows: [i] } = await q.query(`SELECT i.*, e.title, e.category, e.cents FROM images i JOIN expenses e ON e.id=i.expense_id WHERE i.id=$1 AND e.trip_id=$2`, [params.id, trip.id]);
    if (!i) throw new HttpError(404, '图片不存在');
    const actor = await actorName(q, trip, req, admin);
    const label = `「${i.title || CATEGORIES[i.category]} ${fmtMoney(trip.base_currency, i.cents)}」的一张图`;
    await q.query(`INSERT INTO trash(trip_id,kind,label,data,files,deleted_by) VALUES($1,'image',$2,$3,$4,$5)`,
      [trip.id, label, JSON.stringify({ image: { id: i.id, expense_id: i.expense_id, file: i.file, mime: i.mime, bytes: i.bytes, created_at: i.created_at } }), [i.file], actor]);
    await q.query(`DELETE FROM images WHERE id=$1`, [i.id]);
    await log(q, trip.id, actor, 'image.remove', `删除了${label}`);
  });
  return { ok: true };
});
route('GET', '/api/t/:key/images/:id', async ({ params }) => {
  const trip = await loadTrip(params.key);
  const { rows: [i] } = await db.query(`SELECT i.file, i.mime FROM images i JOIN expenses e ON e.id=i.expense_id WHERE i.id=$1 AND e.trip_id=$2`, [params.id, trip.id]);
  if (!i) throw new HttpError(404, '图片不存在');
  return { __image: i };
});

// ---------- 最近删除（回收站） ----------
route('GET', '/api/t/:key/trash', async ({ params }) => {
  const trip = await loadTrip(params.key);
  const { rows } = await db.query(`SELECT id, kind, label, deleted_by AS "deletedBy", deleted_at AS "deletedAt",
    deleted_at + make_interval(days => $2) AS "purgeAt" FROM trash WHERE trip_id=$1 ORDER BY id DESC`, [trip.id, TRASH_DAYS]);
  return { items: rows, days: TRASH_DAYS };
});
route('POST', '/api/t/:key/trash/:id/restore', async ({ params, req, admin }) => {
  const trip = await loadTrip(params.key);
  return tripTx(trip, async (q) => {
    const { rows: [t] } = await q.query(`DELETE FROM trash WHERE id=$1 AND trip_id=$2 RETURNING *`, [params.id, trip.id]);
    if (!t) throw new HttpError(404, '这条删除记录不存在（可能已经恢复过了）');
    const actor = await actorName(q, trip, req, admin);
    if (t.kind === 'image') {
      const i = t.data.image;
      const { rows: [e] } = await q.query(`SELECT id FROM expenses WHERE id=$1 AND trip_id=$2`, [i.expense_id, trip.id]);
      if (!e) throw bad('这张图所属的账目已经删除了，先恢复那笔账');
      const { rows: [{ n }] } = await q.query(`SELECT count(*)::int AS n FROM images WHERE expense_id=$1`, [e.id]);
      if (n >= MAX_IMAGES_PER_EXPENSE) throw bad(`这笔账已经有 ${MAX_IMAGES_PER_EXPENSE} 张图了`);
      await q.query(`INSERT INTO images(id,expense_id,file,mime,bytes,created_at) VALUES($1,$2,$3,$4,$5,$6)`, [i.id, e.id, i.file, i.mime, i.bytes, i.created_at]);
    } else {
      const { expense: x, shares, images } = t.data;
      const mm = await memberMap(q, trip.id);
      if (!mm.has(x.payer_id) || shares.some((s) => !mm.has(s.member_id))) throw bad('这笔账涉及的成员已经被移除了，没法直接恢复');
      // 按现在的汇率 / 结算币种重新算一遍，保证跟这次游玩的其他账目一致
      const base = trip.base_currency, bu = unitOf(base);
      let cents, rate = 1, override = false;
      if (x.currency === base) cents = x.orig_cents;
      else if (x.cny_override && t.data.base === base) { cents = x.cents; rate = Number(x.rate); override = true; }
      else { rate = await tripRate(q, trip, x.currency, null, actor); cents = Math.max(bu, roundTo(x.orig_cents * rate, bu)); }
      const split = splitExpense(x.orig_cents, cents, shares.map((s) => ({ memberId: s.member_id, weight: s.fixed_cents != null ? 0 : Number(s.weight), fixed: s.fixed_cents })), unitOf(x.currency), bu);
      await q.query(`INSERT INTO expenses(id,trip_id,payer_id,cents,category,title,note,day,created_by,created_at,updated_at,currency,orig_cents,rate,cny_override)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,$13,$14)`,
        [x.id, trip.id, x.payer_id, cents, x.category, x.title, x.note, x.day, x.created_by, x.created_at, x.currency, x.orig_cents, rate, override]);
      await writeShares(q, x.id, split);
      for (const i of images) await q.query(`INSERT INTO images(id,expense_id,file,mime,bytes,created_at) VALUES($1,$2,$3,$4,$5,$6)`, [i.id, x.id, i.file, i.mime, i.bytes, i.created_at]);
    }
    await log(q, trip.id, actor, t.kind + '.restore', `恢复了${t.kind === 'image' ? '' : '一笔：'}${t.label}`);
    return { ok: true };
  });
});

// ---------- 转账（结算） ----------
route('POST', '/api/t/:key/payments', async ({ params, body, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  return tripTx(trip, async (q) => {
    const mm = await memberMap(q, trip.id);
    const from = mm.get(Number(body.fromId)), to = mm.get(Number(body.toId));
    if (!from || !to || from.id === to.id) throw bad('转账双方不对');
    const cents = parseAmount(body.amount);
    if (!cents || cents % unitOf(trip.base_currency)) throw bad('金额不对');
    const actor = await actorName(q, trip, req, admin);
    const { rows: [r] } = await q.query(`INSERT INTO payments(trip_id,from_id,to_id,cents,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [trip.id, from.id, to.id, cents, actor]);
    await log(q, trip.id, actor, 'payment.add', `标记 ${from.name} 已转给 ${to.name} ${fmtMoney(trip.base_currency, cents)}`);
    return { id: r.id };
  });
});
route('DELETE', '/api/t/:key/payments/:id', async ({ params, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  await tripTx(trip, async (q) => {
    const mm = await memberMap(q, trip.id);
    const { rows: [p] } = await q.query(`DELETE FROM payments WHERE id=$1 AND trip_id=$2 RETURNING *`, [params.id, trip.id]);
    if (!p) throw new HttpError(404, '这条转账不存在');
    await log(q, trip.id, await actorName(q, trip, req, admin), 'payment.remove', `撤销了「${mm.get(p.from_id)?.name} 转给 ${mm.get(p.to_id)?.name} ${fmtMoney(trip.base_currency, p.cents)}」`);
  });
  return { ok: true };
});

// ---------- 锁定 ----------
route('POST', '/api/t/:key/lock', async ({ params, req, admin }) => {
  const trip = await loadTrip(params.key);
  assertOpen(trip);
  await tripTx(trip, async (q) => {
    await q.query(`UPDATE trips SET locked=true, locked_at=now() WHERE id=$1`, [trip.id]);
    await log(q, trip.id, await actorName(q, trip, req, admin), 'trip.lock', '锁定了账单');
  });
  return { ok: true };
});
route('POST', '/api/t/:key/unlock', async ({ params, req, admin }) => {
  const trip = await loadTrip(params.key);
  await tripTx(trip, async (q) => {
    await q.query(`UPDATE trips SET locked=false, locked_at=NULL WHERE id=$1`, [trip.id]);
    await log(q, trip.id, await actorName(q, trip, req, admin), 'trip.unlock', '解锁了账单');
  }, { open: false });
  return { ok: true };
}, { auth: 'admin' });

route('GET', '/api/t/:key/log', async ({ params }) => {
  const trip = await loadTrip(params.key);
  const { rows } = await db.query(`SELECT id, at, actor, action, detail FROM audit WHERE trip_id=$1 ORDER BY id DESC LIMIT 500`, [trip.id]);
  return { items: rows };
});

// ---------- 管理员 ----------
route('GET', '/api/admin/trips', async () => {
  const { rows: trips } = await db.query(`SELECT t.id, t.key, t.name, to_char(start_day,'YYYY-MM-DD') AS "startDay", to_char(end_day,'YYYY-MM-DD') AS "endDay",
    locked, base_currency AS base, i.note AS "inviteNote", (SELECT count(*)::int FROM members WHERE trip_id=t.id) AS members,
    (SELECT count(*)::int FROM expenses WHERE trip_id=t.id) AS count,
    (SELECT COALESCE(sum(cents),0)::float8 FROM expenses WHERE trip_id=t.id) AS total
    FROM trips t LEFT JOIN invites i ON i.id=t.invite_id WHERE t.deleted_at IS NULL ORDER BY start_day DESC, t.id DESC`);
  // 每人净额 = 付出 - 应摊 + 已转出 - 已收到；未结清金额 = 所有正净额之和
  const { rows: flows } = await db.query(`
    SELECT trip_id, payer_id AS m, sum(cents)::float8 AS c FROM expenses GROUP BY 1,2
    UNION ALL SELECT e.trip_id, s.member_id, -sum(s.cents)::float8 FROM expense_shares s JOIN expenses e ON e.id=s.expense_id GROUP BY 1,2
    UNION ALL SELECT trip_id, from_id, sum(cents)::float8 FROM payments GROUP BY 1,2
    UNION ALL SELECT trip_id, to_id, -sum(cents)::float8 FROM payments GROUP BY 1,2`);
  const net = new Map();
  for (const r of flows) {
    if (!net.has(r.trip_id)) net.set(r.trip_id, new Map());
    const n = net.get(r.trip_id); n.set(r.m, (n.get(r.m) || 0) + r.c);
  }
  return {
    trips: trips.map((t) => ({ ...t, unsettled: [...(net.get(t.id)?.values() || [])].reduce((a, c) => a + (c > 0 ? c : 0), 0) })),
  };
}, { auth: 'admin' });

route('GET', '/api/admin/people', async () => {
  const { rows } = await db.query(`SELECT p.name, count(m.id)::int AS trips, max(t.start_day) AS last
    FROM people p LEFT JOIN members m ON m.person_id=p.id LEFT JOIN trips t ON t.id=m.trip_id
    GROUP BY p.id HAVING count(m.id) > 0 ORDER BY last DESC NULLS LAST, trips DESC LIMIT 100`);
  return { people: rows.map((r) => r.name) };
}, { auth: 'admin' });

// 新建游玩（管理员或凭邀请码）
function parseNewTrip(body) {
  const name = cleanText(body.name, 40);
  if (!name) throw bad('请输入名称');
  if (!validDay(body.startDay)) throw bad('开始日期不对');
  const end = body.endDay || null;
  if (end && (!validDay(end) || end < body.startDay)) throw bad('结束日期不对');
  const base = body.baseCurrency || 'CNY';
  if (!CURRENCIES[base]) throw bad('结算币种不对');
  const names = [...new Set((Array.isArray(body.members) ? body.members : []).map((n) => cleanText(n, 20)).filter(Boolean))];
  if (names.length > 50) throw bad('最多 50 人');
  return { name, start: body.startDay, end, base, names, note: cleanText(body.note, 500) };
}
async function createTrip(q, t, actor, inviteId = null) {
  const key = newKey();
  const { rows: [r] } = await q.query(`INSERT INTO trips(key,name,start_day,end_day,note,base_currency,invite_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [key, t.name, t.start, t.end, t.note, t.base, inviteId]);
  for (const n of t.names) {
    const pid = await findOrCreatePerson(q, n);
    await q.query(`INSERT INTO members(trip_id,person_id) VALUES($1,$2)`, [r.id, pid]);
  }
  await log(q, r.id, actor, 'trip.create', `创建了「${t.name}」，结算币种${CURRENCIES[t.base].name}${t.names.length ? '，成员：' + t.names.join('、') : ''}`);
  return { id: r.id, key };
}
route('POST', '/api/admin/trips', async ({ body }) => {
  const t = parseNewTrip(body);
  return tx((q) => createTrip(q, t, '管理员'));
}, { auth: 'admin' });

// 凭邀请码新建游玩（不需要登录）。错误次数限制和管理员登录共用一张表
route('POST', '/api/invite/trips', async ({ body, req }) => {
  const ipKey = `invite|${clientIp(req)}`;
  const { rows: [fail] } = await db.query(`SELECT count FROM login_fails WHERE key=$1 AND first_at > now() - interval '15 minutes'`, [ipKey]);
  if (fail && fail.count >= 8) throw new HttpError(429, '尝试次数太多，请 15 分钟后再试');
  const code = cleanText(body.code, 40).toUpperCase().replace(/[\s-]/g, '');
  const { rows: [inv] } = await db.query(`SELECT id, note FROM invites WHERE code=$1 AND NOT revoked`, [code]);
  if (!inv) {
    await db.query(`
      INSERT INTO login_fails(key,count,first_at) VALUES($1,1,now())
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN login_fails.first_at > now() - interval '15 minutes' THEN login_fails.count+1 ELSE 1 END,
        first_at = CASE WHEN login_fails.first_at > now() - interval '15 minutes' THEN login_fails.first_at ELSE now() END`, [ipKey]);
    throw new HttpError(403, '邀请码不对或已停用');
  }
  const t = parseNewTrip(body);
  const creator = cleanText(body.creator, 20);
  if (creator && !t.names.includes(creator)) t.names.unshift(creator);
  return tx(async (q) => {
    const r = await createTrip(q, t, creator || `邀请码（${inv.note || code}）`, inv.id);
    await q.query(`UPDATE invites SET uses=uses+1 WHERE id=$1`, [inv.id]);
    if (creator) r.meId = (await q.query(`SELECT m.id FROM members m JOIN people p ON p.id=m.person_id WHERE m.trip_id=$1 AND p.name=$2`, [r.id, creator])).rows[0]?.id;
    return r;
  });
});

// 邀请码管理
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉了容易看错的 0 O 1 I
function newInviteCode() {
  let s = '';
  for (let i = 0; i < 10; i++) s += INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
  return s;
}
route('GET', '/api/admin/invites', async () => {
  const { rows } = await db.query(`SELECT id, code, note, uses, revoked, created_at AS "createdAt" FROM invites ORDER BY revoked, id DESC`);
  return { invites: rows };
}, { auth: 'admin' });
route('POST', '/api/admin/invites', async ({ body }) => {
  const note = cleanText(body.note, 30);
  const { rows: [r] } = await db.query(`INSERT INTO invites(code,note) VALUES($1,$2) RETURNING id, code`, [newInviteCode(), note]);
  return r;
}, { auth: 'admin' });
route('DELETE', '/api/admin/invites/:id', async ({ params }) => {
  const { rowCount } = await db.query(`UPDATE invites SET revoked=true WHERE id=$1`, [params.id]);
  if (!rowCount) throw new HttpError(404, '邀请码不存在');
  return { ok: true };
}, { auth: 'admin' });

route('POST', '/api/admin/trips/:id/rekey', async ({ params }) => {
  const key = newKey();
  const { rowCount } = await db.query(`UPDATE trips SET key=$1 WHERE id=$2`, [key, params.id]);
  if (!rowCount) throw new HttpError(404, '游玩不存在');
  await log(db, params.id, '管理员', 'trip.rekey', '重置了分享链接（旧链接失效）');
  return { key };
}, { auth: 'admin' });

// 删除游玩：先进回收站，TRASH_DAYS 天后由 purgeTrash() 真正删除
route('DELETE', '/api/admin/trips/:id', async ({ params }) => {
  const { rowCount } = await db.query(`UPDATE trips SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL`, [params.id]);
  if (!rowCount) throw new HttpError(404, '游玩不存在');
  await log(db, params.id, '管理员', 'trip.delete', `删除了这次游玩（${TRASH_DAYS} 天内可在管理员「回收站」恢复）`);
  return { ok: true };
}, { auth: 'admin' });
route('POST', '/api/admin/trips/:id/restore', async ({ params }) => {
  const { rowCount } = await db.query(`UPDATE trips SET deleted_at=NULL WHERE id=$1 AND deleted_at IS NOT NULL`, [params.id]);
  if (!rowCount) throw new HttpError(404, '回收站里没有这次游玩');
  await log(db, params.id, '管理员', 'trip.restore', '从回收站恢复了这次游玩');
  return { ok: true };
}, { auth: 'admin' });
route('GET', '/api/admin/trash', async () => {
  const { rows } = await db.query(`SELECT t.id, t.name, to_char(start_day,'YYYY-MM-DD') AS "startDay", to_char(end_day,'YYYY-MM-DD') AS "endDay",
    t.deleted_at AS "deletedAt", t.deleted_at + make_interval(days => $1) AS "purgeAt", (SELECT count(*)::int FROM expenses WHERE trip_id=t.id) AS count
    FROM trips t WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`, [TRASH_DAYS]);
  return { trips: rows, days: TRASH_DAYS };
}, { auth: 'admin' });

// 回收站到期清理：删除超过 TRASH_DAYS 天的游玩和账目 / 截图（这时才删图片文件）
async function purgeTrash() {
  const files = await tx(async (q) => {
    const { rows: trips } = await q.query(`SELECT id FROM trips WHERE deleted_at < now() - make_interval(days => $1)`, [TRASH_DAYS]);
    const ids = trips.map((t) => t.id);
    const { rows: f1 } = await q.query(`SELECT i.file FROM images i JOIN expenses e ON e.id=i.expense_id WHERE e.trip_id = ANY($1)
      UNION ALL SELECT unnest(files) FROM trash WHERE trip_id = ANY($1)
      UNION ALL SELECT unnest(files) FROM trash WHERE deleted_at < now() - make_interval(days => $2)`, [ids, TRASH_DAYS]);
    await q.query(`DELETE FROM trash WHERE trip_id = ANY($1) OR deleted_at < now() - make_interval(days => $2)`, [ids, TRASH_DAYS]);
    await q.query(`DELETE FROM expense_shares WHERE expense_id IN (SELECT id FROM expenses WHERE trip_id = ANY($1))`, [ids]);
    await q.query(`DELETE FROM expenses WHERE trip_id = ANY($1)`, [ids]);
    await q.query(`DELETE FROM payments WHERE trip_id = ANY($1)`, [ids]);
    await q.query(`DELETE FROM trips WHERE id = ANY($1)`, [ids]);
    return f1.map((r) => r.file);
  });
  removeFiles(files);
  return files.length;
}

// ---------- 数据校验 ----------
// 把数据库里所有账目按存下来的份数 / 指定金额 / 汇率重新算一遍，跟存的结果逐分比对；再检查每次游玩收支平衡、图片文件都在。
// node server.js check 和管理员页面顶部的「数据校验」都用它。返回 { ok, problems[], counts }
async function verifyData() {
  const [{ rows: trips }, { rows: exps }, { rows: shares }, { rows: pays }, { rows: mems }, { rows: rates }, { rows: files }] = await Promise.all([
    db.query(`SELECT id, name, base_currency AS base FROM trips`),
    db.query(`SELECT id, trip_id, payer_id, cents, currency, orig_cents, rate::float AS rate, cny_override FROM expenses ORDER BY id`),
    db.query(`SELECT expense_id, member_id, weight::float AS weight, fixed_cents, orig_cents, cents FROM expense_shares`),
    db.query(`SELECT id, trip_id, from_id, to_id, cents FROM payments`),
    db.query(`SELECT id, trip_id FROM members`),
    db.query(`SELECT trip_id, currency, rate::float AS rate FROM trip_rates`),
    db.query(`SELECT file FROM images UNION SELECT file FROM pay_codes UNION SELECT unnest(files) FROM trash`),
  ]);
  const problems = [];
  const tripById = new Map(trips.map((t) => [t.id, t]));
  const where = (t) => `「${t?.name ?? '?'}」`;
  const rateOf = new Map(rates.map((r) => [`${r.trip_id}|${r.currency}`, r.rate]));
  const sharesOf = new Map();
  for (const s of shares) { if (!sharesOf.has(s.expense_id)) sharesOf.set(s.expense_id, []); sharesOf.get(s.expense_id).push(s); }
  const byTrip = new Map(trips.map((t) => [t.id, { members: [], expenses: [], payments: [] }]));
  for (const m of mems) byTrip.get(m.trip_id)?.members.push(m.id);
  for (const e of exps) {
    const t = tripById.get(e.trip_id), base = t.base, bu = unitOf(base), ou = unitOf(e.currency);
    const tag = `${where(t)} 账目 #${e.id}`;
    const sh = sharesOf.get(e.id) || [];
    if (e.orig_cents % ou || e.cents % bu) problems.push(`${tag}：金额不是整${bu > 1 || ou > 1 ? '円' : '分'}`);
    if (e.currency === base) {
      if (e.cents !== e.orig_cents || e.rate !== 1 || e.cny_override) problems.push(`${tag}：同币种账目的折算金额不对`);
    } else if (!e.cny_override) {
      const r = rateOf.get(`${e.trip_id}|${e.currency}`);
      if (r == null) problems.push(`${tag}：缺少 ${e.currency} 的汇率`);
      else {
        if (Math.abs(r - e.rate) > 1e-8) problems.push(`${tag}：汇率 ${e.rate} 跟这次游玩的 ${r} 不一致`);
        const want = Math.max(bu, roundTo(e.orig_cents * r, bu));
        if (want !== e.cents) problems.push(`${tag}：按汇率应折合 ${want / 100}，存的是 ${e.cents / 100}`);
      }
    }
    try {
      const re = splitExpense(e.orig_cents, e.cents, sh.map((x) => ({ memberId: x.member_id, weight: x.fixed_cents != null ? 0 : x.weight, fixed: x.fixed_cents })), ou, bu);
      const stored = new Map(sh.map((x) => [x.member_id, x]));
      for (const x of re) {
        const y = stored.get(x.memberId);
        if (y.cents !== x.cents || y.orig_cents !== x.origCents) { problems.push(`${tag}：成员 #${x.memberId} 分摊应为 ${x.cents / 100}（原币 ${x.origCents / 100}），存的是 ${y.cents / 100}（${y.orig_cents / 100}）`); break; }
      }
    } catch (err) { problems.push(`${tag}：没法重算分摊（${err.message}）`); }
    byTrip.get(e.trip_id).expenses.push({ payerId: e.payer_id, cents: e.cents, shares: sh.map((x) => ({ memberId: x.member_id, cents: x.cents })) });
  }
  for (const p of pays) {
    if (p.cents % unitOf(tripById.get(p.trip_id).base)) problems.push(`${where(tripById.get(p.trip_id))} 转账 #${p.id}：金额不是整数单位`);
    byTrip.get(p.trip_id).payments.push({ fromId: p.from_id, toId: p.to_id, cents: p.cents });
  }
  for (const t of trips) {
    const d = byTrip.get(t.id);
    const { balances, transfers } = settle(d.members, d.expenses, d.payments);
    const sum = balances.reduce((a, b) => a + b.net, 0);
    if (sum !== 0) problems.push(`${where(t)}：所有人的净额加起来不是 0（差 ${sum / 100}）`);
    const unsettled = balances.reduce((a, b) => a + (b.net > 0 ? b.net : 0), 0);
    if (transfers.reduce((a, x) => a + x.cents, 0) !== unsettled) problems.push(`${where(t)}：建议转账总额跟未结清金额对不上`);
  }
  let missing = 0;
  for (const f of files) if (!fs.existsSync(path.join(UPLOADS, f.file))) missing++;
  if (missing) problems.push(`有 ${missing} 个图片文件在磁盘上找不到`);
  return { ok: problems.length === 0, problems, counts: { trips: trips.length, expenses: exps.length, payments: pays.length, files: files.length }, at: new Date().toISOString() };
}
// 最近一次备份（由 deploy/backup.sh 生成）
function latestBackup() {
  try {
    const f = fs.readdirSync(BACKUPS).filter((n) => /^aa-\d{8}-\d{4}\.sql\.gz$/.test(n)).sort().pop();
    if (!f) return null;
    const st = fs.statSync(path.join(BACKUPS, f));
    return { file: f, at: st.mtime.toISOString(), bytes: st.size, ageHours: Math.round((Date.now() - st.mtimeMs) / 36e5 * 10) / 10 };
  } catch { return null; }
}
let lastCheck = null;
route('GET', '/api/admin/health', async () => {
  if (!lastCheck || Date.now() - Date.parse(lastCheck.at) > 60 * 1000) lastCheck = await verifyData();
  return { check: { ...lastCheck, problems: lastCheck.problems.slice(0, 30) }, backup: latestBackup() };
}, { auth: 'admin' });
// 下载最新的数据库备份（管理员偶尔下载一份存到自己电脑 / 网盘，防止服务器整个坏掉）
route('GET', '/api/admin/backup/latest', async () => {
  const b = latestBackup();
  if (!b) throw new HttpError(404, '还没有备份');
  return { __file: { name: b.file, data: fs.readFileSync(path.join(BACKUPS, b.file)), type: 'application/gzip' } };
}, { auth: 'admin' });

// 跨游玩统计（按年）。各次游玩的结算币种可能不同，统一折算成人民币
route('GET', '/api/admin/stats', async ({ query }) => {
  const year = Number(query.get('year')) || Number(todayStr().slice(0, 4));
  if (year < 2000 || year > 2100) throw bad('年份不对');
  const from = `${year}-01-01`, to = `${year + 1}-01-01`;
  const [{ rows: trips }, { rows: exps }, { rows: shares }, { rows: mems }, { rows: rates }, { rows: years }] = await Promise.all([
    db.query(`SELECT id, name, to_char(start_day,'YYYY-MM-DD') AS "startDay", base_currency AS base,
      (SELECT count(*)::int FROM members WHERE trip_id=t.id) AS members FROM trips t WHERE start_day >= $1 AND start_day < $2 AND deleted_at IS NULL ORDER BY start_day`, [from, to]),
    db.query(`SELECT e.trip_id, e.category, e.cents, m.person_id FROM expenses e JOIN trips t ON t.id=e.trip_id JOIN members m ON m.id=e.payer_id
      WHERE t.start_day >= $1 AND t.start_day < $2 AND t.deleted_at IS NULL`, [from, to]),
    db.query(`SELECT e.trip_id, s.cents, m.person_id FROM expense_shares s JOIN expenses e ON e.id=s.expense_id JOIN trips t ON t.id=e.trip_id
      JOIN members m ON m.id=s.member_id WHERE t.start_day >= $1 AND t.start_day < $2 AND t.deleted_at IS NULL`, [from, to]),
    db.query(`SELECT m.trip_id, p.id AS person_id, p.name FROM members m JOIN people p ON p.id=m.person_id JOIN trips t ON t.id=m.trip_id
      WHERE t.start_day >= $1 AND t.start_day < $2 AND t.deleted_at IS NULL`, [from, to]),
    db.query(`SELECT trip_id, currency, rate::float AS rate FROM trip_rates`),
    db.query(`SELECT DISTINCT extract(year FROM start_day)::int AS y FROM trips WHERE deleted_at IS NULL ORDER BY 1 DESC`),
  ]);
  const live = await liveRates();
  const factor = new Map(trips.map((t) => [t.id, toCnyFactor(t.base, rates.filter((r) => r.trip_id === t.id), live)]));
  const cny = (tripId, c) => Math.round(c * (factor.get(tripId) ?? 1));
  const tripTotal = new Map();
  for (const e of exps) tripTotal.set(e.trip_id, (tripTotal.get(e.trip_id) || 0) + cny(e.trip_id, e.cents));
  const people = new Map();
  for (const m of mems) {
    if (!people.has(m.person_id)) people.set(m.person_id, { name: m.name, trips: 0, paid: 0, share: 0 });
    people.get(m.person_id).trips++;
  }
  for (const e of exps) if (people.has(e.person_id)) people.get(e.person_id).paid += cny(e.trip_id, e.cents);
  for (const s of shares) if (people.has(s.person_id)) people.get(s.person_id).share += cny(s.trip_id, s.cents);
  const cats = new Map();
  for (const e of exps) cats.set(e.category, (cats.get(e.category) || 0) + cny(e.trip_id, e.cents));
  const months = new Map();
  for (const t of trips) {
    const m = Number(t.startDay.slice(5, 7));
    const x = months.get(m) || { m, cents: 0, trips: 0 };
    x.cents += tripTotal.get(t.id) || 0; x.trips++; months.set(m, x);
  }
  return {
    year, years: years.map((r) => r.y),
    trips: trips.map((t) => ({ id: t.id, name: t.name, startDay: t.startDay, members: t.members, base: t.base, total: tripTotal.get(t.id) || 0 })),
    people: [...people.values()].sort((a, b) => b.share - a.share),
    categories: [...cats].map(([category, cents]) => ({ category, cents })).sort((a, b) => b.cents - a.cents),
    months: [...months.values()].sort((a, b) => a.m - b.m),
    categoryNames: CATEGORIES,
  };
}, { auth: 'admin' });

// ---------- 静态文件 ----------
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/manifest+json', '.png': 'image/png' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      if (!path.extname(rel)) return serveStatic(req, res, '/'); // 前端路由兜底（/t/xxx 等）
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, limit > 100000 ? '图片太大（最大 6MB）' : '请求太大')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  }
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new HttpError(404, '接口不存在');
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, k === 'key' || k === 'kind' || k === 'cur' ? m[i + 1] : Number(m[i + 1])]));
    let body = {}, rawBody = null;
    if (r.raw) {
      if (!/^image\/(jpeg|png|webp)$/.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, '只接受图片');
      rawBody = await readBody(req, MAX_IMAGE);
      if (!rawBody.length) throw bad('图片是空的');
    } else if (req.method !== 'GET' && req.method !== 'DELETE') {
      // 只接受 JSON：跨站表单无法伪造（防 CSRF）
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, '只接受 JSON');
      const raw = (await readBody(req, 32768)).toString('utf8');
      try { body = raw ? JSON.parse(raw) : {}; } catch { throw bad('JSON 格式不对'); }
      if (typeof body !== 'object' || body === null) body = {};
    }
    const admin = await currentAdmin(req);
    if (admin?.renewToken) res.setHeader('Set-Cookie', sessionCookie(admin.renewToken, SESSION_DAYS * 86400));
    if (r.auth === 'admin' && !admin) throw new HttpError(401, '请先登录');
    const result = await r.handler({ req, res, admin, params, body, rawBody, query: url.searchParams });
    if (result && result.__file) {
      const f = result.__file;
      res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.data.length, 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(f.name)}` });
      return res.end(f.data);
    }
    if (result && result.__image) {
      const { file, mime } = result.__image;
      const data = await fs.promises.readFile(path.join(UPLOADS, file)).catch(() => null);
      if (!data) throw new HttpError(404, '图片文件丢失');
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=86400' });
      return res.end(data);
    }
    send(200, result);
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message });
    console.error(e);
    // 数据库的金额校验触发器拦下了不平的账（说明代码有 bug），整笔已回滚，没有存进去
    if (/aa_invariant/.test(e.message)) return send(500, { error: '数据校验没通过，这次修改没有保存。请截图告诉管理员' });
    send(500, { error: '服务器出错了' });
  }
});

setInterval(() => {
  db.query(`DELETE FROM sessions WHERE expires_at < now()`).catch(() => {});
  db.query(`DELETE FROM login_fails WHERE first_at < now() - interval '1 day'`).catch(() => {});
  purgeTrash().catch((e) => console.error('purgeTrash', e));
}, 3600 * 1000).unref();

async function main() {
  await db.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  // 命令行：node server.js create-admin <用户名> [密码]
  if (process.argv[2] === 'create-admin') {
    const [, , , username, pw] = process.argv;
    if (!username) { console.error('用法：node server.js create-admin <用户名> [密码]'); process.exit(1); }
    const password = pw || crypto.randomBytes(6).toString('base64url');
    await db.query(`INSERT INTO admins(username,pw_hash) VALUES($1,$2) ON CONFLICT (username) DO UPDATE SET pw_hash=EXCLUDED.pw_hash`,
      [username.toLowerCase(), hashPassword(password)]);
    console.log(`管理员 ${username} 的密码：${password}`);
    await db.end();
    return;
  }
  // 命令行：node server.js clean-uploads —— 删除数据库里已经没有引用的图片文件
  if (process.argv[2] === 'clean-uploads') {
    const { rows } = await db.query(`SELECT file FROM images UNION SELECT file FROM pay_codes UNION SELECT unnest(files) FROM trash`);
    const used = new Set(rows.map((r) => r.file));
    const orphans = fs.readdirSync(UPLOADS).filter((f) => !used.has(f));
    for (const f of orphans) if (/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(f)) fs.unlinkSync(path.join(UPLOADS, f));
    console.log(`清理了 ${orphans.length} 个没用的文件`);
    await db.end();
    return;
  }
  // 命令行：node server.js check —— 全量数据校验，有问题时打印出来并以 1 退出
  if (process.argv[2] === 'check') {
    const r = await verifyData();
    console.log(`数据校验：${r.counts.trips} 次游玩、${r.counts.expenses} 笔账、${r.counts.payments} 笔转账、${r.counts.files} 个图片文件`);
    for (const x of r.problems) console.log('  ✗ ' + x);
    console.log(r.ok ? '全部正确' : `发现 ${r.problems.length} 个问题`);
    await db.end();
    process.exit(r.ok ? 0 : 1);
  }
  fs.mkdirSync(UPLOADS, { recursive: true });
  server.listen(PORT, HOST, () => console.log(`aa listening on ${HOST}:${PORT}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
