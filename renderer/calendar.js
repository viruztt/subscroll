// The Calendar page: what arrives in and leaves the services on each day of
// a month, plus free-to-keep giveaways starting and ending. Dates come from
// the lists themselves (announced arrivals, join dates, departures) and from
// what each refresh noticed.
//   games     catalogue games (merged cards)
//   departed  games that left a service, with leftOn
//   free      giveaways { start, end, upcoming }
//   comingOn(g)  announced arrival date when still to come, else null
//   addedOn(g)   date it joined, when known
(function (root) {
  // Monday-first weeks covering the month: [{ iso, inMonth }].
  function monthGrid(month) {
    const [y, m] = month.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const lead = (first.getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells = Math.ceil((lead + days) / 7) * 7;
    const out = [];
    for (let i = 0; i < cells; i++) {
      const d = new Date(Date.UTC(y, m - 1, 1 - lead + i));
      out.push({ iso: d.toISOString().slice(0, 10), inMonth: d.getUTCMonth() === m - 1 });
    }
    return out;
  }

  function shiftMonth(month, by) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + by, 1));
    return d.toISOString().slice(0, 7);
  }

  const KIND_ORDER = { coming: 0, added: 1, left: 2, 'free-start': 3, 'free-end': 4 };

  // day (YYYY-MM-DD) -> events, for the days from `from` to `to` (inclusive).
  function events({ games = [], departed = [], free = [], comingOn = () => null, addedOn = () => null, from, to }) {
    const days = new Map();
    const add = (iso, kind, item) => {
      const day = iso && iso.slice(0, 10);
      if (!day || day < from || day > to) return;
      if (!days.has(day)) days.set(day, []);
      days.get(day).push({ kind, item });
    };
    for (const g of games) {
      const on = comingOn(g);
      if (on) add(on, 'coming', g);
      else add(addedOn(g), 'added', g);
    }
    const seen = new Set();
    for (const d of departed) {
      // The same game can leave two lists on the same day (console and PC).
      const k = `${d.leftOn}|${d.title}`;
      if (!d.leftOn || seen.has(k)) continue;
      seen.add(k);
      add(d.leftOn, 'left', d);
    }
    for (const f of free) {
      if (f.upcoming) add(f.start, 'free-start', f);
      if (f.end) add(f.end, 'free-end', f);
    }
    for (const list of days.values()) list.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.item.title.localeCompare(b.item.title));
    return days;
  }

  const api = { monthGrid, shiftMonth, events };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Calendar = api;
})(this);
