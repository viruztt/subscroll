// Numbers for the Statistics page. The app passes its merged game list and
// a few helpers, so this stays plain arithmetic (and testable):
//   markOf(game)     'played' | 'completed' | 'ignored' | 'wishlist' | 'none'
//   myServices(game) services offering it in your plans, lead service first
//   hours(game)      How Long To Beat main-story hours, or null
//   score(game)      Metacritic score, or null
(function (root) {
  const OTHER = 'other'; // marked games that aren't in any of your plans

  // Platforms, grouped the way people own them. Switch Online's games are
  // listed under their original systems (NES, Game Boy...) but you play
  // them on a Switch.
  const PLATFORMS = ['xbox', 'pc', 'playstation', 'switch', 'mobile', 'vr', 'cloud', 'other'];
  function platformOf(p) {
    const s = String(p || '').trim();
    if (/^console$|xbox/i.test(s)) return 'xbox';
    if (/^pc$|windows/i.test(s)) return 'pc';
    if (/^ps\d|playstation|psvr/i.test(s)) return 'playstation';
    if (/switch/i.test(s)) return 'switch';
    if (/mobile|apple devices|ios|android|iphone|ipad/i.test(s)) return 'mobile';
    if (/quest|\bvr\b/i.test(s)) return 'vr';
    if (/cloud/i.test(s)) return 'cloud';
    return s ? 'other' : null;
  }
  function platformsOf(g) {
    const out = new Set();
    for (const o of g.offers || [g]) {
      if (o.service === 'nso') out.add('switch');
      else for (const p of o.platforms || []) out.add(platformOf(p));
    }
    out.delete(null);
    return out;
  }

  function compute(games, { markOf, myServices, hours, score, subscribed = [] }) {
    const totals = { inPlans: 0, completed: 0, played: 0, ignored: 0 };
    // Games in your plans, by status.
    const plans = { completed: 0, played: 0, wishlist: 0, ignored: 0, untouched: 0 };
    // The games behind each number, for listing them when a chart is clicked.
    const planGames = { completed: [], played: [], wishlist: [], ignored: [], untouched: [] };
    const completedGames = new Map();
    const genreGames = new Map();
    const services = new Map(subscribed.map((s) => [s, { service: s, inPlans: 0, played: 0, completed: 0 }]));
    // Per platform: a game on several counts for each.
    const platforms = new Map();
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
        planGames[mark === 'none' ? 'untouched' : mark]?.push(g);
        if (g.steam) steamOwned += 1;
      }
      for (const p of platformsOf(g)) {
        if (!platforms.has(p)) platforms.set(p, { platform: p, inPlans: 0, played: 0, completed: 0 });
        const row = platforms.get(p);
        if (mine.length) row.inPlans += 1;
        if (mark === 'played' || mark === 'completed') row[mark] += 1;
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
        if (!completedGames.has(s)) completedGames.set(s, []);
        completedGames.get(s).push(g);
        for (const genre of g.genreTags || []) {
          genres.set(genre, (genres.get(genre) || 0) + 1);
          if (!genreGames.has(genre)) genreGames.set(genre, []);
          genreGames.get(genre).push(g);
        }
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
      planGames,
      // Completed out of everything you've started.
      finishRate: totals.completed + totals.played ? totals.completed / (totals.completed + totals.played) : null,
      services: [...services.values()].sort((a, b) => b.inPlans - a.inPlans),
      platforms: [...platforms.values()].sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform)),
      completedBy: [...completedBy].sort(byCount).map(([service, count]) => ({ service, count, games: completedGames.get(service) })),
      genres: [...genres].sort(byCount).map(([genre, count]) => ({ genre, count, games: genreGames.get(genre) })),
      time,
      averageScore: scored ? Math.round(scoreSum / scored) : null,
      steamOwned,
    };
  }

  const api = { compute, OTHER, PLATFORMS, platformOf, platformsOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Stats = api;
})(this);
