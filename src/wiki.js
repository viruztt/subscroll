const fs = require('fs');
const path = require('path');
const http = require('./providers/http');
const { cleanTitle, lookupKey, key } = require('./ratings');

// Developer, publisher, genres and cover art from a game's Wikipedia
// infobox. Switch Online, PS Plus and Netflix lists don't name developers or
// (for Switch Online) genres, and Apple Arcade games that left the App Store
// have no icon there. Looked up in the background, one game at a time, and
// cached for a month (two weeks when no page was found).
const API = 'https://en.wikipedia.org/w/api.php';
const HEADERS = { 'Api-User-Agent': 'Subscroll/0.2 (desktop app)' };
const HIT_DAYS = 30;
const MISS_DAYS = 14;
const PAUSE_MS = 700;
const MAX_FAILURES = 5;
const EDITION = /[\s:–—-]+(standard|deluxe|definitive|complete|enhanced|ultimate|gold|premium|digital deluxe|game of the year|goty|anniversary|remastered|director'?s cut|arcade|cross-gen bundle)( edition| bundle)?$/i;
const SYSTEM_WORDS = {
  NES: 'NES', SNES: 'Super NES', 'Game Boy': 'Game Boy', N64: 'Nintendo 64', 'Sega Genesis': 'Sega Genesis',
  'Game Boy Advance': 'Game Boy Advance', 'Virtual Boy': 'Virtual Boy', 'GameCube (Switch 2)': 'GameCube',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- infobox ----
// The text of one "| field = value" entry, which can run over several lines
// ({{Plainlist| * [[A]] * [[B]] }}).
function field(box, name) {
  const re = new RegExp(`\\n\\s*\\|\\s*${name}\\s*=`, 'i');
  const m = re.exec(box);
  if (!m) return '';
  let depth = 0;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < box.length; i++) {
    const two = box.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth += 1; i += 1; continue; }
    if (two === '}}' || two === ']]') {
      if (depth === 0) break;
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && box[i] === '\n' && /^\n\s*\|/.test(box.slice(i, i + 40))) break;
  }
  return box.slice(start, i);
}

// "[[Nintendo EAD]]<br>{{ubl|[[Rare (company)|Rare]]|Retro}}" -> ['Nintendo EAD', 'Rare', 'Retro']
function listValues(value) {
  let s = value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[\s\S]*?<\/ref>/gi, '')
    .replace(/\{\{\s*(efn|refn|sfn|cn|citation needed|nbsp)[^{}]*\}\}/gi, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/'{2,}/g, '');
  // List and wrapper templates: keep their items.
  s = s.replace(/\{\{\s*(?:ubl|unbulleted list|plainlist|plain list|flatlist|flat list|hlist|collapsible list|nowrap|vgrelease|video game release)\s*\|?/gi, '|')
    .replace(/\{\{|\}\}/g, '|');
  return [...new Set(s.split(/<br\s*\/?>|\n|\*|\||,|;|•/i)
    .map((x) => x.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
    // Region labels from {{Video game release|NA|…|JP|…}}.
    .filter((x) => x && !x.includes('=') && x.length < 80 && !/^(NA|EU|JP|PAL|AU|NZ|WW|KOR|KR|AS|INT|UK|US|EUR|JPN)$/i.test(x)))];
}

function parseInfobox(wikitext) {
  const m = /\{\{\s*infobox video game\s*(?=[|\n<])/i.exec(wikitext || '');
  if (!m) return null;
  const box = `\n${wikitext.slice(m.index + m[0].length)}`;
  const take = (name) => listValues(field(box, name));
  // Developers credited per platform: "Nintendo EAD (N64)" -> "Nintendo EAD".
  const strip = (list) => [...new Set(list.map((x) => x.replace(/\s*\([^)]*\)\s*$/, '').trim()).filter(Boolean))];
  return {
    title: take('title')[0] || null,
    developer: strip(take('developers?')).slice(0, 4).join(', ') || null,
    publisher: strip(take('publishers?')).slice(0, 4).join(', ') || null,
    genres: strip(take('genres?')).slice(0, 6),
  };
}

// ---- finding the page ----
const plain = (title) => cleanTitle(title).replace(EDITION, '').replace(/\s+SP$/, '').trim();
// "Inside (video game)" and "Super Dodge Ball (1988 video game)" name "Inside" and "Super Dodge Ball".
const pageKey = (title) => key(title.replace(/\s*\((?:\d{4} )?(?:[\w-]+ )?(?:video )?game\)\s*$/i, ''));

// Page names to try directly, best first.
function pageNames(title, year) {
  const t = plain(title);
  return [...new Set([year && `${t} (${year} video game)`, t, `${t} (video game)`].filter(Boolean))];
}

async function query(params) {
  const qs = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', redirects: '1',
    prop: 'revisions|pageimages', rvprop: 'content', rvslots: 'main', rvsection: '0',
    piprop: 'thumbnail', pithumbsize: '600', pilicense: 'any', ...params,
  });
  const data = await http.getJson(`${API}?${qs}`, { headers: HEADERS });
  if (data.error) throw new Error(`Wikipedia: ${data.error.info || data.error.code}`);
  return (data.query && data.query.pages) || [];
}

function factsFrom(page) {
  const rev = page.revisions && page.revisions[0];
  const text = rev && (rev.slots ? rev.slots.main && rev.slots.main.content : rev.content);
  const box = parseInfobox(text);
  if (!box) return null;
  return {
    page: page.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    developer: box.developer,
    publisher: box.publisher,
    genres: box.genres,
    image: (page.thumbnail && page.thumbnail.source) || null,
    boxTitle: box.title,
  };
}

const samePage = (page, title) => pageKey(page) === key(plain(title));

// The page is the game when its name (or its infobox title) is the game's.
function matches(facts, title) {
  const k = key(plain(title));
  return pageKey(facts.page) === k || (facts.boxTitle && key(facts.boxTitle) === k);
}

async function findFacts(game) {
  const year = game.releaseDate ? Number(game.releaseDate.slice(0, 4)) : null;
  const names = pageNames(game.title, game.service === 'nso' ? null : year);
  const pages = await query({ titles: names.join('|') });
  const found = new Map();
  for (const p of pages) {
    if (p.missing || p.invalid) continue;
    const f = factsFrom(p);
    if (f) found.set(p.title, f);
  }
  // Redirects mean a page can come back under another name.
  for (const name of names) if (found.has(name)) return found.get(name);
  for (const f of found.values()) if (matches(f, game.title)) return f;
  // Otherwise a search, accepting only a page with the game's own name.
  const hint = game.service === 'nso' ? SYSTEM_WORDS[(game.platforms || [])[0]] || '' : '';
  const hits = await query({ generator: 'search', gsrsearch: `${plain(game.title)} ${hint} video game`.replace(/\s+/g, ' '), gsrlimit: '5' });
  hits.sort((a, b) => (a.index || 0) - (b.index || 0));
  for (const p of hits) {
    const f = factsFrom(p);
    if (f && matches(f, game.title)) return f;
  }
  return null;
}

// ---- cache and background lookups ----
class Wiki {
  constructor(dir, { onFound = () => {}, pauseMs = PAUSE_MS, find = findFacts } = {}) {
    this.file = path.join(dir, 'wikipedia.json');
    this.onFound = onFound;
    this.pauseMs = pauseMs;
    this.find = find;
    this.running = null;
    this.pending = null;
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  facts(g) {
    const hit = this.data[lookupKey(g)];
    return hit && hit.data;
  }

  // Fills what a list left out; the list's own values win.
  fill(g) {
    const f = this.facts(g);
    if (!f) return g;
    const out = { ...g, wikiPage: f.url };
    if (!g.developer && f.developer) out.developer = f.developer;
    if (!g.publisher && f.publisher) out.publisher = f.publisher;
    if (!(g.genres || []).length && f.genres.length) out.genres = f.genres;
    if (!g.image && f.image) out.image = f.image;
    return out;
  }

  due(g, now = Date.now()) {
    const hit = this.data[lookupKey(g)];
    if (!hit) return true;
    return now - hit.at > (hit.data ? HIT_DAYS : MISS_DAYS) * 86400000;
  }

  // games: the ones worth asking about, most wanted first.
  start(games) {
    this.pending = games;
    if (!this.running) this.running = this.loop().finally(() => { this.running = null; });
    return this.running;
  }

  async loop() {
    while (this.pending) {
      const games = this.pending;
      this.pending = null;
      await this.run(games);
    }
  }

  async run(games) {
    const seen = new Set();
    const todo = games.filter((g) => {
      const k = lookupKey(g);
      if (!k || seen.has(k) || !this.due(g)) return false;
      seen.add(k);
      return true;
    });
    let failures = 0;
    let found = 0;
    for (const g of todo) {
      if (this.pending) break;
      try {
        const data = await this.find(g);
        failures = 0;
        this.data[lookupKey(g)] = { at: Date.now(), data };
        if (data) {
          found += 1;
          if (found % 25 === 0) {
            this.save();
            this.onFound(found);
          }
        }
      } catch {
        failures += 1;
        if (failures >= MAX_FAILURES) break;
        await sleep(this.pauseMs * 10 * failures);
      }
      await sleep(this.pauseMs);
    }
    this.save();
    if (found % 25 !== 0) this.onFound(found);
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch {
      // Cache only.
    }
  }
}

// Which games to ask about: games you've completed (they drive "Because you
// beat"), then games in your plans from lists without developers or genres,
// then Apple Arcade games still without a picture.
function wanted(games, { isMine, markOf }) {
  const lacking = (g) => !g.developer || !(g.genres || []).length;
  const gaps = ['nso', 'psplus', 'netflix'];
  const done = games.filter((g) => markOf(g) === 'completed' && lacking(g));
  const mine = games.filter((g) => isMine(g) && gaps.includes(g.service) && lacking(g));
  const covers = games.filter((g) => g.service === 'applearcade' && !g.image);
  return [...done, ...mine, ...covers];
}

module.exports = { Wiki, wanted, samePage, parseInfobox, listValues, pageNames, findFacts, matches, plain };
