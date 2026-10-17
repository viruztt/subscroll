const fs = require('fs');
const path = require('path');
const http = require('./http');
const { tableGrid, toIsoDate } = require('./nintendo');
const { pickMatch, key } = require('../ratings');
const { studioNames } = require('../../renderer/recommend');

// Apple publishes no list of Arcade games; Wikipedia's "Apple Arcade" article
// keeps one (the service's own games, not the "+" editions of App Store
// hits). Icons, descriptions and screenshots come from Apple's public App
// Store search, looked up once per game and cached.
const WIKI_URL = 'https://en.wikipedia.org/w/api.php?action=parse&page=Apple_Arcade&prop=text&format=json&formatversion=2&redirects=1';
const HIT_DAYS = 30;
const MISS_DAYS = 7;

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function parseWikipedia(html, today = new Date().toISOString().slice(0, 10)) {
  const games = [];
  const seen = new Set();
  for (const m of html.matchAll(/<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/gi)) {
    const grid = tableGrid(m[1]);
    const header = grid.find((r) => r.allHeaders);
    if (!header) continue;
    const cols = header.cells.map((c) => (c || '').toLowerCase());
    const titleCol = cols.findIndex((c) => /\b(title|game)\b/.test(c));
    const devCol = cols.findIndex((c) => c.includes('developer'));
    const dateCol = cols.findIndex((c) => c.includes('date'));
    if (titleCol === -1 || devCol === -1) continue;
    for (const row of grid.filter((r) => !r.allHeaders)) {
      const title = (row.cells[titleCol] || '').trim();
      if (!title) continue;
      const id = `applearcade:${slug(title)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const date = dateCol !== -1 ? toIsoDate(row.cells[dateCol] || '') : null;
      games.push({
        id,
        service: 'applearcade',
        title,
        image: null,
        platforms: ['Apple devices'],
        tiers: ['any'],
        leavingSoon: false,
        comingOn: date && date > today ? date : null,
        genres: [],
        releaseDate: date,
        addedOn: date && date <= today ? date : null,
        developer: row.cells[devCol] || null,
        storeUrl: null,
      });
    }
  }
  return games;
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

// Same studio: "ustwo games" and "ustwo games Ltd" both credit ustwo.
const studioKeys = (text) => studioNames(text).map((x) => x.key);
const sameStudio = (a, b) => studioKeys(a).some((x) => studioKeys(b).some((y) => x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)))));

// Exact title first. Failing that, an app by the game's developer whose name
// is the title without its subtitle, or the other way round
// ("Hexaflip: The Action Puzzler" is "Hexaflip" on the App Store).
function pickApp(items, title, developer) {
  const exact = pickMatch(items, title, null);
  if (exact || !developer) return exact;
  const main = key(title.split(/:\s| - /)[0]);
  const full = key(title);
  return items.find(({ name, r }) => {
    const k = key(name.split(/:\s| - /)[0]);
    if (k.length < 3 || !(k === main || full.startsWith(k) || key(name).startsWith(full))) return false;
    return sameStudio(r.artistName, developer) || sameStudio(r.sellerName, developer);
  }) || null;
}

async function storeSearch(title, country, developer = null) {
  const data = await http.getJson(`https://itunes.apple.com/search?term=${encodeURIComponent(title)}&entity=software&country=${country}&limit=10`);
  const items = (data.results || []).map((r) => ({
    name: r.trackName.replace(/\s*\+$/, '').replace(/\s+Arcade Edition$/i, ''),
    year: r.releaseDate ? Number(r.releaseDate.slice(0, 4)) : null,
    r,
  }));
  const hit = pickApp(items, title.replace(/\s+Arcade Edition$/i, ''), developer);
  if (!hit) return null;
  const { r } = hit;
  const para = (r.description || '').split(/\n\s*\n/).map((x) => x.replace(/\s+/g, ' ').trim()).find((x) => x.length > 40) || null;
  return {
    image: r.artworkUrl512 || r.artworkUrl100 || null,
    storeUrl: r.trackViewUrl ? r.trackViewUrl.split('?')[0] : null,
    description: para && para.length > 600 ? `${para.slice(0, 597).replace(/\s+\S*$/, '')}…` : para,
    screenshots: [...(r.screenshotUrls || []), ...(r.ipadScreenshotUrls || [])].slice(0, 4),
    genres: (r.genres || []).filter((g) => g !== 'Games'),
  };
}

function loadCache(cacheDir) {
  return readJson(path.join(cacheDir, 'appstore.json'), {});
}

// Adds the App Store details already looked up.
function applyCached(games, cacheDir) {
  const cache = loadCache(cacheDir);
  return games.map((g) => {
    const d = cache[key(g.title)] && cache[key(g.title)].data;
    if (!d) return g;
    return {
      ...g,
      image: d.image || g.image,
      imageFallback: d.imageFallback || null,
      storeUrl: d.storeUrl || g.storeUrl,
      description: d.description || null,
      screenshots: d.screenshots || [],
      genres: d.genres && d.genres.length ? d.genres : g.genres,
    };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Looks up games without App Store details, one at a time and slowly:
// Apple limits searches to roughly 20 a minute. Runs in the background;
// stops at the first refusal and continues next time.
// Steam's portrait library art, for a game with exactly this title.
async function steamCover(title, country) {
  try {
    const data = await http.getJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=english&cc=${country}`);
    const k = key(title.replace(/\s+Arcade Edition$/i, ''));
    const hit = (data.items || []).find((i) => (!i.type || i.type === 'app') && key(i.name) === k);
    if (!hit) return null;
    return {
      image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${hit.id}/library_600x900.jpg`,
      // Older games may lack portrait art; the store header always exists.
      imageFallback: hit.tiny_image ? hit.tiny_image.replace('capsule_231x87', 'header') : null,
      storeUrl: null, description: null, screenshots: [], genres: [], source: 'Steam',
    };
  } catch {
    // Steam is only a fallback; the App Store answer stands.
    return null;
  }
}

// Misses from before the looser matching and the US and Steam fallbacks are asked again.
const LOOKUP_VERSION = 3;

async function lookupMissing(games, cacheDir, country = 'us', { delayMs = 3500, onFound = () => {} } = {}) {
  const file = path.join(cacheDir, 'appstore.json');
  const cache = loadCache(cacheDir);
  const todo = games.filter((g) => {
    const hit = cache[key(g.title)];
    if (hit && !hit.data && hit.v !== LOOKUP_VERSION) return true;
    return !(hit && Date.now() - hit.fetchedAt < (hit.data ? HIT_DAYS : MISS_DAYS) * 86400000);
  });
  let found = 0;
  for (const g of todo) {
    try {
      let data = await storeSearch(g.title, country, g.developer);
      // Some games are listed in the US store only.
      if (!data && country !== 'us') {
        await sleep(delayMs);
        data = await storeSearch(g.title, 'us', g.developer);
      }
      // Many early Arcade games have left the App Store but are sold on Steam.
      if (!data) {
        await sleep(delayMs);
        data = await steamCover(g.title, country);
      }
      cache[key(g.title)] = { fetchedAt: Date.now(), data, v: LOOKUP_VERSION };
      if (data) found += 1;
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(cache));
      if (data && found % 10 === 0) onFound(found);
    } catch {
      break;
    }
    await sleep(delayMs);
  }
  if (found % 10 !== 0) onFound(found);
  return found;
}

async function fetchLive(settings = {}, cacheDir = null) {
  const data = await http.getJson(WIKI_URL, { headers: { 'Api-User-Agent': 'Subscroll/0.1 (desktop app)' } });
  const games = parseWikipedia(data.parse ? data.parse.text : '');
  if (games.length < 100) throw new Error(`Wikipedia list looks incomplete (${games.length} games)`);
  return cacheDir ? applyCached(games, cacheDir) : games;
}

module.exports = { fetchLive, parseWikipedia, applyCached, lookupMissing, storeSearch, pickApp };
