const path = require('path');
const { getText } = require('./http');
const { readJson, writeJson } = require('../store');
const { matchKey } = require('../../renderer/unify');

// When PS Plus Extra and Premium games joined, from the PlayStation Blog.
// Every month since the June 2022 relaunch the blog posts that month's
// Game Catalog lineup ("Assassin's Creed Mirage | PS5, PS4"), and the
// games join on the third Tuesday of the month. The posts are found
// through the blog's sitemaps (its search and tag pages are closed to
// robots), read one at a time with the pause its robots.txt asks for,
// and kept in psplus-blog.json: a post is read once, and later checks
// only look for new ones.
const BLOG = 'https://blog.playstation.com';
const VERSION = 1;
const FIRST_YEAR = 2022;
const CRAWL_DELAY = 5000;
const CHECK_EVERY = 20 * 3600 * 1000;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// playstation-plus-game-catalog-for-december-..., -game-catalog-lineup-for-...,
// -monthly-games-and-game-catalog-lineup-for-..., -game-catalog-classics-for-...
const POST = /\/(\d{4})\/(\d{2})\/\d{2}\/playstation-plus-(?:monthly-games-and-)?game-catalog-(?:lineup-)?(?:classics-)?(?:for|lineup)-([a-z0-9-]*)\/?$/;
// The relaunch lineup (games available from 13 June 2022 in the Americas).
const LAUNCH = /\/2022\/05\/16\/all-new-playstation-plus-game-lineup/;
const LAUNCH_DAY = '2022-06-13';
const PLATFORM = /\b(PS ?[1-5]|PSP|PS ?VR ?2?|PS Vita)\b/i;

const pad = (n) => String(n).padStart(2, '0');
function thirdTuesday(y, m) {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return `${y}-${pad(m + 1)}-${pad(1 + ((2 - first + 7) % 7) + 14)}`;
}

// The day a post's games joined: the third Tuesday of the month its
// address names (a December post can be for January), else of the month
// it went up.
function joinedFor(url) {
  if (LAUNCH.test(url)) return LAUNCH_DAY;
  const m = POST.exec(url);
  if (!m) return null;
  let year = Number(m[1]);
  const posted = Number(m[2]) - 1;
  const named = MONTHS.findIndex((name) => new RegExp(`(^|-)${name}(-|$)`).test(m[3]));
  const month = named === -1 ? posted : named;
  if (month + 6 < posted) year += 1;
  return thirdTuesday(year, month);
}

const isPost = (url) => POST.test(url) || LAUNCH.test(url);

function locs(xml) {
  return [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
}

// The post sitemaps worth reading: the recent one and one per year since 2022.
function postSitemaps(indexXml) {
  return locs(indexXml).filter((u) => {
    const m = /wp-sitemap-posts-(?:post-)?(recent|\d{4})(?:-\d+)?\.xml$/.exec(u);
    return m && (m[1] === 'recent' || Number(m[1]) >= FIRST_YEAR);
  });
}

function decode(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Game titles in one post, in order: lines like "Far Cry 5 | PS4" (in a
// heading, paragraph or list item), under the post's Game Catalog and
// Classics headings. Essential's monthly games (in 2022's joint posts)
// are left out: they rotate on their own.
function parsePost(html) {
  const out = [];
  let section = 'catalog';
  for (const m of String(html).matchAll(/<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = decode(m[2]);
    if (!text || text.length > 160) continue;
    const bar = text.lastIndexOf('|');
    const right = bar === -1 ? '' : text.slice(bar + 1);
    if (/playstation plus/i.test(text) && !PLATFORM.test(right)) {
      if (/essential|monthly games/i.test(text) && !/extra|premium|catalog|classics/i.test(text)) section = 'essential';
      else if (/extra|premium|catalog|classics/i.test(text)) section = /classics|premium$/i.test(text.trim()) && !/extra/i.test(text) ? 'classics' : 'catalog';
      continue;
    }
    if (bar === -1 || !PLATFORM.test(right) || section === 'essential') continue;
    const title = text.slice(0, bar).trim();
    if (title) out.push({ title, section });
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load(dir) {
  const saved = readJson(path.join(dir, 'psplus-blog.json'), null);
  return saved && saved.version === VERSION ? saved : { version: VERSION, checkedAt: null, sitemaps: {}, posts: {} };
}

const due = (dir, now = Date.now()) => {
  const { checkedAt } = load(dir);
  return !checkedAt || now - Date.parse(checkedAt) > CHECK_EVERY;
};

// Reads sitemaps and any posts not read yet. Returns true when new posts were read.
async function update(dir, { delayMs = CRAWL_DELAY, now = new Date() } = {}) {
  const file = path.join(dir, 'psplus-blog.json');
  const state = load(dir);
  const year = now.getUTCFullYear();
  let first = true;
  const fetchText = async (url) => {
    if (!first) await sleep(delayMs);
    first = false;
    return getText(url, { timeoutMs: 30000 });
  };
  const maps = postSitemaps(await fetchText(`${BLOG}/wp-sitemap.xml`));
  const urls = new Set(Object.keys(state.posts));
  for (const map of maps) {
    // Past years' sitemaps don't change once read.
    const y = /(\d{4})(?:-\d+)?\.xml$/.exec(map);
    if (y && Number(y[1]) < year && state.sitemaps[map]) {
      state.sitemaps[map].forEach((u) => urls.add(u));
      continue;
    }
    const found = locs(await fetchText(map)).filter(isPost);
    if (y) state.sitemaps[map] = found;
    found.forEach((u) => urls.add(u));
  }
  let read = 0;
  // Newest first: recent months matter most for predictions.
  const todo = [...urls].filter((u) => !state.posts[u]).sort((a, b) => (joinedFor(b) || '').localeCompare(joinedFor(a) || ''));
  for (const url of todo) {
    const joined = joinedFor(url);
    if (!joined) continue;
    let html;
    try {
      html = await fetchText(url);
    } catch {
      continue;
    }
    state.posts[url] = { joined, titles: parsePost(html).map((x) => x.title) };
    read += 1;
    // Save as it goes, so an interrupted first read isn't lost.
    writeJson(file, state);
  }
  state.checkedAt = now.toISOString();
  writeJson(file, state);
  return read > 0;
}

// matchKey(title) -> the latest day the game joined, up to today.
function joinDates(state, today = new Date().toISOString().slice(0, 10)) {
  const out = new Map();
  for (const { joined, titles } of Object.values((state && state.posts) || {})) {
    if (!joined || joined > today) continue;
    for (const title of titles || []) {
      const key = matchKey(title);
      if (key && (!out.has(key) || joined > out.get(key))) out.set(key, joined);
    }
  }
  return out;
}

// Adds addedOn from the saved posts to games that don't have one yet.
function apply(games, dir, today) {
  if (!dir) return games;
  const dates = joinDates(load(dir), today);
  if (!dates.size) return games;
  return games.map((g) => {
    if (g.addedOn) return g;
    const date = lookup(dates, g.title);
    return date ? { ...g, addedOn: date } : g;
  });
}

// The blog's title for a game, allowing for small differences: an exact
// match, else the one blog title that starts with the store's (or the
// other way round) when the shorter has at least 10 letters.
function lookup(dates, title) {
  const key = matchKey(title);
  if (!key) return null;
  if (dates.has(key)) return dates.get(key);
  let found = null;
  for (const [k, d] of dates) {
    const [short, long] = k.length < key.length ? [k, key] : [key, k];
    if (short.length >= 10 && long.startsWith(short)) {
      if (found && found !== d) return null;
      found = d;
    }
  }
  return found;
}

module.exports = { update, due, load, apply, joinDates, lookup, parsePost, joinedFor, postSitemaps, isPost };
