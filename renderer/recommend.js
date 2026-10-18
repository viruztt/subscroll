// Picks games to suggest from the plans you have, for onboarding and the
// For you page. Each pick carries the reasons it was chosen. The app passes:
//   isMine(game), markOf(game), isComing(game), score(game) (Metacritic or
//   null), hours(game) (How Long To Beat or null), genres(game) (canonical
//   names), stars(game) (your own 1-5 rating or null; optional),
//   today ('YYYY-MM-DD')
//   tastes: { genres: [...], length: 'any' | 'short' | 'long' }
(function (root) {
  const DAY = 86400000;
  const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / DAY);
  const starsOf = (h, g) => (h.stars ? Number(h.stars(g)) || null : null);
  const ownGenres = (h, g) => h.genres(g).filter((x) => x !== 'Retro');

  // How much you like each genre, from the games you've rated: the average
  // of (stars - 3), trusted fully from three rated games on. A 5-star game
  // makes its genres +0.67, a 1-star game -0.67, until more are rated.
  // Genres most of your plans have ("Action & adventure") say little about
  // a game, so they count for less: fully below 1 in 10 games.
  function genreFeelings(games, h) {
    const sums = new Map();
    const counts = new Map();
    let n = 0;
    for (const g of games) {
      if (h.isMine(g)) {
        n += 1;
        for (const x of ownGenres(h, g)) counts.set(x, (counts.get(x) || 0) + 1);
      }
      const stars = starsOf(h, g);
      if (!stars) continue;
      for (const x of ownGenres(h, g)) {
        const t = sums.get(x) || { sum: 0, n: 0 };
        t.sum += stars - 3;
        t.n += 1;
        sums.set(x, t);
      }
    }
    const out = new Map();
    const rarity = (x) => (n < 20 ? 1 : Math.min(1, Math.log(n / (counts.get(x) || 1)) / Math.log(10)));
    for (const [x, t] of sums) out.set(x, (t.sum / t.n) * (Math.min(t.n, 3) / 3) * rarity(x));
    return out;
  }

  function reasonsFor(g, h, tastes, today, feelings) {
    const out = [];
    if (feelings && feelings.size) {
      const mine = ownGenres(h, g).map((x) => [x, feelings.get(x) || 0]).sort((a, b) => b[1] - a[1]);
      const [best] = mine;
      if (best && best[1] >= 0.6) out.push({ id: 'rated', label: `You rate ${best[0]} highly`, weight: Math.min(2.5, 1.5 * best[1]) });
      // Only genres you've rated low: pushed down, with no label.
      else if (mine.length && mine[mine.length - 1][1] <= -0.6) out.push({ id: 'disliked', label: '', weight: -Math.min(3, 1.5 * -mine[mine.length - 1][1]) });
    }
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
    const feelings = genreFeelings(games, h);
    for (const g of games) {
      if (!h.isMine(g) || h.isComing(g)) continue;
      // You've rated it, so you've played it.
      if (starsOf(h, g)) continue;
      const mark = h.markOf(g);
      if (mark !== 'none' && mark !== 'wishlist') continue;
      const hours = h.hours(g);
      // A length preference rules out games known to be the other kind.
      if (tastes.length === 'short' && hours != null && hours > 20) continue;
      if (tastes.length === 'long' && hours != null && hours < 10) continue;
      const all = reasonsFor(g, h, tastes, today, feelings);
      if (tastes.genres.length && !all.some((r) => r.id === 'genre')) continue;
      const total = all.reduce((sum, r) => sum + r.weight, 0);
      // With no tastes picked, everything in your plans is a candidate.
      if (total <= 0 && tastes.genres.length) continue;
      const reasons = all.filter((r) => r.weight > 0);
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

  // ---- Games like the ones you beat ----
  // "Square Enix Co., Ltd." and "Square Enix" are one studio; a credit can
  // name several ("Arkane Lyon, Bethesda").
  const LEGAL = /[,.]?\s*\b(inc|ltd|llc|co|corp|corporation|gmbh|limited|plc|pty|s\.?a\.?s?|s\.?r\.?l|k\.?k)\b\.?/gi;
  function studioNames(text) {
    if (!text) return [];
    let s = String(text).replace(/\([^)]*\)/g, ' ');
    for (let i = 0; i < 3; i++) s = s.replace(LEGAL, '');
    return s.split(/\s*[,/;]\s*/).map((name) => name.trim().replace(/[\s.,]+$/, ''))
      .filter((name) => name.length > 1)
      .map((name) => ({ name, key: name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '') }))
      .filter((x) => x.key.length > 1);
  }

  function studiosOf(g) {
    const dev = new Map();
    const pub = new Map();
    for (const o of g.offers || [g]) {
      for (const x of studioNames(o.developer)) dev.set(x.key, x.name);
      for (const x of studioNames(o.publisher)) pub.set(x.key, x.name);
    }
    return { dev, pub };
  }

  // "Remedy" and "Remedy Entertainment" are the same studio.
  const sameStudio = (a, b) => a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a)));
  const findStudio = (keys, map) => {
    for (const k of keys) for (const [key, name] of map) if (sameStudio(k, key)) return name;
    return null;
  };

  // For each game you've completed or rated 4 or 5 stars, games in your plans
  // like it: by the same developer, a small publisher you've liked, or the
  // same less common genres. Games you rated 1 or 2 stars work the other way:
  // a game more like one of those than like anything you liked is left out.
  // Returns groups ({ seed, picks, reason: 'beat' | 'loved' }), best first;
  // each game appears once, under the game it's most like.
  const SEED_WEIGHT = { 5: 1.5, 4: 1.25, 3: 0.9 };
  function similar(games, h, { seeds = null, groups = 4, perGroup = 6 } = {}) {
    const pool = seeds || games;
    const done = pool.filter((g) => {
      const stars = starsOf(h, g);
      return stars ? stars >= 3 && (stars >= 4 || h.markOf(g) === 'completed') : h.markOf(g) === 'completed';
    });
    const disliked = pool.filter((g) => (starsOf(h, g) || 9) <= 2);
    if (!done.length) return [];
    const weightOf = (seed) => SEED_WEIGHT[starsOf(h, seed)] || 1;
    // "Super Metroid SP" (a Switch Online save-state edition) isn't a new game
    // after beating Super Metroid.
    const base = (g) => String(g.title).replace(/\s+SP(\s+\(.*\))?$/, '').replace(/\s+\((NA|JP|PAL)\)$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const beaten = new Set([...done, ...disliked].map(base));
    // One entry per game: "Metroid" rather than also its SP editions.
    const byBase = new Map();
    for (const g of games) {
      if (!h.isMine(g) || h.isComing(g) || !['none', 'wishlist'].includes(h.markOf(g)) || starsOf(h, g) || beaten.has(base(g))) continue;
      const k = base(g);
      if (!byBase.has(k) || g.title.length < byBase.get(k).title.length) byBase.set(k, g);
    }
    const candidates = [...byBase.values()];
    const n = candidates.length || 1;
    // Rarer genres say more: "Action & adventure" fits half of any library.
    const genreCount = new Map();
    const pubCount = new Map();
    const devCount = new Map();
    const info = new Map();
    for (const g of [...candidates, ...done, ...disliked]) {
      if (info.has(g)) continue;
      info.set(g, { genres: h.genres(g).filter((x) => x !== 'Retro'), ...studiosOf(g) });
    }
    for (const g of candidates) {
      for (const x of info.get(g).genres) genreCount.set(x, (genreCount.get(x) || 0) + 1);
      for (const k of info.get(g).pub.keys()) pubCount.set(k, (pubCount.get(k) || 0) + 1);
      for (const k of info.get(g).dev.keys()) devCount.set(k, (devCount.get(k) || 0) + 1);
    }
    const idf = (x) => Math.log(1 + n / (genreCount.get(x) || 1));
    // Big publishers (Xbox Game Studios, Nintendo, EA) publish too much to mean anything.
    const smallPub = Math.max(10, n * 0.03);

    function likeness(seed, cand) {
      const a = info.get(seed);
      const b = info.get(cand);
      const reasons = [];
      let sim = 0;
      const dev = findStudio(a.dev.keys(), b.dev);
      if (dev) {
        // A studio behind dozens of the games (Nintendo EAD) counts for less.
        const big = [...b.dev.keys()].some((k) => (devCount.get(k) || 0) > smallPub);
        sim += big ? 2 : 4;
        reasons.push({ id: 'studio', label: `By ${dev}`, weight: big ? 2 : 4 });
      } else {
        const pubKeys = [...b.pub.keys()].filter((k) => (pubCount.get(k) || 0) <= smallPub);
        const pub = findStudio([...a.pub.keys(), ...a.dev.keys()], new Map(pubKeys.map((k) => [k, b.pub.get(k)])));
        if (pub) {
          sim += 2;
          reasons.push({ id: 'studio', label: `From ${pub}`, weight: 2 });
        }
      }
      const shared = a.genres.filter((x) => b.genres.includes(x)).sort((x, y) => idf(y) - idf(x));
      if (shared.length) {
        const sum = (list) => list.reduce((t, x) => t + idf(x), 0);
        const cosine = sum(shared) / Math.sqrt(sum(a.genres) * sum(b.genres));
        // A single very common genre isn't enough on its own.
        if (cosine >= 0.5 && sum(shared) >= Math.log(5)) {
          sim += 3 * cosine;
          reasons.push({ id: 'genre', label: shared.slice(0, 2).join(' + '), weight: 3 * cosine });
        } else if (reasons.length) {
          sim += cosine;
        }
      }
      return reasons.length ? { sim, reasons } : null;
    }

    const bySeed = new Map();
    for (const cand of candidates) {
      let best = null;
      let others = 0;
      for (const seed of done) {
        const l = likeness(seed, cand);
        if (!l) continue;
        const sim = l.sim * weightOf(seed);
        if (!best || sim > best.sim) {
          if (best) others += 1;
          best = { ...l, sim, raw: l.sim, seed };
        } else {
          others += 1;
        }
      }
      if (!best) continue;
      // Like a game you rated low: left out when it's at least as like that
      // one as the game it'd be picked for, pushed down otherwise.
      let worst = 0;
      for (const bad of disliked) {
        const l = likeness(bad, cand);
        if (l) worst = Math.max(worst, l.sim);
      }
      if (worst && worst >= best.raw) continue;
      const score = h.score(cand);
      const reasons = [...best.reasons];
      let total = best.sim + 0.75 * Math.min(others, 2) - 0.5 * worst;
      if (score >= 85) total += 1;
      else if (score >= 75) total += 0.5;
      if (score >= 75) reasons.push({ id: 'score', label: `Metacritic ${score}`, weight: 1 });
      if (!bySeed.has(best.seed)) bySeed.set(best.seed, []);
      bySeed.get(best.seed).push({ game: cand, reasons, total });
    }

    const out = [];
    for (const [seed, list] of bySeed) {
      list.sort((a, b) => b.total - a.total || (h.score(b.game) || 0) - (h.score(a.game) || 0) || a.game.title.localeCompare(b.game.title));
      const picks = list.slice(0, perGroup);
      const strength = picks.slice(0, 3).reduce((t, p) => t + p.total, 0);
      out.push({ seed, picks, strength, reason: (starsOf(h, seed) || 0) >= 4 ? 'loved' : 'beat' });
    }
    out.sort((a, b) => b.strength - a.strength || a.seed.title.localeCompare(b.seed.title));
    return out.slice(0, groups);
  }

  const api = { recommend, similar, studioNames, genreFeelings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Recommend = api;
})(this);
