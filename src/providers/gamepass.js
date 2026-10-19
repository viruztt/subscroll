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
  // The same screenshot is often listed more than once (per device type).
  const screenshots = [...new Set((loc.Images || [])
    .filter((i) => i.ImagePurpose === 'Screenshot' && i.Uri)
    .map((i) => `${i.Uri.startsWith('//') ? 'https:' : ''}${i.Uri}?w=960`))]
    .slice(0, 4);
  return {
    title: loc.ProductTitle || p.ProductId,
    kind: p.ProductKind || null,
    image: pickImage(loc.Images),
    description: loc.ShortDescription || (loc.ProductDescription || '').split('\n')[0] || null,
    screenshots,
    genres,
    developer: loc.DeveloperName || null,
    publisher: loc.PublisherName || null,
    // 9998-12-30 means no date yet.
    releaseDate: market.OriginalReleaseDate && !/^9\d{3}/.test(market.OriginalReleaseDate) ? market.OriginalReleaseDate.slice(0, 10) : null,
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

  // Games announced with a future date (a bonus: the list works without).
  let upcoming = new Map();
  let joined = new Map();
  try {
    const subs = await getJson(`https://catalog.gamepass.com/pcsubscriptions?market=${market}&language=${language}`);
    upcoming = comingSoon(subs);
    joined = joinDates(subs);
  } catch {
    // Keep going without upcoming games.
  }

  const ids = [...new Set([...members.keys(), ...upcoming.keys()])];
  const details = await fetchProducts(ids, { market, language });

  return ids.map((id) => {
    const m = members.get(id) || { tiers: new Set(), platforms: new Set() };
    const soon = upcoming.get(id);
    if (soon) {
      soon.tiers.forEach((t) => m.tiers.add(t));
      soon.platforms.forEach((p) => m.platforms.add(p));
    }
    const d = details.get(id) || { title: id, image: null, genres: [], releaseDate: null, description: null, screenshots: [] };
    return {
      id: `gamepass:${id}`,
      service: 'gamepass',
      title: d.title,
      image: d.image,
      platforms: [...m.platforms],
      tiers: [...m.tiers],
      leavingSoon: leaving.has(id),
      comingOn: soon ? soon.date : null,
      addedOn: joined.get(id) || null,
      genres: d.genres,
      developer: d.developer || null,
      publisher: d.publisher || null,
      releaseDate: d.releaseDate,
      description: d.description,
      screenshots: d.screenshots,
      storeUrl: storeUrl(id),
    };
  });
}

// Product details (title, art, description…) for many store ids at once.
async function fetchProducts(ids, { market = 'US', language = 'en-us' } = {}) {
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
  return details;
}

// pcsubscriptions has, per product and plan, the date it joins ("EntranceDate").
// A date in the coming months means the game is announced but not playable
// yet. Microsoft uses far-future dates as "unknown", so those are skipped.
const PLAN_OF = [[/^pc/i, 'pc', 'pc'], [/^(standard|premium)/i, 'premium', 'console'], [/^(core|essential)/i, 'essential', 'console'], [/^ultimate/i, 'ultimate', 'console']];

function comingSoon(data, now = Date.now()) {
  const out = new Map();
  for (const [id, product] of Object.entries(data || {})) {
    if (!product || typeof product !== 'object') continue;
    for (const [field, meta] of Object.entries(product)) {
      if (!/SubMetadata$/.test(field) || !meta || !meta.EntranceDate) continue;
      const when = Date.parse(meta.EntranceDate);
      if (!(when > now && when < now + 366 * 86400000)) continue;
      const plan = PLAN_OF.find(([re]) => re.test(field));
      const [, tier, platform] = plan || [null, 'ultimate', 'console'];
      const entry = out.get(id) || { date: null, tiers: new Set(), platforms: new Set() };
      const iso = new Date(when).toISOString().slice(0, 10);
      if (!entry.date || iso < entry.date) entry.date = iso;
      entry.tiers.add(tier);
      if (tier === 'ultimate' || tier === 'pc') entry.tiers.add('ultimate');
      entry.platforms.add(platform);
      out.set(id, entry);
    }
  }
  return out;
}

// When each game already in Game Pass joined it: the earliest past
// EntranceDate over its plans.
function joinDates(data, now = Date.now()) {
  const out = new Map();
  for (const [id, product] of Object.entries(data || {})) {
    if (!product || typeof product !== 'object') continue;
    for (const [field, meta] of Object.entries(product)) {
      if (!/SubMetadata$/.test(field) || !meta || !meta.EntranceDate) continue;
      const when = Date.parse(meta.EntranceDate);
      if (!(when <= now)) continue;
      const iso = new Date(when).toISOString().slice(0, 10);
      if (!out.has(id) || iso < out.get(id)) out.set(id, iso);
    }
  }
  return out;
}

// Microsoft's store-wide list names -> product ids (EA Play, Ubisoft+…).
async function fetchSubscriptionLists(market = 'US') {
  const data = await getJson(`https://catalog.gamepass.com/subscriptions?market=${market}`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Unexpected subscriptions format');
  return data;
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
      developer: g.developer || null,
      publisher: g.publisher || null,
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

module.exports = { fetchLive, fetchMirror, fetchProduct, fetchProducts, fetchSubscriptionLists, comingSoon, joinDates, storeUrl, normalizeMirror, siglIds, parseProduct, buildMembership, MIRROR_URL };
