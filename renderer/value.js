// Numbers for the Value page: what the games you beat through your
// subscriptions would cost to buy, against what the subscriptions cost.
// The app passes its game list and helpers:
//   markOf(game)     'played' | 'completed' | …
//   myServices(game) services offering it in your plans, lead service first
//   price(game)      { amount, … } in your currency, or null
//   viaSub(game)     whether you played it through a subscription
//   costs            { serviceId: { periods: [{ from: 'YYYY-MM', to: 'YYYY-MM' | null, monthly, plan }] } }
//                    (older saves: { monthly, since }, read as one open period)
(function (root) {
  // Months paid from the start month to this month, both included.
  function monthsSince(since, today) {
    const m = /^(\d{4})-(\d{2})/.exec(since || '');
    const t = /^(\d{4})-(\d{2})/.exec(today);
    if (!m || !t) return 0;
    return Math.max(0, (t[1] - m[1]) * 12 + (t[2] - m[2]) + 1);
  }

  // A plan's paid stretches, oldest first. `to` null: still paying.
  function periodsOf(c) {
    if (!c || typeof c !== 'object') return [];
    const list = Array.isArray(c.periods) ? c.periods : (c.monthly != null || c.since ? [{ from: c.since || null, to: null, monthly: c.monthly }] : []);
    return list.filter((p) => p && typeof p === 'object')
      .map((p) => ({ from: p.from || null, to: p.to || null, monthly: p.monthly == null || p.monthly === '' ? null : Number(p.monthly), ...(p.plan ? { plan: p.plan } : {}) }))
      .sort((a, b) => (a.from || '9999').localeCompare(b.from || '9999'));
  }

  // Months in a period, both ends included; an open one runs to this month.
  function monthsIn(p, today) {
    if (!p.from) return 0;
    const end = p.to && p.to < today.slice(0, 7) ? p.to : today.slice(0, 7);
    return end < p.from ? 0 : monthsSince(p.from, `${end}-01`);
  }

  function compute(games, { markOf, myServices, price, viaSub, costs = {}, today, includePlayed = false }) {
    const counts = (g) => {
      const mark = markOf(g);
      return (mark === 'completed' || (includePlayed && mark === 'played')) && viaSub(g);
    };
    const services = new Map();
    const row = (s) => {
      if (!services.has(s)) services.set(s, { service: s, monthly: null, since: null, months: 0, paid: 0, value: 0, games: 0 });
      return services.get(s);
    };
    for (const [s, c] of Object.entries(costs)) {
      const periods = periodsOf(c).filter((p) => p.monthly > 0);
      if (!periods.length) continue;
      const r = row(s);
      r.periods = periods.map((p) => ({ ...p, months: monthsIn(p, today), paid: p.monthly * monthsIn(p, today) }));
      r.monthly = periods[periods.length - 1].monthly;
      r.since = periods.find((p) => p.from)?.from || null;
      r.months = r.periods.reduce((n, p) => n + p.months, 0);
      r.paid = r.periods.reduce((n, p) => n + p.paid, 0);
      r.active = periods.some((p) => p.from && !p.to);
    }

    const list = [];
    let worth = 0;
    let priced = 0;
    for (const g of games) {
      if (!counts(g)) continue;
      const p = price(g);
      const s = myServices(g)[0] || (g.offers || [g])[0].service;
      const r = row(s);
      r.games += 1;
      if (p?.amount > 0) {
        worth += p.amount;
        priced += 1;
        r.value += p.amount;
      }
      list.push({ game: g, price: p || null, service: s });
    }
    const paid = [...services.values()].reduce((sum, r) => sum + r.paid, 0);
    return {
      worth,
      paid,
      saved: worth - paid,
      games: list.length,
      priced,
      // What each beaten game cost you through subscriptions.
      perGame: list.length && paid ? paid / list.length : null,
      services: [...services.values()].filter((r) => r.paid || r.games).sort((a, b) => b.value - a.value || b.paid - a.paid),
      list: list.sort((a, b) => (b.price?.amount || 0) - (a.price?.amount || 0) || a.game.title.localeCompare(b.game.title)),
    };
  }

  const api = { compute, monthsSince, periodsOf, monthsIn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Value = api;
})(this);
