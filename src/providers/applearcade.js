const fs = require('fs');
const path = require('path');
const http = require('./http');
const { tableGrid, toIsoDate } = require('./nintendo');
const { pickMatch, key } = require('../ratings');

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

async function storeSearch(title, country) {
  const data = await http.getJson(`https://itunes.apple.com/search?term=${encodeURIComponent(title)}&entity=software&country=${country}&limit=10`);
  const items = (data.results || []).map((r) => ({
    name: r.trackName.replace(/\s*\+$/, ''),
    year: r.releaseDate ? Number(r.releaseDate.slice(0, 4)) : null,
    r,
  }));
  const hit = pickMatch(items, title, null);
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
async function lookupMissing(games, cacheDir, country = 'us', { delayMs = 3500, onFound = () => {} } = {}) {
  const file = path.join(cacheDir, 'appstore.json');
  const cache = loadCache(cacheDir);
  const todo = games.filter((g) => {
    const hit = cache[key(g.title)];
    return !(hit && Date.now() - hit.fetchedAt < (hit.data ? HIT_DAYS : MISS_DAYS) * 86400000);
  });
  let found = 0;
  for (const g of todo) {
    try {
      const data = await storeSearch(g.title, country);
      cache[key(g.title)] = { fetchedAt: Date.now(), data };
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

module.exports = { fetchLive, parseWikipedia, applyCached, lookupMissing, storeSearch };
