// Numbers for the Value page: what the games you beat through your
// subscriptions would cost to buy, against what the subscriptions cost.
// The app passes its game list and helpers:
//   markOf(game)     'played' | 'completed' | …
//   myServices(game) services offering it in your plans, lead service first
//   price(game)      { amount, … } in your currency, or null
//   viaSub(game)     whether you played it through a subscription
//   costs            { serviceId: { monthly, since: 'YYYY-MM' } }
(function (root) {
  // Months paid from the start month to this month, both included.
  function monthsSince(since, today) {
    const m = /^(\d{4})-(\d{2})/.exec(since || '');
    const t = /^(\d{4})-(\d{2})/.exec(today);
    if (!m || !t) return 0;
    return Math.max(0, (t[1] - m[1]) * 12 + (t[2] - m[2]) + 1);
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
      const monthly = Number(c?.monthly);
      if (!(monthly > 0)) continue;
      const r = row(s);
      r.monthly = monthly;
      r.since = c.since || null;
      r.months = monthsSince(c.since, today);
      r.paid = monthly * r.months;
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

  const api = { compute, monthsSince };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Value = api;
})(this);
