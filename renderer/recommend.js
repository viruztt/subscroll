// Picks games to suggest from the plans you have, for onboarding and the
// For you page. Each pick carries the reasons it was chosen. The app passes:
//   isMine(game), markOf(game), isComing(game), score(game) (Metacritic or
//   null), hours(game) (How Long To Beat or null), genres(game) (canonical
//   names), today ('YYYY-MM-DD')
//   tastes: { genres: [...], length: 'any' | 'short' | 'long' }
(function (root) {
  const DAY = 86400000;
  const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / DAY);

  function reasonsFor(g, h, tastes, today) {
    const out = [];
    const liked = h.genres(g).filter((x) => tastes.genres.includes(x));
    if (liked.length) out.push({ id: 'genre', label: liked.slice(0, 2).join(' + '), weight: 3 + Math.min(liked.length - 1, 1) });
    const score = h.score(g);
    if (score >= 85) out.push({ id: 'score', label: `Metacritic ${score}`, weight: 2.5 });
    else if (score >= 75) out.push({ id: 'score', label: `Metacritic ${score}`, weight: 1.2 });
    if (g.leavingSoon) out.push({ id: 'leaving', label: 'Leaving soon', weight: 1.5 });
    if (g.firstSeen && daysBetween(g.firstSeen, today) <= 30) out.push({ id: 'new', label: 'Just added', weight: 1.2 });
    const hours = h.hours(g);
    if (hours != null && tastes.length === 'short' && hours <= 10) out.push({ id: 'length', label: `${Math.max(1, Math.round(hours))}h to beat`, weight: 1.5 });
    if (hours != null && tastes.length === 'long' && hours >= 25) out.push({ id: 'length', label: `${Math.round(hours)}h to beat`, weight: 1.5 });
    if (g.releaseDate && daysBetween(g.releaseDate, today) <= 365) out.push({ id: 'recent', label: 'Out this year', weight: 0.8 });
    return out;
  }

  // Highest-scoring games, no more than `perService` from any one service
  // so one big catalogue doesn't fill the list.
  function recommend(games, h, { tastes = { genres: [], length: 'any' }, today, limit = 12, perService = 5 } = {}) {
    const scored = [];
    for (const g of games) {
      if (!h.isMine(g) || h.isComing(g)) continue;
      const mark = h.markOf(g);
      if (mark !== 'none' && mark !== 'wishlist') continue;
      const hours = h.hours(g);
      // A length preference rules out games known to be the other kind.
      if (tastes.length === 'short' && hours != null && hours > 20) continue;
      if (tastes.length === 'long' && hours != null && hours < 10) continue;
      const reasons = reasonsFor(g, h, tastes, today);
      if (tastes.genres.length && !reasons.some((r) => r.id === 'genre')) continue;
      const total = reasons.reduce((sum, r) => sum + r.weight, 0);
      // With no tastes picked, everything in your plans is a candidate.
      if (total <= 0 && tastes.genres.length) continue;
      scored.push({ game: g, reasons: reasons.sort((a, b) => b.weight - a.weight), total });
    }
    // Ties go to the better-rated, then the newer game.
    scored.sort((a, b) => b.total - a.total || (h.score(b.game) || 0) - (h.score(a.game) || 0)
      || (b.game.releaseDate || '').localeCompare(a.game.releaseDate || '') || a.game.title.localeCompare(b.game.title));
    // Several liked genres take turns, so one big genre doesn't fill the list.
    let ordered = scored;
    if (tastes.genres.length > 1) {
      const queues = tastes.genres.map((name) => scored.filter((x) => h.genres(x.game).includes(name)));
      const taken = new Set();
      ordered = [];
      while (queues.some((q) => q.length)) {
        for (const q of queues) {
          while (q.length && taken.has(q[0])) q.shift();
          if (q.length) {
            taken.add(q[0]);
            ordered.push(q.shift());
          }
        }
      }
    }
    const per = new Map();
    const out = [];
    for (const s of ordered) {
      const svc = s.game.service;
      if ((per.get(svc) || 0) >= perService) continue;
      per.set(svc, (per.get(svc) || 0) + 1);
      out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }

  const api = { recommend };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Recommend = api;
})(this);
