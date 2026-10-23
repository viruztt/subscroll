// Plan ahead: when you'd get through your To play and Now playing games at
// your pace, and which plan to pay for each month if you rotate plans.
//
//   plan(items, { perDay, today, candidates, months })
//
// items: the games, each
//   { id, hours (left to beat), ready (in the plans you have),
//     plans: Set of candidate plan keys that would add it,
//     from: YYYY-MM-DD when it arrives (or null),
//     deadline: YYYY-MM-DD when it leaves or could leave (or null),
//     playing: true for games you're in the middle of }
// candidates: [{ key, price: { amount, months } | null }], the plans you could
//   take for a month on top of the ones you have.
//
// The plan goes a month (30 days) at a time. Each month it fills your playing
// time with the most urgent games first (ones you've started, then the ones
// leaving soonest, then the shortest), trying each plan and keeping the one
// that gets the most played, weighing games that would otherwise be missed
// double. A game that doesn't fit carries on into the next month.
(function (root) {
  const DAY = 86400000;
  const utc = (iso) => Date.parse(`${iso}T00:00:00Z`);
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const addDays = (d, n) => iso(utc(d) + n * DAY);
  const PERIOD = 30;
  // A plan has to add at least this many hours of play to be worth a month.
  const MIN_HOURS = 3;

  const urgency = (a, b) =>
    (b.playing ? 1 : 0) - (a.playing ? 1 : 0) ||
    (a.deadline || '9999').localeCompare(b.deadline || '9999') ||
    a.left - b.left ||
    String(a.id).localeCompare(String(b.id));

  // How a month would go with `key` (null: only your own plans).
  function trial(pool, key, start, end, budget, perDay) {
    const usable = pool.filter((g) => (g.ready || (key && g.plans.has(key))) && (!g.from || g.from <= end) && (!g.deadline || g.deadline >= start));
    usable.sort(urgency);
    let used = 0;
    let score = 0;
    const steps = [];
    for (const g of usable) {
      if (used >= budget) break;
      // Time before it arrives, or after it leaves, can't go to it.
      const opens = g.from && g.from > start ? ((utc(g.from) - utc(start)) / DAY) * perDay : 0;
      const closes = g.deadline && g.deadline < end ? ((utc(g.deadline) - utc(start)) / DAY + 1) * perDay : budget;
      const room = Math.min(budget, closes) - Math.max(used, opens);
      if (room <= 0) continue;
      const hours = Math.min(g.left, room);
      used = Math.max(used, opens) + hours;
      const finishes = hours >= g.left - 1e-9;
      // Playing a game that would otherwise be missed counts double.
      const urgent = g.deadline && g.deadline <= end;
      if (!g.ready) score += hours * (urgent ? 2 : 1);
      steps.push({ id: g.id, hours, finishes, needsPlan: !g.ready });
    }
    return { key, used, score, steps };
  }

  function plan(items, { perDay, today, candidates = [], months = 12 } = {}) {
    const pool = items.filter((g) => g.hours > 0).map((g) => ({ ...g, plans: g.plans || new Set(), left: g.hours }));
    const reachable = (g) => g.ready || g.plans.size > 0;
    const out = { months: [], missed: [], unreachable: pool.filter((g) => !reachable(g)).map((g) => g.id), finishes: null };
    let todo = pool.filter(reachable);
    const totalHours = todo.reduce((n, g) => n + g.left, 0);
    out.hours = totalHours;
    if (!(perDay > 0)) return out;
    const budget = perDay * PERIOD;
    let start = today;
    for (let m = 0; m < months && todo.length; m += 1) {
      const end = addDays(start, PERIOD - 1);
      const tries = [trial(todo, null, start, end, budget, perDay)];
      for (const c of candidates) {
        if (todo.some((g) => g.plans.has(c.key))) tries.push(trial(todo, c.key, start, end, budget, perDay));
      }
      const cost = (t) => (t.key ? candidates.find((c) => c.key === t.key)?.price?.amount ?? Infinity : 0);
      tries.sort((a, b) => b.score - a.score || cost(a) - cost(b));
      let best = tries[0];
      const ownOnly = tries.find((t) => !t.key);
      // Not worth a plan: only a little more than your own plans give.
      if (best.key && best.score < MIN_HOURS) best = ownOnly;
      for (const s of best.steps) {
        const g = todo.find((x) => x.id === s.id);
        g.left -= s.hours;
        // Started: carry on with it first next month.
        if (!s.finishes) g.playing = true;
      }
      const lastDay = best.used >= budget - 1e-9 ? end : addDays(start, Math.max(0, Math.ceil(best.used / perDay) - 1));
      out.months.push({
        start,
        end,
        key: best.key,
        price: best.key ? candidates.find((c) => c.key === best.key)?.price || null : null,
        hours: best.used,
        budget,
        games: best.steps,
        lastDay,
      });
      todo = todo.filter((g) => g.left > 1e-9);
      const next = addDays(end, 1);
      // Gone before the plan got to them.
      for (const g of todo.filter((x) => x.deadline && x.deadline < next)) {
        out.missed.push({ id: g.id, deadline: g.deadline, left: g.left });
      }
      todo = todo.filter((g) => !(g.deadline && g.deadline < next));
      if (!todo.length) out.finishes = lastDay;
      start = next;
      // Nothing playable this month and nothing arriving: the rest can't be planned.
      if (!best.steps.length && !todo.some((g) => g.from && g.from >= start)) break;
    }
    out.leftOver = todo.map((g) => ({ id: g.id, left: g.left }));
    return out;
  }

  // At `perDay` hours a day, the day `hours` of play would be done.
  function forecast(hours, perDay, today) {
    if (!(perDay > 0) || !(hours > 0)) return null;
    const days = Math.ceil(hours / perDay);
    return { days, date: addDays(today, Math.max(0, days - 1)) };
  }

  const api = { plan, forecast, addDays, PERIOD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Planner = api;
})(this);
