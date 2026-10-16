const fs = require('fs');
const path = require('path');
const http = require('./providers/http');
const gamepass = require('./providers/gamepass');

// Descriptions and screenshots for the game panel, fetched when a game is
// opened and cached on disk. Game Pass games already carry both from the
// catalogue; PS Plus reads its store page; retro games get screenshots from
// libretro-thumbnails and a description from Wikipedia.
const MAX_SCREENSHOTS = 4;
const CACHE_DAYS = 30;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

async function getText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await http.fetchRaw(url, { signal: controller.signal, headers: { Accept: 'text/html' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---- PlayStation Store concept page ----
function parsePsStorePage(html) {
  const meta = html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i) ||
    html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i);
  const shots = new Set();
  // Media objects in the page's embedded data mark screenshots by role;
  // older games also name the files PREVIEW_SCREENSHOT.
  const patterns = [
    /"role":"SCREENSHOT","type":"IMAGE","url":"([^"]+)"/g,
    /"type":"IMAGE","role":"SCREENSHOT","url":"([^"]+)"/g,
    /"url":"([^"]+)","role":"SCREENSHOT"/g,
    /(https:\/\/image\.api\.playstation\.com\/[^"'\s)]*SCREENSHOT[^"'\s)]*\.(?:jpg|png))/gi,
  ];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) shots.add(m[1].replace(/\\u002F/g, '/'));
  }
  return {
    description: meta ? decode(meta[1]).trim() : null,
    screenshots: [...shots].slice(0, MAX_SCREENSHOTS).map((u) => (u.includes('?') ? u : `${u}?w=960`)),
  };
}

// ---- Wikipedia ----
const SYSTEM_WORDS = {
  NES: 'NES', SNES: 'Super NES', 'Game Boy': 'Game Boy', N64: 'Nintendo 64', 'Sega Genesis': 'Sega Genesis',
  'Game Boy Advance': 'Game Boy Advance', 'Virtual Boy': 'Virtual Boy', 'GameCube (Switch 2)': 'GameCube',
};

async function wikipediaIntro(title, hint) {
  const query = `${title.replace(/\s+SP(\s+\(.*\))?$/, '').replace(/\s+\((NA|JP)\)$/, '')} ${hint} video game`;
  const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search' +
    `&gsrlimit=1&gsrsearch=${encodeURIComponent(query)}&prop=extracts&exintro=1&explaintext=1&exsentences=3`;
  const data = await http.getJson(url, { headers: { 'Api-User-Agent': 'SubscriptionCatalogue/0.1 (desktop app)' } });
  const page = data.query && data.query.pages && data.query.pages[0];
  if (!page || !page.extract) return null;
  return { text: page.extract.trim(), source: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}` };
}

// libretro keeps title screens and gameplay shots under the same file name
// as the box art.
function retroScreenshots(image) {
  if (!image || !image.includes('/Named_Boxarts/')) return [];
  return ['Named_Titles', 'Named_Snaps'].map((dir) => image.replace('/Named_Boxarts/', `/${dir}/`));
}

function psStoreUrl(url, locale) {
  return url && locale ? url.replace(/\/[a-z]{2}-[a-z]{2}\/concept\//i, `/${locale}/concept/`) : url;
}

const hasCatalogDetails = (game) => game.service === 'gamepass' && !!(game.description || (game.screenshots || []).length);

async function fetchDetails(game, settings = {}) {
  if (hasCatalogDetails(game)) {
    // Lists saved before duplicates were removed can repeat a screenshot.
    return { description: game.description || null, screenshots: [...new Set(game.screenshots || [])].slice(0, MAX_SCREENSHOTS) };
  }
  if (game.service === 'gamepass') {
    // Catalogue saved by an older version, without descriptions.
    try {
      const p = await gamepass.fetchProduct(game.id.replace(/^gamepass:/, ''), settings);
      return { description: p.description, screenshots: p.screenshots };
    } catch {
      return { description: null, screenshots: [] };
    }
  }
  const out = { description: null, screenshots: [] };
  if (game.service === 'psplus' && game.storeUrl) {
    try {
      Object.assign(out, parsePsStorePage(await getText(psStoreUrl(game.storeUrl, settings.psLocale))));
    } catch {
      // Fall through to Wikipedia for the description.
    }
  }
  if (game.service === 'nso') out.screenshots = retroScreenshots(game.image);
  if (!out.description && (game.service === 'nso' || game.service === 'psplus')) {
    try {
      const hint = game.service === 'nso' ? SYSTEM_WORDS[game.platforms[0]] || '' : 'PlayStation';
      const wiki = await wikipediaIntro(game.title, hint);
      if (wiki) {
        out.description = wiki.text;
        out.descriptionSource = wiki.source;
      }
    } catch {
      // No description is fine.
    }
  }
  return out;
}

class DetailsCache {
  constructor(dir) {
    this.file = path.join(dir, 'details.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  async get(game, settings) {
    // Game Pass games normally carry their details already.
    if (hasCatalogDetails(game)) return fetchDetails(game, settings);
    const hit = this.data[game.id];
    if (hit && Date.now() - hit.fetchedAt < CACHE_DAYS * 86400000) return hit;
    const details = { ...(await fetchDetails(game, settings)), fetchedAt: Date.now() };
    // Only remember answers worth keeping, so a failed lookup is retried.
    if (details.description || details.screenshots.length) {
      this.data[game.id] = details;
      fs.writeFile(this.file, JSON.stringify(this.data), () => {});
    }
    return details;
  }
}

module.exports = { DetailsCache, fetchDetails, parsePsStorePage, retroScreenshots, psStoreUrl };
