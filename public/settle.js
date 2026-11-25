// 分摊与结算算法：服务器和浏览器共用这一份（浏览器里挂在 window.AASettle）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AASettle = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 一笔钱怎么分：parts = [{memberId, weight, fixed}]，fixed 不为 null 表示指定金额。
  // 先扣掉指定金额，剩下的按份数分；除不尽的几分钱按"最大余数"逐个补给排在前面的人，保证加起来正好等于总额。
  function computeShares(cents, parts) {
    const fixedSum = parts.reduce((a, p) => a + (p.fixed != null ? p.fixed : 0), 0);
    if (fixedSum > cents) throw shareError('指定金额加起来超过了总额');
    const rest = cents - fixedSum;
    const weighted = parts.filter((p) => p.fixed == null);
    const units = weighted.map((p) => Math.round(p.weight * 100));
    const W = units.reduce((a, b) => a + b, 0);
    if (rest > 0 && W === 0) throw shareError('指定金额加起来不等于总额，还差 ' + (rest / 100).toFixed(2) + ' 元没人分');
    const out = new Map();
    if (W > 0) {
      const base = units.map((u) => Math.floor((rest * u) / W));
      let left = rest - base.reduce((a, b) => a + b, 0);
      const order = units.map((u, i) => ({ i, r: (rest * u) % W })).sort((a, b) => b.r - a.r || a.i - b.i);
      for (let k = 0; left > 0; k = (k + 1) % order.length, left--) base[order[k].i] += 1;
      weighted.forEach((p, i) => out.set(p.memberId, base[i]));
    }
    return parts.map((p) => ({
      memberId: p.memberId,
      weight: p.fixed != null ? 0 : p.weight,
      fixed: p.fixed != null ? p.fixed : null,
      cents: p.fixed != null ? p.fixed : out.get(p.memberId),
    }));
  }
  // 按比例把 total 分成若干份（amounts 是各自的原币金额），用 BigInt 防溢出，零头按最大余数补，保证加起来正好等于 total
  function distribute(total, amounts) {
    const A = amounts.reduce((a, b) => a + b, 0);
    if (A === 0) { const out = amounts.map(() => 0); if (out.length) out[0] = total; return out; }
    const T = BigInt(total), BA = BigInt(A);
    const base = amounts.map((a) => Number((T * BigInt(a)) / BA));
    let left = total - base.reduce((a, b) => a + b, 0);
    const order = amounts.map((a, i) => ({ i, r: (T * BigInt(a)) % BA })).sort((x, y) => (y.r > x.r ? 1 : y.r < x.r ? -1 : x.i - y.i));
    for (let k = 0; left > 0; k = (k + 1) % order.length, left--) base[order[k].i] += 1;
    return base;
  }

  // 外币账：先按原币分摊（origCents 总额），再把人民币总额 cnyCents 按各人原币份额折算。
  // 返回 [{memberId, weight, fixed, origCents, cents}]，fixed 是原币指定金额
  function splitExpense(origCents, cnyCents, parts) {
    const orig = computeShares(origCents, parts);
    const cny = distribute(cnyCents, orig.map((s) => s.cents));
    return orig.map((s, i) => ({ memberId: s.memberId, weight: s.weight, fixed: s.fixed, origCents: s.cents, cents: cny[i] }));
  }

  function shareError(msg) { const e = new Error(msg); e.status = 400; return e; }

  // 结算：每人净额 = 垫付 - 应摊 + 已转出 - 已收到（正数=别人还欠他，负数=他还要给别人）。
  // 然后让欠得最多的人转给被欠得最多的人，反复配对，转账笔数最多是"人数-1"。
  function settle(memberIds, expenses, payments) {
    const b = new Map(memberIds.map((id) => [id, { memberId: id, paid: 0, share: 0, sent: 0, received: 0, net: 0 }]));
    const get = (id) => { if (!b.has(id)) b.set(id, { memberId: id, paid: 0, share: 0, sent: 0, received: 0, net: 0 }); return b.get(id); };
    for (const e of expenses) {
      get(e.payerId).paid += e.cents;
      for (const s of e.shares) get(s.memberId).share += s.cents;
    }
    for (const p of payments) { get(p.fromId).sent += p.cents; get(p.toId).received += p.cents; }
    const balances = [...b.values()];
    for (const x of balances) x.net = x.paid - x.share + x.sent - x.received;

    const debtors = balances.filter((x) => x.net < 0).map((x) => ({ id: x.memberId, amt: -x.net }));
    const creditors = balances.filter((x) => x.net > 0).map((x) => ({ id: x.memberId, amt: x.net }));
    const byAmt = (a, b2) => b2.amt - a.amt || a.id - b2.id;
    const transfers = [];
    while (debtors.length && creditors.length) {
      debtors.sort(byAmt); creditors.sort(byAmt);
      const d = debtors[0], c = creditors[0];
      const amt = Math.min(d.amt, c.amt);
      transfers.push({ fromId: d.id, toId: c.id, cents: amt });
      d.amt -= amt; c.amt -= amt;
      if (!d.amt) debtors.shift();
      if (!c.amt) creditors.shift();
    }
    return { balances, transfers };
  }

  return { computeShares, distribute, splitExpense, settle };
});
