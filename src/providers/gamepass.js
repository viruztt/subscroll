const { getJson, mapLimit, chunk } = require('./http');

// Microsoft's own catalogue lists ("sigls"). Each tier has one list, filtered
// by platform; the two leaving-soon lists flag games but carry no date.
const TIER_LISTS = {
  ultimate: { sigl: '97c6c862-d28a-4907-a3d5-c401f2296a53', sub: 'cfq7ttc0khs0' },
  premium: { sigl: '09a72c0d-c466-426a-9580-b78955d8173a', sub: 'cfq7ttc0p85b' },
  essential: { sigl: '34031711-5a70-4196-bab7-45757dc2294e', sub: 'cfq7ttc0k5dj' },
};
const PLATFORM_CONTEXT = { console: 'ConsoleGen8;ConsoleGen9', pc: 'pc' };
const LEAVING_LISTS = {
  console: '393f05bf-e596-4ef6-9487-6d4fa0eab987',
  pc: 'cc7fc951-d00f-410e-9e02-5e4628e04163',
};
// Community mirror that rebuilds the same lists daily (market FR, en-us text).
const MIRROR_URL = 'https://raw.githubusercontent.com/nanhopper/catabox/main/site/data/current.json';

const storeUrl = (id) => `https://www.xbox.com/games/store/x/${id}`;

function siglIds(payload) {
  if (!Array.isArray(payload)) throw new Error('Unexpected Game Pass list format');
  return payload.filter((x) => x && x.id && !x.siglId).map((x) => x.id);
}

function pickImage(images = []) {
  const byPurpose = (p) => images.find((i) => i.ImagePurpose === p);
  const img = byPurpose('Poster') || byPurpose('BoxArt') || byPurpose('Tile') || images[0];
  if (!img || !img.Uri) return null;
  return img.Uri.startsWith('//') ? `https:${img.Uri}` : img.Uri;
}

function parseProduct(p) {
  const loc = (p.LocalizedProperties || [])[0] || {};
  const market = (p.MarketProperties || [])[0] || {};
  const props = p.Properties || {};
  const genres = props.Categories || (props.Category ? [props.Category] : []);
  const screenshots = (loc.Images || [])
    .filter((i) => i.ImagePurpose === 'Screenshot' && i.Uri)
    .slice(0, 4)
    .map((i) => `${i.Uri.startsWith('//') ? 'https:' : ''}${i.Uri}?w=960`);
  return {
    title: loc.ProductTitle || p.ProductId,
    image: pickImage(loc.Images),
    description: loc.ShortDescription || (loc.ProductDescription || '').split('\n')[0] || null,
    screenshots,
    genres,
    releaseDate: market.OriginalReleaseDate ? market.OriginalReleaseDate.slice(0, 10) : null,
  };
}

// Membership map: productId -> { tiers:Set, platforms:Set }
function buildMembership(lists) {
  const members = new Map();
  for (const { tier, platform, ids } of lists) {
    for (const id of ids) {
      if (!members.has(id)) members.set(id, { tiers: new Set(), platforms: new Set() });
      const m = members.get(id);
      m.tiers.add(tier);
      m.platforms.add(platform);
      // PC Game Pass carries the Ultimate library's PC games.
      if (tier === 'ultimate' && platform === 'pc') m.tiers.add('pc');
    }
  }
  return members;
}

async function fetchLive({ market = 'US', language = 'en-us' } = {}) {
  const requests = [];
  for (const [tier, { sigl, sub }] of Object.entries(TIER_LISTS)) {
    for (const [platform, ctx] of Object.entries(PLATFORM_CONTEXT)) {
      const url = `https://catalog.gamepass.com/sigls/v3?id=${sigl}&language=${language}&market=${market}` +
        `&platformContext=${encodeURIComponent(ctx)}&subscriptionContext=${sub}`;
      requests.push({ tier, platform, url });
    }
  }
  const lists = await mapLimit(requests, 3, async (r) => ({ ...r, ids: siglIds(await getJson(r.url)) }));
  const members = buildMembership(lists);

  const leaving = new Set();
  for (const sigl of Object.values(LEAVING_LISTS)) {
    try {
      const url = `https://catalog.gamepass.com/sigls/v2?id=${sigl}&language=${language}&market=${market}`;
      siglIds(await getJson(url)).forEach((id) => leaving.add(id));
    } catch {
      // Leaving-soon is a bonus; the catalogue is still good without it.
    }
  }

  const ids = [...members.keys()];
  const details = new Map();
  await mapLimit(chunk(ids, 20), 4, async (batch) => {
    const url = `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${batch.join(',')}` +
      `&market=${market}&languages=${language}`;
    try {
      const data = await getJson(url);
      for (const p of data.Products || []) details.set(p.ProductId, parseProduct(p));
    } catch {
      // Missing details just mean a title without artwork.
    }
  });

  return ids.map((id) => {
    const m = members.get(id);
    const d = details.get(id) || { title: id, image: null, genres: [], releaseDate: null, description: null, screenshots: [] };
    return {
      id: `gamepass:${id}`,
      service: 'gamepass',
      title: d.title,
      image: d.image,
      platforms: [...m.platforms],
      tiers: [...m.tiers],
      leavingSoon: leaving.has(id),
      genres: d.genres,
      releaseDate: d.releaseDate,
      description: d.description,
      screenshots: d.screenshots,
      storeUrl: storeUrl(id),
    };
  });
}

function normalizeMirror(data) {
  if (!data || !Array.isArray(data.games)) throw new Error('Unexpected mirror format');
  return data.games.map((g) => {
    const tiers = new Set(g.memberships || []);
    if (((g.platformByTier || {}).ultimate || []).includes('pc')) tiers.add('pc');
    return {
      id: `gamepass:${g.id}`,
      service: 'gamepass',
      title: g.title || g.id,
      image: g.poster || g.boxArt || null,
      platforms: g.platforms || [],
      tiers: [...tiers],
      leavingSoon: !!g.leavingSoon,
      genres: g.genres || [],
      releaseDate: g.releaseDate || null,
      description: g.shortDescription || g.description || null,
      screenshots: (g.screenshots || []).slice(0, 4),
      storeUrl: storeUrl(g.id),
    };
  });
}

// One product's details, for games cached before the catalogue carried
// descriptions.
async function fetchProduct(id, { market = 'US', language = 'en-us' } = {}) {
  const data = await getJson(`https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${id}&market=${market}&languages=${language}`);
  const p = (data.Products || [])[0];
  if (!p) throw new Error(`No product ${id}`);
  return parseProduct(p);
}

async function fetchMirror() {
  return normalizeMirror(await getJson(MIRROR_URL, { timeoutMs: 60000 }));
}

module.exports = { fetchLive, fetchMirror, fetchProduct, normalizeMirror, siglIds, parseProduct, buildMembership, MIRROR_URL };
