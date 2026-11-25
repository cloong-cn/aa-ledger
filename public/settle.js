// 分摊与结算算法：服务器和浏览器共用这一份（浏览器里挂在 window.AASettle）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AASettle = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 一笔钱怎么分：parts = [{memberId, weight, fixed}]，fixed 不为 null 表示指定金额。
  // 先扣掉指定金额，剩下的按份数分；除不尽的几分钱按"最大余数"逐个补给排在前面的人，保证加起来正好等于总额。
  // unit：最小单位（分）。日元没有小数，unit=100，分出来的每一份都是整数円
  function computeShares(cents, parts, unit) {
    unit = unit || 1;
    if (unit > 1) {
      const scaled = computeShares(cents / unit, parts.map((p) => ({ ...p, fixed: p.fixed != null ? p.fixed / unit : null })), 1);
      return scaled.map((x) => ({ ...x, fixed: x.fixed != null ? x.fixed * unit : null, cents: x.cents * unit }));
    }
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
  function distribute(total, amounts, unit) {
    if (unit > 1) return distribute(total / unit, amounts, 1).map((x) => x * unit);
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
  // origUnit / baseUnit：原币和结算币种的最小单位（日元 100，其余 1）
  // 先按 memberId 排好序再算：零头补给谁只取决于成员，跟录入顺序无关，所以任何时候按存下来的份数重算都得到同样结果（数据校验靠这个）
  function splitExpense(origCents, cnyCents, parts, origUnit, baseUnit) {
    const sorted = parts.slice().sort((a, b) => a.memberId - b.memberId);
    const orig = computeShares(origCents, sorted, origUnit);
    const cny = distribute(cnyCents, orig.map((s) => s.cents), baseUnit);
    const byId = new Map(orig.map((s, i) => [s.memberId, { memberId: s.memberId, weight: s.weight, fixed: s.fixed, origCents: s.cents, cents: cny[i] }]));
    return parts.map((p) => byId.get(p.memberId));
  }

  function shareError(msg) { const e = new Error(msg); e.status = 400; return e; }

  // 一笔账里每人"精确"应摊多少（结算币种的分，可能带小数），用分数 {n, d}（BigInt）表示，不丢任何精度。
  // 按份数 / 指定金额的比例来分：份额 = 结算币种总额 × 原币份额 / 原币总额。
  // 旧数据或测试数据里没有份数信息时，就以存下来的分为准。
  function exactShares(e) {
    const sh = e.shares;
    if (!sh.length || sh.some((s) => s.weight == null && s.fixed == null)) return sh.map((s) => ({ memberId: s.memberId, n: BigInt(s.cents), d: 1n }));
    const orig = e.origCents != null ? e.origCents : e.cents;
    const fixedSum = sh.reduce((a, s) => a + (s.fixed != null ? s.fixed : 0), 0);
    const units = sh.map((s) => (s.fixed != null ? 0 : Math.round(s.weight * 100)));
    const W = units.reduce((a, b) => a + b, 0);
    const C = BigInt(e.cents), O = BigInt(orig);
    return sh.map((s, i) => {
      // 原币份额 = fixed，或 (原币总额 - 指定合计) × 份数 / 总份数
      const pn = s.fixed != null ? BigInt(s.fixed) * BigInt(W || 1) : BigInt(orig - fixedSum) * BigInt(units[i]);
      return { memberId: s.memberId, n: C * pn, d: O * BigInt(W || 1) };
    });
  }
  const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
  const addF = (x, y) => { const n = x.n * y.d + y.n * x.d, d = x.d * y.d, g = gcd(n, d); return { n: n / g, d: d / g }; };

  // 结算：先按精确值算出每人"垫付 - 应摊"，再四舍五入到最小单位（分；日元是円），只在最后取整一次，
  // 跟用计算器按精确金额算出来的一致（例如 31.95 两人分，各 15.975，最后差额 8.225 → 8.23）。
  // 极少数情况下（三人以上同时出现半分）四舍五入后加起来不是 0，就把差额从"进位最多"的人身上扣回来，保证一分不多一分不少。
  // 净额 = 上面取整后的结果 + 已转出 - 已收到（正数=别人还欠他，负数=他还要给别人）。
  // 然后让欠得最多的人转给被欠得最多的人，反复配对，转账笔数最多是"人数-1"。
  // unit：结算币种最小单位（日元 100，其余 1）
  function settle(memberIds, expenses, payments, unit) {
    unit = unit || 1;
    const b = new Map(memberIds.map((id) => [id, { memberId: id, paid: 0, share: 0, sent: 0, received: 0, net: 0 }]));
    const get = (id) => { if (!b.has(id)) b.set(id, { memberId: id, paid: 0, share: 0, sent: 0, received: 0, net: 0 }); return b.get(id); };
    const exact = new Map();
    for (const e of expenses) {
      get(e.payerId).paid += e.cents;
      for (const s of exactShares(e)) { get(s.memberId); exact.set(s.memberId, addF(exact.get(s.memberId) || { n: 0n, d: 1n }, s)); }
    }
    for (const p of payments) { get(p.fromId).sent += p.cents; get(p.toId).received += p.cents; }
    const balances = [...b.values()];
    // 精确的"垫付 - 应摊"，四舍五入到 unit
    const U = BigInt(unit);
    const rounded = balances.map((x) => {
      const sh = exact.get(x.memberId) || { n: 0n, d: 1n };
      const n = BigInt(x.paid) * sh.d - sh.n, d = sh.d;               // 精确值 n/d 分
      const neg = n < 0n, a = neg ? -n : n;
      const q = (2n * a + d * U) / (2n * d * U);                       // 绝对值四舍五入到 unit
      const r = Number(neg ? -q * U : q * U);
      const tie = (2n * n) % (d * U) === 0n && n % (d * U) !== 0n;     // 精确值正好是半分（例如 8.225），四舍五入时最容易被问
      return { x, r, tie, ex: Number((n * 1000000n) / d) / 1000000, en: BigInt(r) * d - n, ed: d }; // 取整多算了 en/ed 分（用于极少数的差额修正）
    });
    let sum = rounded.reduce((a, y) => a + y.r, 0);
    if (sum) {
      // 要往下调就先调"进位最多"的人，往上调就先调"舍掉最多"的人；完全一样时按成员编号，结果固定
      const cmp = (p, q) => { const a = p.en * q.ed, b = q.en * p.ed; return a > b ? 1 : a < b ? -1 : 0; };
      const order = rounded.slice().sort((p, q) => (sum > 0 ? cmp(q, p) : cmp(p, q)) || p.x.memberId - q.x.memberId);
      for (let k = 0; sum; k = (k + 1) % order.length) { const s = sum > 0 ? -unit : unit; order[k].r += s; sum += s; }
    }
    // 显示用的应摊：一般 = 垫付 − 取整后的结果（所以表格里「垫付 − 应摊 = 结果」永远对得上）；
    // 只有精确值正好是半分时，显示精确应摊（例如 250.225），让人看得出结果为什么进了一分
    for (const { x, r, tie, ex } of rounded) {
      x.share = tie ? x.paid - ex : x.paid - r;
      x.net = r + x.sent - x.received;
    }

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

  // 各币种的最小单位（以"分"计）：日元没有小数
  const UNITS = { JPY: 100 };
  const unitOf = (cur) => UNITS[cur] || 1;
  // 按最小单位取整
  const roundTo = (cents, unit) => Math.round(cents / unit) * unit;

  return { computeShares, distribute, splitExpense, exactShares, settle, unitOf, roundTo };
});
