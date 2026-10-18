// One card per game. The same game in several services (A Way Out in Game
// Pass, EA Play and PS Plus) becomes one entry that lists every service
// offering it in `offers`. Switch Online games stay on their own (each is a
// particular old console version, not the modern release), apart from
// regional versions of the same game, which share a card.
(function (root) {
  // Which service's entry leads (its artwork, id and details are used).
  const ORDER = ['gamepass', 'psplus', 'eaplay', 'ubisoftplus', 'netflix', 'applearcade', 'crunchyroll', 'humble', 'playpass', 'luna'];
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

  // Switch Online sometimes lists a game twice, once per region:
  // "Adventures of Lolo (NA)" and "Adventures of Lolo (JP)".
  const REGION = /\s*\((NA|US|North America|EU|PAL|Europe|JP|Japan|Japanese(?: version)?)\)\s*$/i;
  const REGION_NAME = { us: 'NA', 'north america': 'NA', eu: 'PAL', europe: 'PAL', japan: 'JP', japanese: 'JP', 'japanese version': 'JP' };
  const VERSION_ORDER = ['', 'NA', 'PAL', 'JP'];
  function regionOf(title) {
    const m = String(title).match(REGION);
    if (!m) return '';
    return REGION_NAME[m[1].toLowerCase()] || m[1].toUpperCase();
  }
  const baseTitle = (title) => String(title).replace(REGION, '');

  function mergeVersions(versions) {
    versions.sort((a, b) => VERSION_ORDER.indexOf(regionOf(a.title)) - VERSION_ORDER.indexOf(regionOf(b.title)));
    if (versions.length === 1) return { ...versions[0], offers: versions };
    const lead = versions.find((v) => v.image) || versions[0];
    const seen = versions.map((v) => v.firstSeen).filter(Boolean).sort();
    return {
      ...lead,
      title: baseTitle(lead.title),
      offers: [lead, ...versions.filter((v) => v !== lead)],
      versions: versions.map((v) => regionOf(v.title)).filter(Boolean),
      tiers: [...new Set(versions.flatMap((v) => v.tiers || []))],
      firstSeen: seen.length ? seen[seen.length - 1] : null,
    };
  }

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
      if (g.service === 'nso') {
        // Regional versions of one game on one system.
        const k = `nso|${(g.platforms || [])[0]}|${baseTitle(g.title)}`;
        if (!groups.has(k)) {
          groups.set(k, []);
          out.push(Object.assign(groups.get(k), { nso: true }));
        }
        groups.get(k).push(g);
        continue;
      }
      const k = g.custom ? '' : matchKey(g.title);
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
    return out.map((offers) => (offers.nso ? mergeVersions(offers) : merge(offers, today)));
  }

  const api = { unify, matchKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Unify = api;
})(this);
