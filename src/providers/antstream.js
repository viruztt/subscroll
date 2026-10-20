const fs = require('fs');
const path = require('path');
const { systemName } = require('./covers');

// Antstream Arcade streams retro games on PC, Xbox and phones. It has no
// public feed; its games page (antstream.com/gameslist) builds the library
// in the browser, 24 games at a time behind a "Load More" button. The app
// opens it in a hidden window, presses the button until every game is shown
// and reads each game's card (title, system, genre, picture, link), plus any
// game list JSON the page downloads on the way.
// What was read last is kept in the catalog folder (antstream-cards.json,
// antstream-capture.json, antstream-requests.txt, antstream-page.txt/.html,
// antstream-log.txt) so the reader can be checked against it.
const SITE_LIST = 'https://www.antstream.com/gameslist';
// Antstream has well over a thousand games; fewer than this means a page changed.
const MIN_GAMES = 300;
// Windows, Xbox consoles ('console', as Game Pass writes it) and phones.
const PLATFORMS = ['PC', 'console', 'Mobile'];

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// "SPECTRUM", "C64", "Megadrive" -> the name the rest of the app uses.
function systemLabel(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return systemName(s) || (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);
}

function makeGame({ title, system, publisher, year, image, link, genre }) {
  const sys = systemLabel(system);
  const y = (String(year || '').match(/\b(19|20)\d{2}\b/) || [])[0];
  const game = {
    id: `antstream:${slug(sys || 'game')}:${slug(title)}`,
    service: 'antstream',
    title: String(title).trim(),
    image: image || null,
    platforms: PLATFORMS,
    system: sys,
    tiers: ['any'],
    leavingSoon: false,
    genres: genre ? [String(genre).trim()] : [],
    releaseDate: null,
    releaseYear: y ? Number(y) : null,
    addedOn: null,
    storeUrl: link || SITE_LIST,
  };
  if (publisher) game.publisher = String(publisher).trim();
  return game;
}

function dedupe(games) {
  const seen = new Set();
  return games.filter((g) => g.title && !seen.has(g.id) && seen.add(g.id));
}

// One card of the library grid, as its text pieces in page order:
// ["Spectrum", "2 Challenges", "Manic Miner", "Platform", "Manic Miner", "View"].
// The title shows twice (or matches the picture's alt text), the system comes
// first and the genre follows.
const NOISE = /^(view|find game|play|play now|\d+\s+challenges?)$/i;
function parseCard(card) {
  const texts = (card.texts || []).map((t) => String(t).replace(/\s+/g, ' ').trim()).filter((t) => t && !NOISE.test(t));
  if (!texts.length) return null;
  const alt = String(card.alt || '').trim().toLowerCase();
  const count = (t) => texts.filter((x) => x.toLowerCase() === t.toLowerCase()).length;
  const title = texts.find((t) => alt && t.toLowerCase() === alt) || texts.find((t) => count(t) > 1) ||
    (texts.length >= 3 ? texts[1] : texts[texts.length - 1]);
  if (!title || title.length > 120) return null;
  const rest = texts.filter((t) => t.toLowerCase() !== title.toLowerCase());
  const system = rest.length > 1 || systemName(rest[0]) ? rest[0] : null;
  const genre = rest.find((t) => t !== system && t.length <= 30) || null;
  const image = card.img && /^https?:/i.test(card.img) ? card.img : null;
  return makeGame({ title, system, genre, image, link: card.href && /^https?:/i.test(card.href) ? card.href : null });
}

function parseCards(cards) {
  return dedupe((cards || []).map(parseCard).filter(Boolean));
}

// ---- game list JSON the page downloads ----
const TITLE_KEYS = ['title', 'name', 'gameName', 'gameTitle', 'displayName'];
const SYSTEM_KEYS = ['system', 'systemName', 'platform', 'platformName', 'console', 'machine', 'format', 'hardware'];
const IMAGE_KEYS = ['image', 'imageUrl', 'image_uri', 'imageUri', 'image_url', 'img_src', 'thumbnail', 'thumbnailUrl', 'cover', 'coverUrl', 'boxart', 'boxArt', 'artwork', 'tile', 'tileImage', 'thumb', 'img', 'picture', 'boxshot', 'poster', 'icon', 'banner'];
const PUBLISHER_KEYS = ['publisher', 'publisherName', 'studio', 'developer'];
const YEAR_KEYS = ['year', 'releaseYear', 'originalReleaseYear', 'released'];
const GENRE_KEYS = ['genre', 'genres', 'category', 'categories'];

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
// of keys. Challenges (objects with challenge or tier fields) aren't games.
// Among the rest, the biggest group with a system wins. Pictures given as a
// bare file name ("pac-man_namco_arcade_game-image.png") are found among the
// picture addresses the page showed (`seen`).
function parseCaptured(responses, seen = []) {
  const groups = new Map();
  const visit = (v, base, context, depth) => {
    if (depth > 12 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, base, context, depth + 1);
      return;
    }
    const title = firstOf(v, TITLE_KEYS);
    const keys = Object.keys(v);
    if (title && title.length <= 120 && !keys.some((k) => /challenge|^tier$/i.test(k))) {
      const sig = [...keys].sort().join(',');
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push({ o: v, base, context });
    }
    const here = firstOf(v, SYSTEM_KEYS) || title || context;
    for (const x of Object.values(v)) if (x && typeof x === 'object') visit(x, base, here, depth + 1);
  };
  for (const r of responses || []) {
    try {
      visit(JSON.parse(r.body), r.url, null, 0);
    } catch { /* not JSON */ }
  }
  const has = (g, keys) => g.some(({ o }) => firstOf(o, keys));
  const all = [...groups.values()].sort((a, b) => (has(b, SYSTEM_KEYS) - has(a, SYSTEM_KEYS)) || (b.length - a.length));
  const best = all[0] || [];
  const fileOf = (u) => {
    try {
      return decodeURIComponent(String(u).split(/[?#]/)[0].split('/').pop()).toLowerCase();
    } catch {
      return '';
    }
  };
  const byFile = new Map(seen.map((u) => [fileOf(u), u]).filter(([f]) => f));
  // Bare file names share one folder: learn it from any picture the page showed.
  let folder = null;
  for (const { o } of best) {
    const img = firstOf(o, IMAGE_KEYS);
    const hit = img && !/^https?:|^\//i.test(img) && byFile.get(fileOf(img));
    if (hit) {
      const depth = img.split('/').length; // "Folder/x.png" sits one level deeper
      folder = hit.split(/[?#]/)[0].split('/').slice(0, -depth).join('/') + '/';
      break;
    }
  }
  const picture = (img, base) => {
    if (!img) return null;
    if (/^https?:/i.test(img)) return img;
    if (!/\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(img)) return null;
    const known = byFile.get(fileOf(img));
    if (known) return known;
    if (folder && !/^\//.test(img)) return folder + img.split('/').map((p) => encodeURIComponent(decodeURIComponent(p))).join('/');
    try {
      return /^\//.test(img) ? new URL(img, base).href : null;
    } catch {
      return null;
    }
  };
  return dedupe(best.map(({ o, base, context }) => makeGame({
    title: firstOf(o, TITLE_KEYS),
    system: firstOf(o, SYSTEM_KEYS) || (context && systemName(context) ? context : null),
    publisher: firstOf(o, PUBLISHER_KEYS),
    year: firstOf(o, YEAR_KEYS),
    genre: firstOf(o, GENRE_KEYS),
    image: picture(firstOf(o, IMAGE_KEYS), base),
  })));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in the page: presses the "Load More" button if there is one.
// In-page helper: the innermost elements whose whole text matches (the page
// draws its buttons from plain elements, not only <button> and <a>).
const FIND_LEAVES = `const leaves = (re) => [...document.querySelectorAll('body *')]
  .filter((e) => e.tagName !== 'SCRIPT' && e.tagName !== 'STYLE' && re.test(e.textContent || '') && ![...e.children].some((c) => re.test(c.textContent || '')));`;

// Runs in the page: presses the "Load More" button if there is one.
const PRESS_MORE = `(() => {
  ${FIND_LEAVES}
  const leaf = leaves(/^\\s*(load|show) more\\s*$/i)[0];
  if (!leaf) return false;
  const b = leaf.closest('button, a, [role=button]') || leaf;
  if (b.disabled) return false;
  b.scrollIntoView({ block: 'center' });
  b.click();
  return true;
})()`;

// Runs in the page: every game card, found from its "View" button. A card is
// the largest box around the button that holds no other card's button.
const READ_CARDS = `(() => {
  ${FIND_LEAVES}
  const views = leaves(/^\\s*view\\s*$/i);
  views.forEach((v) => v.setAttribute('data-subscroll-view', ''));
  const texts = (el) => {
    const out = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) {
      const t = n.textContent.replace(/\\s+/g, ' ').trim();
      if (t) out.push(t);
    }
    return out;
  };
  const picture = (el) => {
    const img = el.querySelector('img');
    // Lazy pictures keep a placeholder until scrolled to; their real address waits in a data attribute.
    const web = (u) => u && /^https?:/i.test(u) ? new URL(u, location.href).href : null;
    if (img) return { img: [img.currentSrc, img.src, img.dataset.src, img.dataset.lazySrc, (img.getAttribute('srcset') || '').split(/\\s+/)[0]].map(web).find(Boolean) || null, alt: img.alt || '' };
    for (const x of [el, ...el.querySelectorAll('*')]) {
      const m = (getComputedStyle(x).backgroundImage || '').match(/url\\(["']?([^"')]+)/);
      if (m) return { img: new URL(m[1], location.href).href, alt: '' };
    }
    return { img: null, alt: '' };
  };
  return views.map((v) => {
    let card = v;
    while (card.parentElement && card.parentElement.querySelectorAll('[data-subscroll-view]').length === 1) card = card.parentElement;
    const link = v.closest('a') || card.querySelector('a[href]');
    return { texts: texts(card), href: link ? link.href : null, ...picture(card) };
  });
})()`;

const COUNT_CARDS = `(() => {
  ${FIND_LEAVES}
  return leaves(/^\\s*view\\s*$/i).length;
})()`;

// Runs in the page: a step further down each time, back to the top at the end.
const SCROLL_THROUGH = `(() => {
  const h = document.body ? document.body.scrollHeight : 0;
  const y = window.scrollY + window.innerHeight >= h - 10 ? 0 : window.scrollY + window.innerHeight;
  window.scrollTo(0, y);
  return y;
})()`;

const SEEN_PICTURES = `[...new Set([...document.images].map((i) => i.currentSrc || i.src).filter(Boolean))]`;

// Opens the games page in a hidden window, presses "Load More" until every
// game shows, then reads the cards. Keeps the JSON the page downloads and a
// list of every address it asked for. Only works inside the app; returns
// null elsewhere.
async function captureSite(url = SITE_LIST, budgetMs = 180000) {
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
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'antstream-list', backgroundThrottling: false },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const responses = [];
  const requests = [];
  const wanted = new Map();
  const dbg = win.webContents.debugger;
  const run = async (code, fallback) => {
    try {
      return await win.webContents.executeJavaScript(code);
    } catch {
      return fallback;
    }
  };
  try {
    // The debugger needs a page to talk to before the real one starts loading.
    await win.loadURL('about:blank');
    dbg.attach('1.3');
    dbg.on('message', async (_e, method, params) => {
      if (method === 'Network.responseReceived') {
        const r = params.response || {};
        if (requests.length < 3000) requests.push(`${r.status} ${params.type} ${r.mimeType} ${r.url}`);
        if (/json/i.test(r.mimeType || '') || params.type === 'XHR' || params.type === 'Fetch' || /\.json(\?|$)/i.test(r.url || '')) wanted.set(params.requestId, r.url);
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
    const until = Date.now() + budgetMs;
    // The library shows up a while after the page (sometimes half a minute):
    // scroll through the page until the first game cards appear.
    const cardCount = () => run(COUNT_CARDS, 0);
    let shown = 0;
    const firstBy = Date.now() + 75000;
    while (Date.now() < firstBy && !(shown = await cardCount())) {
      await run(SCROLL_THROUGH, 0);
      await sleep(2500);
    }
    // Press "Load More" until it's gone and no more cards arrive (six checks
    // in a row), or time's up.
    let misses = 0;
    let presses = 0;
    while (shown && Date.now() < until && misses < 6) {
      const pressed = await run(PRESS_MORE, false);
      if (pressed) presses += 1;
      await sleep(1500);
      const now = await cardCount();
      misses = pressed || now > shown ? 0 : misses + 1;
      if (!pressed) await run('window.scrollTo(0, document.body ? document.body.scrollHeight : 0); 0', 0);
      shown = Math.max(shown, now);
    }
    const cards = await run(READ_CARDS, []);
    const pictures = await run(SEEN_PICTURES, []);
    const text = await run('document.body ? document.body.innerText : ""', '');
    const html = await run('document.documentElement.outerHTML', '');
    return { responses, requests, cards: cards || [], pictures: pictures || [], presses, text: String(text || ''), html: String(html || '') };
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

// The longer list wins; the other fills in pictures, genres and links.
function combine(a, b) {
  const [main, other] = a.length >= b.length ? [a, b] : [b, a];
  const byTitle = new Map(other.map((g) => [slug(g.title), g]));
  return main.map((g) => {
    const o = byTitle.get(slug(g.title));
    if (!o) return g;
    const shouting = (t) => t === t.toUpperCase() && t !== t.toLowerCase();
    return {
      ...g,
      title: shouting(g.title) && !shouting(o.title) ? o.title : g.title,
      image: g.image || o.image,
      genres: g.genres.length ? g.genres : o.genres,
      system: g.system || o.system,
      storeUrl: g.storeUrl !== SITE_LIST ? g.storeUrl : o.storeUrl,
      ...(g.publisher || o.publisher ? { publisher: g.publisher || o.publisher } : {}),
    };
  });
}

async function fetchLive(_settings, dir, { capture = captureSite } = {}) {
  const tried = [];
  let games = [];
  try {
    const cap = await capture();
    if (!cap) throw new Error('needs the app window');
    const fromCards = parseCards(cap.cards);
    const fromJson = parseCaptured(cap.responses, [...(cap.pictures || []), ...(cap.cards || []).map((c) => c.img).filter(Boolean)]);
    games = combine(fromCards, fromJson);
    tried.push(`antstream.com: pressed Load More ${cap.presses || 0} times, ${fromCards.length} game cards, ${fromJson.length} games in the page's JSON (${cap.responses.length} responses)`);
    // Kept after every read (once a day), so the reader can be checked
    // against what the page really sends: the largest responses in full.
    const bySize = [...cap.responses].sort((a, b) => b.body.length - a.body.length);
    let room = 8e6;
    save(dir, 'antstream-capture.json', bySize.map((r) => {
      const full = r.body.length <= room;
      if (full) room -= r.body.length;
      return { url: r.url, size: r.body.length, body: full ? r.body : r.body.slice(0, 4000) };
    }));
    save(dir, 'antstream-cards.json', (cap.cards || []).slice(0, 60));
    save(dir, 'antstream-requests.txt', (cap.requests || []).join('\n'));
    save(dir, 'antstream-page.txt', cap.text);
    save(dir, 'antstream-page.html', String(cap.html || '').slice(0, 4e6));
  } catch (err) {
    tried.push(`antstream.com: ${err.message}`);
  }
  save(dir, 'antstream-log.txt', `${new Date().toISOString()}\n${tried.join('\n')}\n`);
  if (games.length < MIN_GAMES) throw new Error(`Antstream's game list couldn't be read (${tried.join('; ')})`);
  return games;
}

module.exports = { fetchLive, parseCards, parseCard, parseCaptured, combine, SITE_LIST, captureSite };
