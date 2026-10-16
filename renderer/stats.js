// Numbers for the Statistics page. The app passes its merged game list and
// a few helpers, so this stays plain arithmetic (and testable):
//   markOf(game)     'played' | 'completed' | 'ignored' | 'none'
//   myServices(game) services offering it in your plans, lead service first
//   hours(game)      How Long To Beat main-story hours, or null
//   score(game)      Metacritic score, or null
(function (root) {
  const OTHER = 'other'; // marked games that aren't in any of your plans

  function compute(games, { markOf, myServices, hours, score, subscribed = [] }) {
    const totals = { inPlans: 0, completed: 0, played: 0, ignored: 0 };
    // Games in your plans, by status.
    const plans = { completed: 0, played: 0, ignored: 0, untouched: 0 };
    const services = new Map(subscribed.map((s) => [s, { service: s, inPlans: 0, played: 0, completed: 0 }]));
    const completedBy = new Map();
    const genres = new Map();
    const time = { completed: 0, completedTimed: 0, playing: 0, playingTimed: 0 };
    let scoreSum = 0;
    let scored = 0;
    let steamOwned = 0;

    for (const g of games) {
      const mark = markOf(g);
      const mine = myServices(g);
      if (mark in totals) totals[mark] += 1;
      if (mine.length) {
        totals.inPlans += 1;
        plans[mark === 'none' ? 'untouched' : mark] += 1;
        if (g.steam) steamOwned += 1;
      }
      // Per service, a game in two of your services counts for both.
      for (const s of mine) {
        const row = services.get(s);
        if (!row) continue;
        row.inPlans += 1;
        if (mark === 'played' || mark === 'completed') row[mark] += 1;
      }
      const h = hours(g);
      if (mark === 'completed') {
        // In the pie, each game belongs to one service, so the slices add up.
        const s = mine[0] || OTHER;
        completedBy.set(s, (completedBy.get(s) || 0) + 1);
        for (const genre of g.genreTags || []) genres.set(genre, (genres.get(genre) || 0) + 1);
        if (h != null) {
          time.completed += h;
          time.completedTimed += 1;
        }
        const sc = score(g);
        if (sc != null) {
          scoreSum += sc;
          scored += 1;
        }
      } else if (mark === 'played' && h != null) {
        time.playing += h;
        time.playingTimed += 1;
      }
    }

    const byCount = (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]));
    return {
      totals,
      plans,
      // Completed out of everything you've started.
      finishRate: totals.completed + totals.played ? totals.completed / (totals.completed + totals.played) : null,
      services: [...services.values()].sort((a, b) => b.inPlans - a.inPlans),
      completedBy: [...completedBy].sort(byCount).map(([service, count]) => ({ service, count })),
      genres: [...genres].sort(byCount).map(([genre, count]) => ({ genre, count })),
      time,
      averageScore: scored ? Math.round(scoreSum / scored) : null,
      steamOwned,
    };
  }

  const api = { compute, OTHER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Stats = api;
})(this);
