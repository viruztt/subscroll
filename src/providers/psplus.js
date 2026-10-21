const { getJson } = require('./http');
const history = require('./pshistory');

// playstation.com's own lists behind the "PS Plus games" pages.
const LISTS = {
  essential: 'plus-monthly-games-list',
  extra: 'plus-games-list',
  premium: 'plus-classics-list',
};
const MIRROR_BASE = 'https://raw.githubusercontent.com/ppazour/ps-plus-games-list/main/data';

function flatten(payload) {
  if (!Array.isArray(payload)) throw new Error('Unexpected PS Plus list format');
  return payload.flatMap((group) => (Array.isArray(group.games) ? group.games : []));
}

const titleCase = (s) => s.charAt(0) + s.slice(1).toLowerCase();

// The lists don't name publishers, but a product id starts with the
// publisher's PlayStation code (EP9000-CUSA... is Sony's own). The ones
// that matter for when games leave:
const PUBLISHER_CODES = {
  9000: 'Sony Interactive Entertainment',
  '0001': 'Ubisoft',
  '0082': 'Square Enix',
  '0102': 'Capcom',
  '0177': 'Sega',
  '0700': 'Bandai Namco',
  1001: '2K',
  1003: 'Bethesda Softworks',
  1004: 'Rockstar Games',
  1018: 'Warner Bros. Games',
};
const publisherOf = (productId) => PUBLISHER_CODES[String(productId || '').slice(2, 6)] || null;

function normalize(listsByTier) {
  const games = new Map();
  for (const [tier, raw] of Object.entries(listsByTier)) {
    for (const g of flatten(raw)) {
      const key = String(g.conceptId || g.productId || g.name);
      if (!games.has(key)) {
        games.set(key, {
          id: `psplus:${key}`,
          service: 'psplus',
          title: g.nameEn || g.name,
          image: g.imageUrl || null,
          platforms: g.device || [],
          tiers: [],
          leavingSoon: false,
          genres: [...new Set((g.genre || []).map(titleCase))],
          releaseDate: g.releaseDate ? g.releaseDate.slice(0, 10) : null,
          publisher: publisherOf(g.productId),
          storeUrl: g.conceptUrl || null,
        });
      }
      const game = games.get(key);
      if (!game.tiers.includes(tier)) game.tiers.push(tier);
      // Streams with PS Plus Premium.
      if (g.streamingSupported) game.stream = true;
    }
  }
  return [...games.values()];
}

async function fetchFrom(urlFor, dir) {
  const lists = {};
  for (const [tier, list] of Object.entries(LISTS)) {
    // Monthly games are a small bonus list; don't fail the refresh over it.
    try {
      lists[tier] = await getJson(urlFor(list));
    } catch (err) {
      if (tier !== 'essential') throw err;
      lists[tier] = [];
    }
  }
  // When each game joined, from the mirror's daily history.
  return history.withJoinDates(normalize(lists), dir);
}

const fetchLive = ({ psLocale = 'en-us' } = {}, dir = null) =>
  fetchFrom((list) => `https://www.playstation.com/bin/imagic/gameslist?locale=${psLocale}&categoryList=${list}`, dir);

const fetchMirror = (settings, dir = null) => fetchFrom((list) => `${MIRROR_BASE}/${list}.json`, dir);

module.exports = { fetchLive, fetchMirror, normalize, publisherOf, LISTS };
