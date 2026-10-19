// Cheapest way to play a game you want: your plans, a month (or the shortest
// payment) of a plan that has it, buying it, or waiting until it joins a plan
// you already pay for. The app passes:
//   services       built-in services with their tiers
//   subscriptions  { serviceId: tierId } for the plans you have
//   planOptions(service)  the service's list prices in your currency, each
//                  { plan, tier, months, amount, name, length, unsure }
//                  (tier: which of the app's tiers that plan unlocks)
//   price          the game's store price in your currency or null:
//                  { amount, sale, saleEnds, source }
//   owned          you already own it (on Steam)
//   comingOn       its arrival date when it isn't out yet (YYYY-MM-DD)
//   today          YYYY-MM-DD
// Returns the ways, cheapest first: { kind: 'owned' | 'included' | 'wait' |
// 'plan' | 'buy', cost, ... }.
(function (root) {
  const offersOf = (g) => g.offers || [g];

  function keysFor(services, subscriptions) {
    const keys = new Set();
    for (const s of services) {
      const tier = s.tiers.find((t) => t.id === subscriptions[s.id]);
      if (tier) tier.includes.forEach((inc) => keys.add(inc.includes(':') ? inc : `${s.id}:${inc}`));
    }
    return keys;
  }
  // "eaplay:eaplay@pc": a plan that includes only a tier's PC games.
  const covers = (g, keys) => offersOf(g).some((o) => (o.tiers || []).some((t) => keys.has(`${o.service}:${t}`) || (o.platforms || []).some((p) => keys.has(`${o.service}:${t}@${p}`))));

  const days = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
  // Free now, then free later, then the rest; buying beats a plan at the same price (you keep it).
  const RANK = { owned: 0, included: 1, wait: 2, buy: 3, plan: 4 };

  function ways(g, { services = [], subscriptions = {}, planOptions = () => [], price = null, owned = false, comingOn = null, today }) {
    const out = [];
    const later = comingOn && today && comingOn > today ? comingOn : null;
    if (owned) out.push({ kind: 'owned', cost: 0 });
    const current = keysFor(services, subscriptions);
    if (covers(g, current)) {
      if (!later) {
        out.push({ kind: 'included', cost: 0 });
        return out.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
      }
      out.push({ kind: 'wait', cost: 0, on: later, days: days(today, later) });
    }

    // The cheapest plan of each service that has it, on its own.
    for (const s of services) {
      const shortest = new Map();
      for (const o of planOptions(s) || []) {
        if (!(o.amount > 0) || !o.tier) continue;
        const prev = shortest.get(o.plan);
        if (!prev || o.months < prev.months) shortest.set(o.plan, o);
      }
      let best = null;
      for (const o of shortest.values()) {
        if (!covers(g, keysFor(services, { [s.id]: o.tier }))) continue;
        if (!best || o.amount < best.amount || (o.amount === best.amount && o.months > best.months)) best = o;
      }
      if (!best || (later && covers(g, current))) continue;
      const have = subscriptions[s.id];
      out.push({
        kind: 'plan',
        cost: best.amount,
        service: s.id,
        tier: best.tier,
        plan: best.plan,
        name: best.name,
        months: best.months,
        length: best.length,
        upgrade: !!have && have !== best.tier,
        ...(later ? { on: later, days: days(today, later) } : {}),
        ...(best.unsure ? { unsure: true } : {}),
      });
    }

    if (price && price.amount > 0) {
      const onSale = price.sale > 0 && price.sale < price.amount;
      out.push({
        kind: 'buy',
        cost: onSale ? price.sale : price.amount,
        full: price.amount,
        ...(onSale ? { sale: true, off: Math.round((1 - price.sale / price.amount) * 100), saleEnds: price.saleEnds || null } : {}),
        source: price.source || null,
        url: price.url || null,
      });
    }
    return out.sort((a, b) => a.cost - b.cost || RANK[a.kind] - RANK[b.kind] || (a.days || 0) - (b.days || 0));
  }

  const api = { ways, keysFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Cheapest = api;
})(this);
