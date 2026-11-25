// 分摊 / 结算算法单元测试
const { computeShares, settle } = require('../public/settle');
let fail = 0, pass = 0;
const eq = (name, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : (fail++, console.log('✗', name, JSON.stringify(a), '!=', JSON.stringify(b))); };
const cents = (r) => r.map((s) => s.cents);
eq('平分整除', cents(computeShares(300, [1, 2, 3].map((id) => ({ memberId: id, weight: 1, fixed: null })))), [100, 100, 100]);
eq('平分有零头', cents(computeShares(100, [1, 2, 3].map((id) => ({ memberId: id, weight: 1, fixed: null })))), [34, 33, 33]);
eq('按份数', cents(computeShares(1000, [{ memberId: 1, weight: 2, fixed: null }, { memberId: 2, weight: 1, fixed: null }, { memberId: 3, weight: 1, fixed: null }])), [500, 250, 250]);
eq('指定+平分', cents(computeShares(1000, [{ memberId: 1, weight: 0, fixed: 100 }, { memberId: 2, weight: 1, fixed: null }, { memberId: 3, weight: 1, fixed: null }])), [100, 450, 450]);
eq('全指定', cents(computeShares(300, [{ memberId: 1, weight: 0, fixed: 100 }, { memberId: 2, weight: 0, fixed: 200 }])), [100, 200]);
let err = null; try { computeShares(300, [{ memberId: 1, weight: 0, fixed: 400 }]); } catch (e) { err = e.message; } eq('指定超额报错', !!err, true);
err = null; try { computeShares(300, [{ memberId: 1, weight: 0, fixed: 100 }]); } catch (e) { err = e.message; } eq('指定不足报错', !!err, true);
// 求和恒等
for (let i = 0; i < 2000; i++) {
  const n = 1 + Math.floor(Math.random() * 8), c = 1 + Math.floor(Math.random() * 1e6);
  const parts = Array.from({ length: n }, (_, k) => ({ memberId: k + 1, weight: [0.5, 1, 1.5, 2, 3][Math.floor(Math.random() * 5)], fixed: null }));
  const s = computeShares(c, parts).reduce((a, x) => a + x.cents, 0);
  if (s !== c) { fail++; console.log('✗ 求和', c, parts, s); break; }
}
pass++;
// 结算：A 付 300 三人分，B 付 60 三人分
const ex = [{ payerId: 1, cents: 300, shares: [1, 2, 3].map((m) => ({ memberId: m, cents: 100 })) }, { payerId: 2, cents: 60, shares: [1, 2, 3].map((m) => ({ memberId: m, cents: 20 })) }];
let r = settle([1, 2, 3], ex, []);
eq('净额', r.balances.map((b) => b.net), [180, -60, -120]);
eq('转账', r.transfers, [{ fromId: 3, toId: 1, cents: 120 }, { fromId: 2, toId: 1, cents: 60 }]);
r = settle([1, 2, 3], ex, [{ fromId: 3, toId: 1, cents: 120 }]);
eq('部分已转', r.transfers, [{ fromId: 2, toId: 1, cents: 60 }]);
r = settle([1, 2, 3], ex, [{ fromId: 3, toId: 1, cents: 120 }, { fromId: 2, toId: 1, cents: 60 }]);
eq('全部结清', r.transfers, []);
// 随机：转账笔数 ≤ n-1，且执行后全为 0
for (let i = 0; i < 500; i++) {
  const n = 2 + Math.floor(Math.random() * 7), ids = Array.from({ length: n }, (_, k) => k + 1);
  const exps = Array.from({ length: 1 + Math.floor(Math.random() * 10) }, () => {
    const c = 1 + Math.floor(Math.random() * 50000);
    const who = ids.filter(() => Math.random() < 0.7); if (!who.length) who.push(1);
    return { payerId: ids[Math.floor(Math.random() * n)], cents: c, shares: computeShares(c, who.map((m) => ({ memberId: m, weight: 1, fixed: null }))) };
  });
  const a = settle(ids, exps, []);
  const b = settle(ids, exps, a.transfers);
  if (a.transfers.length > n - 1 || b.balances.some((x) => x.net !== 0)) { fail++; console.log('✗ 随机结算', JSON.stringify(exps)); break; }
}
pass++;
// 多币种：按原币份额折算人民币，总和不差一分
const { splitExpense, distribute } = require('../public/settle');
eq('日元三人分', splitExpense(300000, 14246, [1, 2, 3].map((id) => ({ memberId: id, weight: 1, fixed: null }))).map((x) => x.cents), [4749, 4749, 4748]);
eq('大数不溢出', distribute(999999999, [999999999, 1, 1]), [999999997, 1, 1]);
eq('全 0 份额', distribute(100, [0, 0]), [100, 0]);
for (let i = 0; i < 2000; i++) {
  const n = 1 + Math.floor(Math.random() * 8), o = 1 + Math.floor(Math.random() * 1e9), c = 1 + Math.floor(Math.random() * 1e8);
  const r = splitExpense(o, c, Array.from({ length: n }, (_, k) => ({ memberId: k + 1, weight: 1 + (k % 3), fixed: null })));
  if (r.reduce((a, x) => a + x.cents, 0) !== c || r.reduce((a, x) => a + x.origCents, 0) !== o) { fail++; console.log('✗ 折算求和', o, c); break; }
}
pass++;
eq('日元整円分摊', computeShares(100000, [1, 2, 3].map((id) => ({ memberId: id, weight: 1, fixed: null })), 100).map((x) => x.cents), [33400, 33300, 33300]);
eq('人民币折日元整円', splitExpense(1000, 47700, [1, 2, 3].map((id) => ({ memberId: id, weight: 1, fixed: null })), 1, 100).map((x) => x.cents), [15900, 15900, 15900]);
eq('日元结算零头', splitExpense(1000, 47800, [1, 2, 3].map((id) => ({ memberId: id, weight: 1, fixed: null })), 1, 100).map((x) => x.cents), [16000, 15900, 15900]);

// ===== 随机对拍：大量随机账目，检查各项"不变量"（任何一条不成立都说明算法有 bug） =====
{
  const { distribute } = require('../public/settle');
  let seed = 20261125; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const bad = (msg, x) => { fail++; console.log('✗', msg, JSON.stringify(x)); };
  let n1 = 0;
  for (let i = 0; i < 20000 && n1 < 1; i++) {
    const ou = pick([1, 1, 100]), bu = pick([1, 1, 100]);
    const n = 1 + Math.floor(rnd() * 10);
    const orig = (1 + Math.floor(rnd() * 500000)) * ou;
    const ids = Array.from({ length: n }, (_, k) => 1 + k * 7 + Math.floor(rnd() * 5));
    // 部分人指定金额（不超过总额），至少留一个人按份数分
    let room = orig;
    const parts = ids.map((id, k) => {
      if (k > 0 && rnd() < 0.25) { const f = Math.floor((rnd() * room) / 3 / ou) * ou; room -= f; return { memberId: id, weight: 0, fixed: f }; }
      return { memberId: id, weight: pick([0.5, 1, 1, 1, 1.5, 2, 3, 0.33]), fixed: null };
    });
    const base = Math.max(bu, Math.round((orig * pick([1, 0.0466, 21.4, 0.21, 4.6, 0.92])) / bu) * bu);
    const r = splitExpense(orig, base, parts, ou, bu);
    const so = r.reduce((a, x) => a + x.origCents, 0), sb = r.reduce((a, x) => a + x.cents, 0);
    if (so !== orig || sb !== base) { bad('分摊总和不等于总额', { orig, base, parts }); n1++; }
    else if (r.some((x) => x.cents < 0 || x.origCents < 0 || x.cents % bu || x.origCents % ou)) { bad('出现负数或不是整单位', { orig, base, parts, r }); n1++; }
    else if (r.some((x, k) => parts[k].fixed != null && x.origCents !== parts[k].fixed)) { bad('指定金额没被照顾到', { parts, r }); n1++; }
    else {
      // 与录入顺序无关：打乱后再算，每个人分到的必须完全一样
      const shuffled = parts.slice().sort(() => rnd() - 0.5);
      const r2 = new Map(splitExpense(orig, base, shuffled, ou, bu).map((x) => [x.memberId, x]));
      if (r.some((x) => r2.get(x.memberId).cents !== x.cents || r2.get(x.memberId).origCents !== x.origCents)) { bad('结果跟录入顺序有关', { parts }); n1++; }
      // 公平：同样份数的人，分到的差距不超过 1 个最小单位
      const w1 = r.filter((x, k) => parts[k].fixed == null && parts[k].weight === 1).map((x) => x.origCents);
      if (w1.length > 1 && Math.max(...w1) - Math.min(...w1) > ou) { bad('同样份数的人分得不均', { parts, r }); n1++; }
    }
  }
  pass++;
  // 结算：随机多笔账 + 随机已转，建议的转账执行后所有人都清零，笔数 ≤ 人数-1
  let n2 = 0;
  for (let i = 0; i < 3000 && !n2; i++) {
    const n = 2 + Math.floor(rnd() * 12), ids = Array.from({ length: n }, (_, k) => k + 1);
    const exps = Array.from({ length: 1 + Math.floor(rnd() * 15) }, () => {
      const who = ids.filter(() => rnd() < 0.7); if (!who.length) who.push(ids[0]);
      const c = 1 + Math.floor(rnd() * 200000);
      const sh = computeShares(c, who.map((id) => ({ memberId: id, weight: pick([1, 1, 2]), fixed: null })));
      return { payerId: pick(ids), cents: c, shares: sh.map((x) => ({ memberId: x.memberId, cents: x.cents })) };
    });
    const pays = rnd() < 0.5 ? [] : [{ fromId: 1, toId: 2, cents: 1 + Math.floor(rnd() * 5000) }];
    const { balances, transfers } = settle(ids, exps, pays);
    if (balances.reduce((a, b) => a + b.net, 0) !== 0) { bad('净额加起来不是 0', { exps }); n2++; break; }
    if (transfers.length > n - 1 || transfers.some((t) => t.cents <= 0 || t.fromId === t.toId)) { bad('转账笔数或金额不对', transfers); n2++; break; }
    const after = settle(ids, exps, [...pays, ...transfers]);
    if (after.transfers.length || after.balances.some((b) => b.net !== 0)) { bad('按建议转完后没清零', { exps, transfers }); n2++; }
  }
  pass++;
  // 大金额不溢出（BigInt 按比例分）
  const big = distribute(999999999, [333333333, 333333333, 333333334], 1);
  eq('大金额按比例分', [big.reduce((a, b) => a + b, 0), big.every((x) => Number.isSafeInteger(x))], [999999999, true]);
  eq('录入顺序无关（固定例子）', splitExpense(100, 100, [3, 1, 2].map((id) => ({ memberId: id, weight: 1, fixed: null })), 1, 1).map((x) => [x.memberId, x.cents]), [[3, 33], [1, 34], [2, 33]]);
}
console.log(`算法测试：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
