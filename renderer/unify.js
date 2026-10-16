// One card per game. The same game in several services (A Way Out in Game
// Pass, EA Play and PS Plus) becomes one entry that lists every service
// offering it in `offers`. Switch Online games stay on their own: each is a
// particular old console version, not the modern release.
(function (root) {
  // Which service's entry leads (its artwork, id and details are used).
  const ORDER = ['gamepass', 'psplus', 'eaplay', 'ubisoftplus', 'netflix', 'applearcade'];
  const rank = (g) => {
    const i = ORDER.indexOf(g.service);
    return i === -1 ? ORDER.length : i;
  };

  // "A Way Out™", "A Way Out (Windows)" and "A Way Out PS4 & PS5" are one game,
  // as are a game's standard and "Deluxe Edition" listings.
  function matchKey(title) {
    return String(title)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[™®©]/g, '')
      .replace(/\s*\((?:windows|pc|xbox[^)]*|ps[45][^)]*|game preview)\)\s*$/, '')
      .replace(/[\s:–—-]+(for )?(windows( 10| 11)?|pc|xbox series x\|s|xbox one)( edition)?$/, '')
      .replace(/\s+ps[45]\s*(&|and)\s*ps[45]$/, '')
      .replace(/[\s:–—-]+(standard|deluxe|digital deluxe|definitive|complete|gold|game of the year|goty)( edition)?$/, '')
      .replace(/&/g, ' and ')
      .replace(/^the /, '')
      .replace(/[^a-z0-9]+/g, '');
  }

  const coming = (g, today) => !!g.comingOn && g.comingOn > today;

  function merge(offers, today) {
    offers.sort((a, b) => rank(a) - rank(b));
    if (offers.length === 1) return { ...offers[0], offers };
    const lead = offers.find((o) => o.image) || offers[0];
    const pick = (field) => offers.map((o) => o[field]).find((v) => (Array.isArray(v) ? v.length : v)) ?? lead[field];
    const playable = offers.filter((o) => !coming(o, today));
    const seen = playable.map((o) => o.firstSeen).filter(Boolean).sort();
    return {
      ...lead,
      offers: [lead, ...offers.filter((o) => o !== lead)],
      platforms: [...new Set(offers.flatMap((o) => o.platforms || []))],
      genres: pick('genres'),
      releaseDate: pick('releaseDate'),
      description: pick('description'),
      leavingSoon: offers.some((o) => o.leavingSoon),
      // Already playable somewhere means it isn't "coming".
      comingOn: playable.length ? null : offers.map((o) => o.comingOn).sort()[0],
      // "New" when it most recently joined any of the services.
      firstSeen: seen.length ? seen[seen.length - 1] : null,
    };
  }

  function unify(games, today = new Date().toISOString().slice(0, 10)) {
    const out = [];
    const groups = new Map();
    for (const g of games) {
      const k = g.service === 'nso' || g.custom ? '' : matchKey(g.title);
      if (!k) {
        out.push([g]);
        continue;
      }
      if (!groups.has(k)) {
        groups.set(k, []);
        out.push(groups.get(k));
      }
      groups.get(k).push(g);
    }
    return out.map((offers) => merge(offers, today));
  }

  const api = { unify, matchKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Unify = api;
})(this);
