const fs = require('fs');
const path = require('path');
const { getJson } = require('./http');
const { tableGrid, cellText, toIsoDate } = require('./nintendo');
const { systemName } = require('./covers');

// Antstream Arcade streams retro games on PC, Xbox and phones. It has no
// public feed, so the list is read from two places Antstream runs itself:
// 1. the "Antstream Arcade Games List" article in its help centre, read
//    through Zendesk's public Help Center API (JSON with the article's HTML);
// 2. failing that, the games page on antstream.com. That page builds its list
//    in the browser, so the app opens it in a hidden window and keeps the
//    JSON the page downloads.
// When neither gives a full list, what was read is saved in the catalog
// folder (antstream-help.json, antstream-capture.json, antstream-page.txt)
// so the reader can be fixed.
const HELP_URL = 'https://antstream.zendesk.com/api/v2/help_center/en-gb/articles/360004006837.json';
const HELP_PAGE = 'https://antstream.zendesk.com/hc/en-gb/articles/360004006837-Antstream-Arcade-Games-List';
const SITE_LIST = 'https://www.antstream.com/gameslist';
// Antstream has well over a thousand games; fewer than this means a page changed.
const MIN_GAMES = 300;
// Windows, Xbox consoles ('console', as Game Pass writes it) and phones.
const PLATFORMS = ['PC', 'console', 'Mobile'];

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// "August 2024" or "April 13, 2023" -> ISO date (the 1st when there's no day).
function addedDate(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/^[A-Za-z]+ \d{4}$/.test(s)) return toIsoDate(`1 ${s}`);
  return toIsoDate(s);
}

function makeGame({ title, system, publisher, year, image, added, link }, today) {
  const sys = system ? String(system).trim() : null;
  const date = addedDate(added);
  const y = (String(year || '').match(/\b(19|20)\d{2}\b/) || [])[0];
  const game = {
    id: `antstream:${slug(sys || 'game')}:${slug(title)}`,
    service: 'antstream',
    title: String(title).trim(),
    image: image || null,
    platforms: PLATFORMS,
    system: sys || null,
    tiers: ['any'],
    leavingSoon: false,
    genres: [],
    releaseDate: null,
    releaseYear: y ? Number(y) : null,
    addedOn: date && date <= today ? date : null,
    storeUrl: link || SITE_LIST,
  };
  if (date && date > today) game.comingOn = date;
  if (publisher) game.publisher = String(publisher).trim();
  return game;
}

function dedupe(games) {
  const seen = new Set();
  return games.filter((g) => g.title && !seen.has(g.id) && seen.add(g.id));
}

// A line of a plain list: "Boulder Dash", "Boulder Dash (C64)" or "Boulder Dash - Commodore 64".
function lineGame(text, system) {
  const s = String(text || '').replace(/^[\s•·\-–*]+/, '').trim();
  if (!s || s.length > 90 || /https?:|www\.|@/.test(s)) return null;
  // Sentences, not titles.
  if (/[.!?]$/.test(s) && s.split(/\s+/).length > 5) return null;
  const paren = s.match(/^(.+?)\s*[([]([^()[\]]+)[)\]]$/);
  if (paren && systemName(paren[2])) return { title: paren[1], system: paren[2] };
  const dash = s.match(/^(.+?)\s+[-–—|]\s+([^-–—|]+)$/);
  if (dash && systemName(dash[2])) return { title: dash[1], system: dash[2] };
  return { title: s, system };
}

// The help-centre article's HTML: tables with a title column, or lists of
// titles under a heading per system. Read in page order so each heading
// names the system of what follows it.
function parseList(html, today = new Date().toISOString().slice(0, 10)) {
  const out = [];
  let system = null;
  const re = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>|<table\b[^>]*>([\s\S]*?)<\/table>|<li\b[^>]*>([\s\S]*?)<\/li>|<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  for (const m of String(html || '').matchAll(re)) {
    if (m[1]) {
      system = cellText(m[2]).replace(/:$/, '') || system;
    } else if (m[3] != null) {
      const grid = tableGrid(m[3]).filter((r) => r.cells.some((c) => c));
      if (!grid.length) continue;
      const first = grid[0].cells.map((c) => String(c || '').toLowerCase());
      const col = (re2) => first.findIndex((c) => re2.test(c));
      let titleCol = col(/\b(title|game|name)\b/);
      const hasHeader = grid[0].allHeaders || titleCol !== -1;
      if (titleCol === -1) titleCol = 0;
      const sysCol = hasHeader ? col(/system|platform|format|machine|console|computer/) : -1;
      const pubCol = hasHeader ? col(/publisher/) : -1;
      const addCol = hasHeader ? col(/added|release date|joined|date/) : -1;
      const yearCol = hasHeader ? first.findIndex((c, i) => i !== addCol && /year|original|released?\b/.test(c)) : -1;
      for (const row of hasHeader ? grid.slice(1) : grid) {
        if (row.allHeaders) continue;
        const title = (row.cells[titleCol] || '').trim();
        if (!title || title.length > 90) continue;
        out.push(makeGame({
          title,
          system: (sysCol !== -1 && row.cells[sysCol]) || system,
          publisher: pubCol !== -1 ? row.cells[pubCol] : null,
          year: yearCol !== -1 ? row.cells[yearCol] : null,
          added: addCol !== -1 ? row.cells[addCol] : null,
          link: HELP_PAGE,
        }, today));
      }
    } else {
      const inner = m[4] != null ? m[4] : m[5];
      // A paragraph that's only bold text, or ends in a colon, names a system.
      const bold = inner.match(/^\s*<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>\s*(?:<br\s*\/?>)?\s*$/i);
      const whole = cellText(inner);
      if (m[5] != null && ((bold && cellText(bold[2]).length <= 40) || (/:$/.test(whole) && whole.length <= 40))) {
        system = cellText(bold ? bold[2] : inner).replace(/:$/, '');
        continue;
      }
      for (const piece of inner.split(/<br\s*\/?>/i)) {
        const hit = lineGame(cellText(piece), system);
        if (hit) out.push(makeGame({ ...hit, link: HELP_PAGE }, today));
      }
    }
  }
  return dedupe(out);
}

// ---- the antstream.com games page ----
const TITLE_KEYS = ['title', 'name', 'gameName', 'gameTitle', 'displayName'];
const SYSTEM_KEYS = ['system', 'systemName', 'platform', 'platformName', 'console', 'machine', 'format', 'hardware'];
const IMAGE_KEYS = ['image', 'imageUrl', 'thumbnail', 'thumbnailUrl', 'cover', 'coverUrl', 'boxart', 'boxArt', 'artwork', 'tile', 'tileImage', 'thumb', 'img', 'picture', 'boxshot', 'poster', 'icon', 'banner'];
const PUBLISHER_KEYS = ['publisher', 'publisherName'];
const YEAR_KEYS = ['year', 'releaseYear', 'originalReleaseYear', 'released'];

// A field's text: a string, a number, or an object's name/title/url.
function textOf(v) {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return textOf(v[0]);
  if (v && typeof v === 'object') return textOf(v.name ?? v.title ?? v.url ?? v.src ?? v.value ?? null);
  return null;
}
const firstOf = (o, keys) => {
  for (const k of keys) if (k in o && textOf(o[k])) return textOf(o[k]);
  return null;
};

// Every object with a title-like field in the page's JSON, grouped by its set
// of keys: the biggest group is the game list. A game without a system field
// takes the name of the object it's nested in ({ name: 'C64', games: [...] }).
function parseCaptured(responses, today = new Date().toISOString().slice(0, 10)) {
  const groups = new Map();
  const visit = (v, base, context, depth) => {
    if (depth > 12 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, base, context, depth + 1);
      return;
    }
    const title = firstOf(v, TITLE_KEYS);
    if (title && title.length <= 120) {
      const sig = Object.keys(v).sort().join(',');
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push({ o: v, base, context });
    }
    const here = firstOf(v, SYSTEM_KEYS) || title || context;
    for (const x of Object.values(v)) if (x && typeof x === 'object') visit(x, base, here, depth + 1);
  };
  for (const r of responses || []) {
    let data;
    try {
      data = JSON.parse(r.body);
    } catch {
      continue;
    }
    visit(data, r.url, null, 0);
  }
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
  const abs = (u, base) => {
    try {
      return u ? new URL(u, base).href : null;
    } catch {
      return null;
    }
  };
  return dedupe(best.map(({ o, base, context }) => {
    const img = firstOf(o, IMAGE_KEYS);
    return makeGame({
      title: firstOf(o, TITLE_KEYS),
      system: firstOf(o, SYSTEM_KEYS) || (context && systemName(context) ? context : null),
      publisher: firstOf(o, PUBLISHER_KEYS),
      year: firstOf(o, YEAR_KEYS),
      image: img && (/^https?:/i.test(img) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(img)) ? abs(img, base) : null,
    }, today);
  }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Opens the games page in a hidden window and keeps the JSON it downloads
// (and the page's text). Only works inside the app; returns null elsewhere.
async function captureSite(url = SITE_LIST, waitMs = 25000) {
  let electron;
  try {
    electron = require('electron');
  } catch {
    return null;
  }
  if (!electron || !electron.BrowserWindow) return null;
  const win = new electron.BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'antstream-list' },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const responses = [];
  const wanted = new Map();
  const dbg = win.webContents.debugger;
  try {
    // The debugger needs a page to talk to before the real one starts loading.
    await win.loadURL('about:blank');
    dbg.attach('1.3');
    dbg.on('message', async (_e, method, params) => {
      if (method === 'Network.responseReceived') {
        const r = params.response || {};
        if (/json/i.test(r.mimeType || '') || params.type === 'XHR' || params.type === 'Fetch') wanted.set(params.requestId, r.url);
      } else if (method === 'Network.loadingFinished' && wanted.has(params.requestId)) {
        const at = wanted.get(params.requestId);
        wanted.delete(params.requestId);
        try {
          const { body, base64Encoded } = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
          const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
          if (text && text.length < 30e6) responses.push({ url: at, body: text });
        } catch { /* gone already */ }
      }
    });
    await dbg.sendCommand('Network.enable', { maxResourceBufferSize: 30e6, maxTotalBufferSize: 100e6 });
    win.loadURL(url).catch(() => {});
    // Scrolling makes pages that load more as you go fetch the rest.
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await sleep(2500);
      try {
        await win.webContents.executeJavaScript('window.scrollTo(0, document.body ? document.body.scrollHeight : 0); 0');
      } catch { /* still loading */ }
    }
    let text = '';
    try {
      text = await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
    } catch { /* no page */ }
    return { responses, text: String(text || '') };
  } finally {
    try {
      dbg.detach();
    } catch { /* not attached */ }
    win.destroy();
  }
}

function save(dir, name, data) {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 1));
  } catch { /* debugging aid only */ }
}

async function fetchLive(_settings, dir, { capture = captureSite } = {}) {
  const tried = [];
  let games = [];
  try {
    const data = await getJson(HELP_URL, { timeoutMs: 30000 });
    games = parseList(data?.article?.body || '');
    if (games.length < MIN_GAMES) save(dir, 'antstream-help.json', data);
    tried.push(`help centre: ${games.length} games`);
  } catch (err) {
    tried.push(`help centre: ${err.message}`);
  }
  if (games.length < MIN_GAMES) {
    try {
      const cap = await capture();
      if (cap) {
        const found = parseCaptured(cap.responses);
        tried.push(`antstream.com: ${found.length} games`);
        if (found.length > games.length) games = found;
        if (found.length < MIN_GAMES) {
          // The largest responses in full, the rest as a sample.
          const bySize = [...cap.responses].sort((a, b) => b.body.length - a.body.length);
          let room = 15e6;
          save(dir, 'antstream-capture.json', bySize.map((r) => {
            const full = r.body.length <= room;
            if (full) room -= r.body.length;
            return { url: r.url, size: r.body.length, body: full ? r.body : r.body.slice(0, 4000) };
          }));
          save(dir, 'antstream-page.txt', cap.text);
        }
      }
    } catch (err) {
      tried.push(`antstream.com: ${err.message}`);
    }
  }
  if (games.length < MIN_GAMES) throw new Error(`Antstream's game list couldn't be read (${tried.join('; ')})`);
  return games;
}

module.exports = { fetchLive, parseList, parseCaptured, lineGame, addedDate, HELP_PAGE, SITE_LIST, captureSite };
