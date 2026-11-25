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
console.log(`算法测试：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
