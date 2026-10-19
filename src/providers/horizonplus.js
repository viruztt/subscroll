const fs = require('fs');
const path = require('path');
const { getJson, mapLimit } = require('./http');
const { matchKey } = require('../../renderer/unify');

// Meta Horizon+ (Meta Quest). Meta's store pages build their lists in the
// browser, so there's nothing an app can read there. Quest+ History
// (questplushistory.com), run by Carlos Santiago, records every game added
// to and removed from the Games Catalog and every month's games since the
// subscription began (July 2023), and publishes both as JSON:
//   catalog.json  { "2026": { "10": [{ title, url, event: "+" | "-" }] } }
//   monthly.json  { "2026": { "10": [{ title, url }] } }
// The catalog is every game whose latest event is an addition. Monthly games
// can be added to your library during their month and stay playable while
// you subscribe, so this month's are listed until the month ends.
const BASE = 'https://questplushistory.com/wp-content/plugins/quest-plus-tools/data';
const CATALOG_URL = `${BASE}/catalog.json`;
const MONTHLY_URL = `${BASE}/monthly.json`;

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// "https://www.meta.com/experiences/1304877726278670/" -> "1304877726278670"
const appId = (url) => (String(url || '').match(/experiences\/(?:[^/]+\/)?(\d{6,})/) || [])[1] || null;

// Entries oldest first, each with its month as 'YYYY-MM'. Months aren't in
// order in the files, and a month's entries keep their order.
function entries(data) {
  const out = [];
  for (const [year, months] of Object.entries(data || {})) {
    if (!/^\d{4}$/.test(year) || !months || typeof months !== 'object') continue;
    for (const [month, list] of Object.entries(months)) {
      if (!/^\d{1,2}$/.test(month) || !Array.isArray(list)) continue;
      list.forEach((e, i) => { if (e && e.title) out.push({ ...e, month: `${year}-${month.padStart(2, '0')}`, i }); });
    }
  }
  return out.sort((a, b) => a.month.localeCompare(b.month) || a.i - b.i);
}

function makeGame(e, tier) {
  const id = appId(e.url);
  return {
    id: `horizonplus:${id || slug(e.title)}`,
    service: 'horizonplus',
    title: String(e.title).trim(),
    image: null,
    platforms: ['Meta Quest'],
    tiers: [tier],
    leavingSoon: false,
    genres: [],
    releaseDate: null,
    addedOn: null,
    storeUrl: /^https:\/\/(www\.)?(meta|oculus)\.com\//.test(e.url || '') ? e.url : null,
  };
}

// Covers. Quest+ History has none, so they come from MetaMetadata
// (github.com/threethan/MetaMetadata, by threethan), which saves the Quest
// Store's details for every app daily: known_oculus_apps.json maps store ids
// to package names, and common/<package>.json has the cover art. Meta's image
// links expire after a while, so a game also gets its Steam cover (when it's
// on Steam) to fall back on; Steam lookups are kept in horizon-steam.json.
const MM = 'https://raw.githubusercontent.com/threethan/MetaMetadata/main/data';
const STEAM_DAYS = 30;

async function metaCovers(games) {
  const known = await getJson(`${MM}/known_oculus_apps.json`, { timeoutMs: 60000 });
  const pkg = new Map((Array.isArray(known) ? known : []).map((a) => [String(a.id), a.packageName]));
  const out = {};
  await mapLimit(games, 6, async (g) => {
    const name = pkg.get(g.id.split(':')[1]);
    if (!name || !/^[\w.-]+$/.test(name)) return;
    try {
      const d = await getJson(`${MM}/common/${encodeURIComponent(name)}.json`);
      const image = d.portrait || d.square || d.landscape;
      if (/^https:\/\//.test(image || '')) out[g.id] = { image, genres: String(d.genres || '').split(',').map((x) => x.trim()).filter(Boolean) };
    } catch {
      // No cover for this one.
    }
  });
  return out;
}

// Steam's portrait art for a game with the same title (with or without "VR").
async function steamCover(title) {
  const data = await getJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=english&cc=us`);
  const want = new Set([matchKey(title), matchKey(title.replace(/\s+VR$/i, '')), matchKey(`${title} VR`)]);
  const hit = (data.items || []).find((i) => (!i.type || i.type === 'app') && want.has(matchKey(i.name)));
  return hit ? hit.id : null;
}

async function steamCovers(games, dir) {
  const file = dir ? path.join(dir, 'horizon-steam.json') : null;
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first time */ }
  const fresh = (c) => c && Date.now() - c.at < STEAM_DAYS * 86400000;
  let failed = false;
  await mapLimit(games.filter((g) => !fresh(cache[matchKey(g.title)])), 2, async (g) => {
    if (failed) return;
    try {
      cache[matchKey(g.title)] = { at: Date.now(), appid: await steamCover(g.title) };
    } catch {
      failed = true; // Steam is refusing for now; try again next refresh.
    }
  });
  if (file) {
    try { fs.writeFileSync(file, JSON.stringify(cache)); } catch { /* cache only */ }
  }
  const out = {};
  for (const g of games) {
    const appid = cache[matchKey(g.title)]?.appid;
    if (appid) out[g.id] = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/library_600x900.jpg`;
  }
  return out;
}

// Meta's cover first, Steam's when Meta's link has expired (or there's none).
function withCovers(games, meta = {}, steam = {}) {
  return games.map((g) => {
    const m = meta[g.id];
    const image = m?.image || steam[g.id] || g.image;
    return {
      ...g,
      image,
      imageFallback: m?.image && steam[g.id] ? steam[g.id] : null,
      genres: g.genres.length ? g.genres : m?.genres || [],
    };
  });
}

const lastDay = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

// Games in the catalog now, with the month each was (last) added.
function parseCatalog(data) {
  const now = new Map();
  for (const e of entries(data)) {
    const key = appId(e.url) || slug(e.title);
    if (e.event === '-') now.delete(key);
    else if (e.event === '+') now.set(key, e);
  }
  return [...now.values()].map((e) => ({ ...makeGame(e, 'catalog'), addedOn: `${e.month}-01` }));
}

// This month's games, while the month lasts.
function parseMonthly(data, today = new Date().toISOString().slice(0, 10)) {
  const month = today.slice(0, 7);
  return entries(data).filter((e) => e.month === month)
    .map((e) => ({ ...makeGame(e, 'monthly'), addedOn: `${month}-01`, leavesOn: lastDay(month), monthly: true }));
}

async function fetchLive(_settings, dir) {
  const [catalog, monthly] = await Promise.all([getJson(CATALOG_URL, { timeoutMs: 30000 }), getJson(MONTHLY_URL, { timeoutMs: 30000 }).catch(() => null)]);
  const games = parseCatalog(catalog);
  // A change to the file's layout shouldn't empty the list.
  if (games.length < 15) throw new Error(`Horizon+ catalog looks incomplete (${games.length} games)`);
  const byId = new Map(games.map((g) => [g.id, g]));
  for (const g of monthly ? parseMonthly(monthly) : []) {
    const prev = byId.get(g.id);
    byId.set(g.id, prev ? { ...prev, tiers: [...new Set([...prev.tiers, 'monthly'])] } : g);
  }
  const list = [...byId.values()];
  // Covers are a bonus: the list stands without them.
  const [meta, steam] = await Promise.all([metaCovers(list).catch(() => ({})), steamCovers(list, dir).catch(() => ({}))]);
  return withCovers(list, meta, steam);
}

module.exports = { fetchLive, parseCatalog, parseMonthly, entries, appId, withCovers, CATALOG_URL, MONTHLY_URL };
