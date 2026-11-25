// 接口测试：对 http://127.0.0.1:8792 跑。需要先用 run.sh 建好 zzadmin
const BASE = process.env.BASE || 'http://127.0.0.1:8792';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : (fail++, console.log('✗', name, extra)); };
let cookie = '';
async function call(method, path, body, { actor, raw, type } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (actor) headers['X-Actor'] = String(actor);
  let payload;
  if (raw) { payload = raw; headers['Content-Type'] = type || 'image/png'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const sc = res.headers.get('set-cookie'); if (sc && sc.startsWith('aa_session=')) cookie = sc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, ct };
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// 登录
let r = await call('POST', '/api/login', { username: 'zzadmin', password: 'wrong' });
ok('错误密码 401', r.status === 401);
r = await call('POST', '/api/login', { username: 'zzadmin', password: 'test-admin-1' });
ok('登录', r.status === 200 && cookie);
r = await call('GET', '/api/me'); ok('me 是管理员', r.data.admin?.username === 'zzadmin');
const adminCookie = cookie;

// 创建游玩
r = await call('POST', '/api/admin/trips', { name: 'zz测试千岛湖', startDay: '2026-11-20', endDay: '2026-11-22', members: ['zz甲', 'zz乙', 'zz丙'] });
ok('创建游玩', r.status === 200 && r.data.key?.length === 22, JSON.stringify(r.data));
let key = r.data.key; const tripId = r.data.id;
r = await call('POST', '/api/admin/trips', { name: 'zz', startDay: '2026-11-20', endDay: '2026-11-01' });
ok('结束早于开始被拒', r.status === 400);

// 朋友（无 cookie）访问
cookie = '';
r = await call('GET', `/api/t/${key}`);
ok('凭链接访问', r.status === 200 && r.data.members.length === 3 && !r.data.isAdmin);
const [A, B, C] = r.data.members.map((m) => m.id);
r = await call('GET', '/api/t/AAAAAAAAAAAAAAAAAAAAAA'); ok('错误链接 404', r.status === 404);
r = await call('GET', '/api/admin/trips'); ok('非管理员不能列游玩', r.status === 401);

// 临时加人
r = await call('POST', `/api/t/${key}/members`, { name: 'zz丁' }, { actor: A });
ok('加人', r.status === 200); const D = r.data.id;
r = await call('POST', `/api/t/${key}/members`, { name: 'zz丁' }); ok('重复加人被拒', r.status === 400);
r = await call('PATCH', `/api/t/${key}/members/${D}`, { weight: '2' }); ok('改份数', r.status === 200);

// 记账：默认全员
r = await call('POST', `/api/t/${key}/expenses`, { amount: '100', title: '晚饭', category: 'food', payerId: A, day: '2026-11-20',
  shares: [A, B, C].map((id) => ({ memberId: id, weight: 1 })) }, { actor: A });
ok('记账', r.status === 200); const E1 = r.data.id;
r = await call('POST', `/api/t/${key}/expenses`, { amount: '600', title: '民宿', category: 'lodging', payerId: B, day: '2026-11-20',
  shares: [{ memberId: A, weight: 1 }, { memberId: B, weight: 1 }, { memberId: C, weight: 1 }, { memberId: D, weight: 2 }] }, { actor: B });
ok('按份数记账', r.status === 200); const E2 = r.data.id;
r = await call('POST', `/api/t/${key}/expenses`, { amount: '90', title: '油费', category: 'transport', payerId: C, day: '2026-11-21',
  shares: [{ memberId: A, fixed: '10' }, { memberId: B, weight: 1 }, { memberId: C, weight: 1 }] }, { actor: C });
ok('指定金额记账', r.status === 200); const E3 = r.data.id;
r = await call('POST', `/api/t/${key}/expenses`, { amount: '10', payerId: A, shares: [{ memberId: A, fixed: '20' }] });
ok('指定超额被拒', r.status === 400 && /超过/.test(r.data.error), JSON.stringify(r.data));
r = await call('POST', `/api/t/${key}/expenses`, { amount: '0', payerId: A, shares: [{ memberId: A }] }); ok('金额 0 被拒', r.status === 400);
r = await call('POST', `/api/t/${key}/expenses`, { amount: '1.234', payerId: A, shares: [{ memberId: A }] }); ok('三位小数被拒', r.status === 400);
r = await call('POST', `/api/t/${key}/expenses`, { amount: '10', payerId: 999999, shares: [{ memberId: A }] }); ok('外人付款被拒', r.status === 400);
r = await call('POST', `/api/t/${key}/expenses`, { amount: '10', payerId: A, shares: [{ memberId: A }, { memberId: A }] }); ok('重复分摊被拒', r.status === 400);
r = await call('POST', `/api/t/${key}/expenses`, { amount: '10', payerId: A, shares: [] }); ok('空分摊被拒', r.status === 400);

r = await call('GET', `/api/t/${key}`);
const e1 = r.data.expenses.find((e) => e.id === E1), e2 = r.data.expenses.find((e) => e.id === E2), e3 = r.data.expenses.find((e) => e.id === E3);
ok('100 三人分 34/33/33', JSON.stringify(e1.shares.map((s) => s.cents)) === '[3334,3333,3333]', JSON.stringify(e1.shares));
ok('600 按 1:1:1:2', JSON.stringify(e2.shares.map((s) => s.cents)) === '[12000,12000,12000,24000]');
ok('90 指定10 其余平分', JSON.stringify(e3.shares.map((s) => s.cents)) === '[1000,4000,4000]');
// 净额: A 付100 摊 33.34+120+10=163.34 -> -63.34; B 付600 摊 33.33+120+40=193.33 -> +406.67; C 付90 摊 33.33+120+40=193.33 -> -103.33; D 摊240 -> -240
const net = Object.fromEntries(r.data.balances.map((b) => [b.memberId, b.net]));
ok('净额正确', net[A] === -6334 && net[B] === 40667 && net[C] === -10333 && net[D] === -24000, JSON.stringify(net));
ok('净额合计为 0', Object.values(net).reduce((a, b) => a + b, 0) === 0);
ok('转账 3 笔都给 B', r.data.transfers.length === 3 && r.data.transfers.every((t) => t.toId === B), JSON.stringify(r.data.transfers));

// 修改 & 不能移除有账的人
r = await call('PUT', `/api/t/${key}/expenses/${E1}`, { amount: '120', title: '晚饭火锅', category: 'food', payerId: A, day: '2026-11-20', note: '含服务费',
  shares: [A, B, C].map((id) => ({ memberId: id, weight: 1 })) }, { actor: B });
ok('修改账目', r.status === 200);
r = await call('DELETE', `/api/t/${key}/members/${D}`); ok('有账的人不能移除', r.status === 400);
r = await call('POST', `/api/t/${key}/members`, { name: 'zz戊' }); const Ex = r.data.id;
r = await call('DELETE', `/api/t/${key}/members/${Ex}`); ok('无账的人能移除', r.status === 200);

// 截图
r = await call('POST', `/api/t/${key}/expenses/${E1}/images`, null, { raw: PNG, type: 'image/png' });
ok('上传图片', r.status === 200); const IMG = r.data.id;
r = await call('POST', `/api/t/${key}/expenses/${E1}/images`, null, { raw: Buffer.from('<svg></svg>'), type: 'image/png' });
ok('伪造图片被拒', r.status === 400);
r = await call('POST', `/api/t/${key}/expenses/${E1}/images`, null, { raw: PNG, type: 'image/svg+xml' });
ok('svg 类型被拒', r.status === 415);
r = await call('GET', `/api/t/${key}/images/${IMG}`);
ok('读取图片', r.status === 200 && r.ct === 'image/png' && Buffer.compare(r.data, PNG) === 0);
// 收款码
r = await call('PUT', `/api/t/${key}/paycode/${B}/wechat`, null, { raw: PNG, type: 'image/png' }); ok('上传收款码', r.status === 200);
r = await call('GET', `/api/t/${key}`); ok('收款码标记', !!r.data.members.find((m) => m.id === B).codes.wechat);
r = await call('GET', `/api/t/${key}/paycode/${B}/wechat`); ok('读取收款码', r.status === 200 && r.ct === 'image/png');
r = await call('GET', `/api/t/${key}/paycode/${A}/alipay`); ok('无收款码 404', r.status === 404);

// 另一个游玩不能读这个游玩的图片
cookie = adminCookie;
r = await call('POST', '/api/admin/trips', { name: 'zz别的游玩', startDay: '2026-10-01', members: ['zz甲'] });
const key2 = r.data.key; cookie = '';
r = await call('GET', `/api/t/${key2}/images/${IMG}`); ok('跨游玩读图被拒', r.status === 404);
r = await call('DELETE', `/api/t/${key2}/expenses/${E1}`); ok('跨游玩删账被拒', r.status === 404);

// 转账
r = await call('GET', `/api/t/${key}`);
const t0 = r.data.transfers[0];
r = await call('POST', `/api/t/${key}/payments`, { fromId: t0.fromId, toId: t0.toId, amount: (t0.cents / 100).toFixed(2) }, { actor: t0.fromId });
ok('标记已转', r.status === 200); const P1 = r.data.id;
r = await call('GET', `/api/t/${key}`); ok('转账后剩 2 笔', r.data.transfers.length === 2);
r = await call('DELETE', `/api/t/${key}/payments/${P1}`); ok('撤销转账', r.status === 200);
r = await call('GET', `/api/t/${key}`);
for (const t of r.data.transfers) await call('POST', `/api/t/${key}/payments`, { fromId: t.fromId, toId: t.toId, amount: (t.cents / 100).toFixed(2) });
r = await call('GET', `/api/t/${key}`); ok('全部结清', r.data.transfers.length === 0 && r.data.balances.every((b) => b.net === 0));

// 锁定
r = await call('POST', `/api/t/${key}/lock`, {}); ok('锁定', r.status === 200);
r = await call('POST', `/api/t/${key}/expenses`, { amount: '1', payerId: A, shares: [{ memberId: A }] }); ok('锁定后不能记账', r.status === 423);
r = await call('DELETE', `/api/t/${key}/expenses/${E1}`); ok('锁定后不能删', r.status === 423);
r = await call('POST', `/api/t/${key}/unlock`, {}); ok('非管理员不能解锁', r.status === 401);
cookie = adminCookie;
r = await call('GET', `/api/admin/trips`); const lt = r.data.trips.find((t) => t.id === tripId);
ok('列表：已锁定、已结清', lt && lt.locked && lt.unsettled === 0 && lt.total === 81000, JSON.stringify(lt));
r = await call('POST', `/api/t/${key}/unlock`, {}); ok('管理员解锁', r.status === 200);
r = await call('GET', '/api/admin/stats?year=2026'); ok('年度统计', r.status === 200 && r.data.trips.some((t) => t.id === tripId));
r = await call('GET', '/api/admin/people'); ok('常用人名', r.data.people.includes('zz甲'));

// ===== 多币种 =====
r = await call('GET', '/api/fx'); ok('市场汇率', r.status === 200 && r.data.rates.JPY > 0, JSON.stringify(r.data));
r = await call('POST', `/api/t/${key}/expenses`, { amount: '3000', currency: 'JPY', rate: '0.05', title: '拉面', category: 'food', payerId: A, day: '2026-11-21',
  shares: [A, B, C].map((id) => ({ memberId: id, weight: 1 })) }, { actor: A });
ok('日元记账', r.status === 200, JSON.stringify(r.data)); const J1 = r.data.id;
r = await call('GET', `/api/t/${key}`);
let j1 = r.data.expenses.find((e) => e.id === J1);
ok('日元折算 3000×0.05=150', j1.cents === 15000 && j1.origCents === 300000 && j1.currency === 'JPY' && r.data.rates.JPY.rate === 0.05, JSON.stringify(j1));
ok('日元分摊', JSON.stringify(j1.shares.map((s) => [s.origCents, s.cents])) === '[[100000,5000],[100000,5000],[100000,5000]]');
r = await call('POST', `/api/t/${key}/expenses`, { amount: '1000', currency: 'JPY', rate: '9', payerId: B,
  shares: [{ memberId: A, fixed: '100' }, { memberId: B, weight: 1 }, { memberId: C, weight: 1 }] });
const J2 = r.data.id;
r = await call('GET', `/api/t/${key}`); let j2 = r.data.expenses.find((e) => e.id === J2);
ok('第二笔沿用本次汇率（忽略新传的）', j2.cents === 5000 && j2.rate === 0.05, JSON.stringify(j2));
ok('外币指定金额按原币', JSON.stringify(j2.shares.map((s) => [s.origCents, s.cents])) === '[[10000,500],[45000,2250],[45000,2250]]', JSON.stringify(j2.shares));
r = await call('POST', `/api/t/${key}/expenses`, { amount: '500', currency: 'HKD', cny: '470.12', payerId: C, shares: [A, B, C].map((id) => ({ memberId: id })) });
const H1 = r.data.id;
r = await call('GET', `/api/t/${key}`); let h1 = r.data.expenses.find((e) => e.id === H1);
ok('实付人民币', h1.cents === 47012 && h1.baseOverride && h1.shares.reduce((a, s) => a + s.cents, 0) === 47012, JSON.stringify(h1));
ok('港币首次自动用市场汇率', r.data.rates.HKD?.rate > 0);
r = await call('POST', `/api/t/${key}/expenses`, { amount: '10', currency: 'USD', rate: 'abc', payerId: A, shares: [{ memberId: A }] }); ok('非法汇率被拒', r.status === 400);
r = await call('POST', `/api/t/${key}/expenses`, { amount: '1', currency: 'JPY', payerId: A, shares: [{ memberId: A }] });
r2: { const t = await call('GET', `/api/t/${key}`); ok('1 日元 = 5 分', t.data.expenses.find((e) => e.id === r.data.id)?.cents === 5); }
r = await call('POST', `/api/t/${key}/expenses`, { amount: '10', currency: 'XXX', payerId: A, shares: [{ memberId: A }] });
r2b: { const t = await call('GET', `/api/t/${key}`); ok('未知币种按人民币', t.data.expenses.find((e) => e.id === r.data.id)?.currency === 'CNY'); }
// 改汇率 → 重算
r = await call('PUT', `/api/t/${key}/rates/JPY`, { rate: '0.048' }, { actor: A }); ok('改汇率', r.status === 200 && r.data.recomputed === 3, JSON.stringify(r.data));
r = await call('GET', `/api/t/${key}`); j1 = r.data.expenses.find((e) => e.id === J1); j2 = r.data.expenses.find((e) => e.id === J2);
ok('改汇率后重算', j1.cents === 14400 && j2.cents === 4800 && JSON.stringify(j2.shares.map((s) => s.cents)) === '[480,2160,2160]', JSON.stringify([j1.cents, j2.shares]));
ok('重算后净额合计仍为 0', r.data.balances.reduce((a, b) => a + b.net, 0) === 0);
h1 = r.data.expenses.find((e) => e.id === H1);
r = await call('PUT', `/api/t/${key}/rates/HKD`, { rate: '2' }); r = await call('GET', `/api/t/${key}`);
ok('实付人民币不受汇率影响', r.data.expenses.find((e) => e.id === H1).cents === 47012);
r = await call('PUT', `/api/t/${key}/rates/CNY`, { rate: '2' }); ok('人民币汇率不能改', r.status === 400);
r = await call('PUT', `/api/t/${key}/rates/JPY`, { rate: '0' }); ok('汇率 0 被拒', r.status === 400);
// 外币改回人民币
r = await call('PUT', `/api/t/${key}/expenses/${J2}`, { amount: '50', currency: 'CNY', payerId: B, shares: [A, B].map((id) => ({ memberId: id })) });
r = await call('GET', `/api/t/${key}`); j2 = r.data.expenses.find((e) => e.id === J2);
ok('外币改回人民币', j2.currency === 'CNY' && j2.cents === 5000 && j2.origCents === 5000 && j2.rate === 1);

// ===== 导出 Excel =====
r = await call('GET', `/api/t/${key}/export`);
ok('导出 Excel', r.status === 200 && r.ct.includes('spreadsheetml') && r.data.subarray(0, 2).toString() === 'PK', r.status);

// ===== 结算币种 =====
cookie = adminCookie;
r = await call('POST', '/api/admin/trips', { name: 'zz日本', startDay: '2026-12-01', baseCurrency: 'JPY', members: ['zz甲', 'zz乙'] });
ok('建日元结算的游玩', r.status === 200); const jkey = r.data.key; const jid = r.data.id;
cookie = '';
r = await call('GET', `/api/t/${jkey}`); const [JA, JB] = r.data.members.map((m) => m.id);
ok('结算币种 JPY', r.data.trip.base === 'JPY' && r.data.fx.rates.CNY > 1, JSON.stringify(r.data.fx));
r = await call('POST', `/api/t/${jkey}/expenses`, { amount: '3000', payerId: JA, shares: [JA, JB].map((id) => ({ memberId: id })) });
ok('默认币种=结算币种', r.status === 200);
r = await call('POST', `/api/t/${jkey}/expenses`, { amount: '100', currency: 'CNY', rate: '20', payerId: JB, shares: [JA, JB].map((id) => ({ memberId: id })) });
r = await call('GET', `/api/t/${jkey}`);
ok('人民币折日元 100×20=2000', r.data.expenses.find((e) => e.currency === 'CNY')?.cents === 200000 && r.data.expenses.find((e) => e.currency === 'JPY')?.cents === 300000);
ok('toCny 用本次汇率', Math.abs(r.data.trip.toCny - 0.05) < 1e-9, r.data.trip.toCny);
r = await call('POST', `/api/t/${jkey}/expenses`, { amount: '10.5', payerId: JA, shares: [{ memberId: JA }] }); ok('日元不能有小数', r.status === 400);
r = await call('POST', `/api/t/${jkey}/expenses`, { amount: '1000', payerId: JA, shares: [JA, JB].map((id) => ({ memberId: id })).concat([]) });
const J3 = r.data.id;
r = await call('POST', `/api/t/${jkey}/expenses`, { amount: '33.33', currency: 'CNY', payerId: JA, shares: [JA, JB].map((id) => ({ memberId: id })) });
const J4 = r.data.id;
r = await call('GET', `/api/t/${jkey}`);
const j4 = r.data.expenses.find((e) => e.id === J4);
ok('人民币折日元取整', j4.cents === 66700 && j4.shares.every((x) => x.cents % 100 === 0), JSON.stringify(j4));
ok('日元结算净额都是整円', r.data.balances.every((b) => b.net % 100 === 0) && r.data.transfers.every((t) => t.cents % 100 === 0));
r = await call('POST', `/api/t/${jkey}/payments`, { fromId: JA, toId: JB, amount: '1.5' }); ok('日元转账不能有小数', r.status === 400);
for (const id of [J3, J4]) await call('DELETE', `/api/t/${jkey}/expenses/${id}`);
// 换结算币种 JPY → CNY（1 日元 = 0.05 人民币）
r = await call('PUT', `/api/t/${jkey}/base`, { currency: 'CNY', rate: '0.05' });
ok('换结算币种', r.status === 200 && r.data.recomputed === 2, JSON.stringify(r.data));
r = await call('GET', `/api/t/${jkey}`);
const jy = r.data.expenses.find((e) => e.currency === 'JPY'), cn = r.data.expenses.find((e) => e.currency === 'CNY');
ok('换后：日元账 3000×0.05=150，人民币账=100', r.data.trip.base === 'CNY' && jy.cents === 15000 && jy.rate === 0.05 && cn.cents === 10000 && cn.rate === 1, JSON.stringify([jy, cn]));
ok('换后汇率表只剩 JPY', JSON.stringify(Object.keys(r.data.rates)) === '["JPY"]' && r.data.rates.JPY.rate === 0.05);
r = await call('POST', `/api/t/${jkey}/payments`, { fromId: JA, toId: JB, amount: '1' });
r = await call('PUT', `/api/t/${jkey}/base`, { currency: 'USD' }); ok('有转账后不能换', r.status === 400);
cookie = adminCookie;
r = await call('GET', '/api/admin/stats?year=2026'); const jt = r.data.trips.find((t) => t.id === jid);
ok('年度统计折算人民币', jt && jt.total === 25000, JSON.stringify(jt));

// ===== 邀请码 =====
cookie = '';
r = await call('POST', '/api/invite/trips', { code: 'WRONGCODE', name: 'zz邀请', startDay: '2026-12-01' }); ok('错误邀请码 403', r.status === 403);
cookie = adminCookie;
r = await call('POST', '/api/admin/invites', { note: 'zz阿杰' }); ok('生成邀请码', r.status === 200 && r.data.code.length === 10); const inv = r.data;
cookie = '';
r = await call('POST', '/api/invite/trips', { code: inv.code.toLowerCase().replace(/(.{5})/, '$1-'), name: 'zz邀请建的', startDay: '2026-12-02', creator: 'zz阿杰', members: ['zz乙'], baseCurrency: 'HKD' });
ok('凭邀请码建游玩', r.status === 200 && r.data.key && r.data.meId, JSON.stringify(r.data)); const ikey = r.data.key;
r = await call('GET', `/api/t/${ikey}`); ok('创建人自动加入、港币结算', r.data.members.some((m) => m.name === 'zz阿杰') && r.data.trip.base === 'HKD');
r = await call('GET', '/api/admin/invites'); ok('普通人不能看邀请码', r.status === 401);
cookie = adminCookie;
r = await call('GET', '/api/admin/invites'); ok('使用次数', r.data.invites.find((i) => i.id === inv.id)?.uses === 1);
r = await call('GET', '/api/admin/trips'); ok('列表显示邀请人', r.data.trips.find((t) => t.key === ikey)?.inviteNote === 'zz阿杰');
r = await call('DELETE', `/api/admin/invites/${inv.id}`); ok('停用邀请码', r.status === 200);
cookie = '';
r = await call('POST', '/api/invite/trips', { code: inv.code, name: 'zz再来', startDay: '2026-12-02' }); ok('停用后不能用', r.status === 403);
cookie = adminCookie;
for (const k of [jkey, ikey]) { const t = await call('GET', `/api/t/${k}`); await call('DELETE', `/api/admin/trips/${t.data.trip.id}`); }

// 操作记录
r = await call('GET', `/api/t/${key}/log`);
ok('操作记录', r.data.items.some((i) => i.actor === 'zz乙' && /修改了一笔/.test(i.detail)) && r.data.items.some((i) => /锁定/.test(i.detail)));

// 重置链接
r = await call('POST', `/api/admin/trips/${tripId}/rekey`, {}); const newKey = r.data.key;
r = await call('GET', `/api/t/${key}`); ok('旧链接失效', r.status === 404);
r = await call('GET', `/api/t/${newKey}`); ok('新链接可用', r.status === 200);
key = newKey;

// CSRF：非 JSON 被拒
r = await fetch(BASE + `/api/t/${key}/lock`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }); ok('非 JSON 被拒', r.status === 415);

// ===== v4 数据安全 =====
{
  cookie = adminCookie;
  let t = await call('POST', '/api/admin/trips', { name: 'zz回收站', startDay: '2026-11-10', members: ['zz甲', 'zz乙', 'zz丙'] });
  const tk = t.data.key, tid = t.data.id;
  cookie = '';
  let d = (await call('GET', `/api/t/${tk}`)).data; const [m1, m2, m3] = d.members.map((m) => m.id);
  // 并发：10 个人同时第一次用日元记账、各自带不同汇率 → 只能有一个汇率生效，所有账都按它算
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => call('POST', `/api/t/${tk}/expenses`, { amount: String(1000 + i * 7), currency: 'JPY', rate: (0.046 + i / 10000).toFixed(4), payerId: [m1, m2, m3][i % 3],
    shares: [m3, m1, m2].map((id) => ({ memberId: id, weight: 1 })) })));
  ok('并发记账都成功', rs.every((x) => x.status === 200), rs.map((x) => x.status).join());
  d = (await call('GET', `/api/t/${tk}`)).data;
  const rate = d.rates.JPY.rate;
  ok('并发下汇率统一', d.expenses.every((e) => e.rate === rate && e.cents === Math.round(e.origCents * rate)), JSON.stringify(d.expenses.map((e) => e.rate)));
  // 并发改汇率 + 记账
  await Promise.all([call('PUT', `/api/t/${tk}/rates/JPY`, { rate: '0.05' }), call('POST', `/api/t/${tk}/expenses`, { amount: '3000', currency: 'JPY', payerId: m1, shares: [m1, m2].map((id) => ({ memberId: id, weight: 1 })) })]);
  d = (await call('GET', `/api/t/${tk}`)).data;
  ok('并发改汇率后全部按新汇率', d.expenses.length === 11 && d.expenses.every((e) => e.rate === 0.05 && e.cents === Math.round(e.origCents * 0.05)));
  // 删账 → 回收站 → 恢复
  const ex = d.expenses.find((e) => e.origCents === 300000);
  await call('POST', `/api/t/${tk}/expenses/${ex.id}/images`, null, { raw: PNG });
  let r2 = await call('DELETE', `/api/t/${tk}/expenses/${ex.id}`, undefined, { actor: m2 });
  ok('删账', r2.status === 200);
  r2 = await call('GET', `/api/t/${tk}/trash`);
  const tr = r2.data.items[0];
  ok('回收站里有这笔', r2.data.items.length === 1 && tr.kind === 'expense' && tr.deletedBy === 'zz乙', JSON.stringify(r2.data));
  r2 = await call('GET', `/api/t/${key}/trash`); ok('别的游玩看不到', !r2.data.items?.some((i) => i.id === tr.id));
  r2 = await call('POST', `/api/t/${key}/trash/${tr.id}/restore`, {}); ok('不能从别的游玩恢复', r2.status === 404);
  // 删除期间改了汇率，恢复时按现在的汇率重算
  await call('PUT', `/api/t/${tk}/rates/JPY`, { rate: '0.048' });
  r2 = await call('POST', `/api/t/${tk}/trash/${tr.id}/restore`, {}, { actor: m1 });
  ok('恢复', r2.status === 200, JSON.stringify(r2.data));
  d = (await call('GET', `/api/t/${tk}`)).data;
  const back = d.expenses.find((e) => e.id === ex.id);
  ok('恢复后内容、图片、日期都在', back && back.origCents === 300000 && back.images.length === 1 && back.day === ex.day && back.cents === 14400, JSON.stringify(back));
  ok('恢复后分摊平', back.shares.reduce((a, x) => a + x.cents, 0) === back.cents);
  r2 = await call('GET', `/api/t/${tk}/images/${back.images[0]}`); ok('恢复后图片能打开', r2.status === 200);
  r2 = await call('POST', `/api/t/${tk}/trash/${tr.id}/restore`, {}); ok('不能恢复两次', r2.status === 404);
  // 删图 → 恢复
  await call('DELETE', `/api/t/${tk}/images/${back.images[0]}`);
  r2 = await call('GET', `/api/t/${tk}/trash`); const ti = r2.data.items.find((i) => i.kind === 'image');
  ok('删图进回收站', !!ti);
  await call('POST', `/api/t/${tk}/trash/${ti.id}/restore`, {});
  d = (await call('GET', `/api/t/${tk}`)).data;
  ok('恢复图片', d.expenses.find((e) => e.id === ex.id).images.length === 1);
  r2 = await call('GET', `/api/t/${tk}/log`); ok('恢复写进操作记录', r2.data.items.some((i) => /恢复了一笔/.test(i.detail)));
  // 换结算币种后再恢复：按新币种重算
  const ex2 = d.expenses.find((e) => e.origCents === 100000);
  await call('DELETE', `/api/t/${tk}/expenses/${ex2.id}`);
  r2 = await call('PUT', `/api/t/${tk}/base`, { currency: 'JPY', rate: '21' }); ok('换结算币种', r2.status === 200, JSON.stringify(r2.data));
  const tr2 = (await call('GET', `/api/t/${tk}/trash`)).data.items.find((i) => i.kind === 'expense');
  r2 = await call('POST', `/api/t/${tk}/trash/${tr2.id}/restore`, {}); ok('换币种后恢复', r2.status === 200, JSON.stringify(r2.data));
  d = (await call('GET', `/api/t/${tk}`)).data;
  const b2 = d.expenses.find((e) => e.id === ex2.id);
  ok('换币种后恢复按新币种', b2 && b2.currency === 'JPY' && b2.cents === 100000 && b2.rate === 1, JSON.stringify(b2));
  ok('换币种后总账平', d.balances.reduce((a, b) => a + b.net, 0) === 0);
  // 太大的金额被拒，而不是数据库报错
  r2 = await call('POST', `/api/t/${tk}/expenses`, { amount: '9999999', currency: 'USD', rate: '150', payerId: m1, shares: [{ memberId: m1, weight: 1 }] });
  ok('超大金额被拒', r2.status === 400, JSON.stringify(r2.data));
  // 锁定后不能恢复
  const ex3 = d.expenses[0];
  await call('DELETE', `/api/t/${tk}/expenses/${ex3.id}`);
  await call('POST', `/api/t/${tk}/lock`, {});
  const tr3 = (await call('GET', `/api/t/${tk}/trash`)).data.items[0];
  r2 = await call('POST', `/api/t/${tk}/trash/${tr3.id}/restore`, {}); ok('锁定后不能恢复', r2.status === 423);
  // 数据校验
  cookie = adminCookie;
  r2 = await call('GET', '/api/admin/health');
  ok('数据校验通过', r2.status === 200 && r2.data.check.ok, JSON.stringify(r2.data.check?.problems));
  ok('能看到最近备份', !!r2.data.backup?.file);
  cookie = ''; r2 = await call('GET', '/api/admin/health'); ok('非管理员看不到校验', r2.status === 401);
  r2 = await call('GET', '/api/admin/backup/latest'); ok('非管理员不能下载备份', r2.status === 401);
  cookie = adminCookie;
  r2 = await call('GET', '/api/admin/backup/latest'); ok('下载备份', r2.status === 200 && r2.data[0] === 0x1f && r2.data[1] === 0x8b);
  // 删除游玩 → 回收站 → 恢复
  r2 = await call('DELETE', `/api/admin/trips/${tid}`); ok('删除游玩', r2.status === 200);
  r2 = await call('GET', `/api/t/${tk}`); ok('删除后链接打不开', r2.status === 404);
  r2 = await call('GET', '/api/admin/trips'); ok('列表里不显示', !r2.data.trips.some((x) => x.id === tid));
  r2 = await call('GET', '/api/admin/trash'); ok('回收站里有', r2.data.trips.some((x) => x.id === tid && x.count === 10));
  r2 = await call('POST', `/api/admin/trips/${tid}/restore`, {}); ok('恢复游玩', r2.status === 200);
  r2 = await call('GET', `/api/t/${tk}`); ok('恢复后数据都在', r2.status === 200 && r2.data.expenses.length === 10);
  await call('DELETE', `/api/admin/trips/${tid}`);
}

// 删除游玩（连同图片）
r = await call('DELETE', `/api/admin/trips/${tripId}`); ok('删除游玩', r.status === 200);
r = await call('GET', `/api/t/${key}`); ok('删除后 404', r.status === 404);
r = await call('DELETE', `/api/admin/trips/${(await call('GET', `/api/t/${key2}`)).data.trip.id}`);
// 收款码清理
cookie = '';
// 四舍五入：31.95 两人分（各 15.975），首页"待结清"和游玩页结算必须一致
{
  cookie = adminCookie;
  let x = await call('POST', '/api/admin/trips', { name: 'zz四舍五入', startDay: '2026-11-20', members: ['zz甲', 'zz乙'] });
  const k = x.data.key; cookie = '';
  const t0 = (await call('GET', `/api/t/${k}`)).data; const [P, Q] = t0.members.map((m) => m.id);
  await call('POST', `/api/t/${k}/expenses`, { amount: '31.95', payerId: P, day: '2026-11-20', shares: [{ memberId: P, weight: 1 }, { memberId: Q, weight: 1 }] });
  const t1 = (await call('GET', `/api/t/${k}`)).data;
  ok('31.95 两人分：乙应付 15.98（精确 15.975 四舍五入）', JSON.stringify(t1.transfers.map((y) => y.cents)) === '[1598]', JSON.stringify(t1.transfers));
  cookie = adminCookie;
  const list = (await call('GET', '/api/admin/trips')).data.trips;
  ok('首页待结清 = 结算页应收', list.find((y) => y.key === k)?.unsettled === t1.balances.reduce((a, b) => a + (b.net > 0 ? b.net : 0), 0));
  await call('DELETE', `/api/admin/trips/${t1.trip.id}`);
  cookie = '';
}
console.log(`接口测试：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
