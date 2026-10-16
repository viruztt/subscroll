const fs = require('fs');
const path = require('path');
const http = require('./providers/http');

// Metacritic scores and How Long To Beat times. Neither site has a public
// API, so this uses the same search endpoints their own pages call. Every
// game is looked up once in the background and cached for a month (two
// weeks when nothing was found), so sorting by score or length covers the
// whole catalogue.
const HIT_DAYS = 30;
const MISS_DAYS = 14;
const CONCURRENCY = 2;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// ---- titles ----
const EDITION = /[\s:–—-]+(standard|deluxe|definitive|complete|enhanced|ultimate|gold|premium|digital deluxe|game of the year|goty|anniversary|director'?s cut)( edition)?$/i;

function cleanTitle(title) {
  return title
    .replace(/[™®©]/g, '')
    .replace(/\s+\((NA|JP|EU|PAL)\)$/i, '') // Switch Online regional versions
    .replace(/\s+SP(\s+\(.*\))?$/, '') // Switch Online special editions
    .replace(/\s*\((?:classic|ps[1-5]|ps4 ?& ?ps5|windows|pc|xbox[^)]*|game preview|preview)[^)]*\)\s*$/i, '')
    .replace(/\s+ps[45]\s*(&|and)\s*ps[45]$/i, '')
    .replace(/[\s:–—-]+(for )?(windows( 10)?|pc|xbox series x\|s|xbox one|game preview)( edition)?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const key = (title) => title
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ')
  .replace(/^(the|a) /, '')
  .replace(/[^a-z0-9]+/g, '');

// Best search result for a title: an exact match, then one that differs
// only by an edition suffix. Ties go to the closest release year.
function pickMatch(items, title, year) {
  const k = key(title);
  const base = key(title.replace(EDITION, ''));
  const scored = items
    .map((item) => {
      const names = [item.name, ...(item.aliases || [])].filter(Boolean);
      const keys = names.map((n) => key(cleanTitle(n)));
      let rank = null;
      if (keys.includes(k)) rank = 0;
      else if (keys.some((x) => x === base || key(cleanTitle(item.name).replace(EDITION, '')) === base)) rank = 1;
      return { item, rank };
    })
    .filter((x) => x.rank !== null);
  if (!scored.length) return null;
  const yearGap = (item) => (year && item.year ? Math.abs(item.year - year) : 0);
  scored.sort((a, b) => a.rank - b.rank || yearGap(a.item) - yearGap(b.item));
  return scored[0].item;
}

// ---- Metacritic ----
// The key is the public one metacritic.com's own pages send.
const MC_SEARCH = 'https://backend.metacritic.com/finder/metacritic/search/';
const MC_KEY = '1MOZgmNFxvmljaQR1X9KAij9Mo4xAY3u';

async function metacritic(title, year) {
  const url = `${MC_SEARCH}${encodeURIComponent(title)}/web?apiKey=${MC_KEY}&offset=0&limit=20`;
  const data = await http.getJson(url, { headers: { 'User-Agent': BROWSER_UA } });
  const items = ((data.data && data.data.items) || [])
    .filter((i) => i.type === 'game-title')
    .map((i) => ({
      name: i.title,
      year: i.releaseDate ? Number(String(i.releaseDate).slice(0, 4)) : i.premiereYear || null,
      score: Number.parseInt(i.criticScoreSummary && i.criticScoreSummary.score, 10),
      url: i.slug ? `https://www.metacritic.com/game/${i.slug}/` : null,
    }));
  const hit = pickMatch(items, title, year);
  return hit ? { score: Number.isFinite(hit.score) ? hit.score : null, url: hit.url } : null;
}

// ---- How Long To Beat ----
// The search endpoint's path and a short-lived token are read from the
// site's own scripts, as its pages do; both change from time to time.
const HLTB = 'https://howlongtobeat.com/';
const POST_RE = /fetch\s*\(\s*["'`]\/api\/([a-zA-Z0-9_/]+)["'`][^,{;]*,\s*{[^}]*method:\s*["']POST["']/i;

async function getText(url, headers) {
  const res = await http.fetchRaw(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

const hltbHeaders = () => ({ 'User-Agent': BROWSER_UA, Referer: HLTB, Origin: HLTB.replace(/\/$/, '') });

async function hltbSession() {
  let apiPath = 'api/s';
  try {
    const home = await getText(HLTB, hltbHeaders());
    const scripts = [...home.matchAll(/<script[^>]+src="([^"]*\/_next\/static\/chunks\/[^"]+)"/g)].map((m) => m[1]);
    for (const src of scripts) {
      const m = (await getText(new URL(src, HLTB).href, hltbHeaders())).match(POST_RE);
      if (m) {
        apiPath = `api/${m[1].replace(/\/$/, '')}`;
        break;
      }
    }
  } catch {
    // Fall back to the last known path.
  }
  const init = await http.getJson(`${HLTB}${apiPath}/init?t=${Date.now()}`, { headers: hltbHeaders() });
  const session = { url: `${HLTB}${apiPath}`, token: init.token, hpKey: null, hpVal: null };
  for (const [name, value] of Object.entries(init)) {
    if (/key/i.test(name)) session.hpKey = value;
    else if (/val/i.test(name)) session.hpVal = value;
  }
  return session;
}

function hltbPayload(title, session) {
  const payload = {
    searchType: 'games',
    searchTerms: title.split(' '),
    searchPage: 1,
    size: 20,
    searchOptions: {
      games: {
        userId: 0, platform: '', sortCategory: 'popular', rangeCategory: 'main',
        rangeTime: { min: 0, max: 0 }, gameplay: { perspective: '', flow: '', genre: '', difficulty: '' },
        rangeYear: { max: '', min: '' }, modifier: 'hide_dlc',
      },
      users: { sortCategory: 'postcount' },
      lists: { sortCategory: 'follows' },
      filter: '', sort: 0, randomizer: 0,
    },
    useCache: true,
  };
  if (session.hpKey) payload[session.hpKey] = session.hpVal;
  return payload;
}

const hours = (seconds) => (seconds > 0 ? Math.round(seconds / 360) / 10 : null);

class HowLongToBeat {
  constructor() {
    this.session = null;
  }

  async search(title, year, retried = false) {
    if (!this.session) this.session = hltbSession();
    const session = await this.session;
    const headers = { ...hltbHeaders(), 'Content-Type': 'application/json', Accept: '*/*' };
    if (session.token) headers['x-auth-token'] = String(session.token);
    if (session.hpKey) {
      headers['x-hp-key'] = String(session.hpKey);
      headers['x-hp-val'] = String(session.hpVal);
    }
    const res = await http.fetchRaw(session.url, { method: 'POST', headers, body: JSON.stringify(hltbPayload(title, session)) });
    if (!res.ok) {
      // Tokens expire; get a fresh one once.
      this.session = null;
      if (!retried && (res.status === 401 || res.status === 403 || res.status === 404)) return this.search(title, year, true);
      throw new Error(`HTTP ${res.status} from howlongtobeat.com`);
    }
    const data = await res.json();
    const items = (data.data || []).map((g) => ({
      name: g.game_name,
      aliases: g.game_alias ? String(g.game_alias).split(/,\s*/) : [],
      year: g.release_world || null,
      main: hours(g.comp_main),
      plus: hours(g.comp_plus),
      all: hours(g.comp_100),
      url: `${HLTB}game/${g.game_id}`,
    }));
    const hit = pickMatch(items, title, year);
    return hit ? { main: hit.main, plus: hit.plus, all: hit.all, url: hit.url } : null;
  }
}

// ---- background lookups ----
// Same-titled retro games on different systems are different games.
const lookupKey = (g) => (g.service === 'nso' ? `${g.platforms[0]}|` : '') + key(cleanTitle(g.title));

class Ratings {
  constructor(dir, { onUpdate = () => {}, onProgress = () => {} } = {}) {
    this.file = path.join(dir, 'ratings.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
    this.onUpdate = onUpdate;
    this.onProgress = onProgress;
    this.hltb = new HowLongToBeat();
    this.running = null;
    this.pending = null;
  }

  // game id -> { mc, mcUrl, hltb: { main, plus, all }, hltbUrl }
  forGames(games) {
    const out = {};
    for (const g of games) {
      const r = this.data[lookupKey(g)];
      if (r) out[g.id] = r;
    }
    return out;
  }

  fresh(r) {
    if (!r) return false;
    const found = r.mc != null || r.hltb != null;
    return Date.now() - r.fetchedAt < (found ? HIT_DAYS : MISS_DAYS) * 86400000;
  }

  // Looks up every game without fresh data, `first` ones first. A second
  // call while running restarts with the new list once the current one ends.
  start(games, first = () => false) {
    this.pending = { games, first };
    if (!this.running) this.running = this.loop().finally(() => { this.running = null; });
    return this.running;
  }

  async loop() {
    while (this.pending) {
      const { games, first } = this.pending;
      this.pending = null;
      await this.run(games, first);
    }
  }

  async run(games, first) {
    const groups = new Map(); // lookup key -> games sharing it
    for (const g of games) {
      const k = lookupKey(g);
      if (!k || this.fresh(this.data[k])) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(g);
    }
    const todo = [...groups.entries()].sort((a, b) => Number(b[1].some(first)) - Number(a[1].some(first)));
    let done = 0;
    let failures = 0;
    let lastSave = Date.now();
    const total = todo.length;
    if (!total) return;
    this.onProgress({ done, total });
    await http.mapLimit(todo, CONCURRENCY, async ([k, group]) => {
      if (this.pending || failures > 25) return; // superseded, or the sites are unreachable
      const g = group[0];
      const title = cleanTitle(g.title);
      const year = g.releaseDate ? Number(g.releaseDate.slice(0, 4)) : null;
      const [mc, hl] = await Promise.allSettled([metacritic(title, year), this.hltb.search(title, year)]);
      if (mc.status === 'rejected' && hl.status === 'rejected') {
        failures += 1;
      } else {
        failures = 0;
        const prev = this.data[k] || {};
        const entry = {
          mc: mc.status === 'fulfilled' ? (mc.value ? mc.value.score : null) : prev.mc ?? null,
          mcUrl: mc.status === 'fulfilled' ? (mc.value ? mc.value.url : null) : prev.mcUrl ?? null,
          hltb: hl.status === 'fulfilled' ? (hl.value && (hl.value.main || hl.value.plus || hl.value.all) ? { main: hl.value.main, plus: hl.value.plus, all: hl.value.all } : null) : prev.hltb ?? null,
          hltbUrl: hl.status === 'fulfilled' ? (hl.value ? hl.value.url : null) : prev.hltbUrl ?? null,
          fetchedAt: Date.now(),
        };
        // A failed half is retried on the next run.
        if (mc.status === 'rejected' || hl.status === 'rejected') entry.fetchedAt = 0;
        this.data[k] = entry;
        this.onUpdate(Object.fromEntries(group.map((x) => [x.id, entry])));
      }
      done += 1;
      this.onProgress({ done, total });
      if (Date.now() - lastSave > 10000) {
        lastSave = Date.now();
        this.save();
      }
    });
    this.save();
    this.onProgress({ done: total, total, finished: true, failed: failures > 25 });
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch {
      // Cache only; nothing lost but time.
    }
  }
}

module.exports = { Ratings, HowLongToBeat, metacritic, cleanTitle, pickMatch, lookupKey, key };
