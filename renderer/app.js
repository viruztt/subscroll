/* global api */
const $ = (sel) => document.querySelector(sel);
const PAGE_SIZE = 120;
// Same as PLAYED_MINUTES in src/steam.js.
const STEAM_PLAYED_MINUTES = 30;
const SOURCE_LABEL = { live: 'official source', mirror: 'community mirror', bundled: 'bundled list' };
const SHORT_SOURCE = { live: 'official', mirror: 'mirror', bundled: 'bundled' };

const ui = {
  view: 'browse',
  search: '',
  services: new Set(), // empty = all
  status: 'all',
  platform: 'all',
  genre: 'all',
  length: 'all',
  sort: 'title',
  mineOnly: false,
  shown: PAGE_SIZE,
};

let services = [];
let tierBadges = {};
let regions = [];
let state = null;
let catalogs = [];
let games = []; // flattened catalogue + custom games
let departed = [];
let drawerGame = null;
let ratings = {}; // game id -> { mc, mcUrl, hltb: { main, plus, all }, hltbUrl }
let prices = {}; // game id -> { amount, currency, source, url } looked up for the Value page
let priceProgress = null;
let lastPriceAsk = 0;
let free = { at: null, games: [], errors: {} }; // free-to-keep giveaways
let drawerRoll = null; // set while the drawer shows a rolled game
let rollTimer = null;
const detailsCache = new Map(); // game id -> details, or a pending promise

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const allServices = () => [...services, ...(state.customServices || [])];
const serviceById = (id) => allServices().find((s) => s.id === id);
const fmtDate = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const todayIso = () => new Date().toISOString().slice(0, 10);
const daysUntil = (iso) => Math.round((new Date(`${iso}T00:00:00`) - new Date(`${todayIso()}T00:00:00`)) / 86400000);

function unlocked() {
  const keys = new Set();
  for (const s of allServices()) {
    const tier = s.tiers.find((t) => t.id === state.subscriptions[s.id]);
    // "service:tier" entries are another service's tier (Ultimate includes EA Play).
    if (tier) tier.includes.forEach((inc) => keys.add(inc.includes(':') ? inc : `${s.id}:${inc}`));
  }
  return keys;
}

// A game can be in several services; each is one of its offers.
const offersOf = (g) => g.offers || [g];
const offerIsMine = (o, keys) => o.tiers.some((t) => keys.has(`${o.service}:${t}`));
const isMine = (g, keys) => offersOf(g).some((o) => offerIsMine(o, keys));
const inServices = (g, set) => offersOf(g).some((o) => set.has(o.service));
// One per service: a service can list two editions of the same game.
function serviceOffers(g) {
  const by = new Map();
  for (const o of offersOf(g)) {
    const prev = by.get(o.service);
    by.set(o.service, prev ? { ...prev, tiers: [...new Set([...prev.tiers, ...o.tiers])], leavingSoon: prev.leavingSoon || o.leavingSoon } : o);
  }
  return [...by.values()];
}

// Plans of the service that include this game, cheapest first.
function plansFor(g) {
  const s = serviceById(g.service);
  if (!s) return [];
  return s.tiers.filter((t) => t.includes.some((inc) => g.tiers.includes(inc)));
}

function tierLabel(g) {
  const s = serviceById(g.service);
  // PS Plus and NSO lists describe what kind of entry it is (Classic, etc.).
  const badge = g.tiers.map((t) => tierBadges[`${g.service}:${t}`]).find(Boolean);
  if (badge && g.service !== 'nso') return badge;
  const plans = plansFor(g);
  if (!s || plans.length === 0) return '';
  if (plans.length === s.tiers.length) return 'All plans';
  return plans.length === 1 ? plans[0].name : `${plans[0].name} and up`;
}

// Announced for a future date, not playable yet.
const isComing = (g) => !!g.comingOn && g.comingOn > todayIso();

function leaveInfo(g) {
  const date = state.leaveDates[g.id];
  if (date) return { date, soon: daysUntil(date) <= 31, past: daysUntil(date) < 0 };
  if (g.leavingSoon) {
    // For a game in several services, say which one it's leaving.
    const from = serviceOffers(g).length > 1 ? serviceOffers(g).filter((o) => o.leavingSoon).map((o) => serviceById(o.service)?.short || o.service) : [];
    return { date: null, soon: true, from };
  }
  return null;
}

// Marks belong to the game, whichever service's entry was marked (marks
// made before games were merged sit on any of its ids).
let markGroups = new Map(); // game id -> every id of the same game
const markIds = (id) => markGroups.get(id) || [id];

function markOf(id) {
  for (const x of markIds(id)) if (state.marks[x]) return state.marks[x];
  return 'none';
}

async function setMark(id, value) {
  const marks = { ...state.marks };
  for (const x of markIds(id)) delete marks[x];
  if (value) marks[id] = value;
  await saveState({ marks });
}

// ---------- sale alerts ----------
// To play games outside your plans: where to buy them is worth watching.
function saleWatchList() {
  const keys = unlocked();
  const ids = new Set(games.flatMap((g) => offersOf(g).map((o) => o.id)));
  const list = games.filter((g) => markOf(g.id) === 'wishlist' && !isComing(g) && !isMine(g, keys));
  const gone = departed.filter((d) => state.marks[d.id] === 'wishlist' && !ids.has(d.id));
  return [...list, ...gone].map((g) => ({ id: g.id, title: g.title, offers: offersOf(g).map((o) => ({ id: o.id, service: o.service, storeUrl: o.storeUrl || null })) }));
}
let saleWatchSent = '';
function syncSaleWatch() {
  if (!games.length) return;
  const list = saleWatchList();
  const sig = JSON.stringify(list.map((g) => g.id));
  if (sig === saleWatchSent) return;
  saleWatchSent = sig;
  api.watchSales(list).catch(() => {});
}
// A sale on a To play game outside your plans, in your currency.
function saleOf(g) {
  if (markOf(g.id) !== 'wishlist') return null;
  const p = prices[g.id];
  if (!p || !(p.sale > 0) || !(p.amount > p.sale) || p.currency !== regionCurrency()) return null;
  if (isMine(g, unlocked())) return null;
  return { ...p, off: Math.round((1 - p.sale / p.amount) * 100) };
}

// Your own star rating (1-5) and notes, shared by every entry of the game.
function noteOf(id) {
  const notes = state.notes || {};
  for (const x of markIds(id)) if (notes[x]) return notes[x];
  return null;
}
const starsOf = (id) => noteOf(id)?.stars || null;

async function setNote(id, patch) {
  const notes = { ...(state.notes || {}) };
  const prev = noteOf(id) || {};
  for (const x of markIds(id)) delete notes[x];
  const next = { ...prev, ...patch, at: new Date().toISOString() };
  if (!next.stars) delete next.stars;
  if (!next.text || !next.text.trim()) delete next.text;
  if (next.stars || next.text) notes[id] = next;
  await saveState({ notes });
}

async function saveState(patch) {
  state = await api.updateState(patch);
}

// ---------- data ----------
// Switch Online lists some games (or regional versions) only in Japan or
// only outside it. Lists saved before regions were tracked are western.
function inMyRegion(g) {
  if (g.service !== 'nso') return true;
  const mine = regions.find((r) => r.id === state.settings.region)?.nintendo || 'west';
  return (g.regions || ['west']).includes(mine);
}

// The Steam copy of a game, when the imported library has one. Switch
// Online games are old console versions, so they never match.
function steamOf(g) {
  const owned = state.steam?.owned;
  if (!owned || g.service === 'nso' || g.custom) return null;
  return owned[Unify.matchKey(g.title)] || null;
}

// A game released in the last 30 days that's already in a service joined it
// on release day or later; the release date stands in when the service gives
// no join date (Gears of War: E-Day, released 6 October, day one on Game Pass).
function recentRelease(g) {
  if (!g.releaseDate || isComing(g)) return null;
  const days = daysUntil(g.releaseDate);
  return days <= 0 && days >= -30 ? g.releaseDate : null;
}

function rebuildGames() {
  departed = [];
  const out = [];
  for (const c of catalogs) {
    for (const g of c.games) {
      if (inMyRegion(g)) out.push({ ...g, firstSeen: c.history?.firstSeen?.[g.id] || g.addedOn || recentRelease(g) });
    }
    for (const d of c.history?.departed || []) departed.push(d);
  }
  for (const g of state.customGames || []) out.push({ ...g, custom: true });
  games = Unify.unify(out).map((g) => ({ ...g, genreTags: Genres.genresOf(g), steam: steamOf(g) }));
  markGroups = new Map();
  for (const g of games) {
    const ids = offersOf(g).map((o) => o.id);
    if (ids.length > 1) ids.forEach((id) => markGroups.set(id, ids));
  }
}

function platformsList() {
  const set = new Set();
  games.forEach((g) => g.platforms.forEach((p) => set.add(p)));
  return [...set].sort((a, b) => a.localeCompare(b));
}

const PLATFORM_LABEL = { console: 'Xbox console', pc: 'PC', cloud: 'Cloud streaming' };

// Plans that let you stream a game: "gamepass:premium", "psplus:premium".
const CLOUD_TIER_ORDER = ['essential', 'premium', 'ultimate'];
function cloudKeys(g) {
  const out = new Set();
  for (const o of offersOf(g)) {
    if (o.service === 'psplus' && o.stream) out.add('psplus:premium');
    if (o.cloud) for (const t of o.cloud.tiers) out.add(`gamepass:${t}`);
  }
  return out;
}
const canStream = (g, keys) => [...cloudKeys(g)].some((k) => keys.has(k));

// The platform filter; "Cloud streaming" means streamable (with your plans, when only those are shown).
function platformOk(g, keys) {
  if (ui.platform === 'all') return true;
  if (ui.platform === 'cloud') return cloudKeys(g).size > 0 && (!ui.mineOnly || !keys.size || canStream(g, keys));
  return g.platforms.includes(ui.platform);
}

function cloudRow(g) {
  if (cloudKeys(g).size) {
    const yours = canStream(g, unlocked());
    return [el('dt', {}, 'Cloud'), el('dd', {}, `Stream with ${cloudPlans(g)}${yours ? ', which you have' : ''}`)];
  }
  if (offersOf(g).some((o) => o.cloud?.own)) return [el('dt', {}, 'Cloud'), el('dd', {}, 'Streams with Xbox Cloud Gaming if you own it')];
  return null;
}

// "Game Pass Premium and up, PS Plus Premium"
function cloudPlans(g) {
  const ck = cloudKeys(g);
  const out = [];
  const gp = CLOUD_TIER_ORDER.find((t) => ck.has(`gamepass:${t}`));
  if (gp) out.push(`${planName('gamepass', gp)}${gp === 'ultimate' ? '' : ' and up'}`);
  if (ck.has('psplus:premium')) out.push(planName('psplus', 'premium'));
  return out.join(', ');
}
const platformName = (p) => PLATFORM_LABEL[p] || p;

const hideDeparted = () => !!state.settings.hideDeparted;
// "My games" is where completed games are collected, so they stay there.
const hideCompleted = () => !!state.settings.hideCompleted && ui.view !== 'mine';
// Picking "Ignored" in the status filter shows them anyway, to un-ignore.
const hideIgnored = () => state.settings.hideIgnored !== false && ui.view !== 'mine' && ui.status !== 'ignored';

function filtered(list, { keepDeparted = false } = {}) {
  const keys = unlocked();
  const q = ui.search.trim().toLowerCase();
  return list.filter((g) => {
    if (ui.services.size && !inServices(g, ui.services)) return false;
    // The To play list shows games outside your plans too, to see where they are.
    if (ui.mineOnly && ui.view !== 'toplay' && !isMine(g, keys)) return false;
    if (!keepDeparted && hideDeparted() && (g.leftOn || g.departed || leaveInfo(g)?.past)) return false;
    if (hideCompleted() && markOf(g.id) === 'completed') return false;
    if (hideIgnored() && markOf(g.id) === 'ignored') return false;
    if (ui.status === 'steam' ? !g.steam : ui.status !== 'all' && markOf(g.id) !== ui.status) return false;
    if (!platformOk(g, keys)) return false;
    if (!fitsGenreAndLength(g)) return false;
    // Search finds your notes too.
    if (q && !g.title.toLowerCase().includes(q) && !(noteOf(g.id)?.text || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

// 0 means Metacritic hasn't scored it (older results were saved that way).
const mcScore = (g) => (ratings[g.id]?.mc > 0 ? ratings[g.id].mc : null);
// Main story time, or the closest thing HLTB has for games without a story.
function beatHours(g) {
  const h = ratings[g.id]?.hltb;
  return h ? h.main ?? h.plus ?? h.all ?? null : null;
}

// Departed games keep their original fields, so work out genres here too.
function fitsGenreAndLength(g) {
  if (ui.genre !== 'all' && !(g.genreTags || Genres.genresOf(g)).includes(ui.genre)) return false;
  return Genres.fitsLength(beatHours(g), ui.length);
}

function fmtHours(h) {
  if (h == null) return '';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  return h < 10 ? `${Math.round(h * 2) / 2}h` : `${Math.round(h)}h`;
}

function sorted(list) {
  const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  // Games without a score or time go last, whichever way the list runs.
  const byValue = (fn, dir) => (a, b) => {
    const x = fn(a);
    const y = fn(b);
    if (x == null || y == null) return (x == null) - (y == null) || byTitle(a, b);
    return (x - y) * dir || byTitle(a, b);
  };
  const copy = [...list];
  if (ui.sort === 'score') return copy.sort(byValue(mcScore, -1));
  if (ui.sort === 'short') return copy.sort(byValue(beatHours, 1));
  if (ui.sort === 'long') return copy.sort(byValue(beatHours, -1));
  if (ui.sort === 'stars') return copy.sort(byValue((g) => starsOf(g.id), -1));
  if (ui.sort === 'release') copy.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '') || byTitle(a, b));
  else if (ui.sort === 'added') copy.sort((a, b) => (b.firstSeen || '').localeCompare(a.firstSeen || '') || byTitle(a, b));
  else copy.sort(byTitle);
  return copy;
}

// ---------- rendering ----------
function serviceTag(g) {
  const s = serviceById(g.service);
  return el('span', { class: 'tag', style: `--svc:${s ? s.color : '#666'}` }, s ? s.short || s.name : g.service);
}

// One service: its tag and plan. Several: a tag each, plan on hover, and
// the services in your plans highlighted.
function serviceMeta(g, keys) {
  const offers = serviceOffers(g);
  if (offers.length === 1) return el('div', { class: 'meta' }, serviceTag(g), el('span', { class: 'tier' }, tierLabel(g)));
  return el('div', { class: 'meta' }, offers.map((o) => {
    const tag = serviceTag(o);
    const s = serviceById(o.service);
    tag.title = [s?.name, tierLabel(o)].filter(Boolean).join(': ');
    if (keys && !offerIsMine(o, keys)) tag.classList.add('dim');
    return tag;
  }));
}

function placeholder(g) {
  const s = serviceById(g.service);
  return el('div', { class: 'cover placeholder', style: `--svc:${s ? s.color : '#444'}` },
    el('span', {}, g.service === 'nso' ? g.platforms[0] : g.title));
}

function cover(g) {
  if (!g.image) return placeholder(g);
  const msStore = ['gamepass', 'eaplay', 'ubisoftplus'].includes(g.service);
  const src = msStore ? `${g.image}?w=300&h=450&q=80` : g.image;
  // Retro box art comes in every shape, and phone games have square icons,
  // so show those whole instead of cropping.
  const whole = ['nso', 'netflix', 'applearcade', 'crunchyroll'].includes(g.service);
  const img = el('img', { class: `cover ${whole ? 'contain' : ''}`, src, loading: 'lazy', alt: '' });
  // Offline or a dead link: show the same artwork-free tile Nintendo games use.
  img.addEventListener('error', function failed() {
    // Steam art: the portrait cover first, then the store header.
    if (g.imageFallback && img.src !== g.imageFallback) {
      img.src = g.imageFallback;
      return;
    }
    img.removeEventListener('error', failed);
    img.replaceWith(placeholder(g));
  });
  return img;
}

function scoreClass(score) {
  if (score >= 75) return 'good';
  return score >= 50 ? 'mixed' : 'bad';
}

function stats(g) {
  const score = mcScore(g);
  const h = beatHours(g);
  return [
    score != null ? el('span', { class: `score ${scoreClass(score)}`, title: 'Metacritic score' }, score) : null,
    h != null ? el('span', { class: 'hltb', title: 'How Long To Beat: main story' }, `⏱ ${fmtHours(h)}`) : null,
  ];
}

function markButtons(g, wide = false) {
  const mark = markOf(g.id);
  const set = (value) => async (e) => {
    e.stopPropagation();
    await setMark(g.id, mark === value ? null : value);
    render(true);
  };
  return el('div', { class: 'marks' },
    el('button', { class: `mark ${mark === 'played' ? 'on' : ''}`, title: 'Mark as played', onclick: set('played') }, '▶ Played'),
    el('button', { class: `mark ${mark === 'completed' ? 'on done' : ''}`, title: 'Mark as completed', onclick: set('completed') }, '★ Completed'),
    wide ? toPlayButton(g, 'mark toplay') : null,
    wide ? ignoreButton(g, 'mark ignore') : null);
}

// Games you want to play, available now or coming. Playing one replaces it.
function toPlayButton(g, cls) {
  const on = markOf(g.id) === 'wishlist';
  return el('button', {
    class: `${cls} ${on ? 'on' : ''}`,
    title: on ? 'On your To play list: click to remove' : 'Add to your To play list',
    onclick: async (e) => {
      e.stopPropagation();
      await setMark(g.id, on ? null : 'wishlist');
      render(true);
    },
  }, cls.startsWith('mark') ? (on ? '✓ To play' : '＋ To play') : (on ? '✓' : '＋'));
}

// Cards keep it on the cover (shown on hover) to leave room for the others.
function ignoreButton(g, cls) {
  const ignored = markOf(g.id) === 'ignored';
  return el('button', {
    class: `${cls} ${ignored ? 'on ignored' : ''}`,
    title: ignored ? 'Ignored: click to stop ignoring' : 'Ignore: not interested, hide it',
    onclick: async (e) => {
      e.stopPropagation();
      await setMark(g.id, ignored ? null : 'ignored');
      render(true);
    },
  }, cls.startsWith('mark') ? (ignored ? '⊘ Ignored' : '⊘ Ignore') : '⊘');
}

function steamText(s) {
  return s.minutes ? `You own this on Steam, ${fmtHours(s.minutes / 60)} played` : 'You own this on Steam, not played yet';
}

function card(g, keys) {
  const leave = leaveInfo(g);
  const mine = isMine(g, keys);
  const badges = [];
  if (leave) {
    const text = leave.date ? (leave.past ? `Left ${fmtDate(leave.date)}` : `Leaves ${fmtDate(leave.date)}`)
      : leave.from?.length ? `Leaving ${leave.from.join(', ')} soon` : 'Leaving soon';
    badges.push(el('span', { class: `badge ${leave.soon ? 'warn' : ''}` }, text));
  }
  if (isComing(g)) badges.push(el('span', { class: 'badge coming' }, `Coming ${fmtDate(g.comingOn)}`));
  else if (g.firstSeen && daysUntil(g.firstSeen) >= -30) badges.push(el('span', { class: 'badge new' }, 'New'));
  if (g.leftOn || g.departed) badges.push(el('span', { class: 'badge gone' }, g.leftOn ? `Left ${fmtDate(g.leftOn)}` : 'Left the service'));
  // Regional versions sharing this card.
  if (g.versions?.length > 1) badges.push(el('span', { class: 'badge region', title: 'Regional versions included' }, g.versions.join(' + ')));
  if (markOf(g.id) === 'wishlist') badges.push(el('span', { class: 'badge toplay' }, 'To play'));
  if (g.steam) badges.push(el('span', { class: 'badge steam', title: steamText(g.steam) }, 'On Steam'));
  const sale = saleOf(g);
  if (sale) badges.push(el('span', { class: 'badge sale', title: `On sale on ${sale.source || 'its store'}: usually ${money(sale.amount)}${sale.saleEnds ? `, until ${fmtDate(sale.saleEnds.slice(0, 10))}` : ''}` }, `${sale.off}% off · ${money(sale.sale)}`));
  const note = noteOf(g.id);
  if (note) badges.push(el('span', { class: 'badge stars', title: note.text ? `Your note: ${note.text}` : 'Your rating' }, note.stars ? '★'.repeat(note.stars) : '', note.text ? (note.stars ? ' ✎' : '✎ Note') : ''));
  if (cloudKeys(g).size) {
    const yours = canStream(g, keys);
    badges.push(el('span', { class: `badge cloud ${yours ? 'yours' : ''}`, title: `Stream it with ${cloudPlans(g)}${yours ? ' (in your plans)' : ''}` }, '☁ Cloud'));
  }
  const open = () => { drawerRoll = null; openDrawer(g); };
  return el('article', { class: `card ${mine ? 'mine' : ''} mark-${markOf(g.id)}`, 'data-id': g.id, onclick: open },
    el('div', { class: 'cover-wrap' }, cover(g), el('div', { class: 'badges' }, badges), toPlayButton(g, 'cover-btn cover-toplay'), ignoreButton(g, 'cover-btn cover-ignore')),
    el('div', { class: 'body' },
      el('div', { class: 'title', title: g.title }, g.title),
      serviceMeta(g, keys),
      el('div', { class: 'stats' }, stats(g)),
      markButtons(g)));
}

function renderGrid(list, emptyText) {
  const content = $('#content');
  content.replaceChildren();
  if (list.length === 0) {
    content.append(el('div', { class: 'empty' }, emptyText));
    return;
  }
  const keys = unlocked();
  const grid = el('div', { class: 'grid' }, list.slice(0, ui.shown).map((g) => card(g, keys)));
  content.append(grid);
  if (list.length > ui.shown) {
    const more = el('div', { class: 'more' }, `Showing ${ui.shown} of ${list.length}`);
    content.append(more);
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        ui.shown += PAGE_SIZE;
        render(true);
      }
    }, { rootMargin: '600px' });
    io.observe(more);
  }
}

function summaryText(list) {
  const keys = unlocked();
  const mine = list.filter((g) => isMine(g, keys)).length;
  const subs = Object.keys(state.subscriptions).filter((k) => state.subscriptions[k]).length;
  const base = subs ? `${list.length} games · ${mine} included in your subscriptions` : `${list.length} games · set your subscriptions to see what you can play`;
  return ui.length !== 'all' ? `${base} · only games with a How Long To Beat time` : base;
}

function renderBrowse() {
  const list = sorted(filtered(games));
  $('#summary').textContent = summaryText(list);
  renderGrid(list, 'No games match these filters.');
}

// ---------- recommendations ----------
const tastes = () => ({ genres: [], length: 'any', ...(state.settings.tastes || {}) });

function recommendations(limit = 12, perService = 5) {
  const keys = unlocked();
  return Recommend.recommend(games, {
    isMine: (g) => isMine(g, keys),
    markOf: (g) => markOf(g.id),
    isComing,
    score: mcScore,
    hours: beatHours,
    genres: (g) => g.genreTags || [],
  }, { tastes: tastes(), today: todayIso(), limit, perService });
}

async function setTastes(patch) {
  await saveState({ settings: { ...state.settings, tastes: { ...tastes(), ...patch } } });
  render(true);
}

// Genre chips and a length choice, shared by onboarding and For you.
function tastePicker() {
  const t = tastes();
  const present = new Set(games.flatMap((g) => g.genreTags || []));
  const genres = Genres.GENRES.filter((n) => present.has(n) || t.genres.includes(n));
  const toggle = (n) => setTastes({ genres: t.genres.includes(n) ? t.genres.filter((x) => x !== n) : [...t.genres, n] });
  const lengths = [['any', 'Any length'], ['short', 'Short (under 10 hours)'], ['long', 'Long (25 hours or more)']];
  return el('div', { class: 'tastes' },
    el('div', { class: 'chips' }, genres.map((n) => el('button', { class: `chip taste ${t.genres.includes(n) ? 'on' : ''}`, onclick: () => toggle(n) }, n))),
    el('div', { class: 'seg', style: '--svc:#6aa8ff' }, lengths.map(([id, label]) => el('button', { class: t.length === id ? 'on' : '', onclick: () => setTastes({ length: id }) }, label))));
}

// Cards with a line saying why each was picked.
function recommendationGrid(picks) {
  const keys = unlocked();
  return el('div', { class: 'grid' }, picks.map(({ game, reasons }) => {
    const c = card(game, keys);
    // Leaving soon and new already show as badges on the cover.
    const why = el('div', { class: 'reasons' }, reasons.filter((r) => !['leaving', 'new'].includes(r.id)).slice(0, 3).map((r) => el('span', { class: `reason ${r.id}` }, r.label)));
    c.querySelector('.body').insertBefore(why, c.querySelector('.marks'));
    return c;
  }));
}

// Groups of games like the ones you've completed, best first.
function likeCompleted() {
  const keys = unlocked();
  return Recommend.similar(games, {
    isMine: (g) => isMine(g, keys),
    markOf: (g) => markOf(g.id),
    isComing,
    score: mcScore,
    genres: (g) => g.genreTags || [],
  }, { seeds: statsGames(), groups: 4, perGroup: 6 });
}

function renderForYou() {
  const content = $('#content');
  content.replaceChildren();
  $('#summary').textContent = 'Picked from your plans: games in genres you like, well-reviewed, leaving soon or just added, then games like the ones you beat. Scores and play times make these better as they load.';
  if (!Object.values(state.subscriptions).some(Boolean)) {
    content.append(el('div', { class: 'panel' }, el('h2', {}, 'What you like'), tastePicker()));
    content.append(el('div', { class: 'empty' }, 'Pick your plans in Settings and recommendations show up here.'));
    return;
  }
  // Games in a "Because you beat" row aren't repeated in the picks above it.
  const groups = likeCompleted();
  const shown = new Set(groups.flatMap((x) => x.picks.map((p) => p.game.id)));
  content.append(el('div', { class: 'section-head' }, el('h3', {}, 'Picked for you'), el('span', { class: 'muted' }, 'From the genres and length you like')));
  content.append(el('div', { class: 'panel' }, tastePicker()));
  const picks = recommendations(24 + shown.size, 10).filter((p) => !shown.has(p.game.id)).slice(0, 24);
  content.append(picks.length ? recommendationGrid(picks) : el('div', { class: 'empty' }, 'Nothing matches these choices yet. Try another genre or length.'));
  for (const { seed, picks: like } of groups) {
    content.append(el('div', { class: 'section-head' },
      el('h3', {}, 'Because you beat ', el('button', { class: 'link inline seed', onclick: () => openDrawer(seed) }, seed.title)),
      el('span', { class: 'muted' }, 'Same studio or similar genres')));
    content.append(recommendationGrid(like));
  }
  if (!groups.length) {
    const beaten = statsGames().some((g) => markOf(g.id) === 'completed');
    content.append(el('div', { class: 'section-head' }, el('h3', {}, 'Because you beat…')));
    content.append(el('div', { class: 'hint-row muted' }, beaten
      ? 'Nothing in your plans is much like the games you\'ve completed yet. Developers and genres fill in over the first few minutes as they\'re looked up.'
      : 'Mark games as ★ Completed and games like them show up here, by the same studio or with similar genres.'));
  }
}

// ---------- onboarding ----------
// First launch: country, services, tastes, then a first set of picks.
let onboarding = null; // { step }
const ONBOARD_STEPS = 4;

function guessRegion() {
  const tag = String(navigator.languages?.[0] || navigator.language || '').split('-')[1]?.toUpperCase();
  const id = tag === 'UK' ? 'GB' : tag;
  return regions.some((r) => r.id === id) ? id : 'US';
}

function startOnboarding() {
  onboarding = { step: 0 };
  if (!$('#onboarding')) document.body.append(el('div', { id: 'onboarding', class: 'onboard' }));
  renderOnboarding();
}

async function finishOnboarding() {
  onboarding = null;
  $('#onboarding')?.remove();
  await saveState({ settings: { ...state.settings, onboarded: true } });
  const hasSubs = Object.values(state.subscriptions).some(Boolean);
  ui.mineOnly = hasSubs;
  $('#mine-only').checked = hasSubs;
  ui.view = hasSubs ? 'foryou' : 'subs';
  render();
}

async function onboardNext() {
  if (onboarding.step === 0) {
    // The lists are fetched for the country picked here.
    refresh();
  }
  onboarding.step += 1;
  renderOnboarding();
}

function renderOnboarding() {
  const box = $('#onboarding');
  if (!onboarding || !box) return;
  const { step } = onboarding;
  const back = step > 0 ? el('button', { class: 'link', onclick: () => { onboarding.step -= 1; renderOnboarding(); } }, 'Back') : el('span');
  const dots = el('div', { class: 'onboard-dots' }, Array.from({ length: ONBOARD_STEPS }, (_, i) => el('span', { class: i === step ? 'on' : '' })));
  let body;
  let next = el('button', { class: 'primary', onclick: onboardNext }, 'Next');

  if (step === 0) {
    const select = el('select', {}, regions.map((r) => el('option', { value: r.id }, r.name)));
    select.value = state.settings.onboardRegionPicked ? state.settings.region : guessRegion();
    const pick = () => saveState({ settings: { ...state.settings, region: select.value, onboardRegionPicked: true } });
    select.addEventListener('change', pick);
    next = el('button', { class: 'primary', onclick: async () => { await pick(); rebuildGames(); onboardNext(); } }, 'Get started');
    body = [
      el('img', { class: 'onboard-logo', src: 'logo.svg', alt: '' }),
      el('h1', {}, 'Welcome to Subscroll'),
      el('p', { class: 'lead' }, 'Every game you already pay for, in one place. Tell it which subscriptions you have and it shows what\'s in them, what\'s leaving, and what to play next.'),
      el('label', { class: 'onboard-field' }, el('span', {}, 'Where do you play?'), select),
      el('p', { class: 'muted' }, 'Game Pass and PS Plus catalogues differ a little by country.'),
    ];
  } else if (step === 1) {
    const rows = allServices().filter((s) => !s.custom).map((s) => {
      const current = state.subscriptions[s.id] || '';
      const pick = async (tierId) => {
        await saveState({ subscriptions: { ...state.subscriptions, [s.id]: tierId || undefined } });
        renderOnboarding();
      };
      return el('div', { class: 'sub-row', style: `--svc:${s.color}` },
        el('div', { class: 'sub-name' }, el('strong', {}, s.name)),
        el('div', { class: 'seg' },
          el('button', { class: current ? '' : 'on', onclick: () => pick('') }, 'No'),
          s.tiers.map((t) => el('button', { class: current === t.id ? 'on' : '', onclick: () => pick(t.id) }, t.name))));
    });
    const any = Object.values(state.subscriptions).some(Boolean);
    next = el('button', { class: 'primary', disabled: !any, onclick: onboardNext }, 'Next');
    body = [
      el('h1', {}, 'Which services do you have?'),
      el('p', { class: 'lead' }, 'Pick your plan for each. Game Pass Ultimate already includes EA Play and Ubisoft+ Classics.'),
      el('div', { class: 'onboard-services' }, rows),
    ];
  } else if (step === 2) {
    body = [
      el('h1', {}, 'What do you like to play?'),
      el('p', { class: 'lead' }, 'Pick a few genres and how long you like games to be. You can change this any time on the For you page.'),
      tastePicker(),
    ];
  } else {
    const picks = recommendations(8);
    next = el('button', { class: 'primary', onclick: finishOnboarding }, 'Start browsing');
    body = [
      el('h1', {}, 'Picked for you'),
      el('p', { class: 'lead' }, 'From the plans you have. Click ＋ on a cover to save a game to your To play list. More picks, which get better as scores and play times load, are on the For you page.'),
      picks.length ? recommendationGrid(picks) : el('p', { class: 'muted' }, 'Loading your services\' games…'),
    ];
  }
  box.replaceChildren(el('div', { class: 'onboard-card' },
    el('div', { class: 'onboard-body' }, body),
    el('div', { class: 'onboard-foot' }, back, dots, el('div', { class: 'onboard-actions' },
      step > 0 && step < 3 ? el('button', { class: 'link', onclick: finishOnboarding }, 'Skip') : null, next))));
}

function renderLeaving() {
  const list = filtered(games.filter((g) => leaveInfo(g)));
  list.sort((a, b) => (leaveInfo(a).date || '9999').localeCompare(leaveInfo(b).date || '9999') || a.title.localeCompare(b.title));
  $('#summary').textContent = `${list.length} games leaving. Xbox flags these itself but gives no exact date.`;
  renderGrid(list, 'Nothing is flagged as leaving right now.');
}

function renderChanges() {
  // Lists with dates back to launch (Switch Online, Apple Arcade) would make
  // this every game, so only the last 30 days, newest first.
  const added = filtered(games.filter((g) => g.firstSeen && !isComing(g) && daysUntil(g.firstSeen) >= -30 && daysUntil(g.firstSeen) <= 0))
    .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.title.localeCompare(b.title));
  const gone = filtered(departed);
  const content = $('#content');
  $('#summary').textContent = hideDeparted()
    ? 'Games found by comparing each refresh with the last one. Departed games are hidden.'
    : 'Changes found by comparing each refresh with the last one.';
  content.replaceChildren();
  const keys = unlocked();
  const section = (title, list, empty) => el('div', {},
    el('h2', {}, title),
    list.length ? el('div', { class: 'grid' }, list.slice(0, 240).map((g) => card(g, keys))) : el('div', { class: 'empty small' }, empty));
  content.append(section(`Added in the last 30 days (${added.length})`, added, 'Nothing added in the last 30 days. New games show up here after a refresh finds them.'));
  if (!hideDeparted()) content.append(section(`Left the service (${gone.length})`, gone, 'No departures recorded yet.'));
}

function renderComing() {
  const list = filtered(games.filter(isComing));
  list.sort((a, b) => a.comingOn.localeCompare(b.comingOn) || a.title.localeCompare(b.title));
  $('#summary').textContent = `${list.length} announced games. Game Pass and Switch Online publish dates ahead; Apple Arcade dates come from Wikipedia. PS Plus, EA Play, Ubisoft+ and Netflix don't announce in a form the app can read.`;
  renderGrid(list, 'Nothing announced right now.');
}

function renderMine() {
  const list = sorted(filtered(games.filter((g) => markOf(g.id) !== 'none')));
  const done = list.filter((g) => markOf(g.id) === 'completed').length;
  const ignored = list.filter((g) => markOf(g.id) === 'ignored').length;
  $('#summary').textContent = `${list.length} games marked · ${done} completed · ${ignored} ignored`;
  renderGrid(list, 'Mark games as played, completed or ignored and they will be collected here.');
}

// Your To play list, grouped by when and where you can play each game.
function renderToPlay() {
  const content = $('#content');
  content.replaceChildren();
  const keys = unlocked();
  const ids = new Set(games.flatMap((g) => offersOf(g).map((o) => o.id)));
  const gone = new Map();
  for (const d of departed) if (state.marks[d.id] === 'wishlist' && !ids.has(d.id)) gone.set(d.id, d);
  const list = sorted(filtered(games.filter((g) => markOf(g.id) === 'wishlist')));
  const groups = [
    ['Ready to play', 'In your plans now.', list.filter((g) => !isComing(g) && isMine(g, keys))],
    ['Coming soon', 'Announced, with the date it arrives.', list.filter(isComing).sort((a, b) => a.comingOn.localeCompare(b.comingOn))],
    ['In other services', "Available, but not in the plans you have. Checked for sales twice a day.", list.filter((g) => !isComing(g) && !isMine(g, keys))],
    ['No longer available', 'Left every service that had it. Checked for sales twice a day.', [...gone.values()]],
  ];
  const total = list.length + gone.size;
  $('#summary').textContent = total ? `${total} game${total === 1 ? '' : 's'} to play · ${groups[0][2].length} ready now` : '';
  if (!total) {
    content.append(el('div', { class: 'empty' }, 'Click ＋ on a game\'s cover (or "To play" in its details) to keep it here, whether it\'s out now or coming soon.'));
    return;
  }
  const advice = advisorPanel();
  if (advice) content.append(advice);
  for (const [title, hint, items] of groups) {
    if (!items.length) continue;
    content.append(el('div', { class: 'section-head' }, el('h3', {}, title, el('span', { class: 'muted' }, ` ${items.length}`)), el('span', { class: 'muted' }, hint)),
      el('div', { class: 'grid' }, items.map((g) => card(g, keys))));
  }
}

// "Game Pass Ultimate", "PC Game Pass", "PS Plus Extra", "Netflix Games".
function planName(serviceId, tierId) {
  const s = serviceById(serviceId);
  if (!s) return serviceId;
  const t = s.tiers.find((x) => x.id === tierId);
  if (!t || s.tiers.length === 1) return s.name;
  return t.name.includes(s.short) ? t.name : `${s.short} ${t.name}`;
}

// Which plan to pick up for your To play list, for people who rotate plans.
function advisorPanel() {
  const r = Advisor.advise(games, {
    services: allServices(),
    subscriptions: state.subscriptions,
    markOf: (g) => markOf(g.id),
    comingOn: (g) => (isComing(g) ? g.comingOn : null),
    leaving: (g) => { const l = leaveInfo(g); return !!(l && l.soon && !l.past); },
    today: todayIso(),
  });
  const idle = r.keep.filter((k) => !k.needs);
  const lower = r.keep.filter((k) => k.lower);
  if (!r.options.length && !idle.length && !lower.length) return null;
  const n = (x, word) => `${x} ${word}${x === 1 ? '' : 's'}`;
  const thumb = (g) => {
    const ms = ['gamepass', 'eaplay', 'ubisoftplus'].includes(g.service);
    const img = g.image ? el('img', { src: ms ? `${g.image}?w=80&h=120&q=70` : g.image, loading: 'lazy', alt: '' }) : null;
    const initials = () => el('span', {}, g.title.slice(0, 2));
    if (img) img.addEventListener('error', () => img.replaceWith(initials()));
    return el('button', { class: 'adv-thumb', title: g.title, onclick: () => openDrawer(g) }, img || initials());
  };
  const rows = r.options.slice(0, 4).map((o, i) => {
    const s = serviceById(o.service);
    const facts = [`Covers ${o.games.length} of your ${r.total} To play games`];
    if (o.leaving.length) facts.push(`${o.leaving.length} leaving soon`);
    if (o.arriving.length) facts.push(`${o.arriving.length} arriving this month`);
    if (o.smaller) facts.push(`${planName(o.service, o.smaller.tier)} alone covers ${o.smaller.count}`);
    const shown = [...o.leaving, ...o.games.filter((g) => !o.leaving.includes(g))].slice(0, 6);
    return el('div', { class: `adv-row ${i === 0 ? 'best' : ''}` },
      el('span', { class: 'dot', style: `background:${s?.color || 'var(--accent)'}` }),
      el('div', { class: 'adv-main' },
        el('div', { class: 'adv-title' }, el('strong', {}, planName(o.service, o.tier)),
          i === 0 ? el('span', { class: 'badge toplay' }, 'Best pick') : null,
          o.upgradeFrom ? el('span', { class: 'muted' }, ` upgrade from ${planName(o.service, o.upgradeFrom)}`) : null),
        el('div', { class: 'muted' }, facts.join(' · '))),
      el('div', { class: 'adv-covers' }, shown.map(thumb), o.games.length > shown.length ? el('span', { class: 'muted' }, `+${o.games.length - shown.length}`) : null));
  });
  const notes = [];
  if (r.rotation.length > 1) {
    notes.push(el('p', { class: 'adv-note' }, el('strong', {}, 'Month by month: '),
      r.rotation.map((x) => `${planName(x.service, x.tier)} (${x.count})`).join(' → '),
      el('span', { class: 'muted' }, '. One plan a month, counting games announced for the next few months.')));
  }
  for (const k of idle) notes.push(el('p', { class: 'adv-note' }, `${planName(k.service, k.tier)}: nothing on your To play list needs it right now, so you could pause it.`));
  for (const k of lower) notes.push(el('p', { class: 'adv-note' }, `${planName(k.service, k.tier)}: ${planName(k.service, k.lower)} covers the ${n(k.needs, 'To play game')} you need it for.`));
  const hint = r.options.length
    ? `For the To play games you can't play with the plans you have${r.ready ? ` (${r.ready} you can)` : ''}.`
    : 'Everything on your To play list is in your plans already.';
  return el('div', { class: 'panel advisor' },
    el('div', { class: 'panel-head' }, el('h2', {}, 'Which plan to get'), el('span', { class: 'muted' }, hint)),
    rows, notes);
}

// ---------- calendar ----------
const CAL_KINDS = {
  coming: { label: 'Arriving', cls: 'k-coming' },
  added: { label: 'Added', cls: 'k-added' },
  left: { label: 'Left', cls: 'k-left' },
  'free-start': { label: 'Free from', cls: 'k-free' },
  'free-end': { label: 'Last day free', cls: 'k-free' },
};
const CAL_LEGEND = [['coming', 'Arriving'], ['added', 'Added'], ['left', 'Left'], ['free', 'Free games']];
const calGroup = (kind) => (kind.startsWith('free') ? 'free' : kind);
const isFree = (item) => !!item.store && !item.service;

function renderCalendar() {
  const content = $('#content');
  content.replaceChildren();
  const today = todayIso();
  if (!ui.calMonth) ui.calMonth = today.slice(0, 7);
  ui.calHidden = ui.calHidden || new Set();
  const grid = Calendar.monthGrid(ui.calMonth);
  const days = Calendar.events({
    games: filtered(games),
    departed: filtered(departed, { keepDeparted: true }),
    free: free.games.filter((g) => !freeMark(g) && freeShown(g)),
    comingOn: (g) => (isComing(g) ? g.comingOn : null),
    addedOn: (g) => g.firstSeen || null,
    from: grid[0].iso,
    to: grid[grid.length - 1].iso,
  });
  for (const [day, list] of days) days.set(day, list.filter((e) => !ui.calHidden.has(calGroup(e.kind))));
  const monthName = new Date(`${ui.calMonth}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const inMonth = [...days].filter(([d]) => d.startsWith(ui.calMonth)).flatMap(([, l]) => l);
  const count = (k) => inMonth.filter((e) => calGroup(e.kind) === k).length;
  $('#summary').textContent = `${monthName}: ${count('coming')} arriving · ${count('added')} added · ${count('left')} left${ui.mineOnly ? ' · in your plans' : ''}`;

  const go = (month, day = null) => { ui.calMonth = month; ui.calDay = day; render(true); };
  const head = el('div', { class: 'cal-head' },
    el('button', { class: 'cal-nav', title: 'Previous month', onclick: () => go(Calendar.shiftMonth(ui.calMonth, -1)) }, '‹'),
    el('h2', {}, monthName),
    el('button', { class: 'cal-nav', title: 'Next month', onclick: () => go(Calendar.shiftMonth(ui.calMonth, 1)) }, '›'),
    ui.calMonth !== today.slice(0, 7) ? el('button', { class: 'cal-nav', onclick: () => go(today.slice(0, 7)) }, 'Today') : null,
    el('div', { class: 'cal-legend' }, CAL_LEGEND.map(([k, label]) => el('button', {
      class: `cal-key k-${k} ${ui.calHidden.has(k) ? 'off' : ''}`,
      title: ui.calHidden.has(k) ? 'Show these' : 'Hide these',
      onclick: () => { if (ui.calHidden.has(k)) ui.calHidden.delete(k); else ui.calHidden.add(k); render(true); },
    }, el('span', { class: 'swatch' }), label))));

  // Xbox flags games as leaving without a date, so they can't go on a day.
  const undated = filtered(games).filter((g) => { const l = leaveInfo(g); return l && l.soon && !l.date && !l.past; }).length;
  const note = undated ? el('p', { class: 'muted cal-note' }, `${undated} game${undated === 1 ? ' is' : 's are'} leaving soon without a date, so they aren't on the calendar. `,
    el('button', { class: 'link inline', onclick: () => { ui.view = 'leaving'; render(); } }, 'See Leaving soon')) : null;

  const MAX = 3;
  const weekdays = grid.slice(0, 7).map((c) => new Date(`${c.iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' }));
  const cells = grid.map((c) => {
    const list = days.get(c.iso) || [];
    const pick = (e) => (isFree(e.item) ? () => go(ui.calMonth, c.iso) : () => openDrawer(e.item));
    return el('div', {
      class: `cal-day ${c.inMonth ? '' : 'out'} ${c.iso === today ? 'today' : ''} ${ui.calDay === c.iso ? 'picked' : ''} ${list.length ? 'has' : ''}`,
      onclick: (e) => { if (!e.target.closest('.cal-ev')) go(c.iso.slice(0, 7), ui.calDay === c.iso ? null : c.iso); },
    },
    el('div', { class: 'cal-num' }, String(Number(c.iso.slice(8)))),
    list.slice(0, MAX).map((e) => el('button', { class: `cal-ev ${CAL_KINDS[e.kind].cls}`, title: `${CAL_KINDS[e.kind].label}: ${e.item.title}`, onclick: pick(e) }, e.item.title)),
    list.length > MAX ? el('div', { class: 'cal-more' }, `+${list.length - MAX} more`) : null);
  });
  content.append(head, note, el('div', { class: 'cal-grid' }, weekdays.map((w) => el('div', { class: 'cal-wd' }, w)), cells));

  // Below the grid: the picked day, or every day of the month with something on.
  const keys = unlocked();
  const agendaDays = [...days.keys()].filter((d) => (ui.calDay ? d === ui.calDay : d.startsWith(ui.calMonth)) && days.get(d).length).sort();
  const agenda = el('div', { class: 'cal-agenda' },
    ui.calDay ? el('button', { class: 'link', onclick: () => go(ui.calMonth) }, `Show all of ${monthName}`) : null);
  if (!agendaDays.length) agenda.append(el('div', { class: 'empty small' }, ui.calDay ? 'Nothing on this day.' : 'Nothing dated this month with these filters.'));
  for (const d of agendaDays) {
    const list = days.get(d);
    agenda.append(el('div', { class: 'section-head' }, el('h3', {}, new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))));
    for (const kind of Object.keys(CAL_KINDS)) {
      const items = list.filter((e) => e.kind === kind).map((e) => e.item);
      if (!items.length) continue;
      agenda.append(el('div', { class: `cal-kind ${CAL_KINDS[kind].cls}` }, `${CAL_KINDS[kind].label} (${items.length})`),
        kind.startsWith('free') ? el('div', { class: 'free-grid' }, items.map(freeCard)) : el('div', { class: 'grid' }, items.slice(0, 120).map((g) => card(g, keys))));
    }
  }
  content.append(agenda);
}

// ---------- free to keep ----------
const FREE_STORES = {
  epic: { name: 'Epic Games Store', short: 'Epic', color: '#2a2a2a' },
  steam: { name: 'Steam', short: 'Steam', color: '#1b2838' },
  gog: { name: 'GOG', short: 'GOG', color: '#86328a' },
  prime: { name: 'Prime Gaming', short: 'Prime', color: '#00a8e1' },
  psplus: { name: 'PlayStation Plus', short: 'PS Plus', color: '#0070d1' },
  fpd: { name: 'Xbox Free Play Days', short: 'Free Play Days', color: '#107c10' },
  humble: { name: 'Humble Choice', short: 'Humble', color: '#cc2929' },
};
const FREE_CHECK_HOURS = 6;
const freeMark = (g) => (state.freebies || {})[g.id] || null;
// PS Plus monthly games and Free Play Days need that plan (PC Game Pass has no Free Play Days).
function hasPlanFor(needs) {
  if (!needs) return true;
  const tier = (state.subscriptions || {})[needs];
  return needs === 'gamepass' ? !!tier && tier !== 'pc' : !!tier;
}
const NEEDS = { psplus: 'PS Plus', gamepass: 'Game Pass', humble: 'Humble Choice' };
const freeShown = (g) => ui.freeAll || hasPlanFor(g.needs);
const openFree = () => free.games.filter((g) => !g.upcoming && !freeMark(g) && hasPlanFor(g.needs));

function whenText(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// "in 3 days", "in 5 hours"
function inText(iso) {
  const ms = new Date(iso) - Date.now();
  const h = Math.round(ms / 3600000);
  if (h < 1) return 'within the hour';
  if (h < 36) return `in ${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `in ${d} days`;
}

async function setFreeMark(g, value) {
  const freebies = { ...(state.freebies || {}) };
  if (value) freebies[g.id] = value;
  else delete freebies[g.id];
  state = await api.updateState({ freebies });
  render(true);
}

// Catalogue games with the same title, so a giveaway you already have in a plan says so.
function freeAlsoIn(g) {
  const k = Unify.matchKey(g.title);
  if (!k) return null;
  const hit = games.find((x) => Unify.matchKey(x.title) === k);
  if (!hit) return null;
  // A PS Plus monthly game is in the PS Plus list itself.
  return serviceOffers(hit).filter((o) => !(g.store === 'psplus' && o.service === 'psplus')).map((o) => serviceById(o.service)?.short).filter(Boolean).join(', ');
}

function freeCard(g) {
  const store = FREE_STORES[g.store] || { name: g.store, short: g.store, color: '#444' };
  const mark = freeMark(g);
  const soon = !mark && g.kind !== 'try' && g.end && new Date(g.end) - Date.now() < 26 * 3600000;
  const img = g.image ? el('img', { src: g.image, loading: 'lazy', alt: '' }) : null;
  const art = el('div', { class: 'free-art' }, img || el('span', {}, g.mystery ? 'Mystery game' : g.title));
  if (img) img.addEventListener('error', () => img.replaceWith(el('span', {}, g.title)));
  const tryIt = g.kind === 'try';
  const when = g.upcoming
    ? `${tryIt ? 'Play free' : 'Free'} from ${whenText(g.start)}${g.end ? ` to ${whenText(g.end)}` : ''}`
    : !g.end ? 'No end date given'
      : tryIt ? `Play free until ${whenText(g.end)}, ${inText(g.end)}` : `Claim by ${whenText(g.end)}, ${inText(g.end)}`;
  const needs = g.needs ? (hasPlanFor(g.needs) ? `With your ${NEEDS[g.needs]}` : `Needs ${NEEDS[g.needs]}`) : tryIt ? 'Open to everyone' : null;
  const facts = [
    g.worth ? `Usually ${g.worth}` : null,
    g.limited ? 'Keys while they last' : null,
    g.trial ? 'Timed trial' : tryIt ? 'The full game for the weekend; progress carries over if you buy it' : null,
    g.store === 'psplus' ? 'Stays in your library while you have PS Plus' : null,
    g.store === 'humble' ? 'Yours to keep once claimed' : null,
  ].filter(Boolean);
  const also = freeAlsoIn(g);
  const claim = g.store === 'prime' ? 'Claim with Prime' : g.store === 'psplus' ? 'Add on PS Store' : tryIt ? 'Get it on Xbox' : `Claim on ${store.short}`;
  return el('div', { class: `free-card ${mark ? 'dim' : ''}` },
    art,
    el('div', { class: 'free-body' },
      el('div', { class: 'free-tags' }, el('span', { class: 'badge', style: `background:${store.color}` }, store.short),
        mark === 'claimed' ? el('span', { class: 'badge done' }, tryIt ? 'Played' : 'Claimed') : null,
        needs ? el('span', { class: `free-needs ${g.needs && !hasPlanFor(g.needs) ? 'missing' : ''}` }, needs) : null),
      el('h4', {}, g.title),
      el('div', { class: `free-when ${soon && !g.upcoming ? 'urgent' : ''}` }, when),
      facts.length ? el('div', { class: 'muted' }, facts.join(' · ')) : null,
      also ? el('div', { class: 'muted' }, `Also in ${also}`) : null,
      el('div', { class: 'free-actions' },
        g.url ? el('button', { class: g.upcoming || mark ? 'mark' : 'primary', onclick: () => api.openExternal(g.url) }, g.upcoming ? (g.store === 'psplus' && /blog\./.test(g.url) ? 'Announcement ↗' : 'Store page ↗') : `${claim} ↗`) : null,
        g.upcoming ? null : mark
          ? el('button', { class: 'mark', onclick: () => setFreeMark(g, null) }, 'Undo')
          : [el('button', { class: 'mark', title: 'Hide it and skip its reminder', onclick: () => setFreeMark(g, 'claimed') }, tryIt ? '✓ Played' : '✓ Claimed'),
            el('button', { class: 'mark', title: 'Hide it and skip its reminder', onclick: () => setFreeMark(g, 'skip') }, 'Not interested')])));
}

function renderFree() {
  const content = $('#content');
  content.replaceChildren();
  // Ending soonest first; no end date last.
  const byEnd = (a, b) => (a.end || '9').localeCompare(b.end || '9') || a.title.localeCompare(b.title);
  const shown = free.games.filter(freeShown);
  const hidden = free.games.filter((g) => !hasPlanFor(g.needs));
  const now = shown.filter((g) => !g.upcoming && !freeMark(g) && g.kind !== 'try').sort(byEnd);
  const weekend = shown.filter((g) => !g.upcoming && !freeMark(g) && g.kind === 'try').sort(byEnd);
  const next = shown.filter((g) => g.upcoming).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  const done = shown.filter((g) => !g.upcoming && freeMark(g)).sort(byEnd);
  const checked = free.at ? `checked ${new Date(free.at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'checking now…';
  $('#summary').textContent = `${now.length} free to keep right now${weekend.length ? ` · ${weekend.length} free to play this weekend` : ''} · ${checked}`;
  const SOURCE_NAMES = { epic: "Epic's list", gamerpower: 'GamerPower (Steam, GOG and Prime)', psplus: "PlayStation's monthly games list", psblog: 'the PlayStation Blog', fpd: 'Xbox Wire (Free Play Days)', humble: 'Humble Choice' };
  const failed = Object.keys(free.errors || {});
  if (failed.length) {
    content.append(el('p', { class: 'muted' }, `Couldn't reach ${failed.map((k) => SOURCE_NAMES[k] || k).join(' or ')} this time, so you see what it found before.`));
  }
  content.append(el('p', { class: 'muted free-lead' },
    'Games you keep for good once claimed, plus your plans\' monthly games and free weekends. Epic\'s weekly games come from Epic\'s own store list; Steam, GOG and Prime Gaming (claimed through Amazon Luna) giveaways from ',
    el('button', { class: 'link inline', onclick: () => api.openExternal('https://www.gamerpower.com/') }, 'GamerPower'),
    '. PS Plus monthly games come from PlayStation\'s own list and the PlayStation Blog, Humble Choice games from Humble\'s page, and Xbox Free Play Days from Xbox Wire. You get an alert when new ones appear and on the last day of ones you haven\'t marked claimed.'));
  const section = (title, hint, items) => {
    if (!items.length) return;
    content.append(el('div', { class: 'section-head' }, el('h3', {}, title, el('span', { class: 'muted' }, ` ${items.length}`)), el('span', { class: 'muted' }, hint)),
      el('div', { class: 'free-grid' }, items.map(freeCard)));
  };
  section('Free to keep now', 'Ending soonest first.', now);
  section('Free to play this weekend', 'Xbox Free Play Days: the full game for a few days.', weekend);
  section('Coming next', 'Epic\'s next free games and next month\'s PS Plus games.', next);
  section('Claimed or not interested', '', done);
  if (hidden.length) {
    const plans = [...new Set(hidden.map((g) => NEEDS[g.needs]))].join(' or ');
    content.append(el('p', { class: 'muted' },
      ui.freeAll ? `Showing ${hidden.length} that need ${plans}, which you don't have. ` : `${hidden.length} more need ${plans}, which you don't have. `,
      el('button', { class: 'link inline', onclick: () => { ui.freeAll = !ui.freeAll; render(true); } }, ui.freeAll ? 'Hide them' : 'Show them')));
  }
  if (!free.games.length) content.append(el('div', { class: 'empty' }, free.at ? 'No giveaways right now.' : 'Looking for giveaways…'));
}

function freeDue() {
  return !free.at || Date.now() - new Date(free.at) > FREE_CHECK_HOURS * 3600000;
}

async function loadFree(force = false) {
  free = await api.getFree();
  if (force || freeDue()) {
    try {
      free = await api.refreshFree();
    } catch {
      // Shown as before; the background check tries again.
    }
  }
  renderChrome();
  if (ui.view === 'free') render(true);
}

api.onFreeChanged(async () => {
  free = await api.getFree();
  renderChrome();
  if (ui.view === 'free') render(true);
});

// ---------- statistics ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

// A ring chart: each slice is a circle stroke dashed to its share
// (the circle's circumference is 100, so a share is its percentage).
function donut(slices, centre, caption) {
  const total = slices.reduce((sum, x) => sum + x.value, 0);
  const svg = svgEl('svg', { viewBox: '0 0 42 42', class: 'donut', role: 'img' });
  svg.append(svgEl('circle', { cx: 21, cy: 21, r: 15.915, fill: 'none', stroke: '#2a2f3a', 'stroke-width': 6 }));
  let offset = 25; // start at 12 o'clock
  for (const x of slices) {
    if (!x.value) continue;
    const pct = (x.value / total) * 100;
    const ring = svgEl('circle', { cx: 21, cy: 21, r: 15.915, fill: 'none', stroke: x.color, 'stroke-width': 6, 'stroke-dasharray': `${pct} ${100 - pct}`, 'stroke-dashoffset': offset });
    ring.append(svgEl('title', {}, `${x.label}: ${x.value}`));
    svg.append(ring);
    offset -= pct;
  }
  svg.append(svgEl('text', { x: 21, y: 20.5, class: 'donut-num' }, centre), svgEl('text', { x: 21, y: 26, class: 'donut-cap' }, caption));
  const legend = el('ul', { class: 'legend' }, slices.filter((x) => x.value).map((x) => el('li', {},
    el('span', { class: 'dot', style: `background:${x.color}` }),
    el('span', { class: 'legend-name' }, x.label),
    el('span', { class: 'legend-num' }, `${x.value}`, el('span', { class: 'muted' }, ` · ${share(x.value / total)}`)))));
  return el('div', { class: 'chart' }, svg, legend);
}

const STATUS_COLOR = { completed: '#f2c94c', played: '#3ccf91', wishlist: '#6aa8ff', untouched: '#3a404d', ignored: '#6b7280' };
const pct = (x) => `${Math.round(x * 100)}%`;
// Shares too small to round up still show as something.
const share = (x) => (x > 0 && x < 0.005 ? '<1%' : pct(x));

function statsGames() {
  // Marked games that have since left a service still count.
  const ids = new Set(games.flatMap((g) => offersOf(g).map((o) => o.id)));
  const gone = new Map();
  for (const d of departed) {
    if (state.marks[d.id] && !ids.has(d.id) && !gone.has(d.id)) gone.set(d.id, { ...d, genreTags: Genres.genresOf(d) });
  }
  return [...games, ...gone.values()];
}

function renderStats() {
  const content = $('#content');
  content.replaceChildren();
  const keys = unlocked();
  const subscribed = allServices().filter((s) => [...keys].some((k) => k.startsWith(`${s.id}:`))).map((s) => s.id);
  const st = Stats.compute(statsGames(), {
    markOf: (g) => markOf(g.id),
    myServices: (g) => serviceOffers(g).filter((o) => offerIsMine(o, keys)).map((o) => o.service),
    hours: beatHours,
    score: mcScore,
    subscribed,
  });
  const { totals } = st;
  const nameOf = (id) => (id === Stats.OTHER ? 'Not in your plans' : serviceById(id)?.name || id);
  const colorOf = (id) => (id === Stats.OTHER ? '#4b5263' : serviceById(id)?.color || '#666');
  const withGames = st.services.filter((r) => r.inPlans);
  $('#summary').textContent = withGames.length
    ? `${totals.inPlans} games in your plans across ${withGames.length} service${withGames.length === 1 ? '' : 's'}`
    : 'Pick your plans in Settings to see how far through them you are';

  if (!totals.completed && !totals.played) {
    content.append(el('div', { class: 'empty' }, 'Mark games as played or completed (or import your Steam library in Settings) and your statistics will show up here.'));
    return;
  }

  const tile = (value, label, title) => el('div', { class: 'tile', title: title || '' }, el('div', { class: 'tile-num' }, value), el('div', { class: 'tile-label' }, label));
  content.append(el('div', { class: 'tiles' },
    tile(totals.completed, 'completed'),
    tile(totals.played, 'playing', 'Marked as played but not completed'),
    st.finishRate != null ? tile(pct(st.finishRate), 'finish rate', 'Completed out of every game you have started') : null,
    st.time.completedTimed ? tile(`${Math.round(st.time.completed)}h`, 'of games finished', `How Long To Beat main-story time of ${st.time.completedTimed} of your completed games`) : null,
    st.averageScore != null ? tile(st.averageScore, 'average Metacritic', 'Average score of the games you completed') : null,
    totals.inPlans ? tile(share(st.plans.completed / totals.inPlans), 'of your plans done', `${st.plans.completed} completed out of ${totals.inPlans} games in your plans`) : null,
    state.steam?.owned ? tile(st.steamOwned, 'owned on Steam', 'Games in your plans that you also own on Steam') : null));

  content.append(el('div', { class: 'chart-row' },
    el('div', { class: 'panel' },
      el('h2', {}, 'Completed by service'),
      el('p', { class: 'muted' }, 'A game in several of your services counts for the first one listed on its card.'),
      donut(st.completedBy.map((x) => ({ label: nameOf(x.service), value: x.count, color: colorOf(x.service) })), totals.completed, 'completed')),
    el('div', { class: 'panel' },
      el('h2', {}, 'Your plans by status'),
      el('p', { class: 'muted' }, 'Every game in your plans, by how far you got with it.'),
      totals.inPlans
        ? donut([
          { label: 'Completed', value: st.plans.completed, color: STATUS_COLOR.completed },
          { label: 'Playing', value: st.plans.played, color: STATUS_COLOR.played },
          { label: 'To play', value: st.plans.wishlist, color: STATUS_COLOR.wishlist },
          { label: 'Ignored', value: st.plans.ignored, color: STATUS_COLOR.ignored },
          { label: 'Not started', value: st.plans.untouched, color: STATUS_COLOR.untouched },
        ], totals.inPlans, 'in plans')
        : el('p', { class: 'muted' }, 'No plans picked yet.'))));

  if (withGames.length) {
    content.append(el('div', { class: 'panel' },
      el('h2', {}, 'Progress per service'),
      withGames.map((r) => el('div', { class: 'svc-progress', style: `--svc:${colorOf(r.service)}` },
        el('div', { class: 'svc-progress-name' }, nameOf(r.service)),
        el('div', { class: 'bar', title: `${r.completed} completed, ${r.played} playing, of ${r.inPlans}` },
          el('span', { class: 'bar-done', style: `width:${r.inPlans ? (r.completed / r.inPlans) * 100 : 0}%` }),
          el('span', { class: 'bar-playing', style: `width:${r.inPlans ? (r.played / r.inPlans) * 100 : 0}%` })),
        el('div', { class: 'svc-progress-num' }, `${r.completed} of ${r.inPlans} completed · ${r.played} playing`)))));
  }

  if (st.genres.length) {
    const top = st.genres.slice(0, 8);
    const most = top[0].count;
    content.append(el('div', { class: 'panel' },
      el('h2', {}, 'What you finish'),
      el('p', { class: 'muted' }, 'Genres of your completed games (a game can have more than one).'),
      top.map((x) => el('div', { class: 'svc-progress' },
        el('div', { class: 'svc-progress-name' }, x.genre),
        el('div', { class: 'bar' }, el('span', { class: 'bar-genre', style: `width:${(x.count / most) * 100}%` })),
        el('div', { class: 'svc-progress-num' }, `${x.count}`)))));
  }

  if (st.time.playingTimed) {
    content.append(el('p', { class: 'muted stats-note' }, `The ${st.time.playingTimed} games you're playing that have a How Long To Beat time add up to about ${Math.round(st.time.playing)} hours of main story.`));
  }
}

// ---------- value ----------
const regionCurrency = () => regions.find((r) => r.id === state.settings.region)?.currency || null;
function money(amount, digits) {
  const currency = regionCurrency();
  if (!currency) return amount.toFixed(2);
  const d = digits ?? (amount >= 100 ? 0 : 2);
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d }).format(amount);
}

// The price you entered, else the one found in a store (in your currency).
function priceOf(g) {
  const manual = state.priceOverrides?.[g.id];
  if (typeof manual === 'number') return { amount: manual, manual: true };
  const p = prices[g.id];
  return p?.amount > 0 && p.currency === regionCurrency() ? p : null;
}

// Played through a subscription, unless you said otherwise. Games you own
// on Steam, or that aren't in your plans, you probably bought.
function viaSub(g, keys) {
  const set = state.viaSub?.[g.id];
  if (typeof set === 'boolean') return set;
  return isMine(g, keys) && !g.steam;
}

function renderValue() {
  const content = $('#content');
  content.replaceChildren();
  const keys = unlocked();
  const includePlayed = !!state.settings.valueIncludePlayed;
  const beaten = statsGames().filter((g) => ['completed', ...(includePlayed ? ['played'] : [])].includes(markOf(g.id)));
  // Prices for every beaten game, so ticking one shows its price at once.
  // The app only looks up the ones it has no recent price for.
  if (Date.now() - lastPriceAsk > 60000) {
    lastPriceAsk = Date.now();
    api.lookupPrices(beaten.map((g) => ({ id: g.id, title: g.title, offers: offersOf(g).map((o) => ({ id: o.id, service: o.service, storeUrl: o.storeUrl || null })) })));
  }
  const v = Value.compute(beaten, {
    markOf: (g) => markOf(g.id),
    myServices: (g) => serviceOffers(g).filter((o) => offerIsMine(o, keys)).map((o) => o.service),
    price: priceOf,
    viaSub: (g) => viaSub(g, keys),
    costs: state.costs || {},
    today: todayIso(),
    includePlayed,
  });
  const lookingUp = priceProgress && priceProgress.done < priceProgress.total ? ` Looking up prices: ${priceProgress.done} of ${priceProgress.total}.` : '';
  $('#summary').textContent = `Today's full store prices${regionCurrency() ? ` in ${regionCurrency()}` : ''}, not sale prices.${lookingUp}`;

  const tile = (value, label, title, cls = '') => el('div', { class: `tile ${cls}`, title: title || '' }, el('div', { class: 'tile-num' }, value), el('div', { class: 'tile-label' }, label));
  const ahead = v.saved >= 0;
  content.append(el('div', { class: 'tiles' },
    tile(money(v.worth), `to buy the ${v.games} game${v.games === 1 ? '' : 's'} you beat`, v.priced < v.games ? `${v.games - v.priced} without a price yet` : ''),
    tile(v.paid ? money(v.paid) : '—', 'paid in subscriptions', v.paid ? '' : 'Enter what you pay below'),
    v.paid ? tile(money(Math.abs(v.saved)), ahead ? 'saved by subscribing' : 'more than buying them', '', ahead ? 'good' : 'bad') : null,
    v.perGame ? tile(money(v.perGame), 'per game beaten', 'What each game cost you through subscriptions') : null));

  const playedBox = el('input', { type: 'checkbox' });
  playedBox.checked = includePlayed;
  playedBox.addEventListener('change', async () => { await saveState({ settings: { ...state.settings, valueIncludePlayed: playedBox.checked } }); render(true); });
  content.append(el('label', { class: 'check-row value-toggle' }, playedBox, el('span', {}, 'Count games you played but didn\'t finish')));

  content.append(costsPanel(v), beatenPanel(v));
}

// What each plan costs you, to compare against.
function costsPanel(v) {
  const subscribed = allServices().filter((s) => state.subscriptions[s.id]);
  const byService = new Map(v.services.map((r) => [r.service, r]));
  const save = async (id, patch) => {
    const costs = { ...(state.costs || {}) };
    costs[id] = { ...(costs[id] || {}), ...patch };
    await saveState({ costs });
    render(true);
  };
  const rows = subscribed.map((s) => {
    const c = state.costs?.[s.id] || {};
    const r = byService.get(s.id);
    const monthly = el('input', { type: 'number', min: '0', step: '0.01', placeholder: 'per month', value: c.monthly ?? '' });
    monthly.addEventListener('change', () => save(s.id, { monthly: monthly.value === '' ? null : Number(monthly.value) }));
    const since = el('input', { type: 'month', value: c.since || '', max: todayIso().slice(0, 7) });
    since.addEventListener('change', () => save(s.id, { since: since.value || null }));
    const verdict = r && r.paid ? (r.value >= r.paid ? `saved ${money(r.value - r.paid)}` : `${money(r.paid - r.value)} more than buying`) : '';
    return el('div', { class: 'cost-row', style: `--svc:${s.color}` },
      el('div', { class: 'cost-name' }, el('span', { class: 'dot', style: `background:${s.color}` }), s.name),
      el('label', { class: 'cost-field' }, monthly, el('span', { class: 'muted' }, '/ month since'), since),
      el('div', { class: 'cost-sum' },
        r?.paid ? el('div', {}, `${money(r.paid)} paid over ${r.months} month${r.months === 1 ? '' : 's'}`) : el('div', { class: 'muted' }, c.monthly ? 'Pick the month you started' : 'Not counted'),
        r?.games ? el('div', { class: 'muted' }, `${r.games} beaten, worth ${money(r.value)}${verdict ? ` · ${verdict}` : ''}`) : null));
  });
  return el('div', { class: 'panel' },
    el('h2', {}, 'What you pay'),
    el('p', { class: 'muted' }, 'Enter the monthly price of each plan you pay for and when you started (for a yearly plan, divide by 12). Leave out plans that come included with another, like EA Play with Game Pass Ultimate.'),
    rows.length ? rows : el('p', { class: 'muted' }, 'Pick your plans in Settings first.'));
}

// Every beaten game, its price, and whether it counts.
function beatenPanel(v) {
  const keys = unlocked();
  const all = statsGames().filter((g) => ['completed', ...(state.settings.valueIncludePlayed ? ['played'] : [])].includes(markOf(g.id)));
  const counted = new Set(v.list.map((x) => x.game.id));
  all.sort((a, b) => (counted.has(b.id) - counted.has(a.id)) || ((priceOf(b)?.amount || 0) - (priceOf(a)?.amount || 0)) || a.title.localeCompare(b.title));
  const rows = all.map((g) => {
    const on = counted.has(g.id);
    const box = el('input', { type: 'checkbox', title: 'Played through a subscription' });
    box.checked = on;
    box.addEventListener('change', async () => { await saveState({ viaSub: { ...(state.viaSub || {}), [g.id]: box.checked } }); render(true); });
    const p = priceOf(g);
    const looked = prices[g.id];
    const input = el('input', { type: 'number', min: '0', step: '0.01', class: 'price-input', placeholder: looked ? 'enter price' : 'looking up…', value: p?.manual ? p.amount : '' });
    input.addEventListener('change', async () => {
      const overrides = { ...(state.priceOverrides || {}) };
      if (input.value === '') delete overrides[g.id];
      else overrides[g.id] = Number(input.value);
      await saveState({ priceOverrides: overrides });
      render(true);
    });
    const shown = p && !p.manual
      ? el('span', { class: 'price' }, el('button', { class: 'link inline', title: `Full price on ${p.source}`, onclick: () => p.url && api.openExternal(p.url) }, money(p.amount, 2)), el('span', { class: 'muted' }, ` ${p.source}`),
        el('button', { class: 'link inline price-edit', title: 'Use a different price', onclick: (e) => { e.currentTarget.parentElement.replaceWith(input); input.focus(); } }, 'edit'))
      : input;
    return el('div', { class: `beaten-row ${on ? '' : 'off'}` },
      el('label', { class: 'beaten-check' }, box, el('span', { class: 'beaten-title', title: g.title }, g.title)),
      el('div', { class: 'meta' }, serviceOffers(g).slice(0, 3).map((o) => serviceTag(o)), markOf(g.id) === 'played' ? el('span', { class: 'tier' }, 'played') : null),
      shown);
  });
  return el('div', { class: 'panel' },
    el('h2', {}, 'Games you beat'),
    el('p', { class: 'muted' }, 'Untick games you bought or played some other way; they don\'t count. Prices come from the service\'s own store, else Steam; Switch Online classics aren\'t sold anywhere, so enter what they\'re worth to you.'),
    rows.length ? rows : el('p', { class: 'muted' }, 'Mark games as completed and they show up here.'));
}

function renderSubs() {
  $('#summary').textContent = 'Your plans, region, background, Steam and profile export. Everything is saved on this computer.';
  const content = $('#content');
  content.replaceChildren();

  const rows = allServices().map((s) => {
    const current = state.subscriptions[s.id] || '';
    const pick = async (tierId) => {
      await saveState({ subscriptions: { ...state.subscriptions, [s.id]: tierId || undefined } });
      render(true);
    };
    const cat = catalogs.find((c) => c.service === s.id);
    const count = cat ? cat.games.length : (state.customGames || []).filter((g) => g.service === s.id).length;
    return el('div', { class: 'sub-row', style: `--svc:${s.color}` },
      el('div', { class: 'sub-name' }, el('strong', {}, s.name), el('span', { class: 'muted' }, `${count} games`)),
      el('div', { class: 'seg' },
        el('button', { class: current ? '' : 'on', onclick: () => pick('') }, 'Not subscribed'),
        s.tiers.map((t) => el('button', { class: current === t.id ? 'on' : '', onclick: () => pick(t.id) }, t.name))),
      s.custom ? el('button', { class: 'link danger', onclick: () => removeCustomService(s) }, 'Remove') : null);
  });

  content.append(el('div', { class: 'panel' },
    el('div', { class: 'panel-head' }, el('h2', {}, 'My subscriptions'), el('button', { class: 'link', onclick: startOnboarding }, 'Run the welcome setup again')),
    rows));
  content.append(customServicePanel(), customGamePanel(), regionPanel(), backgroundPanel(), steamPanel(), backupPanel(), sourcesPanel());
}

// Tray, start with Windows and alerts.
function backgroundPanel() {
  const toggle = (key, label, hint, fallback) => {
    const box = el('input', { type: 'checkbox' });
    box.checked = state.settings[key] ?? fallback;
    box.addEventListener('change', () => saveState({ settings: { ...state.settings, [key]: box.checked } }));
    return el('label', { class: 'check-row' }, box, el('span', {}, el('strong', {}, label), el('span', { class: 'muted' }, ` ${hint}`)));
  };
  const windows = navigator.userAgent.includes('Windows');
  return el('div', { class: 'panel' },
    el('h2', {}, 'Background'),
    el('p', { class: 'muted' }, 'Subscroll can keep running in the system tray and check the lists once a day, so you hear about new and leaving games without opening it.'),
    el('div', { class: 'checks' },
      toggle('closeToTray', 'Keep running in the tray when the window is closed.', 'Quit from the tray icon\'s menu.', true),
      windows ? toggle('startWithWindows', 'Start with Windows.', 'Starts in the tray, without opening the window.', false) : null,
      toggle('alerts', 'Alerts.', 'A notification when games join a service in your plans, or games in your plans start leaving. Completed and ignored games are left out.', true),
      toggle('freeAlerts', 'Free game alerts.', 'A notification when new games are free to keep, and on the last day of ones you haven\'t marked claimed.', true),
      toggle('saleAlerts', 'Sale alerts.', 'A notification when a To play game that isn\'t in your plans goes on sale (Microsoft Store, PlayStation Store or Steam).', true)));
}

// Steam library import: owned games get a badge, played ones a mark.
function steamPanel() {
  const s = state.steam;
  const profile = el('input', { placeholder: 'Steam profile link or Steam ID', value: s?.profile || '' });
  const key = el('input', { type: 'password', placeholder: s?.key ? 'API key saved (enter a new one to replace it)' : 'Steam Web API key', autocomplete: 'off' });
  const status = el('p', { class: 'muted' });
  status.id = 'steam-status';
  const games = (n) => `${n} game${n === 1 ? '' : 's'}`;
  if (s?.importedAt) status.textContent = `Last imported ${new Date(s.importedAt).toLocaleString()}: ${games(s.count)} in your Steam library.`;
  const button = el('button', { class: 'primary' }, s ? 'Import again' : 'Import');
  button.onclick = async () => {
    button.disabled = true;
    status.textContent = 'Reading your Steam library…';
    const r = await api.importSteam(profile.value, key.value);
    button.disabled = false;
    if (!r.ok) {
      status.textContent = r.error;
      return;
    }
    state = r.state;
    rebuildGames();
    render(true);
    const { owned, inCatalogue, marked } = r.summary;
    const fresh = document.querySelector('#steam-status');
    if (fresh) fresh.textContent = `Found ${games(owned)} on Steam. ${inCatalogue} of them ${inCatalogue === 1 ? 'is' : 'are'} in the services here, and ${marked ? `${marked} ${marked === 1 ? 'was' : 'were'} newly marked as played` : 'none needed marking as played'}.`;
  };
  const forget = async () => {
    state = await api.forgetSteam();
    rebuildGames();
    render(true);
  };
  const keyLink = el('button', { class: 'link inline', onclick: () => api.openExternal('https://steamcommunity.com/dev/apikey') }, 'steamcommunity.com/dev/apikey');
  return el('div', { class: 'panel' },
    el('h2', {}, 'Steam library'),
    el('p', { class: 'muted' },
      `Games you own on Steam get an "On Steam" badge, and games you've played there for ${STEAM_PLAYED_MINUTES} minutes or more are marked as played (once, so you can still unmark them). It's read again with the daily refresh. You need a free Web API key from `, keyLink,
      ' (sign in, type any domain such as localhost, and copy the key), and your Steam profile\'s Game details set to Public.'),
    el('div', { class: 'form' }, profile, key, button,
      s ? el('button', { class: 'link danger', onclick: forget }, 'Forget Steam') : null),
    status);
}

// The last export or import result, kept while the page is rebuilt.
let profileNote = '';
// Everything Subscroll keeps about you in one file, to keep safe or move to another PC.
function backupPanel() {
  const games = (n) => `${n} marked game${n === 1 ? '' : 's'}`;
  const size = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const status = el('p', { class: 'muted' }, profileNote);
  const lookups = el('input', { type: 'checkbox', checked: '' });
  const exportIt = async () => {
    const r = await api.exportBackup({ lookups: lookups.checked });
    if (r.ok) status.textContent = profileNote = `Exported ${games(r.marks)}, your plans and settings (${size(r.bytes)}) to ${r.file}`;
  };
  const restore = async () => {
    const r = await api.importBackup();
    if (r.error) {
      status.textContent = profileNote = r.error;
    } else if (r.ok) {
      profileNote = `Imported ${games(r.marks)}, your plans and settings${r.looked ? `, plus ${r.looked} looked-up detail${r.looked === 1 ? '' : 's'} such as scores and prices` : ''}.`;
      state = r.state;
      rebuildGames();
      // Rebuilds this panel, which shows the note.
      render(true);
    }
  };
  status.id = 'backup-status';
  return el('div', { class: 'panel' },
    el('h2', {}, 'Export & import profile'),
    el('p', { class: 'muted' },
      'Everything Subscroll keeps about you in one JSON file: plans, marks, To play list, your own services and games, settings, Value page costs, Steam link, free games you claimed, and when games joined or left each list. '
      + 'Keep it safe or move it to another PC. Importing replaces your plans, marks and settings on this PC, and adds the history and looked-up data to what it already has. '
      + 'The file includes your Steam Web API key if you added one, so keep it to yourself.'),
    el('div', { class: 'checks' }, el('label', { class: 'check-row' }, lookups, el('span', {}, el('strong', {}, 'Include looked-up data.'), el('span', { class: 'muted' }, ' Scores, play times, prices, descriptions and covers, so the other PC needn\'t look them all up again. Makes the file bigger.')))),
    el('div', { class: 'form' },
      el('button', { class: 'primary', onclick: exportIt }, 'Export profile…'),
      el('button', { onclick: restore }, 'Import profile…')),
    status);
}

function customServicePanel() {
  const name = el('input', { placeholder: 'Service name, e.g. Google Play Pass or Amazon Luna' });
  const tiers = el('input', { placeholder: 'Plans, cheapest first, comma separated (optional)' });
  const add = async () => {
    if (!name.value.trim()) return;
    const id = `custom-${Date.now().toString(36)}`;
    const tierNames = tiers.value.split(',').map((t) => t.trim()).filter(Boolean);
    const list = (tierNames.length ? tierNames : ['Subscribed']).map((t, i) => ({ id: `t${i}`, name: t }));
    // Each plan includes every cheaper plan.
    list.forEach((t, i) => { t.includes = list.slice(0, i + 1).map((x) => x.id); });
    const hue = Math.floor(Math.random() * 360);
    await saveState({ customServices: [...(state.customServices || []), { id, name: name.value.trim(), color: `hsl(${hue} 60% 45%)`, tiers: list, custom: true }] });
    render(true);
  };
  return el('div', { class: 'panel' },
    el('h2', {}, 'Add another service'),
    el('p', { class: 'muted' }, 'For services without a public game list, add the service here and its games below.'),
    el('div', { class: 'form' }, name, tiers, el('button', { class: 'primary', onclick: add }, 'Add service')));
}

async function removeCustomService(s) {
  if (!confirm(`Remove ${s.name} and its games?`)) return;
  const subscriptions = { ...state.subscriptions };
  delete subscriptions[s.id];
  await saveState({
    customServices: state.customServices.filter((c) => c.id !== s.id),
    customGames: (state.customGames || []).filter((g) => g.service !== s.id),
    subscriptions,
  });
  rebuildGames();
  render(true);
}

function customGamePanel() {
  const custom = state.customServices || [];
  if (custom.length === 0) return el('div');
  const title = el('input', { placeholder: 'Game title' });
  const svc = el('select', {}, custom.map((s) => el('option', { value: s.id }, s.name)));
  const tier = el('select');
  const fillTiers = () => {
    const s = custom.find((c) => c.id === svc.value);
    tier.replaceChildren(...s.tiers.map((t) => el('option', { value: t.id }, t.name)));
  };
  svc.addEventListener('change', fillTiers);
  fillTiers();
  const platform = el('input', { placeholder: 'Platform (optional)' });
  const leave = el('input', { type: 'date', title: 'Leaving date (optional)' });
  const add = async () => {
    if (!title.value.trim()) return;
    const id = `${svc.value}:${Date.now().toString(36)}`;
    const game = { id, service: svc.value, title: title.value.trim(), image: null, platforms: platform.value.trim() ? [platform.value.trim()] : [], tiers: [tier.value], leavingSoon: false, genres: [], releaseDate: null, storeUrl: null };
    const patch = { customGames: [...(state.customGames || []), game] };
    if (leave.value) patch.leaveDates = { ...state.leaveDates, [id]: leave.value };
    await saveState(patch);
    rebuildGames();
    title.value = '';
    render(true);
  };
  return el('div', { class: 'panel' },
    el('h2', {}, 'Add a game to your own service'),
    el('div', { class: 'form' }, title, svc, tier, platform, leave, el('button', { class: 'primary', onclick: add }, 'Add game')));
}

function regionPanel() {
  const current = state.settings.region || '';
  const select = el('select', {},
    current ? null : el('option', { value: '' }, `Custom (${state.settings.market})`),
    regions.map((r) => el('option', { value: r.id }, r.name)));
  select.value = current;
  const note = el('span', { class: 'muted' });
  select.addEventListener('change', async () => {
    await saveState({ settings: { ...state.settings, region: select.value } });
    rebuildGames();
    note.textContent = 'Refreshing the lists for this country…';
    await refresh();
    note.textContent = '';
  });
  return el('div', { class: 'panel' },
    el('h2', {}, 'Region'),
    el('p', { class: 'muted' }, 'Game Pass and PS Plus catalogues differ a little by country. Switch Online only differs in Japan, which has some games the rest of the world doesn\'t (and the other way round).'),
    el('div', { class: 'form' }, el('label', {}, 'Country ', select), note));
}

function sourcesPanel() {
  const rows = catalogs.map((c) => {
    const s = serviceById(c.service);
    const when = c.fetchedAt ? new Date(c.fetchedAt).toLocaleString() : 'unknown';
    return el('li', {}, el('strong', {}, s.name), `: ${c.games.length} games from the ${SOURCE_LABEL[c.source] || c.source}, updated ${when}`);
  });
  return el('div', { class: 'panel' },
    el('h2', {}, 'Where the lists come from'),
    el('ul', { class: 'sources' }, rows),
    el('p', { class: 'muted' },
      'Game Pass, EA Play and Ubisoft+ come from Microsoft\'s catalogue service (so EA Play and Ubisoft+ show their Xbox and Microsoft Store editions), PS Plus from playstation.com\'s game lists. If Game Pass or PS Plus are unreachable the app falls back to community mirrors on GitHub. ',
      'Nintendo publishes no list, so Switch Online comes from Wikipedia\'s "Nintendo Classics" article, with box art from the libretro-thumbnails collection. ',
      'Netflix games are the apps Netflix publishes on the App Store. Apple Arcade comes from Wikipedia\'s "Apple Arcade" article, with icons and details from the App Store, looked up a few at a time.'));
}

function openDrawer(g) {
  drawerGame = g;
  const drawer = $('#drawer');
  const leave = leaveInfo(g);
  const offers = serviceOffers(g);
  const keys = unlocked();
  // Per service when the game is in more than one.
  const plans = offers.length === 1 ? plansFor(g).map((t) => t.name).join(', ')
    : offers.map((o) => el('div', {}, `${serviceById(o.service)?.name || o.service}: ${plansFor(o).map((t) => t.name).join(', ') || '—'}`));
  const close = closeDrawer;
  const deleteCustom = async () => {
    await saveState({ customGames: state.customGames.filter((c) => c.id !== g.id) });
    rebuildGames();
    close();
    render(true);
  };
  drawer.replaceChildren(
    el('div', { class: 'drawer-backdrop', onclick: close }),
    el('div', { class: 'drawer-panel' },
      el('button', { class: 'close', onclick: close, title: 'Close' }, '✕'),
      drawerRoll ? rollBar() : null,
      cover(g),
      el('h2', {}, g.title),
      serviceMeta(g, keys),
      playBar(g),
      el('dl', {},
        el('dt', {}, 'Included in'), el('dd', {}, plans.length ? plans : '—'),
        el('dt', {}, 'Platforms'), el('dd', {}, g.platforms.map(platformName).join(', ') || '—'),
        g.versions?.length ? [el('dt', {}, 'Versions'), el('dd', {}, g.versions.join(', '))] : null,
        cloudRow(g),
        g.steam ? [el('dt', {}, 'Steam'), el('dd', {}, el('button', { class: 'link inline', onclick: () => api.openExternal(`https://store.steampowered.com/app/${g.steam.appid}/`) }, steamText(g.steam).replace('You own this on Steam, ', 'Owned, '), ' ↗'))] : null,
        g.genreTags?.length ? [el('dt', {}, 'Genre'), el('dd', {}, g.genreTags.join(', '))]
          : g.genres?.length ? [el('dt', {}, 'Genre'), el('dd', {}, g.genres.join(', '))] : null,
        studioRows(g),
        g.releaseDate ? [el('dt', {}, 'Released'), el('dd', {}, fmtDate(g.releaseDate))] : null,
        isComing(g) ? [el('dt', {}, 'Coming'), el('dd', {}, fmtDate(g.comingOn))] : null,
        g.firstSeen && !isComing(g) ? [el('dt', {}, 'Added'), el('dd', {}, fmtDate(g.firstSeen))] : null,
        ratingRows(g),
        leave ? [el('dt', {}, 'Leaving'), el('dd', {}, leave.date ? fmtDate(leave.date) : `${leave.from?.length ? `${leave.from.join(', ')}: ` : ''}soon, no date announced`)] : null),
      markButtons(g, true),
      notesSection(g),
      detailsSection(g),
      offers.filter((o) => o.storeUrl).map((o) => el('button', { class: 'link', onclick: () => api.openExternal(o.storeUrl) },
        o.service === 'nso' ? 'Open the Wikipedia list ↗' : offers.length > 1 ? `Open on ${serviceById(o.service)?.short || o.service} ↗` : 'Open store page ↗')),
      g.custom ? el('button', { class: 'link danger', onclick: deleteCustom }, 'Delete this game') : null));
  drawer.classList.remove('hidden');
}

// Your star rating and notes, saved as you type.
function notesSection(g) {
  const note = noteOf(g.id) || {};
  const stars = el('div', { class: 'stars-input', role: 'radiogroup', 'aria-label': 'Your rating' });
  const drawStars = (n) => stars.replaceChildren(...[1, 2, 3, 4, 5].map((i) => el('button', {
    class: `star ${i <= (n || 0) ? 'on' : ''}`,
    title: n === i ? 'Clear your rating' : `${i} star${i === 1 ? '' : 's'}`,
    'aria-checked': String(n === i),
    role: 'radio',
    onclick: async () => {
      const next = (noteOf(g.id)?.stars || 0) === i ? null : i;
      drawStars(next);
      await setNote(g.id, { stars: next });
      render(true);
    },
  }, '★')));
  drawStars(note.stars);
  const text = el('textarea', { class: 'note-text', rows: 3, placeholder: 'Your notes: where you got to, what to try, who recommended it…' });
  text.value = note.text || '';
  let timer;
  const saveText = async () => {
    clearTimeout(timer);
    if ((noteOf(g.id)?.text || '') === text.value) return;
    await setNote(g.id, { text: text.value });
  };
  text.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(saveText, 600); });
  // Re-drawing the list on blur shows the note badge without losing focus while typing.
  text.addEventListener('blur', async () => { await saveText(); render(true); });
  return el('section', { class: 'notes' },
    el('div', { class: 'notes-head' }, el('span', { class: 'muted' }, 'Your rating'), stars),
    text);
}

// Play / install buttons. Steam is asked whether the game is installed.
const steamInstalledCache = new Map();
function playBar(g) {
  const bar = el('div', { class: 'play-bar' });
  const draw = (installed) => {
    const actions = Play.playActions(g, { installed });
    bar.replaceChildren(...actions.map((a) => el('button', {
      class: a.primary ? 'primary' : 'mark',
      title: a.url,
      onclick: async () => {
        const r = await api.launch(a.url);
        if (r.ok) return;
        bar.querySelector('.play-error')?.remove();
        bar.append(el('span', { class: 'muted play-error' }, a.kind === 'steam' ? "Couldn't open Steam. Is it installed?" : a.kind === 'xbox' ? "Couldn't open the Xbox app. Is it installed?" : "Couldn't open that link."));
      },
    }, a.label)));
    bar.classList.toggle('hidden', !actions.length);
  };
  const appid = g.steam?.appid;
  draw(appid ? steamInstalledCache.get(appid) ?? null : null);
  if (appid && !steamInstalledCache.has(appid)) {
    api.steamInstalled(appid).then((v) => {
      steamInstalledCache.set(appid, v);
      if (bar.isConnected) draw(v);
    }).catch(() => {});
  }
  return bar;
}

// Developer and publisher, from whichever service's list names them.
function studioRows(g) {
  const pick = (field) => [...new Set((g.offers || [g]).map((o) => o[field]).filter(Boolean))][0];
  const dev = pick('developer');
  const pub = pick('publisher');
  return [
    ...(dev ? [el('dt', {}, 'Developer'), el('dd', {}, dev)] : []),
    ...(pub && pub !== dev ? [el('dt', {}, 'Publisher'), el('dd', {}, pub)] : []),
  ];
}

function ratingRows(g) {
  const r = ratings[g.id];
  const link = (url, ...children) => (url ? el('button', { class: 'link inline', onclick: () => api.openExternal(url) }, ...children) : el('span', {}, ...children));
  const rows = [];
  if (r?.mc > 0) {
    rows.push(el('dt', {}, 'Metacritic'), el('dd', {}, link(r.mcUrl, el('span', { class: `score ${scoreClass(r.mc)}` }, r.mc), ' ↗')));
  } else if (r?.mcUrl) {
    rows.push(el('dt', {}, 'Metacritic'), el('dd', {}, link(r.mcUrl, 'Not scored yet ↗')));
  }
  if (r?.hltb) {
    const parts = [['Main', r.hltb.main], ['+ Extras', r.hltb.plus], ['100%', r.hltb.all]]
      .filter(([, h]) => h != null)
      .map(([label, h]) => `${label} ${fmtHours(h)}`);
    rows.push(el('dt', {}, 'Time to beat'), el('dd', {}, link(r.hltbUrl, parts.join(' · '), ' ↗')));
  }
  return rows;
}

function closeDrawer() {
  drawerGame = null;
  drawerRoll = null;
  clearTimeout(rollTimer);
  $('#drawer').classList.add('hidden');
}

// ---------- description + screenshots ----------
function loadDetails(g) {
  if (!detailsCache.has(g.id)) {
    const { offers, ...lead } = g;
    const pending = api.getDetails(lead)
      .catch(() => ({ description: null, screenshots: [] }))
      .then((d) => {
        detailsCache.set(g.id, d);
        // Fill in the drawer if this game is still the one open.
        const slot = document.querySelector(`#drawer .details[data-id="${CSS.escape(g.id)}"]`);
        if (slot) slot.replaceWith(detailsSection(g));
      });
    detailsCache.set(g.id, pending);
  }
  return detailsCache.get(g.id);
}

function detailsSection(g) {
  const d = loadDetails(g);
  const slot = el('section', { class: 'details', 'data-id': g.id });
  if (d instanceof Promise) {
    slot.append(el('p', { class: 'muted loading' }, 'Loading description and screenshots…'));
    return slot;
  }
  if (d.description) {
    slot.append(el('p', { class: 'description' }, d.description));
    if (d.descriptionSource) {
      slot.append(el('button', { class: 'link small', onclick: () => api.openExternal(d.descriptionSource) }, 'From Wikipedia ↗'));
    }
  } else {
    slot.append(el('p', { class: 'muted' }, 'No description found for this game.'));
  }
  const shots = d.screenshots || [];
  if (shots.length) {
    const gallery = el('div', { class: `shots ${g.service === 'nso' ? 'retro' : ''}` });
    for (const src of shots) {
      const img = el('img', { src, loading: 'lazy', alt: 'Screenshot', onclick: () => openLightbox(src, g) });
      // Not every retro game has a title screen or snap; drop missing ones.
      img.addEventListener('error', () => {
        img.remove();
        if (!gallery.querySelector('img')) gallery.remove();
      }, { once: true });
      gallery.append(img);
    }
    slot.append(gallery);
  }
  return slot;
}

function openLightbox(src, g) {
  const box = el('div', { class: `lightbox ${g.service === 'nso' ? 'retro' : ''}`, onclick: () => box.remove() },
    el('img', { src, alt: '' }));
  document.body.append(box);
}

// ---------- roll a random game ----------

// Games you could start right now: the ones in your plans (everything if no
// plans are set), minus completed ones, narrowed by the service and platform
// filters.
function rollPool() {
  const keys = unlocked();
  const hasSubs = keys.size > 0;
  return games.filter((g) => {
    if (hasSubs && !isMine(g, keys)) return false;
    if (['completed', 'ignored'].includes(markOf(g.id)) || isComing(g)) return false;
    if (ui.services.size && !inServices(g, ui.services)) return false;
    if (!platformOk(g, keys)) return false;
    if (!fitsGenreAndLength(g)) return false;
    return true;
  });
}

function rollScope() {
  const parts = [];
  if (ui.services.size) parts.push([...ui.services].map((id) => serviceById(id)?.name || id).join(', '));
  if (ui.platform !== 'all') parts.push(platformName(ui.platform));
  if (ui.genre !== 'all') parts.push(ui.genre);
  if (ui.length !== 'all') parts.push(Genres.LENGTHS.find((l) => l.id === ui.length)?.label.toLowerCase());
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function rollBar() {
  const subs = unlocked().size > 0;
  return el('div', { class: 'roll-bar' },
    el('span', { class: 'muted' }, `Rolled from ${drawerRoll.pool} ${subs ? 'games in your subscriptions' : 'games'}${rollScope()}, completed and ignored ones left out`),
    el('button', { class: 'primary', onclick: roll }, '🎲 Roll again'));
}

function roll() {
  const pool = rollPool();
  clearTimeout(rollTimer);
  if (pool.length === 0) {
    drawerGame = null;
    $('#drawer').replaceChildren(
      el('div', { class: 'drawer-backdrop', onclick: closeDrawer }),
      el('div', { class: 'drawer-panel' },
        el('button', { class: 'close', onclick: closeDrawer, title: 'Close' }, '✕'),
        el('h2', {}, 'Nothing to roll'),
        el('p', { class: 'muted' }, 'No games match: everything in your subscriptions is completed, or the filters leave nothing.')));
    $('#drawer').classList.remove('hidden');
    return;
  }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  loadDetails(pick); // start fetching while the dice spin
  drawerGame = null;
  drawerRoll = null;
  const face = el('div', { class: 'roll-face' });
  const name = el('div', { class: 'roll-name' });
  $('#drawer').replaceChildren(
    el('div', { class: 'drawer-backdrop', onclick: closeDrawer }),
    el('div', { class: 'drawer-panel rolling' }, el('div', { class: 'roll-dice' }, '🎲'), face, name));
  $('#drawer').classList.remove('hidden');
  // Flick through random covers, slowing down, then land on the pick.
  let step = 0;
  const steps = 14;
  const flick = () => {
    const g = step >= steps ? pick : pool[Math.floor(Math.random() * pool.length)];
    // The title tile sits under the art, so a cover still loading isn't blank.
    face.replaceChildren(el('div', { class: 'cover-wrap' }, placeholder(g), g.image ? cover(g) : null));
    name.textContent = g.title;
    step += 1;
    clearTimeout(rollTimer);
    if (step > steps) {
      rollTimer = setTimeout(() => {
        drawerRoll = { pool: pool.length };
        openDrawer(pick);
      }, 450);
      return;
    }
    rollTimer = setTimeout(flick, 45 + step * step * 1.6);
  };
  flick();
}

function renderChrome() {
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === ui.view));
  $('#toolbar').classList.toggle('hidden', ['subs', 'stats', 'value', 'foryou', 'free'].includes(ui.view));

  const chips = $('#service-chips');
  chips.replaceChildren(...allServices().map((s) => el('button', {
    class: `chip ${ui.services.has(s.id) ? 'on' : ''}`,
    style: `--svc:${s.color}`,
    onclick: () => {
      if (ui.services.has(s.id)) ui.services.delete(s.id);
      else ui.services.add(s.id);
      ui.shown = PAGE_SIZE;
      render();
    },
  }, s.name)));

  const pf = $('#platform-filter');
  const current = ui.platform;
  pf.replaceChildren(el('option', { value: 'all' }, 'Any platform'), ...platformsList().map((p) => el('option', { value: p }, platformName(p))),
    el('option', { value: 'cloud' }, platformName('cloud')));
  pf.value = current;

  // Only genres some game actually has.
  const present = new Set(games.flatMap((g) => g.genreTags || []));
  const gf = $('#genre-filter');
  gf.replaceChildren(el('option', { value: 'all' }, 'Any genre'), ...Genres.GENRES.filter((n) => present.has(n)).map((n) => el('option', { value: n }, n)));
  gf.value = present.has(ui.genre) ? ui.genre : 'all';
  if (gf.value !== ui.genre) ui.genre = 'all';
  const lf = $('#length-filter');
  if (!lf.options.length) lf.replaceChildren(el('option', { value: 'all' }, 'Any length'), ...Genres.LENGTHS.map((l) => el('option', { value: l.id }, l.label)));
  lf.value = ui.length;

  const keys = unlocked();
  const leaving = games.filter((g) => leaveInfo(g) && (!ui.mineOnly || isMine(g, keys))).length;
  $('#leaving-count').textContent = leaving || '';
  $('#coming-count').textContent = games.filter((g) => isComing(g) && (!ui.mineOnly || isMine(g, keys))).length || '';
  // Games on your To play list you can start now.
  $('#toplay-count').textContent = games.filter((g) => markOf(g.id) === 'wishlist' && !isComing(g) && isMine(g, keys)).length || '';
  $('#free-count').textContent = openFree().length || '';

  const sync = catalogs.map((c) => {
    const s = serviceById(c.service);
    // Services added later have no bundled list until their first refresh.
    if (!c.games.length) return el('div', {}, `${s.short}: `, el('span', { class: 'muted' }, 'not loaded yet'));
    const when = c.fetchedAt ? new Date(c.fetchedAt).toLocaleDateString() : '—';
    return el('div', {}, `${s.short}: ${when}`, el('span', { class: 'muted' }, ` (${SHORT_SOURCE[c.source] || c.source})`));
  });
  $('#sync').replaceChildren(...sync);
}

// keepScroll: redraw in place (after marking a game, new results…) rather
// than starting the list from the top.
function render(keepScroll = false) {
  syncSaleWatch();
  const content = $('#content');
  const top = content.scrollTop;
  if (!keepScroll) ui.shown = PAGE_SIZE;
  renderChrome();
  ({ foryou: renderForYou, browse: renderBrowse, coming: renderComing, leaving: renderLeaving, changes: renderChanges, mine: renderMine, toplay: renderToPlay, free: renderFree, calendar: renderCalendar, stats: renderStats, value: renderValue, subs: renderSubs })[ui.view]();
  if (keepScroll) content.scrollTop = top;
  if (drawerGame) openDrawer(drawerGame);
  // Lists arriving during onboarding fill in its counts and picks.
  if (onboarding) renderOnboarding();
}

// A click on an alert opens the page it's about.
api.onShowView((view) => {
  ui.view = view;
  $('#content').scrollTop = 0;
  render();
});

// Prices arrive one game at a time.
let priceTimer = null;
api.onPrices(({ updates, progress }) => {
  Object.assign(prices, updates);
  priceProgress = progress.done < progress.total ? progress : null;
  if (!['value', 'toplay'].includes(ui.view) || priceTimer) return;
  priceTimer = setTimeout(() => { priceTimer = null; if (['value', 'toplay'].includes(ui.view)) render(true); }, 800);
});

// The daily refresh reads the Steam library again.
api.onStateChanged((s) => {
  state = s;
  rebuildGames();
  render(true);
});

// Apple Arcade icons arrive in the background a few at a time.
api.onCatalogChanged(async () => {
  catalogs = await api.getCatalog();
  rebuildGames();
  render(true);
});

// ---------- Metacritic / How Long To Beat ----------
let reorderTimer = null;

function showRatingProgress(p) {
  const status = $('#ratings-status');
  if (!p || p.finished) {
    // A site that stopped answering is asked again on the next run.
    const names = (p?.stopped || []).map((x) => x.replace(/ \(.*\)$/, ''));
    status.textContent = names.length ? `${names.join(' and ')} stopped answering, will try again later` : '';
    status.title = (p?.stopped || []).join('\n');
    return;
  }
  status.textContent = `Fetching scores and times: ${p.done} of ${p.total}`;
}

api.onRatings(({ updates, progress }) => {
  Object.assign(ratings, updates);
  showRatingProgress(progress);
  // Patch cards in place so browsing isn't interrupted.
  for (const id of Object.keys(updates)) {
    for (const node of document.querySelectorAll(`.card[data-id="${CSS.escape(id)}"] .stats`)) {
      const g = games.find((x) => x.id === id);
      if (g) node.replaceChildren(...stats(g).filter(Boolean));
    }
  }
  if (drawerGame && updates[drawerGame.id]) openDrawer(drawerGame);
  // Lists sorted by score or length reorder now and then as results arrive.
  if (['score', 'short', 'long'].includes(ui.sort) && !reorderTimer) {
    reorderTimer = setTimeout(() => { reorderTimer = null; render(true); }, 5000);
  }
});

// ---------- refresh ----------
async function refresh() {
  const btn = $('#refresh-btn');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    const { results, catalog } = await api.refresh();
    catalogs = catalog;
    rebuildGames();
    ratings = (await api.getRatings()).ratings;
    const failed = results.filter((r) => !r.ok);
    btn.textContent = failed.length ? 'Some lists failed, retry' : 'Refresh catalogues';
    if (failed.length) btn.title = failed.map((r) => `${r.service}: ${r.errors.join('; ')}`).join('\n');
    render(true);
  } catch (err) {
    btn.textContent = 'Refresh failed, retry';
    btn.title = String(err);
  } finally {
    btn.disabled = false;
  }
}

api.onRefreshProgress(({ service, state: s }) => {
  if (s === 'running') $('#refresh-btn').textContent = `Refreshing ${serviceById(service)?.name || service}…`;
});

// ---------- wiring ----------
function wire() {
  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    ui.view = b.dataset.view;
    $('#content').scrollTop = 0;
    render();
  });
  let t;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { ui.search = e.target.value; render(); }, 120);
  });
  $('#status-filter').addEventListener('change', (e) => { ui.status = e.target.value; render(); });
  $('#platform-filter').addEventListener('change', (e) => { ui.platform = e.target.value; render(); });
  $('#genre-filter').addEventListener('change', (e) => { ui.genre = e.target.value; render(); });
  $('#length-filter').addEventListener('change', (e) => { ui.length = e.target.value; render(); });
  $('#sort').addEventListener('change', (e) => { ui.sort = e.target.value; render(); });
  $('#mine-only').addEventListener('change', (e) => { ui.mineOnly = e.target.checked; render(); });
  for (const [id, setting] of [['#hide-departed', 'hideDeparted'], ['#hide-completed', 'hideCompleted'], ['#hide-ignored', 'hideIgnored']]) {
    $(id).addEventListener('change', async (e) => {
      await saveState({ settings: { ...state.settings, [setting]: e.target.checked } });
      render(true);
    });
  }
  $('#refresh-btn').addEventListener('click', refresh);
  $('#roll-btn').addEventListener('click', roll);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const box = document.querySelector('.lightbox');
    if (box) box.remove();
    else closeDrawer();
  });
}

async function init() {
  ({ services, tierBadges, regions } = await api.getServices());
  state = await api.getState();
  catalogs = await api.getCatalog();
  rebuildGames();
  prices = await api.getPrices();
  const r = await api.getRatings();
  ratings = r.ratings;
  showRatingProgress(r.progress);
  const hasSubs = Object.values(state.subscriptions).some(Boolean);
  ui.mineOnly = hasSubs;
  $('#mine-only').checked = hasSubs;
  $('#hide-departed').checked = hideDeparted();
  $('#hide-completed').checked = !!state.settings.hideCompleted;
  $('#hide-ignored').checked = state.settings.hideIgnored !== false;
  if (!hasSubs) ui.view = 'subs';
  wire();
  render();
  loadFree().catch(() => {});

  // First launch: the setup picks the country before any list is fetched.
  if (!hasSubs && !state.settings.onboarded) {
    startOnboarding();
    return;
  }
  const hours = Number(state.settings.autoRefreshHours) || 24;
  const last = state.lastRefresh ? new Date(state.lastRefresh) : null;
  if (!last || Date.now() - last > hours * 3600000) refresh();
}

init();
