// Goals on the Statistics page, such as "beat 2 games a month": progress in
// the current week, month or year, the streak of periods in a row you met
// it, and your best streak. They count games by the day you marked them
// completed (finishedOn), which the app records from now on; games you'd
// completed before can be given a date in their details.
//   goal:     { id, count, unit: 'games' | 'hours', per: 'week' | 'month' | 'year', since: 'YYYY-MM-DD' }
//   finished: [{ id, date: 'YYYY-MM-DD', hours }] (hours: How Long To Beat, or null)
(function (root) {
  const DAY = 86400000;
  const utc = (iso) => new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const iso = (d) => d.toISOString().slice(0, 10);

  // The start of the week (Monday), month or year a day falls in.
  function periodStart(date, per) {
    const d = utc(date);
    if (per === 'year') return `${date.slice(0, 4)}-01-01`;
    if (per === 'month') return `${date.slice(0, 7)}-01`;
    const back = (d.getUTCDay() + 6) % 7;
    return iso(new Date(d - back * DAY));
  }

  function nextStart(start, per) {
    const d = utc(start);
    if (per === 'year') return `${d.getUTCFullYear() + 1}-01-01`;
    if (per === 'month') return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
    return iso(new Date(d.getTime() + 7 * DAY));
  }

  // Ids that became completed get today's date; ids no longer completed lose theirs.
  function stampFinished(finishedOn = {}, before = {}, after = {}, today) {
    const out = { ...finishedOn };
    for (const [id, mark] of Object.entries(after)) {
      if (mark === 'completed' && before[id] !== 'completed' && !out[id]) out[id] = today;
    }
    for (const id of Object.keys(out)) if (after[id] !== 'completed') delete out[id];
    return out;
  }

  const amountOf = (goal, list) => (goal.unit === 'hours' ? list.reduce((t, f) => t + (Number(f.hours) || 0), 0) : list.length);

  // Periods from the first finish (or the goal's start) to now, with what
  // you did in each; the last one is the current, unfinished period.
  function progress(goal, finished, today) {
    const per = goal.per || 'month';
    const target = Math.max(1, Number(goal.count) || 1);
    const dated = finished.filter((f) => f.date && f.date <= today);
    const first = [goal.since || today, ...dated.map((f) => f.date)].sort()[0];
    const periods = [];
    for (let start = periodStart(first, per); start <= today; start = nextStart(start, per)) {
      const end = nextStart(start, per);
      const inside = dated.filter((f) => f.date >= start && f.date < end);
      const done = amountOf(goal, inside);
      periods.push({ start, end, done, met: done >= target, games: inside.map((f) => f.id) });
    }
    const current = periods[periods.length - 1];
    // The current period counts once it's met; until then the streak runs to the last one.
    let streak = 0;
    for (let i = periods.length - (current.met ? 1 : 2); i >= 0 && periods[i].met; i--) streak += 1;
    let best = 0;
    let run = 0;
    for (const p of periods) {
      run = p.met ? run + 1 : 0;
      best = Math.max(best, run);
    }
    return {
      target,
      current: { ...current, left: Math.round((utc(current.end) - utc(today)) / DAY) },
      streak,
      best,
      history: periods,
    };
  }

  const api = { progress, stampFinished, periodStart, nextStart };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Goals = api;
})(this);
