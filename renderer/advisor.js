// Plan advisor: which subscription to pick up for the games on your To play
// list, for people who rotate plans month to month instead of keeping them all.
// The app passes its game list, services and helpers:
//   services       built-in and custom services with their tiers
//   subscriptions  { serviceId: tierId } for the plans you have
//   markOf(game)   'wishlist' for To play games
//   comingOn(game) arrival date (YYYY-MM-DD) when announced, else null
//   leaving(game)  whether it's leaving soon
//   today          YYYY-MM-DD
(function (root) {
  const HORIZON_DAYS = 31;
  const MONTHS = 4;

  function keysFor(services, subscriptions) {
    const keys = new Set();
    for (const s of services) {
      const tier = s.tiers.find((t) => t.id === subscriptions[s.id]);
      if (tier) tier.includes.forEach((inc) => keys.add(inc.includes(':') ? inc : `${s.id}:${inc}`));
    }
    return keys;
  }

  const offersOf = (g) => g.offers || [g];
  const covers = (g, keys) => offersOf(g).some((o) => (o.tiers || []).some((t) => keys.has(`${o.service}:${t}`)));
  const days = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);

  // Urgent games first: one leaving soon counts extra, one still on its way counts half.
  const score = (o) => o.now.length + o.leaving.length + o.arriving.length / 2;

  function advise(games, { services, subscriptions = {}, markOf, comingOn = () => null, leaving = () => false, today }) {
    const toPlay = games.filter((g) => markOf(g) === 'wishlist');
    const current = keysFor(services, subscriptions);
    const comingIn = (g) => {
      const on = comingOn(g);
      return on && on > today ? days(today, on) : 0;
    };
    // Out now, or arriving within the month.
    const playable = (g) => comingIn(g) <= HORIZON_DAYS;
    const ready = toPlay.filter((g) => !comingIn(g) && covers(g, current));
    const wanted = toPlay.filter((g) => playable(g) && !covers(g, current));

    // Each plan you could take (or upgrade to), with the To play games it adds.
    function optionsFor(pool) {
      const out = [];
      for (const s of services) {
        const found = [];
        s.tiers.forEach((t, rank) => {
          if (subscriptions[s.id] === t.id) return;
          const keys = keysFor(services, { ...subscriptions, [s.id]: t.id });
          const gained = pool.filter((g) => covers(g, keys));
          if (!gained.length) return;
          found.push({
            service: s.id, tier: t.id, rank, games: gained,
            now: gained.filter((g) => !comingIn(g)),
            arriving: gained.filter((g) => comingIn(g)),
            leaving: gained.filter((g) => !comingIn(g) && leaving(g)),
            upgradeFrom: subscriptions[s.id] || null,
          });
        });
        if (!found.length) continue;
        // The tier that adds the most; the lower one when they tie.
        found.sort((a, b) => b.games.length - a.games.length || a.rank - b.rank);
        const best = found[0];
        // A lower tier that still covers part of it.
        const smaller = found.filter((o) => o.rank < best.rank).sort((a, b) => b.games.length - a.games.length)[0];
        out.push({ ...best, smaller: smaller ? { tier: smaller.tier, count: smaller.games.length } : null });
      }
      return out.sort((a, b) => score(b) - score(a) || a.service.localeCompare(b.service));
    }

    const options = optionsFor(wanted);

    // Month by month: take the best plan, play its games, then the next.
    const rotation = [];
    let left = toPlay.filter((g) => !covers(g, current) && comingIn(g) <= HORIZON_DAYS * MONTHS);
    const used = new Set();
    while (left.length && rotation.length < MONTHS) {
      const next = optionsFor(left).find((o) => !used.has(o.service));
      if (!next) break;
      used.add(next.service);
      rotation.push({ service: next.service, tier: next.tier, count: next.games.length });
      const took = new Set(next.games);
      left = left.filter((g) => !took.has(g));
    }

    // Plans you have that no To play game needs, or that a lower tier would cover.
    const pending = toPlay.filter(playable);
    const keep = [];
    for (const s of services) {
      const tierId = subscriptions[s.id];
      if (!tierId) continue;
      const without = keysFor(services, { ...subscriptions, [s.id]: undefined });
      const needs = pending.filter((g) => covers(g, current) && !covers(g, without));
      let lower = null;
      const rank = s.tiers.findIndex((t) => t.id === tierId);
      for (const t of s.tiers.slice(0, Math.max(0, rank))) {
        const keys = keysFor(services, { ...subscriptions, [s.id]: t.id });
        if (needs.length && needs.every((g) => covers(g, keys))) { lower = t.id; break; }
      }
      keep.push({ service: s.id, tier: tierId, needs: needs.length, lower });
    }

    return {
      total: toPlay.length,
      ready: ready.length,
      unavailable: toPlay.filter((g) => playable(g) && !covers(g, current) && !options.some((o) => o.games.includes(g))).length,
      options,
      rotation,
      keep,
    };
  }

  const api = { advise, keysFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Advisor = api;
})(this);
