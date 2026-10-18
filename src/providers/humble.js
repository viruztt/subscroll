const fs = require('fs');
const path = require('path');
const { fetchRaw } = require('./http');
const { key } = require('../ratings');
const { monthWindow } = require('../monthly');

// Humble Choice: each month's games, yours to keep once claimed while you're
// a member. Humble's membership page carries the month's games as JSON in a
// <script type="application/json"> block; the games sit under a `game_data`
// map (contentChoiceOptions → contentChoiceData), each with a title.
const PAGE = 'https://www.humblebundle.com/membership';

// A new month starts on the first Tuesday, late morning in California.
function humbleWindow(now = new Date()) {
  const at = (y, m0) => {
    const w = monthWindow(y, m0);
    const shift = (iso) => new Date(Date.parse(iso) + 3600000).toISOString(); // 10am, an hour after PS Plus
    return { ...w, start: shift(w.start), end: shift(w.end) };
  };
  let w = at(now.getUTCFullYear(), now.getUTCMonth());
  if (new Date(w.start) > now) w = at(now.getUTCFullYear(), now.getUTCMonth() - 1);
  return w;
}

function jsonBlocks(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // Not JSON after all.
    }
  }
  return out;
}

// Finds the first `game_data` map anywhere in the page's JSON.
function findGameData(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  if (node.game_data && typeof node.game_data === 'object' && !Array.isArray(node.game_data)) return node.game_data;
  for (const v of Object.values(node)) {
    const hit = findGameData(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const firstUrl = (g, fields) => {
  for (const f of fields) {
    const v = g[f];
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
  }
  return null;
};

function parseChoice(html, { now = new Date() } = {}) {
  let data = null;
  for (const block of jsonBlocks(html)) {
    data = findGameData(block);
    if (data) break;
  }
  if (!data) return null;
  const w = humbleWindow(now);
  const games = [];
  for (const [slug, g] of Object.entries(data)) {
    if (!g || typeof g.title !== 'string' || !g.title.trim()) continue;
    const title = g.title.trim();
    games.push({
      id: `humble:${key(title) || slug}`,
      service: 'humble',
      title,
      image: firstUrl(g, ['image', 'tile_image', 'featured_image', 'carousel_image', 'logo']),
      platforms: ['PC'],
      tiers: ['choice'],
      leavingSoon: false,
      genres: Array.isArray(g.genres) ? g.genres.filter((x) => typeof x === 'string') : [],
      description: typeof g.description_text === 'string' ? g.description_text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600) || null : null,
      developer: Array.isArray(g.developers) && typeof g.developers[0] === 'string' ? g.developers[0] : null,
      storeUrl: PAGE,
      month: w.month,
      start: w.start,
      end: w.end,
    });
  }
  return games;
}

// The page as text; when its games can't be found it's saved next to the
// catalogue (humble-page.html) so the format change can be looked at.
async function fetchPage(dir) {
  const res = await fetchRaw(PAGE, { headers: { Accept: 'text/html' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from humblebundle.com`);
  const html = await res.text();
  const games = parseChoice(html);
  if (!games || !games.length) {
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'humble-page.html'), html);
      } catch {
        // Debugging aid only.
      }
    }
    throw new Error("Couldn't find this month's games on Humble's page");
  }
  return games;
}

const fetchLive = (_settings, dir) => fetchPage(dir);

module.exports = { fetchLive, fetchPage, parseChoice, humbleWindow, PAGE };
