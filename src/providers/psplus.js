const { getJson } = require('./http');

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
          storeUrl: g.conceptUrl || null,
        });
      }
      const game = games.get(key);
      if (!game.tiers.includes(tier)) game.tiers.push(tier);
    }
  }
  return [...games.values()];
}

async function fetchFrom(urlFor) {
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
  return normalize(lists);
}

const fetchLive = ({ psLocale = 'en-us' } = {}) =>
  fetchFrom((list) => `https://www.playstation.com/bin/imagic/gameslist?locale=${psLocale}&categoryList=${list}`);

const fetchMirror = () => fetchFrom((list) => `${MIRROR_BASE}/${list}.json`);

module.exports = { fetchLive, fetchMirror, normalize, LISTS };
