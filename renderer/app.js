/* global api, I18n */
const { t, tn, tEl, tk } = I18n;
const $ = (sel) => document.querySelector(sel);
const PAGE_SIZE = 120;
// Same as PLAYED_MINUTES in src/steam.js.
const STEAM_PLAYED_MINUTES = 30;
const SOURCE_LABEL = { live: tk('official source'), mirror: tk('community mirror'), bundled: tk('bundled list') };
const SHORT_SOURCE = { live: tk('official'), mirror: tk('mirror'), bundled: tk('bundled') };

const ui = {
  view: 'browse',
  search: '',
  services: new Set(), // empty = all
  status: 'all',
  platform: 'all',
  statsPlatform: 'all', // the Statistics page's own platform pick
  statsPick: null, // a chart slice or genre whose games are listed: { chart, key }
  genre: 'all',
  length: 'all',
  sort: 'title',
  leavingOrder: 'date', // the Leaving soon page: 'date' or 'start' (what to start first)
  openPossible: false, // Leaving soon: the less likely predictions unfolded
  mineOnly: false,
  settingsTab: 'plans',
  openIntros: new Set(), // long explanations you've opened with ⓘ
  shown: PAGE_SIZE,
};

// Long explanations show their first sentence; ⓘ opens the rest in place.
function splitIntro(text) {
  const m = /^(.+?(?:[.!?](?=\s)|。))\s*(\S.*)$/s.exec(String(text).trim());
  return m ? [m[1], m[2]] : [String(text).trim(), ''];
}
function introNodes(text, onToggle) {
  const [first, rest] = splitIntro(text);
  if (!rest) return [first];
  const open = ui.openIntros.has(first);
  return [first, ' ', el('button', {
    class: `link intro-more ${open ? 'on' : ''}`,
    title: open ? t('Show less') : rest,
    'aria-expanded': String(open),
    onclick: (e) => {
      e.stopPropagation();
      if (open) ui.openIntros.delete(first); else ui.openIntros.add(first);
      onToggle();
    },
  }, 'ⓘ'), ...(open ? [el('span', { class: 'intro-rest' }, ` ${rest}`)] : [])];
}
function intro(text, cls = 'muted') {
  const p = el('p', { class: `${cls} intro` });
  const fill = () => p.replaceChildren(...introNodes(text, fill));
  fill();
  return p;
}
// The line under the toolbar, shortened the same way when it runs long.
function compactSummary() {
  const box = $('#summary');
  const text = box.textContent;
  if (text.length < 110) return;
  const fill = () => box.replaceChildren(...introNodes(text, fill));
  fill();
}

let services = [];
let tierBadges = {};
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
const fmtDate = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString(I18n.locale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '');
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
// "eaplay:eaplay@pc": a plan that includes only a tier's PC games (PC Game Pass and EA Play).
const offerIsMine = (o, keys) => (o.tiers || []).some((t) => keys.has(`${o.service}:${t}`) || (o.platforms || []).some((p) => keys.has(`${o.service}:${t}@${p}`)));
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
  // Antstream has one plan; its games differ by the system they're from.
  if (g.service === 'antstream' && g.system) return g.system;
  const plans = plansFor(g);
  if (!s || plans.length === 0) return '';
  if (plans.length === s.tiers.length) return t('All plans');
  return plans.length === 1 ? plans[0].name : t('{plan} and up', { plan: plans[0].name });
}

// Announced for a future date, not playable yet.
const isComing = (g) => !!g.comingOn && g.comingOn > todayIso();

function leaveInfo(g) {
  // A date the user typed in once, or one the service's list gives.
  const date = state.leaveDates[g.id] || serviceOffers(g).map((o) => o.leavesOn).filter(Boolean).sort()[0] || g.leavesOn;
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
  const before = state.marks;
  const marks = { ...state.marks };
  // A finish date stays with the game when its mark moves to another entry.
  const kept = value === 'completed' ? markIds(id).map((x) => before[x] === 'completed' && state.finishedOn?.[x]).find(Boolean) : null;
  for (const x of markIds(id)) delete marks[x];
  if (value) marks[id] = value;
  const finishedOn = Goals.stampFinished(state.finishedOn || {}, before, marks, todayIso());
  if (kept) finishedOn[id] = kept;
  // A game you mark yourself starts out not counted on the Value page (tick
  // it there if a subscription paid for it). Imports keep the old guess.
  const patch = { marks, finishedOn };
  if (['completed', 'played', 'playing', 'dropped'].includes(value) && viaSubSet(id) === undefined) patch.viaSub = { ...(state.viaSub || {}), [id]: false };
  await saveState(patch);
}

// Your own "played through a subscription" answer for a game, if you gave one.
function viaSubSet(id) {
  for (const x of markIds(id)) if (typeof state.viaSub?.[x] === 'boolean') return state.viaSub[x];
  return undefined;
}

// The day a completed game was marked completed (or the day you gave it).
function finishedOf(id) {
  if (markOf(id) !== 'completed') return null;
  for (const x of markIds(id)) if (state.finishedOn?.[x]) return state.finishedOn[x];
  return null;
}
async function setFinished(id, day) {
  const finishedOn = { ...(state.finishedOn || {}) };
  const own = markIds(id).find((x) => state.marks[x] === 'completed') || id;
  for (const x of markIds(id)) delete finishedOn[x];
  if (day) finishedOn[own] = day;
  await saveState({ finishedOn });
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
  if (!(next.hours > 0)) delete next.hours;
  if (next.stars || next.text || next.hours) notes[id] = next;
  await saveState({ notes });
}

async function saveState(patch) {
  state = await api.updateState(patch);
  if (patch.settings) applyTheme();
}

// Light or dark styles (data-theme on the page). "Same as the system"
// follows the system's setting, also when it changes while Subscroll runs.
const systemLight = window.matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const pref = state?.settings?.theme || 'dark';
  const light = pref === 'light' || (pref === 'system' && systemLight.matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
}
systemLight.addEventListener('change', applyTheme);

// ---------- data ----------
// Switch Online lists some games (or regional versions) only in Japan or
// only outside it. Lists saved before regions were tracked are western.
function inMyRegion(g) {
  if (g.service !== 'nso') return true;
  const mine = state.settings.nintendo || 'west';
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
      // joined: when it joined the service, if known (for predicting when it leaves).
      if (inMyRegion(g)) out.push({ ...g, firstSeen: c.history?.firstSeen?.[g.id] || g.addedOn || recentRelease(g), joined: g.addedOn || c.history?.firstSeen?.[g.id] || null });
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
  setTimeout(recordPredictions, 0);
}

function platformsList() {
  const set = new Set();
  games.forEach((g) => g.platforms.forEach((p) => set.add(p)));
  return [...set].sort((a, b) => a.localeCompare(b, I18n.locale()));
}

const PLATFORM_LABEL = { console: tk('Xbox console'), pc: tk('PC'), cloud: tk('Cloud streaming') };

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
    return [el('dt', {}, t('Cloud')), el('dd', {}, yours ? t('Stream with {plans}, which you have', { plans: cloudPlans(g) }) : t('Stream with {plans}', { plans: cloudPlans(g) }))];
  }
  if (offersOf(g).some((o) => o.cloud?.own)) return [el('dt', {}, t('Cloud')), el('dd', {}, t('Streams with Xbox Cloud Gaming if you own it'))];
  return null;
}

// "Game Pass Premium and up, PS Plus Premium"
function cloudPlans(g) {
  const ck = cloudKeys(g);
  const out = [];
  const gp = CLOUD_TIER_ORDER.find((t) => ck.has(`gamepass:${t}`));
  if (gp) out.push(gp === 'ultimate' ? planName('gamepass', gp) : t('{plan} and up', { plan: planName('gamepass', gp) }));
  if (ck.has('psplus:premium')) out.push(planName('psplus', 'premium'));
  return out.join(', ');
}
const platformName = (p) => (PLATFORM_LABEL[p] ? t(PLATFORM_LABEL[p]) : p);

// GeForce NOW streams copies you own on PC stores: the stores a game streams from.
// An empty list means free to play, with no store needed.
const onGfn = (g) => offersOf(g).some((o) => o.gfn);
function gfnStores(g) {
  return [...new Set(offersOf(g).flatMap((o) => o.gfn || []))];
}
// The stores you can stream it from with what you have: your Steam library,
// or a plan that has its PC version (PC Game Pass, EA Play, Ubisoft+).
function gfnYours(g, keys) {
  const stores = gfnStores(g);
  const mineOn = (service) => offersOf(g).some((o) => o.service === service && offerIsMine(o, keys) && (o.platforms || []).includes('pc'));
  return stores.filter((s) => (s === 'Steam' && g.steam) || (s === 'Xbox' && mineOn('gamepass')) || (s === 'EA app' && mineOn('eaplay')) || (s === 'Ubisoft Connect' && mineOn('ubisoftplus')));
}
const gfnStoreName = (s) => (s === 'Xbox' ? t('Xbox app (PC Game Pass)') : s);

function gfnRow(g) {
  if (!onGfn(g)) return null;
  const stores = gfnStores(g);
  const yours = gfnYours(g, unlocked());
  return [el('dt', {}, 'GeForce NOW'), el('dd', {},
    stores.length ? t('Streams your copy from {stores}', { stores: stores.map(gfnStoreName).join(', ') }) : t('Free to play, no store copy needed'),
    yours.length ? el('div', { class: 'muted' }, t('You have it on {store}', { store: yours.map(gfnStoreName).join(', ') })) : null)];
}

const hideDeparted = () => !!state.settings.hideDeparted;
// "My games" is where completed games are collected, so they stay there.
const hideCompleted = () => !!state.settings.hideCompleted && ui.view !== 'mine';
// Picking "Ignored" in the status filter shows them anyway, to un-ignore.
const hideIgnored = () => state.settings.hideIgnored !== false && ui.view !== 'mine' && ui.status !== 'ignored';
// Same for dropped games: they stay on My games and under the "Dropped" filter.
const hideDropped = () => !!state.settings.hideDropped && ui.view !== 'mine' && ui.status !== 'dropped';

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
    if (hideDropped() && markOf(g.id) === 'dropped') return false;
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
// The How Long To Beat time you picked in Settings (main story unless you
// changed it). A game without that time uses the next longer one, then a
// shorter one.
const HLTB_ORDER = { main: ['main', 'plus', 'all'], plus: ['plus', 'all', 'main'], all: ['all', 'plus', 'main'] };
const HLTB_LABEL = { main: tk('How Long To Beat main story'), plus: tk('How Long To Beat main + extras'), all: tk('How Long To Beat 100%') };
const hltbKind = () => (HLTB_ORDER[state.settings.hltbTime] ? state.settings.hltbTime : 'main');
const hltbLabel = () => t(HLTB_LABEL[hltbKind()]);
function beatHours(g) {
  const h = ratings[g.id]?.hltb;
  if (!h) return null;
  for (const k of HLTB_ORDER[hltbKind()]) if (h[k] != null) return h[k];
  return null;
}
// Hours you've played: your own entry first, then Steam's playtime (from an
// hour up, so a game finished elsewhere and only opened on Steam doesn't count).
const STEAM_MIN_MINUTES = 60;
function playedHours(g) {
  const own = noteOf(g.id)?.hours;
  if (own > 0) return { hours: own, source: 'you' };
  if (g.steam?.minutes >= STEAM_MIN_MINUTES) return { hours: g.steam.minutes / 60, source: 'steam' };
  return null;
}
// Time a game took you: hours played when known, else How Long To Beat.
const timeTaken = (g) => playedHours(g)?.hours ?? beatHours(g);
const TIME_SOURCE = { you: tk('Your hours played'), steam: tk('Steam playtime') };
const timeSource = (g) => (playedHours(g) ? t(TIME_SOURCE[playedHours(g).source]) : hltbLabel());

// A dropped game counts on the Value page for the part of it you played:
// your hours over How Long To Beat's, or a quarter when either is missing.
const DROPPED_SHARE = 0.25;
function droppedShare(g) {
  const own = playedHours(g)?.hours;
  const beat = beatHours(g);
  return own > 0 && beat > 0 ? Math.min(1, own / beat) : DROPPED_SHARE;
}
// Hours for the Value page: a dropped game without your own hours counts
// its share of How Long To Beat's time.
function valueHours(g) {
  if (markOf(g.id) !== 'dropped') return timeTaken(g);
  const own = playedHours(g)?.hours;
  if (own > 0) return own;
  const beat = beatHours(g);
  return beat ? beat * DROPPED_SHARE : null;
}

// ---------- can I finish it in time? ----------
// How many hours a day you play, worked out again when your marks, Steam
// import or settings change (state is replaced on every save).
let paceMemo = { state: null, day: null, value: null };
function playPace() {
  const today = todayIso();
  if (paceMemo.state !== state || paceMemo.day !== today) {
    paceMemo = { state, day: today, value: Deadline.pace({ minutesDay: playMinutesSet(), steam: state.steam, finished: finishedList(), today }) };
  }
  return paceMemo.value;
}

// Minutes a day you said you play, or null to work it out. Older versions
// saved hours a week.
function playMinutesSet() {
  const s = state.settings;
  if (s.playMinutesDay > 0) return s.playMinutesDay;
  if (s.playHoursWeek > 0) return (s.playHoursWeek * 60) / 7;
  return null;
}

// How long you play a day, in hours or minutes. Empty: Subscroll works it
// out from your Steam playtime and the games you complete.
function playTimeControl(onSaved = () => render(true)) {
  const unit = el('select', { 'aria-label': t('Unit') },
    el('option', { value: 'h' }, t('hours a day')),
    el('option', { value: 'm' }, t('minutes a day')));
  const set = playMinutesSet();
  unit.value = state.settings.playTimeUnit || (set && set < 60 ? 'm' : 'h');
  const box = el('input', { type: 'number', min: '0', step: 'any', class: 'play-time', placeholder: t('Work it out'), 'aria-label': t('Time you play a day') });
  const show = () => {
    const m = playMinutesSet();
    box.value = m ? String(unit.value === 'h' ? Math.round(m / 6) / 10 : Math.round(m)) : '';
  };
  show();
  box.addEventListener('change', async () => {
    const n = Number(box.value);
    const minutes = n > 0 ? Math.round(unit.value === 'h' ? n * 60 : n) : null;
    await saveState({ settings: { ...state.settings, playMinutesDay: minutes, playHoursWeek: null, playTimeUnit: unit.value } });
    onSaved();
  });
  // A new unit shows the same time in it.
  unit.addEventListener('change', async () => {
    await saveState({ settings: { ...state.settings, playTimeUnit: unit.value } });
    show();
  });
  return el('span', { class: 'play-time-control' }, box, unit);
}

// The verdict for a game leaving soon that you haven't completed or ignored.
function finishVerdict(g) {
  const leave = leaveInfo(g);
  const mark = markOf(g.id);
  if (!leave || !leave.soon || leave.past || isComing(g) || ['completed', 'ignored', 'dropped'].includes(mark)) return null;
  const played = noteOf(g.id)?.hours || (g.steam?.minutes || 0) / 60;
  return Deadline.verdict({ beat: beatHours(g), played, leave, today: todayIso(), perDay: playPace().perDay });
}

// Hours a day with one decimal ("1.3h"), or minutes under an hour ("40m").
function fmtPerDay(h) {
  if (h < 1) return t('{n}m', { n: Math.max(5, Math.round((h * 60) / 5) * 5) });
  return t('{n}h', { n: new Intl.NumberFormat(I18n.locale(), { maximumFractionDigits: 1 }).format(Math.round(h * 10) / 10) });
}

const VERDICT_LABEL = { ok: tk('Fits your pace'), tight: tk('Tight at your pace'), unlikely: tk('More than you usually play') };

// "12h to beat, 9 days left: about 1.3h a day".
function verdictText(v) {
  const hours = v.played > 0 ? t('{hours} left to beat', { hours: fmtHours(v.hours) }) : t('{hours} to beat', { hours: fmtHours(v.hours) });
  const days = v.days === 0 ? t('last day') : v.estimated ? tn(v.days, '{n} day left (estimated)', '{n} days left (estimated)') : tn(v.days, '{n} day left', '{n} days left');
  return t('{hours}, {days}: about {perDay} a day', { hours, days, perDay: fmtPerDay(v.perDay) });
}

function paceSource(p) {
  if (p.source === 'setting') return t('as you set it');
  if (p.source === 'steam') return t('from your Steam playtime over the last two weeks');
  if (p.source === 'finished') return tn(p.games, 'from the {n} game you completed in the last three months', 'from the {n} games you completed in the last three months');
  if (p.why === 'steam-pending') return t('a guess until Subscroll reads your recent Steam playtime, which it does when it next starts or refreshes');
  if (p.why === 'steam-idle') return t('a guess, as Steam shows no play in the last two weeks and you haven\'t completed games lately');
  return t('a guess until you complete some games or import your Steam library');
}

function verdictLine(g) {
  const v = finishVerdict(g);
  if (!v) return null;
  return el('div', { class: `deadline ${v.status}`, title: `${verdictText(v)}\n${t(VERDICT_LABEL[v.status])}` },
    t('{perDay} a day to finish', { perDay: fmtPerDay(v.perDay) }));
}

// Departed games keep their original fields, so work out genres here too.
function fitsGenreAndLength(g) {
  if (ui.genre !== 'all' && !(g.genreTags || Genres.genresOf(g)).includes(ui.genre)) return false;
  return Genres.fitsLength(beatHours(g), ui.length);
}

function fmtHours(h) {
  if (h == null) return '';
  if (h < 1) return t('{n}m', { n: Math.max(1, Math.round(h * 60)) });
  return h < 10 ? t('{n}h', { n: Math.round(h * 2) / 2 }) : t('{n}h', { n: Math.round(h) });
}

function sorted(list) {
  const byTitle = (a, b) => a.title.localeCompare(b.title, I18n.locale(), { sensitivity: 'base' });
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
  const whole = ['nso', 'netflix', 'applearcade', 'crunchyroll', 'playpass', 'antstream'].includes(g.service);
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
    score != null ? el('span', { class: `score ${scoreClass(score)}`, title: t('Metacritic score') }, score) : null,
    h != null ? el('span', { class: 'hltb', title: hltbLabel() }, `⏱ ${fmtHours(h)}`) : null,
  ];
}

function markButtons(g, wide = false) {
  const mark = markOf(g.id);
  const set = (value) => async (e) => {
    e.stopPropagation();
    await setMark(g.id, mark === value ? null : value);
    render(true);
  };
  const button = (value, cls, title, label) => el('button', { class: `mark ${mark === value ? `on ${cls}` : ''}`, title, onclick: set(value) }, label);
  const playing = button('playing', '', t('Mark as now playing'), `▶ ${t('Now playing')}`);
  const played = button('played', 'played', t('Mark as played'), `✓ ${t('Played')}`);
  const completed = button('completed', 'done', t('Mark as completed'), `★ ${t('Completed')}`);
  const dropped = button('dropped', 'dropped', t('Mark as dropped: started, but you stopped'), `✕ ${t('Dropped')}`);
  // Cards have room for two: the first shows how far you got, and clicking
  // it when it's on clears the mark.
  if (!wide) return el('div', { class: 'marks' }, mark === 'played' ? played : mark === 'dropped' ? dropped : playing, completed);
  return el('div', { class: 'marks' }, playing, played, completed, dropped, toPlayButton(g, 'mark toplay'), ignoreButton(g, 'mark ignore'));
}

// Games you want to play, available now or coming. Playing one replaces it.
function toPlayButton(g, cls) {
  const on = markOf(g.id) === 'wishlist';
  return el('button', {
    class: `${cls} ${on ? 'on' : ''}`,
    title: on ? t('On your To play list: click to remove') : t('Add to your To play list'),
    onclick: async (e) => {
      e.stopPropagation();
      await setMark(g.id, on ? null : 'wishlist');
      render(true);
    },
  }, cls.startsWith('mark') ? (on ? `✓ ${t('To play')}` : `＋ ${t('To play')}`) : (on ? '✓' : '＋'));
}

// Cards keep it on the cover (shown on hover) to leave room for the others.
function ignoreButton(g, cls) {
  const ignored = markOf(g.id) === 'ignored';
  return el('button', {
    class: `${cls} ${ignored ? 'on ignored' : ''}`,
    title: ignored ? t('Ignored: click to stop ignoring') : t('Ignore: not interested, hide it'),
    onclick: async (e) => {
      e.stopPropagation();
      await setMark(g.id, ignored ? null : 'ignored');
      render(true);
    },
  }, cls.startsWith('mark') ? (ignored ? `⊘ ${t('Ignored')}` : `⊘ ${t('Ignore')}`) : '⊘');
}

function steamText(s) {
  return s.minutes ? t('You own this on Steam, {time} played', { time: fmtHours(s.minutes / 60) }) : t('You own this on Steam, not played yet');
}

// Your mark on a game, shown on its cover so the buttons can wait for a hover.
const STATUS_BADGE = { playing: ['▶', tk('Now playing')], played: ['✓', tk('Played')], completed: ['★', tk('Completed')], dropped: ['✕', tk('Dropped')], ignored: ['⊘', tk('Ignored')] };

// Grid or list, for the pages that list games (Settings › list view).
const listView = () => !!state.settings.listView;

function card(g, keys, { list = false } = {}) {
  const leave = leaveInfo(g);
  const mine = isMine(g, keys);
  const badges = [];
  const status = STATUS_BADGE[markOf(g.id)];
  if (status) badges.push(el('span', { class: `badge status ${markOf(g.id)}` }, `${status[0]} ${t(status[1])}`));
  if (leave) {
    const text = leave.date ? (leave.past ? t('Left {date}', { date: fmtDate(leave.date) }) : t('Leaves {date}', { date: fmtDate(leave.date) }))
      : leave.from?.length ? t('Leaving {service} soon', { service: leave.from.join(', ') }) : t('Leaving soon');
    badges.push(el('span', { class: `badge ${leave.soon ? 'warn' : ''}` }, text));
  }
  if (isComing(g)) badges.push(el('span', { class: 'badge coming' }, t('Coming {date}', { date: fmtDate(g.comingOn) })));
  else if (g.firstSeen && daysUntil(g.firstSeen) >= -30) badges.push(el('span', { class: 'badge new' }, t('New')));
  if (g.leftOn || g.departed) badges.push(el('span', { class: 'badge gone' }, g.leftOn ? t('Left {date}', { date: fmtDate(g.leftOn) }) : t('Left the service')));
  // Regional versions sharing this card.
  if (g.versions?.length > 1) badges.push(el('span', { class: 'badge region', title: t('Regional versions included') }, g.versions.join(' + ')));
  if (markOf(g.id) === 'wishlist') badges.push(el('span', { class: 'badge toplay' }, t('To play')));
  if (g.steam) badges.push(el('span', { class: 'badge steam', title: steamText(g.steam) }, t('On Steam')));
  const sale = saleOf(g);
  if (sale) {
    const sp = { store: sale.source, price: money(sale.amount), date: sale.saleEnds ? fmtDate(sale.saleEnds.slice(0, 10)) : '' };
    const saleTitle = sale.source
      ? (sale.saleEnds ? t('On sale on {store}: usually {price}, until {date}', sp) : t('On sale on {store}: usually {price}', sp))
      : (sale.saleEnds ? t('On sale on its store: usually {price}, until {date}', sp) : t('On sale on its store: usually {price}', sp));
    badges.push(el('span', { class: 'badge sale', title: saleTitle }, t('{percent}% off · {price}', { percent: sale.off, price: money(sale.sale) })));
  }
  const note = noteOf(g.id);
  if (note && (note.stars || note.text)) badges.push(el('span', { class: 'badge stars', title: note.text ? t('Your note: {note}', { note: note.text }) : t('Your rating') }, note.stars ? '★'.repeat(note.stars) : '', note.text ? (note.stars ? ' ✎' : `✎ ${t('Note')}`) : ''));
  if (cloudKeys(g).size) {
    const yours = canStream(g, keys);
    badges.push(el('span', { class: `badge cloud ${yours ? 'yours' : ''}`, title: yours ? t('Stream it with {plans} (in your plans)', { plans: cloudPlans(g) }) : t('Stream it with {plans}', { plans: cloudPlans(g) }) }, `☁ ${t('Cloud')}`));
  }
  if (onGfn(g)) {
    const yours = gfnYours(g, keys);
    const stores = gfnStores(g).map(gfnStoreName).join(', ');
    const free = !stores;
    badges.push(el('span', { class: `badge gfn ${yours.length || free ? 'yours' : ''}`, title: free ? t('Free to play on GeForce NOW') : yours.length ? t('Stream it on GeForce NOW: you have it on {store}', { store: yours.map(gfnStoreName).join(', ') }) : t('Streams on GeForce NOW if you own it on {stores}', { stores }) }, 'GeForce NOW'));
  }
  const open = () => { drawerRoll = null; openDrawer(g); };
  const tools = () => el('div', { class: 'cover-tools' }, toPlayButton(g, 'cover-btn cover-toplay'), ignoreButton(g, 'cover-btn cover-ignore'));
  // A list row: a small cover, then everything on one line, buttons at the end.
  if (list) {
    return el('article', { class: `card row ${mine ? 'mine' : ''} mark-${markOf(g.id)}`, 'data-id': g.id, onclick: open },
      el('div', { class: 'cover-wrap' }, cover(g)),
      el('div', { class: 'body' },
        el('div', { class: 'title', title: g.title }, g.title),
        serviceMeta(g, keys),
        el('div', { class: 'stats' }, stats(g)),
        el('div', { class: 'row-badges' }, badges, verdictLine(g)),
        el('div', { class: 'row-actions' }, markButtons(g), tools())));
  }
  return el('article', { class: `card ${mine ? 'mine' : ''} mark-${markOf(g.id)}`, 'data-id': g.id, onclick: open },
    el('div', { class: 'cover-wrap' }, cover(g), el('div', { class: 'badges' }, badges),
      el('div', { class: 'cover-actions' }, tools(), markButtons(g))),
    el('div', { class: 'body' },
      el('div', { class: 'title', title: g.title }, g.title),
      serviceMeta(g, keys),
      el('div', { class: 'stats' }, stats(g)),
      verdictLine(g)));
}

// The pages that list games, as a grid of covers or a compact list.
function gameGrid(list, keys) {
  const rows = listView();
  return el('div', { class: `grid ${rows ? 'list' : ''}` }, list.map((g) => card(g, keys, { list: rows })));
}

function renderGrid(list, emptyText) {
  const content = $('#content');
  content.replaceChildren();
  if (list.length === 0) {
    content.append(el('div', { class: 'empty' }, emptyText));
    return;
  }
  const keys = unlocked();
  const grid = gameGrid(list.slice(0, ui.shown), keys);
  content.append(grid);
  if (list.length > ui.shown) {
    const more = el('div', { class: 'more' }, t('Showing {shown} of {total}', { shown: ui.shown, total: list.length }));
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
  const count = tn(list.length, '{n} game', '{n} games');
  const base = subs ? `${count} · ${tn(mine, '{n} included in your subscriptions', '{n} included in your subscriptions')}` : `${count} · ${t('set your subscriptions to see what you can play')}`;
  return ui.length !== 'all' ? `${base} · ${t('only games with a How Long To Beat time')}` : base;
}

function renderBrowse() {
  const list = sorted(filtered(games));
  $('#summary').textContent = summaryText(list);
  renderGrid(list, t('No games match these filters.'));
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
    stars: (g) => starsOf(g.id),
  }, { tastes: tastes(), today: todayIso(), limit, perService });
}

async function setTastes(patch) {
  await saveState({ settings: { ...state.settings, tastes: { ...tastes(), ...patch } } });
  render(true);
}

// Genre chips and a length choice, shared by onboarding and For you.
function tastePicker() {
  const mine = tastes();
  const present = new Set(games.flatMap((g) => g.genreTags || []));
  const genres = Genres.GENRES.filter((n) => present.has(n) || mine.genres.includes(n));
  const toggle = (n) => setTastes({ genres: mine.genres.includes(n) ? mine.genres.filter((x) => x !== n) : [...mine.genres, n] });
  const lengths = [['any', t('Any length')], ['short', t('Short (under 10 hours)')], ['long', t('Long (25 hours or more)')]];
  return el('div', { class: 'tastes' },
    el('div', { class: 'chips' }, genres.map((n) => el('button', { class: `chip taste ${mine.genres.includes(n) ? 'on' : ''}`, onclick: () => toggle(n) }, t(n)))),
    el('div', { class: 'seg', style: '--svc:#6aa8ff' }, lengths.map(([id, label]) => el('button', { class: mine.length === id ? 'on' : '', onclick: () => setTastes({ length: id }) }, label))));
}

// Cards with a line saying why each was picked.
function recommendationGrid(picks) {
  const keys = unlocked();
  return el('div', { class: 'grid' }, picks.map(({ game, reasons }) => {
    const c = card(game, keys);
    // Leaving soon and new already show as badges on the cover.
    const why = el('div', { class: 'reasons' }, reasons.filter((r) => !['leaving', 'new'].includes(r.id)).slice(0, 3).map((r) => el('span', { class: `reason ${r.id}` }, r.label)));
    c.querySelector('.body').append(why);
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
    stars: (g) => starsOf(g.id),
  }, { seeds: statsGames(), groups: 4, perGroup: 6 });
}

function renderForYou() {
  const content = $('#content');
  content.replaceChildren();
  $('#summary').textContent = t('Picked from your plans: games in genres you like, well-reviewed, leaving soon or just added, then games like the ones you beat or rated highly. Your star ratings count: games like the ones you rated low drop. Scores and play times make these better as they load.');
  if (!Object.values(state.subscriptions).some(Boolean)) {
    content.append(el('div', { class: 'panel' }, el('h2', {}, t('What you like')), tastePicker()));
    content.append(el('div', { class: 'empty' }, t('Pick your plans in Settings and recommendations show up here.')));
    return;
  }
  // Games in a "Because you beat" row aren't repeated in the picks above it.
  const groups = likeCompleted();
  const shown = new Set(groups.flatMap((x) => x.picks.map((p) => p.game.id)));
  content.append(el('div', { class: 'section-head' }, el('h3', {}, t('Picked for you')), el('span', { class: 'muted' }, t('From the genres and length you like'))));
  content.append(el('div', { class: 'panel' }, tastePicker()));
  const picks = recommendations(24 + shown.size, 10).filter((p) => !shown.has(p.game.id)).slice(0, 24);
  content.append(picks.length ? recommendationGrid(picks) : el('div', { class: 'empty' }, t('Nothing matches these choices yet. Try another genre or length.')));
  for (const { seed, picks: like, reason } of groups) {
    const title = el('button', { class: 'link inline seed', onclick: () => openDrawer(seed) }, seed.title);
    content.append(el('div', { class: 'section-head' },
      el('h3', {}, reason === 'loved' ? tEl('Because you loved {title}', { title }) : tEl('Because you beat {title}', { title })),
      el('span', { class: 'muted' }, t('Same studio or similar genres'))));
    content.append(recommendationGrid(like));
  }
  if (!groups.length) {
    const beaten = statsGames().some((g) => markOf(g.id) === 'completed' || (starsOf(g.id) || 0) >= 4);
    content.append(el('div', { class: 'section-head' }, el('h3', {}, t('Because you beat…'))));
    content.append(el('div', { class: 'hint-row muted' }, beaten
      ? t('Nothing in your plans is much like the games you\'ve completed yet. Developers and genres fill in over the first few minutes as they\'re looked up.')
      : t('Mark games as ★ Completed or rate them 4 or 5 stars, and games like them show up here, by the same studio or with similar genres.')));
  }
}

// ---------- onboarding ----------
// First launch: country, services, tastes, then a first set of picks.
let onboarding = null; // { step }
const ONBOARD_STEPS = 4;

// The country from the system's language settings: "en-GB" says GB, and a
// bare "lt" most likely means Lithuania.
function guessRegion() {
  for (const tag of [...(navigator.languages || []), navigator.language].filter(Boolean)) {
    let id = null;
    try {
      id = new Intl.Locale(tag).maximize().region;
    } catch { /* not a language tag */ }
    if (id === 'UK') id = 'GB';
    if (Regions.isCountry(id)) return id;
  }
  return 'US';
}

// The country picker, and below it, when your country lacks the Xbox or
// PlayStation store, the country whose store to use for those instead.
function countryPicker(onChange) {
  const { region, fallbackRegion } = state.settings;
  const country = el('select', {}, Regions.names(Regions.COUNTRIES, I18n.locale()).map((c) => el('option', { value: c.id }, c.name)));
  country.value = region || 'US';
  const fallback = el('select', {}, Regions.names(Regions.FALLBACKS, I18n.locale()).map((c) => el('option', { value: c.id }, c.name)));
  const note = el('div', { class: 'fallback-row' });
  const shown = () => {
    const r = Regions.resolve(country.value, fallback.value);
    fallback.value = r.fallbackRegion;
    if (!r.missing.length) {
      note.replaceChildren();
      return;
    }
    const name = Regions.names([country.value], I18n.locale())[0].name;
    const text = r.missing.length === 2
      ? t('Xbox and PlayStation don\'t sell games in {country}. For Game Pass, PS Plus and store prices, use the store of:', { country: name })
      : r.missing[0] === 'xbox'
        ? t('Xbox doesn\'t sell games in {country}. For Game Pass and Xbox prices, use the store of:', { country: name })
        : t('PlayStation doesn\'t sell games in {country}. For PS Plus and PlayStation prices, use the store of:', { country: name });
    note.replaceChildren(el('span', { class: 'muted' }, text), fallback);
  };
  fallback.value = Regions.resolve(country.value, fallbackRegion).fallbackRegion;
  shown();
  const changed = () => {
    shown();
    onChange({ region: country.value, fallbackRegion: fallback.value });
  };
  country.addEventListener('change', () => {
    // A new country gets that country's usual fallback.
    fallback.value = Regions.defaultFallback(country.value);
    changed();
  });
  fallback.addEventListener('change', changed);
  return { country, note };
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
  showHideCount();
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
  const back = step > 0 ? el('button', { class: 'link', onclick: () => { onboarding.step -= 1; renderOnboarding(); } }, t('Back')) : el('span');
  const dots = el('div', { class: 'onboard-dots' }, Array.from({ length: ONBOARD_STEPS }, (_, i) => el('span', { class: i === step ? 'on' : '' })));
  let body;
  let next = el('button', { class: 'primary', onclick: onboardNext }, t('Next'));

  if (step === 0) {
    if (!state.settings.onboardRegionPicked && state.settings.region !== guessRegion()) {
      state.settings = { ...state.settings, region: guessRegion(), fallbackRegion: null };
    }
    let picked = { region: state.settings.region, fallbackRegion: state.settings.fallbackRegion };
    const picker = countryPicker((p) => { picked = p; });
    const pick = () => saveState({ settings: { ...state.settings, ...picked, onboardRegionPicked: true } });
    next = el('button', { class: 'primary', onclick: async () => { await pick(); rebuildGames(); onboardNext(); } }, t('Get started'));
    body = [
      el('img', { class: 'onboard-logo', src: 'logo.svg', alt: '' }),
      el('h1', {}, t('Welcome to Subscroll')),
      el('p', { class: 'lead' }, t('Every game you already pay for, in one place. Tell it which subscriptions you have and it shows what\'s in them, what\'s leaving, and what to play next.')),
      el('label', { class: 'onboard-field' }, el('span', {}, t('Where do you play?')), picker.country),
      picker.note,
      el('p', { class: 'muted' }, t('Game Pass and PS Plus catalogues differ a little by country.')),
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
          el('button', { class: current ? '' : 'on', onclick: () => pick('') }, t('No')),
          s.tiers.map((t) => el('button', { class: current === t.id ? 'on' : '', onclick: () => pick(t.id) }, t.name))));
    });
    const any = Object.values(state.subscriptions).some(Boolean);
    next = el('button', { class: 'primary', disabled: !any, onclick: onboardNext }, t('Next'));
    body = [
      el('h1', {}, t('Which services do you have?')),
      el('p', { class: 'lead' }, t('Pick your plan for each. Game Pass Ultimate already includes EA Play and Ubisoft+ Classics.')),
      el('div', { class: 'onboard-services' }, rows),
    ];
  } else if (step === 2) {
    body = [
      el('h1', {}, t('What do you like to play?')),
      el('p', { class: 'lead' }, t('Pick a few genres and how long you like games to be. You can change this any time on the For you page.')),
      tastePicker(),
      el('label', { class: 'onboard-field' }, el('span', {}, t('How long do you play a day?')), playTimeControl(() => {})),
      el('p', { class: 'muted' }, t('Optional. It tells you whether you can finish games before they leave. Leave it empty and Subscroll works it out from your Steam playtime and the games you complete. You can change it in Settings.')),
    ];
  } else {
    const picks = recommendations(8);
    next = el('button', { class: 'primary', onclick: finishOnboarding }, t('Start browsing'));
    body = [
      el('h1', {}, t('Picked for you')),
      el('p', { class: 'lead' }, t('From the plans you have. Click ＋ on a cover to save a game to your To play list. More picks, which get better as scores and play times load, are on the For you page.')),
      picks.length ? recommendationGrid(picks) : el('p', { class: 'muted' }, t('Loading your services\' games…')),
    ];
  }
  box.replaceChildren(el('div', { class: 'onboard-card' },
    el('div', { class: 'onboard-body' }, body),
    el('div', { class: 'onboard-foot' }, back, dots, el('div', { class: 'onboard-actions' },
      step > 0 && step < 3 ? el('button', { class: 'link', onclick: finishOnboarding }, t('Skip')) : null, next))));
}

// ---------- predictions ----------
// When a game could leave, from when it joined (renderer/predict.js). A game
// on several services (or editions) is predicted only when all of them
// could end, and then for the last of those dates. Your own services count
// when you have one; a service saying the game is leaving comes first.
const PREDICT_DAYS = 45;
// raw: as the rules say, before the scorecard demotes a rule that keeps missing.
function predictionOf(g, keys = unlocked(), { raw = false } = {}) {
  if (g.custom || leaveInfo(g) || isComing(g)) return null;
  const all = offersOf(g);
  const mine = all.filter((o) => offerIsMine(o, keys));
  const today = todayIso();
  let last = null;
  for (const o of mine.length ? mine : all) {
    const p = Predict.predict(o, { today, horizon: PREDICT_DAYS });
    if (!p) return null;
    if (!last || p.date > last.date) last = { ...p, service: o.service, likely: p.likely && (!last || last.likely) };
    else if (!p.likely) last = { ...last, likely: false };
  }
  if (last && !raw && last.likely && Scorecard.demoted(predictionStats(), last.service, last.kind)) return { ...last, likely: false, demoted: true };
  return last;
}

const PREDICT_KIND = {
  short: tk('Rockstar and 2K games usually stay 3 to 6 months.'),
  big: tk('Big publishers\' games often stay 24 months, renewed a year at a time.'),
  standard: tk('Most games sign for 12 months, renewed a year at a time.'),
};
const PREDICT_DAY = {
  psplus: tk('PS Plus removes games on the third Tuesday of the month.'),
  gamepass: tk('Game Pass removes games on the 15th or the last day of the month.'),
};

// "Joined Game Pass on 5 Nov 2025: 12 months on is 5 Nov. Most games…"
function predictionReason(p) {
  const service = serviceById(p.service)?.name || p.service;
  return [
    tn(p.months, 'Joined {service} on {joined}, {n} month earlier.', 'Joined {service} on {joined}, {n} months earlier.', { service, joined: fmtDate(p.joined) }),
    t(PREDICT_KIND[p.kind]),
    PREDICT_DAY[p.service] ? t(PREDICT_DAY[p.service]) : '',
    ruleRecord(p),
  ].filter(Boolean).join(' ');
}

// "So far this rule was right 4 of 6 times."
function ruleRecord(p) {
  const r = Scorecard.ruleStats(predictionStats(), p.service, p.kind, p.demoted ? true : p.likely);
  if (!r || !r.total) return '';
  const line = tn(r.total, 'So far this rule was right {right} of {n} time.', 'So far this rule was right {right} of {n} times.', { right: r.right });
  return p.demoted ? `${line} ${t('That\'s too few to call it likely.')}` : line;
}

function predictionLine(p) {
  return el('div', { class: `predicted ${p.likely ? 'likely' : 'possible'}`, title: predictionReason(p) },
    p.likely ? t('Likely to leave around {date}', { date: fmtDate(p.date) }) : t('Could leave around {date}', { date: fmtDate(p.date) }));
}

// Cards with their predicted date, and how much a day finishing would take.
function predictionGrid(list, keys) {
  const grid = gameGrid(list.map((x) => x.g), keys);
  const pace = playPace();
  [...grid.children].forEach((c, i) => {
    const { g, p } = list[i];
    const v = ['completed', 'ignored', 'dropped'].includes(markOf(g.id)) ? null
      : Deadline.verdict({ beat: beatHours(g), played: noteOf(g.id)?.hours || (g.steam?.minutes || 0) / 60, leave: { date: p.date }, today: todayIso(), perDay: pace.perDay });
    const line = predictionLine(p);
    const need = v ? el('div', { class: `deadline ${v.status}`, title: `${verdictText(v)}\n${t(VERDICT_LABEL[v.status])}` }, t('{perDay} a day to finish', { perDay: fmtPerDay(v.perDay) })) : null;
    (c.querySelector('.row-badges') || c.querySelector('.body')).append(line, need || '');
  });
  return grid;
}

// The Predictions part of Leaving soon: likely ones, then the rest folded away.
function predictionsSection() {
  const keys = unlocked();
  const found = filtered(games).map((g) => ({ g, p: predictionOf(g, keys) })).filter((x) => x.p);
  found.sort((a, b) => a.p.date.localeCompare(b.p.date) || a.g.title.localeCompare(b.g.title, I18n.locale()));
  const likely = found.filter((x) => x.p.likely);
  const possible = found.filter((x) => !x.p.likely);
  const more = el('details', { class: 'predict-more' },
    el('summary', {}, tn(possible.length, 'Less likely: {n} game at a later renewal', 'Less likely: {n} games at a later renewal')),
    possible.length ? predictionGrid(possible.slice(0, 120), keys) : '');
  more.open = !!ui.openPossible;
  more.addEventListener('toggle', () => { ui.openPossible = more.open; });
  return el('section', { class: 'predictions' },
    el('h2', {}, t('Predictions ({n})', { n: found.length })),
    intro(t('Games that could leave in the next {days} days (for PS Plus, up to the removal day after next), worked out from when they joined. Most games sign for 12 months, big publishers\' games often 24, Rockstar and 2K games 3 to 6, and the service\'s own studios\' games usually stay. PS Plus removes games on the third Tuesday of the month and Game Pass on the 15th or the last day. Only games with a known join date are here: Game Pass gives it; for PS Plus it comes from the PlayStation Blog\'s monthly lineup posts since 2022, and for other services from Subscroll\'s own refreshes. Sony doesn\'t publish which PS Plus games are leaving outside the console, so its predictions can include games that were renewed.', { days: PREDICT_DAYS })),
    likely.length ? predictionGrid(likely, keys) : el('div', { class: 'empty small' }, t('No games look likely to leave in the next {days} days.', { days: PREDICT_DAYS })),
    possible.length ? more : null,
    scorecardPanel());
}

// ---------- prediction scorecard ----------
// Every prediction is kept from the first day it's made (state.predictionLog)
// and checked once its day has passed (renderer/scorecard.js).
function recordPredictions() {
  if (!state || !games.length) return;
  const keys = unlocked();
  const found = [];
  for (const g of games) {
    const p = predictionOf(g, keys, { raw: true });
    if (!p) continue;
    const o = offersOf(g).find((x) => x.service === p.service);
    if (o) found.push({ ...p, id: o.id, title: g.title });
  }
  const before = state.predictionLog || {};
  const { log, added } = Scorecard.record(before, found, todayIso());
  if (added || Object.keys(log).length !== Object.keys(before).length) saveState({ predictionLog: log });
}

let judgedMemo = { state: null, catalogs: null, day: null, value: [] };
function judgedPredictions() {
  const today = todayIso();
  if (judgedMemo.state === state && judgedMemo.catalogs === catalogs && judgedMemo.day === today) return judgedMemo.value;
  const left = new Map();
  for (const d of departed) if (d.leftOn) left.set(d.id, d.leftOn);
  const present = new Set();
  const refreshed = {};
  for (const c of catalogs) {
    for (const g of c.games) present.add(g.id);
    if (c.source !== 'bundled' && c.fetchedAt) refreshed[c.service] = String(c.fetchedAt).slice(0, 10);
  }
  const value = Object.values(state.predictionLog || {}).map((e) => ({ ...e, outcome: Scorecard.judge(e, { leftOn: left.get(e.id) || null, present: present.has(e.id), refreshedOn: refreshed[e.service] || null, today }) }));
  judgedMemo = { state, catalogs, day: today, value };
  return value;
}
let statsMemo = { judged: null, value: null };
function predictionStats() {
  const judged = judgedPredictions();
  if (statsMemo.judged !== judged) statsMemo = { judged, value: Scorecard.stats(judged) };
  return statsMemo.value;
}

const RULE_LABEL = {
  short: tk('Rockstar and 2K, 3 to 6 months'),
  big: tk('Big publishers, 24 months'),
  standard: tk('Most games, 12 months'),
};
const OUTCOME_LABEL = { right: tk('Left around then'), 'other-day': tk('Left on another day'), stayed: tk('Stayed') };

function scorecardPanel() {
  const judged = judgedPredictions();
  const checked = judged.filter((j) => OUTCOME_LABEL[j.outcome]);
  const waiting = judged.filter((j) => j.outcome === 'pending').length;
  const s = predictionStats();
  const pct = (r) => `${Math.round((100 * r.right) / r.total)}%`;
  const body = [];
  if (!checked.length) {
    body.push(el('p', { class: 'muted' }, waiting
      ? tn(waiting, 'Subscroll keeps every prediction and checks it once its day has passed. {n} is waiting for its day.', 'Subscroll keeps every prediction and checks it once its day has passed. {n} are waiting for their day.')
      : t('Subscroll keeps every prediction and checks it once its day has passed.')));
  } else {
    const line = (label, r) => (r.total ? el('div', { class: 'score-line' }, el('strong', {}, label), ' ', tn(r.total, '{right} of {n} left around the predicted day ({pct})', '{right} of {n} left around the predicted day ({pct})', { right: r.right, pct: pct(r) })) : null);
    body.push(line(t('Likely:'), s.likely), line(t('Less likely:'), s.possible));
    const rules = Object.entries(s.rules).filter(([, r]) => r.total).sort((a, b) => b[1].total - a[1].total).map(([key, r]) => {
      const [service, kind, which] = key.split(':');
      const demoted = which === 'likely' && Scorecard.demoted(s, service, kind);
      return el('tr', {},
        el('td', {}, serviceById(service)?.name || service),
        el('td', {}, which === 'likely' ? t(RULE_LABEL[kind] || kind) : t('{rule}, later renewals', { rule: t(RULE_LABEL[kind] || kind) })),
        el('td', { class: 'num' }, `${r.right} / ${r.total}`),
        el('td', { class: 'muted' }, demoted ? t('Now shown as less likely') : ''));
    });
    body.push(el('table', { class: 'score-rules' }, rules));
    const recent = checked.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40);
    const list = el('details', { class: 'score-recent' }, el('summary', {}, tn(checked.length, 'The {n} checked prediction', 'The {n} checked predictions')),
      el('ul', {}, recent.map((j) => el('li', { class: `outcome ${j.outcome}` },
        el('span', { class: 'outcome-mark' }, j.outcome === 'right' ? '✓' : '✗'), ' ', j.title, ' ',
        el('span', { class: 'muted' }, t('{service}, {date}: {outcome}', { service: serviceById(j.service)?.short || j.service, date: fmtDate(j.date), outcome: t(OUTCOME_LABEL[j.outcome]) }))))));
    body.push(list);
    if (waiting) body.push(el('p', { class: 'muted' }, tn(waiting, '{n} more is waiting for its day.', '{n} more are waiting for their day.')));
  }
  return el('div', { class: 'panel scorecard' },
    el('div', { class: 'panel-head' }, el('h2', {}, t('How past predictions did')),
      el('span', { class: 'muted' }, t('A rule whose likely calls are mostly wrong (after 5 or more) is shown as less likely from then on.'))),
    body);
}

function renderLeaving() {
  const list = filtered(games.filter((g) => leaveInfo(g)));
  const byDate = (a, b) => (leaveInfo(a).date || '9999').localeCompare(leaveInfo(b).date || '9999') || a.title.localeCompare(b.title, I18n.locale());
  const pace = playPace();
  const verdicts = new Map(list.map((g) => [g.id, finishVerdict(g)]));
  if (ui.leavingOrder === 'start') {
    // Least time to spare first; games you can't finish at your pace, then games without a time, last.
    const rank = (v) => (!v ? 2 : v.status === 'unlikely' ? 1 : 0);
    const spare = (v) => (v ? Deadline.startWithin(v, pace.perDay) : 0);
    list.sort((a, b) => { const va = verdicts.get(a.id); const vb = verdicts.get(b.id); return rank(va) - rank(vb) || spare(va) - spare(vb) || byDate(a, b); });
  } else list.sort(byDate);
  $('#summary').textContent = tn(list.length, '{n} game leaving. Xbox flags these itself but gives no exact date.', '{n} games leaving. Xbox flags these itself but gives no exact date.');
  renderGrid(list, t('Nothing is flagged as leaving right now.'));
  if (list.length) $('#content').prepend(paceBar([...verdicts.values()].filter(Boolean), pace));
  $('#content').append(predictionsSection());
}

// Your playing pace, how long you play a day, and the order of the Leaving soon page.
function paceBar(verdicts, pace) {
  const fits = verdicts.filter((v) => v.status === 'ok').length;
  const order = (value) => () => { ui.leavingOrder = value; render(true); };
  return el('div', { class: 'pace-bar' },
    el('div', { class: 'pace-text' },
      el('strong', {}, t('Can you finish them in time?')), ' ',
      t('Your pace: about {pace} a day, {source}.', { pace: fmtPerDay(pace.perDay), source: paceSource(pace) }), ' ',
      verdicts.length ? tn(fits, '{n} game fits it.', '{n} games fit it.') : '',
      pace.source === 'default' || pace.source === 'setting' ? null : el('span', { class: 'muted' }, ` ${t('Not right? Pick how much you play.')}`)),
    el('div', { class: 'pace-controls' },
      el('label', { class: 'pace-hours' }, el('span', { class: 'muted' }, t('You play')), playTimeControl()),
      el('div', { class: 'seg' },
        el('button', { class: ui.leavingOrder === 'start' ? '' : 'on', onclick: order('date') }, t('By leave date')),
        el('button', { class: ui.leavingOrder === 'start' ? 'on' : '', onclick: order('start') }, t('What to start first')))));
}

function renderChanges() {
  // Lists with dates back to launch (Switch Online, Apple Arcade) would make
  // this every game, so only the last 30 days, newest first.
  const added = filtered(games.filter((g) => g.firstSeen && !isComing(g) && daysUntil(g.firstSeen) >= -30 && daysUntil(g.firstSeen) <= 0))
    .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.title.localeCompare(b.title, I18n.locale()));
  const gone = filtered(departed);
  const content = $('#content');
  $('#summary').textContent = hideDeparted()
    ? t('Games found by comparing each refresh with the last one. Departed games are hidden.')
    : t('Changes found by comparing each refresh with the last one.');
  content.replaceChildren();
  const keys = unlocked();
  const section = (title, list, empty) => el('div', {},
    el('h2', {}, title),
    list.length ? gameGrid(list.slice(0, 240), keys) : el('div', { class: 'empty small' }, empty));
  content.append(section(t('Added in the last 30 days ({n})', { n: added.length }), added, t('Nothing added in the last 30 days. New games show up here after a refresh finds them.')));
  if (!hideDeparted()) content.append(section(t('Left the service ({n})', { n: gone.length }), gone, t('No departures recorded yet.')));
}

function renderComing() {
  const list = filtered(games.filter(isComing));
  list.sort((a, b) => a.comingOn.localeCompare(b.comingOn) || a.title.localeCompare(b.title, I18n.locale()));
  $('#summary').textContent = tn(list.length, '{n} announced game. Game Pass and Switch Online publish dates ahead; Apple Arcade dates come from Wikipedia. PS Plus, EA Play, Ubisoft+ and Netflix don\'t announce in a form the app can read.', '{n} announced games. Game Pass and Switch Online publish dates ahead; Apple Arcade dates come from Wikipedia. PS Plus, EA Play, Ubisoft+ and Netflix don\'t announce in a form the app can read.');
  renderGrid(list, t('Nothing announced right now.'));
}

// ---------- now playing ----------
// How far into a game you are: your hours (or Steam's) against How Long To Beat.
function playProgress(g) {
  const played = playedHours(g)?.hours || 0;
  const beat = beatHours(g);
  return { played, beat, share: beat ? Math.min(1, played / beat) : null, left: beat ? Math.max(0, beat - played) : null };
}

function progressBlock(g) {
  const p = playProgress(g);
  const text = p.beat
    ? (p.played ? (p.played >= p.beat ? t('{played} played, past its {beat} to beat', { played: fmtHours(p.played), beat: fmtHours(p.beat) }) : t('{played} of {beat} · {left} to go', { played: fmtHours(p.played), beat: fmtHours(p.beat), left: fmtHours(p.left) })) : t('{beat} to beat', { beat: fmtHours(p.beat) }))
    : (p.played ? t('{played} played', { played: fmtHours(p.played) }) : t('No time yet'));
  // One more hour: adds to your own hours, or starts from Steam's.
  const plus = el('button', {
    class: 'mark plus-hour',
    title: t('Add an hour to your hours played'),
    onclick: async (e) => {
      e.stopPropagation();
      await setNote(g.id, { hours: Math.round((p.played + 1) * 10) / 10 });
      render(true);
    },
  }, t('+1h'));
  return el('div', { class: 'progress' },
    p.share != null ? el('div', { class: 'bar', title: t('Hours played against {time}', { time: hltbLabel() }) }, el('span', { class: 'bar-playing', style: `width:${p.share * 100}%` })) : null,
    el('div', { class: 'progress-line' }, el('span', { class: 'muted' }, text), plus));
}

// Games you're playing now: leaving soon first, then the ones you're furthest into.
function renderPlaying() {
  const keys = unlocked();
  const list = filtered(games.filter((g) => markOf(g.id) === 'playing'));
  const leaving = (g) => { const l = leaveInfo(g); return l && l.soon && !l.past ? (l.date || '9999') : null; };
  list.sort((a, b) => {
    const la = leaving(a);
    const lb = leaving(b);
    if (la || lb) return !la ? 1 : !lb ? -1 : la.localeCompare(lb);
    return (playProgress(b).share ?? -1) - (playProgress(a).share ?? -1) || a.title.localeCompare(b.title, I18n.locale());
  });
  const left = list.reduce((sum, g) => sum + (playProgress(g).left || 0), 0);
  $('#summary').textContent = list.length
    ? `${tn(list.length, '{n} game on the go', '{n} games on the go')}${left ? ` · ${t('about {hours} left to beat them', { hours: fmtHours(left) })}` : ''}`
    : '';
  const content = $('#content');
  content.replaceChildren();
  if (!list.length) {
    content.append(el('div', { class: 'empty' }, t('Mark a game ▶ Now playing (hover its cover) and it shows up here, with how far you are.')));
    return;
  }
  const grid = gameGrid(list, keys);
  for (const node of grid.children) {
    const g = list.find((x) => x.id === node.dataset.id);
    if (!g) continue;
    // In the list it sits before the buttons at the end of the line.
    const actions = node.querySelector('.row-actions');
    if (actions) actions.before(progressBlock(g));
    else node.querySelector('.body').append(progressBlock(g));
  }
  content.append(grid);
}

function renderMine() {
  const list = sorted(filtered(games.filter((g) => markOf(g.id) !== 'none')));
  const done = list.filter((g) => markOf(g.id) === 'completed').length;
  const ignored = list.filter((g) => markOf(g.id) === 'ignored').length;
  const playing = list.filter((g) => markOf(g.id) === 'playing').length;
  $('#summary').textContent = tn(list.length, '{n} game marked · {playing} now playing · {done} completed · {ignored} ignored', '{n} games marked · {playing} now playing · {done} completed · {ignored} ignored', { done, ignored, playing });
  renderGrid(list, t('Mark games as now playing, played, completed, dropped or ignored and they will be collected here.'));
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
    [t('Ready to play'), t('In your plans now.'), list.filter((g) => !isComing(g) && isMine(g, keys))],
    [t('Coming soon'), t('Announced, with the date it arrives.'), list.filter(isComing).sort((a, b) => a.comingOn.localeCompare(b.comingOn))],
    [t('In other services'), t('Available, but not in the plans you have. Checked for sales twice a day.'), list.filter((g) => !isComing(g) && !isMine(g, keys))],
    [t('No longer available'), t('Left every service that had it. Checked for sales twice a day.'), [...gone.values()]],
  ];
  const total = list.length + gone.size;
  $('#summary').textContent = total ? tn(total, '{n} game to play · {ready} ready now', '{n} games to play · {ready} ready now', { ready: groups[0][2].length }) : '';
  // The backlog forecast (Plan ahead has the details).
  const f = total ? makePlan().forecast : null;
  if (f) $('#summary').textContent += ` · ${t('about {time} at your pace', { time: durationText(f.days) })}`;
  if (!total) {
    content.append(el('div', { class: 'empty' }, t('Click ＋ on a game\'s cover (or "To play" in its details) to keep it here, whether it\'s out now or coming soon.')));
    return;
  }
  const advice = advisorPanel();
  if (advice) content.append(advice);
  // Games you can't play yet say the cheapest way to.
  const withCheapest = (g, gone) => {
    const c = card(g, keys);
    if (!gone && isMine(g, keys) && !isComing(g)) return c;
    const [best] = waysToPlay(g, { gone });
    if (best && best.kind !== 'included') c.querySelector('.body').append(el('div', { class: `cheapest ${best.kind}`, title: t('The cheapest way to play it. Open the game for the other ways.') }, wayText(best, true)));
    return c;
  };
  for (const [title, hint, items] of groups) {
    if (!items.length) continue;
    const gone = title === groups[3][0];
    content.append(el('div', { class: 'section-head' }, el('h3', {}, title, el('span', { class: 'muted' }, ` ${items.length}`)), el('span', { class: 'muted' }, hint)),
      el('div', { class: 'grid' }, items.map((g) => withCheapest(g, gone))));
  }
}

// ---------- controller mode ----------
// A big-screen view for a TV, browsed with a gamepad (or the keyboard or a
// remote): lists across the top (LB / RB), big covers, a game's details with
// Play and mark buttons. renderer/tv.js turns buttons and keys into actions.
let tv = null; // { tab, index, shown, detail: null | { g, focus }, rolled }
const TV_PAGE = 120;
const tvTop = (list, n = 400) => list.slice(0, n);
function tvTabs() {
  const keys = unlocked();
  const mine = keys.size ? (g) => isMine(g, keys) : () => true;
  const byTitle = (a, b) => a.title.localeCompare(b.title, I18n.locale());
  const leaving = (g) => { const l = leaveInfo(g); return l && l.soon && !l.past; };
  const playable = games.filter((g) => mine(g) && !isComing(g));
  const tabs = [
    ['foryou', t('For you'), () => (keys.size ? recommendations(48, 12).map((p) => p.game) : [])],
    ['playing', t('Now playing'), () => games.filter((g) => markOf(g.id) === 'playing').sort(byTitle)],
    ['toplay', t('To play'), () => games.filter((g) => markOf(g.id) === 'wishlist').sort((a, b) => Number(isComing(a)) - Number(isComing(b)) || Number(isMine(b, keys)) - Number(isMine(a, keys)) || byTitle(a, b))],
    ['leaving', t('Leaving soon'), () => playable.filter(leaving).sort((a, b) => (leaveInfo(a).date || '9999').localeCompare(leaveInfo(b).date || '9999') || byTitle(a, b))],
    ['new', t('New'), () => playable.filter((g) => g.firstSeen && daysUntil(g.firstSeen) >= -30).sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || byTitle(a, b))],
    ['coming', t('Coming soon'), () => games.filter((g) => isComing(g) && mine(g)).sort((a, b) => a.comingOn.localeCompare(b.comingOn))],
    ['all', keys.size ? t('All in your plans') : t('All games'), () => playable.filter((g) => !['ignored', 'completed', 'dropped'].includes(markOf(g.id))).sort((a, b) => (mcScore(b) || 0) - (mcScore(a) || 0) || byTitle(a, b))],
  ];
  return tabs.map(([id, label, list]) => ({ id, label, games: tvTop(list()) })).filter((x) => x.games.length || x.id === 'all');
}

function tvCols() {
  return Math.min(8, Math.max(3, Math.floor((window.innerWidth - 120) / 250)));
}

function openTv() {
  tv = { tab: 0, index: 0, shown: TV_PAGE, detail: null };
  closeDrawer();
  closeShare();
  if (!$('#tv')) document.body.append(el('div', { id: 'tv', class: 'tv', role: 'application', 'aria-label': t('Controller mode') }));
  api.setFullScreen(true);
  renderTv();
}

function closeTv() {
  tv = null;
  $('#tv')?.remove();
  api.setFullScreen(false);
  render(true);
}

function tvLine(g) {
  const leave = leaveInfo(g);
  if (isComing(g)) return t('Coming {date}', { date: fmtDate(g.comingOn) });
  if (leave && !leave.past) return leave.date ? t('Leaves {date}', { date: fmtDate(leave.date) }) : t('Leaving soon');
  const status = STATUS_BADGE[markOf(g.id)];
  if (status) return `${status[0]} ${t(status[1])}`;
  if (markOf(g.id) === 'wishlist') return `＋ ${t('To play')}`;
  return serviceOffers(g).map((o) => serviceById(o.service)?.short || o.service).join(' · ');
}

function renderTv() {
  const box = $('#tv');
  if (!box || !tv) return;
  const tabs = tvTabs();
  tv.tab = Math.min(tv.tab, tabs.length - 1);
  const tab = tabs[tv.tab];
  const list = tab.games;
  tv.index = Math.min(tv.index, Math.max(list.length - 1, 0));
  if (tv.index >= tv.shown - tvCols() * 2) tv.shown = tv.index + TV_PAGE;
  const cols = tvCols();
  const grid = el('div', { class: 'tv-grid', style: `--cols:${cols}` }, list.slice(0, tv.shown).map((g, i) => el('button', {
    class: `tv-tile ${i === tv.index ? 'focus' : ''}`,
    tabindex: '-1',
    onclick: () => { tv.index = i; tvOpen(g); },
  }, el('div', { class: 'cover-wrap' }, placeholder(g), g.image ? cover(g) : null), el('div', { class: 'tv-title' }, g.title), el('div', { class: 'tv-sub' }, tvLine(g)))));
  box.replaceChildren(
    el('header', { class: 'tv-head' },
      el('img', { class: 'tv-logo', src: 'logo.svg', alt: '' }),
      el('div', { class: 'tv-tabs' },
        el('span', { class: 'tv-key' }, 'LB'),
        tabs.map((x, i) => el('button', { class: `tv-tab ${i === tv.tab ? 'on' : ''}`, tabindex: '-1', onclick: () => { tv.tab = i; tv.index = 0; tv.detail = null; renderTv(); } }, x.label, el('span', { class: 'tv-count' }, String(x.games.length)))),
        el('span', { class: 'tv-key' }, 'RB'))),
    list.length ? grid : el('div', { class: 'tv-empty' }, t('Nothing here yet.')),
    el('footer', { class: 'tv-hints' },
      [['Ⓐ', t('Open')], ['Ⓧ', t('To play')], ['Ⓨ', t('Roll a game')], ['LB RB', t('Switch list')], ['Ⓑ', t('Back')], ['☰', t('Exit controller mode')]]
        .map(([k, label]) => el('span', {}, el('span', { class: 'tv-key' }, k), label))));
  if (tv.detail) box.append(tvDetail());
  box.querySelector('.tv-tile.focus')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function tvActions(g) {
  const mark = markOf(g.id);
  const keys = unlocked();
  const play = isMine(g, keys) && !isComing(g) ? Play.playActions(g, { installed: g.steam?.appid ? steamInstalledCache.get(g.steam.appid) ?? null : null, platform: system.platform }) : [];
  const toggle = (value) => async () => { await setMark(g.id, mark === value ? null : value); renderTv(); };
  return [
    ...play.map((a) => ({ label: a.label, run: () => api.launch(a.url) })),
    { label: mark === 'wishlist' ? `✓ ${t('On your To play list')}` : `＋ ${t('To play')}`, run: toggle('wishlist') },
    { label: mark === 'playing' ? `✓ ${t('Now playing')}` : `▶ ${t('Now playing')}`, run: toggle('playing') },
    { label: mark === 'completed' ? `✓ ${t('Completed')}` : `★ ${t('Completed')}`, run: toggle('completed') },
    { label: t('Close'), run: () => { tv.detail = null; renderTv(); } },
  ];
}

function tvDetail() {
  const { g } = tv.detail;
  const actions = tvActions(g);
  tv.detail.focus = Math.min(tv.detail.focus, actions.length - 1);
  const r = ratings[g.id] || {};
  const facts = [];
  const leave = leaveInfo(g);
  if (isComing(g)) facts.push(t('Coming {date}', { date: fmtDate(g.comingOn) }));
  else if (leave && !leave.past) facts.push(leave.date ? t('Leaves {date}', { date: fmtDate(leave.date) }) : t('Leaving soon'));
  if (mcScore(g)) facts.push(`Metacritic ${mcScore(g)}`);
  if (beatHours(g)) facts.push(t('{time} to beat', { time: fmtHours(beatHours(g)) }));
  if (starsOf(g.id)) facts.push('★'.repeat(starsOf(g.id)));
  const d = loadDetails(g);
  if (d instanceof Promise) d.then(() => { if (tv?.detail?.g === g) renderTv(); });
  const description = d instanceof Promise ? t('Loading description and screenshots…') : d?.description || '';
  return el('div', { class: 'tv-detail' },
    el('div', { class: 'tv-detail-card' },
      el('div', { class: 'tv-detail-cover' }, el('div', { class: 'cover-wrap' }, placeholder(g), g.image ? cover(g) : null)),
      el('div', { class: 'tv-detail-body' },
        tv.rolled ? el('div', { class: 'tv-rolled' }, `🎲 ${t('Rolled for you')}`) : null,
        el('h1', {}, g.title),
        serviceMeta(g, unlocked()),
        facts.length ? el('p', { class: 'tv-facts' }, facts.join('  ·  ')) : null,
        description ? el('p', { class: 'tv-desc' }, description) : null,
        el('div', { class: 'tv-actions' }, actions.map((a, i) => el('button', {
          class: `tv-action ${i === tv.detail.focus ? 'focus' : ''} ${i === 0 ? 'primary' : ''}`,
          tabindex: '-1',
          onclick: () => { tv.detail.focus = i; a.run(); },
        }, a.label))))));
}

function tvOpen(g, rolled = false) {
  tv.detail = { g, focus: 0 };
  tv.rolled = rolled;
  const appid = g.steam?.appid;
  if (appid && !steamInstalledCache.has(appid)) {
    api.steamInstalled(appid).then((v) => { steamInstalledCache.set(appid, v); if (tv?.detail?.g === g) renderTv(); }).catch(() => {});
  }
  renderTv();
}

function tvAction(action, source) {
  if (!tv) {
    // Start / Menu on a gamepad opens controller mode from anywhere.
    if (action === 'menu' && source === 'pad') openTv();
    return;
  }
  if (action === 'menu') return closeTv();
  const tabs = tvTabs();
  const list = tabs[Math.min(tv.tab, tabs.length - 1)].games;
  if (tv.detail) {
    const actions = tvActions(tv.detail.g);
    if (action === 'left' || action === 'up') tv.detail.focus = Math.max(0, tv.detail.focus - 1);
    else if (action === 'right' || action === 'down') tv.detail.focus = Math.min(actions.length - 1, tv.detail.focus + 1);
    else if (action === 'ok') return actions[tv.detail.focus]?.run();
    else if (action === 'back') tv.detail = null;
    else if (action === 'x') {
      const g = tv.detail.g;
      return setMark(g.id, markOf(g.id) === 'wishlist' ? null : 'wishlist').then(renderTv);
    }
    else if (action === 'y') return tvRoll();
    else return;
    return renderTv();
  }
  if (['up', 'down', 'left', 'right'].includes(action)) {
    const next = TV.move(tv.index, action, tvCols(), list.length);
    if (next === tv.index) return;
    tv.index = next;
    // Move the highlight without redrawing every cover.
    const tiles = $('#tv').querySelectorAll('.tv-tile');
    if (tv.index >= tiles.length) return renderTv();
    $('#tv .tv-tile.focus')?.classList.remove('focus');
    tiles[tv.index].classList.add('focus');
    tiles[tv.index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  if (action === 'prevTab' || action === 'nextTab') {
    tv.tab = (tv.tab + (action === 'nextTab' ? 1 : -1) + tabs.length) % tabs.length;
    tv.index = 0;
    tv.shown = TV_PAGE;
    $('#tv .tv-grid')?.scrollTo(0, 0);
    return renderTv();
  }
  if (action === 'ok' && list[tv.index]) return tvOpen(list[tv.index]);
  if (action === 'x' && list[tv.index]) {
    const g = list[tv.index];
    return setMark(g.id, markOf(g.id) === 'wishlist' ? null : 'wishlist').then(renderTv);
  }
  if (action === 'y') return tvRoll();
  // The keyboard's Esc leaves; a gamepad's B doesn't, so a stray press on the sofa keeps you here.
  if (action === 'back' && source === 'key') closeTv();
}

function tvRoll() {
  const pool = rollPool();
  if (!pool.length) return;
  tvOpen(pool[Math.floor(Math.random() * pool.length)], true);
}

const pad = new TV.Pad((action, source) => tvAction(action, source), { win: window });
document.addEventListener('keydown', (e) => {
  if (!tv) return;
  const action = TV.keyAction(e);
  e.preventDefault();
  e.stopPropagation();
  if (action) tvAction(action, 'key');
}, true);

// ---------- share a list ----------
// Which list each page shares first, and the lists you can pick.
const SHARE_FROM = { toplay: 'wishlist', playing: 'playing', mine: 'completed' };
const SHARE_LISTS = [['wishlist', tk('To play')], ['playing', tk('Now playing')], ['completed', tk('Completed')], ['played', tk('Played')]];
let shareUi = null; // { mark, format: 'image'|'text', markdown, where, stars }

function shareGames(mark) {
  const list = games.filter((g) => markOf(g.id) === mark);
  // Completed games: the latest first. The rest by title.
  if (mark === 'completed') return list.sort((a, b) => (finishedOf(b.id) || '').localeCompare(finishedOf(a.id) || '') || a.title.localeCompare(b.title, I18n.locale()));
  return list.sort((a, b) => a.title.localeCompare(b.title, I18n.locale()));
}

function addShareButton() {
  const mark = SHARE_FROM[ui.view];
  if (!mark || !SHARE_LISTS.some(([m]) => shareGames(m).length)) return;
  $('#summary').append(el('button', { class: 'link share-btn', onclick: () => openShare(shareGames(mark).length ? mark : SHARE_LISTS.find(([m]) => shareGames(m).length)[0]) }, t('Share…')));
}

const SHARE_HEADING = { wishlist: tk('My To play list'), playing: tk('What I\'m playing'), completed: tk('Games I completed'), played: tk('Games I played') };
const shareFooter = () => t('Made with Subscroll · github.com/viruztt/subscroll');
const WHOLE_COVERS = ['nso', 'netflix', 'applearcade', 'crunchyroll', 'playpass', 'antstream'];

function shareItems(list) {
  return list.map((g) => ({
    title: g.title,
    where: serviceOffers(g).map((o) => serviceById(o.service)?.short || serviceById(o.service)?.name || o.service).join(', '),
    stars: starsOf(g.id) || 0,
    color: serviceById(g.service)?.color || '#555',
    whole: WHOLE_COVERS.includes(g.service),
  }));
}

function openShare(mark) {
  shareUi = { format: 'image', markdown: false, where: true, stars: true, ...(shareUi || {}), mark };
  if (!$('#share')) document.body.append(el('div', { id: 'share', class: 'onboard', onclick: (e) => { if (e.target.id === 'share') closeShare(); } }));
  renderShare();
}
function closeShare() {
  $('#share')?.remove();
}

// Covers come through the main process, so the picture can be saved.
const coverCache = new Map();
function coverUrl(g) {
  if (!g.image) return null;
  return ['gamepass', 'eaplay', 'ubisoftplus'].includes(g.service) ? `${g.image}?w=300&h=450&q=80` : g.image;
}
async function loadCovers(list) {
  const want = list.filter((g) => !coverCache.has(g.id));
  if (want.length) {
    const data = await api.fetchImages(want.map((g) => [coverUrl(g), g.imageFallback || null]));
    want.forEach((g, i) => coverCache.set(g.id, data[i] || null));
  }
  return Promise.all(list.map((g) => new Promise((resolve) => {
    const src = coverCache.get(g.id);
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  })));
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

async function renderShare() {
  const box = $('#share');
  if (!box || !shareUi) return;
  const list = shareGames(shareUi.mark);
  const items = shareItems(list);
  const heading = t(SHARE_HEADING[shareUi.mark]);
  const status = el('p', { class: 'muted share-status' });
  const opt = (key, label) => {
    const c = el('input', { type: 'checkbox' });
    c.checked = !!shareUi[key];
    c.addEventListener('change', () => { shareUi[key] = c.checked; renderShare(); });
    return el('label', { class: 'check-row inline' }, c, el('span', {}, label));
  };
  const seg = (key, options) => el('div', { class: 'seg' }, options.map(([v, label]) => el('button', { class: shareUi[key] === v ? 'on' : '', onclick: () => { shareUi[key] = v; renderShare(); } }, label)));
  const which = el('select', {}, SHARE_LISTS.filter(([m]) => shareGames(m).length).map(([m, label]) => el('option', { value: m, ...(m === shareUi.mark ? { selected: '' } : {}) }, `${t(label)} (${shareGames(m).length})`)));
  which.addEventListener('change', () => { shareUi.mark = which.value; renderShare(); });
  const preview = el('div', { class: 'share-preview' });
  const text = () => Share.text(items, { heading, footer: shareFooter(), markdown: shareUi.markdown, where: shareUi.where, stars: shareUi.stars });
  let canvas = null;
  const copy = async () => {
    if (shareUi.format === 'text') await api.copyText(text());
    else if (canvas) await api.copyImage(canvas.toDataURL('image/png'));
    status.textContent = shareUi.format === 'text' ? t('Copied the list. Paste it wherever you like.') : t('Copied the picture. Paste it wherever you like.');
  };
  const save = async () => {
    const name = `subscroll-${shareUi.mark === 'wishlist' ? 'to-play' : shareUi.mark}`;
    const r = shareUi.format === 'text'
      ? await api.saveShare({ name: `${name}.${shareUi.markdown ? 'md' : 'txt'}`, text: text() })
      : canvas && await api.saveShare({ name: `${name}.png`, png: canvas.toDataURL('image/png') });
    if (r?.ok) status.textContent = t('Saved to {file}', { file: r.file });
  };
  box.replaceChildren(el('div', { class: 'onboard-card share-card', role: 'dialog', 'aria-label': t('Share a list') },
    el('div', { class: 'onboard-body' },
      el('div', { class: 'panel-head' }, el('h1', {}, t('Share a list')), el('button', { class: 'link', onclick: closeShare }, t('Close'))),
      el('div', { class: 'share-options' },
        which,
        seg('format', [['image', t('Picture')], ['text', t('Text')]]),
        shareUi.format === 'text' ? seg('markdown', [[false, t('Plain text')], [true, t('Markdown')]]) : null,
        opt('where', t('Where to play it')),
        opt('stars', t('Your stars'))),
      preview,
      status),
    el('div', { class: 'onboard-foot share-foot' },
      el('span', { class: 'muted' }, shareUi.format === 'image' && list.length > Share.MAX_IMAGE ? t('The picture shows the first {n} games; the text has them all.', { n: Share.MAX_IMAGE }) : ''),
      el('span'),
      el('div', { class: 'onboard-actions' }, el('button', { onclick: save }, t('Save…')), el('button', { class: 'primary', onclick: copy }, t('Copy'))))));
  if (shareUi.format === 'text') {
    preview.append(el('textarea', { class: 'share-text', readonly: '', rows: 16 }, text()));
    return;
  }
  preview.append(el('p', { class: 'muted' }, t('Getting the covers…')));
  const mark = shareUi.mark;
  const images = await loadCovers(list.slice(0, Share.MAX_IMAGE));
  // Picked another list or closed it while the covers loaded.
  if (!shareUi || shareUi.mark !== mark || shareUi.format !== 'image' || !$('#share')) return;
  canvas = el('canvas', { class: 'share-canvas' });
  Share.draw(canvas, {
    heading,
    sub: tn(list.length, '{n} game', '{n} games'),
    footer: shareFooter(),
    more: tn(list.length - Share.MAX_IMAGE, 'and {n} more', 'and {n} more'),
    items,
    images,
    where: shareUi.where,
    stars: shareUi.stars,
    colors: { bg: cssVar('--bg'), panel: cssVar('--panel-2'), text: cssVar('--text'), muted: cssVar('--muted'), accent: cssVar('--accent-text') },
  });
  preview.replaceChildren(canvas);
}

// "Game Pass Ultimate", "PC Game Pass", "PS Plus Extra", "Netflix Games".
function planName(serviceId, tierId) {
  const s = serviceById(serviceId);
  if (!s) return serviceId;
  const t = s.tiers.find((x) => x.id === tierId);
  if (!t || s.tiers.length === 1) return s.name;
  return t.name.includes(s.short) ? t.name : `${s.short} ${t.name}`;
}

// ---------- cheapest way to play ----------
// Your plans, a plan that has it, buying it or waiting for it, cheapest first.
// A game that has left every service can only be bought.
function waysToPlay(g, { gone = false } = {}) {
  const currency = regionCurrency();
  const p = prices[g.id];
  const manual = state.priceOverrides?.[g.id];
  const price = p?.amount > 0 && p.currency === currency ? p : typeof manual === 'number' && manual > 0 ? { amount: manual } : null;
  return Cheapest.ways(g, {
    services: gone ? [] : allServices(),
    subscriptions: state.subscriptions,
    planOptions: (s) => (currency ? PlanPrices.options(s, currency, { tierName: (t) => s.tiers.find((x) => x.id === t)?.name || t }) : []),
    price,
    owned: !!g.steam,
    comingOn: isComing(g) ? g.comingOn : null,
    today: todayIso(),
  });
}

// "Game Pass Premium", "Switch Online + Expansion Pack", "Netflix Standard with adverts".
function wayPlanName(w) {
  const s = serviceById(w.service);
  if (!s) return w.name;
  if (s.tiers.length === 1 && w.name === s.tiers[0].name) return s.name;
  return w.name.includes(s.short) ? w.name : `${s.short} ${w.name}`;
}

// How long a plan's price covers: 'a month', 'a year', '3 months'.
const planLength = (months) => (months === 1 ? t('a month') : months === 12 ? t('a year') : tn(months, '{n} month', '{n} months'));
function wayText(w, short = false) {
  switch (w.kind) {
    case 'owned': return t('You own it on Steam');
    case 'included': return t('In your plans');
    case 'wait': return short ? t('Wait until {date}, then it\'s in your plans', { date: fmtDate(w.on) }) : tn(w.days, 'Wait: it joins your plans on {date} (in {n} day)', 'Wait: it joins your plans on {date} (in {n} days)', { date: fmtDate(w.on) });
    case 'plan': {
      const plan = w.upgrade ? t('Upgrade to {plan}', { plan: wayPlanName(w) }) : wayPlanName(w);
      const p = { plan, price: money(w.cost), length: planLength(w.months), date: w.on ? fmtDate(w.on) : '' };
      if (short) return w.on ? t('{plan}, {price} for {length}, from {date}', p) : t('{plan}, {price} for {length}', p);
      if (w.on) return w.unsure ? t('{plan}: {price} for {length}, from {date} (price not confirmed)', p) : t('{plan}: {price} for {length}, from {date}', p);
      return w.unsure ? t('{plan}: {price} for {length} (price not confirmed)', p) : t('{plan}: {price} for {length}', p);
    }
    case 'buy': {
      if (short) return w.sale ? t('Buy it for {price} on sale', { price: money(w.cost) }) : t('Buy it for {price}', { price: money(w.cost) });
      const sale = w.sale ? (w.saleEnds ? t('{off}% off until {date}', { off: w.off, date: fmtDate(w.saleEnds.slice(0, 10)) }) : t('{off}% off', { off: w.off })) : '';
      const p = { price: money(w.cost), sale, store: w.source };
      if (w.sale) return w.source ? t('Buy it: {price} ({sale}) on {store}', p) : t('Buy it: {price} ({sale})', p);
      return w.source ? t('Buy it: {price} on {store}', p) : t('Buy it: {price}', p);
    }
    default: return '';
  }
}

// When you finished a completed game, for goals. Changeable.
function finishedRows(g) {
  if (markOf(g.id) !== 'completed') return null;
  const input = el('input', { type: 'date', class: 'finished-date', value: finishedOf(g.id) || '', max: todayIso(), title: t('When you finished it; goals on the Statistics page count it in that week, month or year') });
  input.addEventListener('change', () => setFinished(g.id, input.value || null));
  return [el('dt', {}, t('Finished')), el('dd', {}, input, finishedOf(g.id) ? null : el('span', { class: 'muted', title: t('Goals leave out completed games without a date') }, t(' not dated')))];
}

// In a game's details, when it isn't in your plans now.
function cheapestRows(g) {
  const ways = waysToPlay(g, { gone: !!(g.departed || g.leftOn) && !isComing(g) });
  if (!ways.length || ways[0].kind === 'included') return null;
  return [el('dt', {}, t('Cheapest way')), el('dd', { class: 'ways' }, ways.slice(0, 3).map((w, i) => el('div', { class: i ? 'muted' : 'best' }, wayText(w))))];
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
  const thumb = (g) => {
    const ms = ['gamepass', 'eaplay', 'ubisoftplus'].includes(g.service);
    const img = g.image ? el('img', { src: ms ? `${g.image}?w=80&h=120&q=70` : g.image, loading: 'lazy', alt: '' }) : null;
    const initials = () => el('span', {}, g.title.slice(0, 2));
    if (img) img.addEventListener('error', () => img.replaceWith(initials()));
    return el('button', { class: 'adv-thumb', title: g.title, onclick: () => openDrawer(g) }, img || initials());
  };
  const rows = r.options.slice(0, 4).map((o, i) => {
    const s = serviceById(o.service);
    const facts = [tn(r.total, 'Covers {count} of your {n} To play game', 'Covers {count} of your {n} To play games', { count: o.games.length })];
    if (o.leaving.length) facts.push(tn(o.leaving.length, '{n} leaving soon', '{n} leaving soon'));
    if (o.arriving.length) facts.push(tn(o.arriving.length, '{n} arriving this month', '{n} arriving this month'));
    if (o.smaller) facts.push(t('{plan} alone covers {n}', { plan: planName(o.service, o.smaller.tier), n: o.smaller.count }));
    const shown = [...o.leaving, ...o.games.filter((g) => !o.leaving.includes(g))].slice(0, 6);
    return el('div', { class: `adv-row ${i === 0 ? 'best' : ''}` },
      el('span', { class: 'dot', style: `background:${s?.color || 'var(--accent)'}` }),
      el('div', { class: 'adv-main' },
        el('div', { class: 'adv-title' }, el('strong', {}, planName(o.service, o.tier)),
          i === 0 ? el('span', { class: 'badge toplay' }, t('Best pick')) : null,
          o.upgradeFrom ? el('span', { class: 'muted' }, t(' upgrade from {plan}', { plan: planName(o.service, o.upgradeFrom) })) : null),
        el('div', { class: 'muted' }, facts.join(' · '))),
      el('div', { class: 'adv-covers' }, shown.map(thumb), o.games.length > shown.length ? el('span', { class: 'muted' }, `+${o.games.length - shown.length}`) : null));
  });
  const notes = [];
  if (r.rotation.length > 1) {
    notes.push(el('p', { class: 'adv-note' }, tEl('Rotating plans? {link} works out which plan to pay for each month, and when you\'d be through your list.', {
      link: el('button', { class: 'link inline', onclick: () => { ui.view = 'plan'; $('#content').scrollTop = 0; render(); } }, t('Plan ahead')),
    })));
  }
  for (const k of idle) notes.push(el('p', { class: 'adv-note' }, t('{plan}: nothing on your To play list needs it right now, so you could pause it.', { plan: planName(k.service, k.tier) })));
  for (const k of lower) notes.push(el('p', { class: 'adv-note' }, tn(k.needs, '{plan}: {lower} covers the {n} To play game you need it for.', '{plan}: {lower} covers the {n} To play games you need it for.', { plan: planName(k.service, k.tier), lower: planName(k.service, k.lower) })));
  const hint = r.options.length
    ? (r.ready ? t('For the To play games you can\'t play with the plans you have ({n} you can).', { n: r.ready }) : t('For the To play games you can\'t play with the plans you have.'))
    : t('Everything on your To play list is in your plans already.');
  return el('div', { class: 'panel advisor' },
    el('div', { class: 'panel-head' }, el('h2', {}, t('Which plan to get')), el('span', { class: 'muted' }, hint)),
    rows, notes);
}

// ---------- plan ahead ----------
// Your To play and Now playing games against the time you play a day
// (renderer/planner.js): when you'd be through them, and which plan to pay
// for each month if you rotate plans.
const UNKNOWN_HOURS = 12;
function hoursLeft(g) {
  const beat = beatHours(g);
  const played = playedHours(g)?.hours || 0;
  if (beat == null) return { hours: Math.max(1, UNKNOWN_HOURS - played), guessed: true };
  return { hours: Math.max(0.5, beat - played), guessed: false };
}

// When it leaves, or could: the service's date, the usual Game Pass day for
// a game flagged without one, or a likely prediction.
function deadlineOf(g, keys) {
  const l = leaveInfo(g);
  if (l && !l.past) return { date: l.date || Deadline.guessLeaveDate(todayIso()), kind: l.date ? 'leaving' : 'guess' };
  const p = predictionOf(g, keys);
  return p && p.likely ? { date: p.date, kind: 'predicted' } : null;
}

// Each plan you could take for a month on top of yours, with its list price
// (a month's, or the shortest it's sold for).
function planCandidates() {
  const svcs = allServices();
  const currency = regionCurrency();
  const out = [];
  for (const s of svcs) {
    const options = currency ? PlanPrices.options(s, currency) : [];
    for (const tier of s.tiers) {
      if (state.subscriptions[s.id] === tier.id) continue;
      const priced = options.filter((o) => o.tier === tier.id).sort((a, b) => a.months - b.months)[0];
      out.push({
        key: `${s.id}:${tier.id}`, service: s.id, tier: tier.id,
        keys: Advisor.keysFor(svcs, { ...state.subscriptions, [s.id]: tier.id }),
        price: priced ? { amount: priced.amount, months: priced.months, unsure: !!priced.unsure } : null,
      });
    }
  }
  return out;
}

// Games not out yet stay out of the plan (dates slip, and there's no time
// to beat yet); the page lists them on their own.
function planInput(keys) {
  const candidates = planCandidates();
  const wanted = games.filter((g) => ['wishlist', 'playing'].includes(markOf(g.id)));
  const upcoming = wanted.filter(isComing).sort((a, b) => a.comingOn.localeCompare(b.comingOn));
  const items = wanted.filter((g) => !isComing(g)).map((g) => {
    const { hours, guessed } = hoursLeft(g);
    const ready = isMine(g, keys);
    const d = deadlineOf(g, keys);
    return {
      id: g.id, g, hours, guessed, ready,
      plans: new Set(ready ? [] : candidates.filter((c) => isMine(g, c.keys)).map((c) => c.key)),
      deadline: d?.date || null,
      deadlineKind: d?.kind || null,
      playing: markOf(g.id) === 'playing',
    };
  });
  return { items, candidates, upcoming };
}

function makePlan() {
  const keys = unlocked();
  const { items, candidates, upcoming } = planInput(keys);
  const pace = playPace();
  const today = todayIso();
  const result = Planner.plan(items, { perDay: pace.perDay, today, candidates: candidates.map((c) => ({ key: c.key, price: c.price })) });
  return { items, candidates, upcoming, pace, result, forecast: Planner.forecast(result.hours, pace.perDay, today) };
}

// "12 days", "5 weeks", "4 months".
function durationText(days) {
  if (days < 14) return tn(days, '{n} day', '{n} days');
  if (days < 61) return tn(Math.round(days / 7), '{n} week', '{n} weeks');
  return tn(Math.round(days / 30.4), '{n} month', '{n} months');
}

const DEADLINE_TEXT = {
  leaving: tk('leaves {date}'),
  guess: tk('leaving, probably by {date}'),
  predicted: tk('could leave {date}'),
};

function planPriceText(price) {
  if (!price) return '';
  const p = { price: money(price.amount), length: planLength(price.months) };
  return price.months === 1 ? t('{price} a month', p) : t('{price} for {length}', p);
}

function renderPlan() {
  const content = $('#content');
  content.replaceChildren();
  const { items, candidates, upcoming, pace, result: r, forecast: f } = makePlan();
  $('#summary').textContent = '';
  if (!items.length && !upcoming.length) {
    content.append(el('div', { class: 'empty' }, t('Add games to To play (＋ on a cover) or mark them Now playing, and this page works out when you\'d get through them and which plan to pay for each month.')));
    return;
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const counted = items.filter((i) => !r.unreachable.includes(i.id));
  const guessed = counted.filter((i) => i.guessed).length;
  const stat = (value, label) => el('div', { class: 'plan-stat' }, el('strong', {}, value), el('span', { class: 'muted' }, label));
  const done = r.finishes || f?.date || null;
  if (items.length) {
    content.append(el('div', { class: 'panel plan-forecast' },
      el('div', { class: 'panel-head' }, el('h2', {}, t('Your backlog')),
        el('span', { class: 'muted' }, tn(counted.length, '{n} To play or Now playing game you can play through your plans or one you could add.', '{n} To play and Now playing games you can play through your plans or one you could add.'))),
      el('div', { class: 'plan-stats' },
        stat(fmtHours(r.hours), t('to play')),
        stat(f ? durationText(f.days) : '–', t('at {perDay} a day', { perDay: fmtPerDay(pace.perDay) })),
        stat(done ? fmtDate(done) : '–', r.finishes ? t('done around, following the plan below') : t('done around'))),
      el('div', { class: 'plan-pace' }, el('span', { class: 'muted' }, t('How long you play a day ({source}):', { source: paceSource(pace) })), ' ', playTimeControl()),
      guessed ? el('p', { class: 'muted small' }, tn(guessed, '{n} game has no How Long To Beat time yet, so it counts as {hours}.', '{n} games have no How Long To Beat time yet, so each counts as {hours}.', { hours: fmtHours(UNKNOWN_HOURS) })) : null));

    // Month by month.
    const total = r.months.reduce((n, m) => (m.price && n !== null ? (m.price.months === 1 ? n + m.price.amount : null) : n), 0);
    const months = r.months.map((m) => {
      const c = m.key ? candidates.find((x) => x.key === m.key) : null;
      const s = c ? serviceById(c.service) : null;
      const head = el('div', { class: 'plan-month-head' },
        el('strong', {}, t('{from} to {to}', { from: fmtDate(m.start), to: fmtDate(m.end) })),
        c ? el('span', { class: 'plan-chip', style: `--svc:${s?.color || 'var(--accent)'}` }, planName(c.service, c.tier)) : el('span', { class: 'plan-chip own' }, t('Just your plans')),
        c?.price ? el('span', { class: 'muted' }, planPriceText(c.price)) : null,
        el('span', { class: 'muted plan-hours' }, t('{used} of {budget} of play', { used: fmtHours(m.hours), budget: fmtHours(m.budget) })));
      const rows = m.games.map((step) => {
        const it = byId.get(step.id);
        return el('li', { class: step.needsPlan ? 'needs-plan' : '' },
          el('button', { class: 'game-link', onclick: () => openDrawer(it.g) }, it.g.title), ' ',
          el('span', { class: 'muted', title: it.guessed ? t('No How Long To Beat time yet, so this is a guess of {hours} in all.', { hours: fmtHours(UNKNOWN_HOURS) }) : '' },
            it.guessed
              ? (step.finishes ? t('about {hours} to finish it (a guess)', { hours: fmtHours(step.hours) }) : t('about {hours}, then carry on next month (a guess)', { hours: fmtHours(step.hours) }))
              : (step.finishes ? t('{hours} to finish it', { hours: fmtHours(step.hours) }) : t('{hours}, then carry on next month', { hours: fmtHours(step.hours) }))),
          it.deadline ? el('span', { class: `plan-deadline ${it.deadlineKind}` }, t(DEADLINE_TEXT[it.deadlineKind], { date: fmtDate(it.deadline) })) : null);
      });
      return el('div', { class: `plan-month ${c ? 'paid' : ''}` }, head, rows.length ? el('ol', {}, rows) : el('div', { class: 'muted' }, t('Nothing to play this month yet.')));
    });
    content.append(el('div', { class: 'panel plan-months' },
      el('div', { class: 'panel-head' }, el('h2', {}, t('Month by month')),
        el('span', { class: 'muted' }, t('Keep the plans you have and add at most one a month, picked so you play the most. Games you\'ve started come first, then the ones leaving soonest, then the shortest.'))),
      months.length ? months : el('div', { class: 'empty small' }, t('Set how long you play a day to see a plan.')),
      total ? el('p', { class: 'muted' }, t('Plans added: {price} in all, at list prices.', { price: money(total) })) : null));

    if (r.missed.length) {
      content.append(el('div', { class: 'panel plan-missed' },
        el('div', { class: 'panel-head' }, el('h2', {}, t('Might not make it')),
          el('span', { class: 'muted' }, t('These leave, or could leave, before the plan gets to them. Start them sooner, or play more a day.'))),
        el('ul', {}, r.missed.map((m) => {
          const it = byId.get(m.id);
          return el('li', {}, el('button', { class: 'game-link', onclick: () => openDrawer(it.g) }, it.g.title), ' ',
            el('span', { class: `plan-deadline ${it.deadlineKind}` }, t(DEADLINE_TEXT[it.deadlineKind], { date: fmtDate(m.deadline) })), ' ',
            el('span', { class: 'muted' }, t('{hours} not played', { hours: fmtHours(m.left) })));
        }))));
    }
  }
  if (upcoming.length) {
    const keys = unlocked();
    content.append(el('div', { class: 'panel plan-upcoming' },
      el('div', { class: 'panel-head' }, el('h2', {}, t('Not out yet')),
        el('span', { class: 'muted' }, t('Left out of the plan until they arrive, as dates can slip and there\'s no time to beat yet.'))),
      el('ul', {}, upcoming.map((g) => el('li', {},
        el('button', { class: 'game-link', onclick: () => openDrawer(g) }, g.title), ' ',
        el('span', { class: 'muted' }, isMine(g, keys) ? t('arrives {date}, in your plans', { date: fmtDate(g.comingOn) }) : t('arrives {date}', { date: fmtDate(g.comingOn) })))))));
  }
  const notes = [];
  if (r.leftOver?.length) notes.push(tn(r.leftOver.length, '{n} more game is left after a year of this plan.', '{n} more games are left after a year of this plan.'));
  if (r.unreachable.length) notes.push(tn(r.unreachable.length, '{n} game isn\'t in any plan; To play shows the cheapest way to play it.', '{n} games aren\'t in any plan; To play shows the cheapest way to play them.'));
  if (notes.length) content.append(el('p', { class: 'muted' }, notes.join(' ')));
}

// ---------- calendar ----------
const CAL_KINDS = {
  coming: { label: tk('Arriving'), cls: 'k-coming' },
  added: { label: tk('Added'), cls: 'k-added' },
  left: { label: tk('Left'), cls: 'k-left' },
  'free-start': { label: tk('Free from'), cls: 'k-free' },
  'free-end': { label: tk('Last day free'), cls: 'k-free' },
};
const CAL_LEGEND = [['coming', tk('Arriving')], ['added', tk('Added')], ['left', tk('Left')], ['free', tk('Free games')]];
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
  const monthName = new Date(`${ui.calMonth}-01T00:00:00`).toLocaleDateString(I18n.locale(), { month: 'long', year: 'numeric' });
  const inMonth = [...days].filter(([d]) => d.startsWith(ui.calMonth)).flatMap(([, l]) => l);
  const count = (k) => inMonth.filter((e) => calGroup(e.kind) === k).length;
  const counts = { month: monthName, coming: count('coming'), added: count('added'), left: count('left') };
  $('#summary').textContent = ui.mineOnly ? t('{month}: {coming} arriving · {added} added · {left} left · in your plans', counts) : t('{month}: {coming} arriving · {added} added · {left} left', counts);

  const go = (month, day = null) => { ui.calMonth = month; ui.calDay = day; render(true); };
  const head = el('div', { class: 'cal-head' },
    el('button', { class: 'cal-nav', title: t('Previous month'), onclick: () => go(Calendar.shiftMonth(ui.calMonth, -1)) }, '‹'),
    el('h2', {}, monthName),
    el('button', { class: 'cal-nav', title: t('Next month'), onclick: () => go(Calendar.shiftMonth(ui.calMonth, 1)) }, '›'),
    ui.calMonth !== today.slice(0, 7) ? el('button', { class: 'cal-nav', onclick: () => go(today.slice(0, 7)) }, t('Today')) : null,
    el('div', { class: 'cal-legend' }, CAL_LEGEND.map(([k, label]) => el('button', {
      class: `cal-key k-${k} ${ui.calHidden.has(k) ? 'off' : ''}`,
      title: ui.calHidden.has(k) ? t('Show these') : t('Hide these'),
      onclick: () => { if (ui.calHidden.has(k)) ui.calHidden.delete(k); else ui.calHidden.add(k); render(true); },
    }, el('span', { class: 'swatch' }), t(label)))));

  // Xbox flags games as leaving without a date, so they can't go on a day.
  const undated = filtered(games).filter((g) => { const l = leaveInfo(g); return l && l.soon && !l.date && !l.past; }).length;
  const note = undated ? el('p', { class: 'muted cal-note' }, tn(undated, '{n} game is leaving soon without a date, so they aren\'t on the calendar. ', '{n} games are leaving soon without a date, so they aren\'t on the calendar. '),
    el('button', { class: 'link inline', onclick: () => { ui.view = 'leaving'; render(); } }, t('See Leaving soon'))) : null;

  const MAX = 3;
  const weekdays = grid.slice(0, 7).map((c) => new Date(`${c.iso}T00:00:00`).toLocaleDateString(I18n.locale(), { weekday: 'short' }));
  const cells = grid.map((c) => {
    const list = days.get(c.iso) || [];
    const pick = (e) => (isFree(e.item) ? () => go(ui.calMonth, c.iso) : () => openDrawer(e.item));
    return el('div', {
      class: `cal-day ${c.inMonth ? '' : 'out'} ${c.iso === today ? 'today' : ''} ${ui.calDay === c.iso ? 'picked' : ''} ${list.length ? 'has' : ''}`,
      onclick: (e) => { if (!e.target.closest('.cal-ev')) go(c.iso.slice(0, 7), ui.calDay === c.iso ? null : c.iso); },
    },
    el('div', { class: 'cal-num' }, String(Number(c.iso.slice(8)))),
    list.slice(0, MAX).map((e) => el('button', { class: `cal-ev ${CAL_KINDS[e.kind].cls}`, title: t('{kind}: {title}', { kind: t(CAL_KINDS[e.kind].label), title: e.item.title }), onclick: pick(e) }, e.item.title)),
    list.length > MAX ? el('div', { class: 'cal-more' }, t('+{n} more', { n: list.length - MAX })) : null);
  });
  content.append(head, note, el('div', { class: 'cal-grid' }, weekdays.map((w) => el('div', { class: 'cal-wd' }, w)), cells));

  // Below the grid: the picked day, or every day of the month with something on.
  const keys = unlocked();
  const agendaDays = [...days.keys()].filter((d) => (ui.calDay ? d === ui.calDay : d.startsWith(ui.calMonth)) && days.get(d).length).sort();
  const agenda = el('div', { class: 'cal-agenda' },
    ui.calDay ? el('button', { class: 'link', onclick: () => go(ui.calMonth) }, t('Show all of {month}', { month: monthName })) : null);
  if (!agendaDays.length) agenda.append(el('div', { class: 'empty small' }, ui.calDay ? t('Nothing on this day.') : t('Nothing dated this month with these filters.')));
  for (const d of agendaDays) {
    const list = days.get(d);
    agenda.append(el('div', { class: 'section-head' }, el('h3', {}, new Date(`${d}T00:00:00`).toLocaleDateString(I18n.locale(), { weekday: 'long', day: 'numeric', month: 'long' }))));
    for (const kind of Object.keys(CAL_KINDS)) {
      const items = list.filter((e) => e.kind === kind).map((e) => e.item);
      if (!items.length) continue;
      agenda.append(el('div', { class: `cal-kind ${CAL_KINDS[kind].cls}` }, t('{kind} ({n})', { kind: t(CAL_KINDS[kind].label), n: items.length })),
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
  return d.toLocaleString(I18n.locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// "in 3 days", "in 5 hours"
function inText(iso) {
  const ms = new Date(iso) - Date.now();
  const h = Math.round(ms / 3600000);
  if (h < 1) return t('within the hour');
  if (h < 36) return tn(h, 'in {n} hour', 'in {n} hours');
  const d = Math.round(h / 24);
  return tn(d, 'in {n} day', 'in {n} days');
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
  const art = el('div', { class: 'free-art' }, img || el('span', {}, g.mystery ? t('Mystery game') : g.title));
  if (img) img.addEventListener('error', () => img.replaceWith(el('span', {}, g.title)));
  const tryIt = g.kind === 'try';
  const span = g.upcoming ? { start: whenText(g.start), end: g.end ? whenText(g.end) : '' } : null;
  const when = g.upcoming
    ? (tryIt
      ? (g.end ? t('Play free from {start} to {end}', span) : t('Play free from {start}', span))
      : (g.end ? t('Free from {start} to {end}', span) : t('Free from {start}', span)))
    : !g.end ? t('No end date given')
      : tryIt ? t('Play free until {date}, {when}', { date: whenText(g.end), when: inText(g.end) }) : t('Claim by {date}, {when}', { date: whenText(g.end), when: inText(g.end) });
  const needs = g.needs ? (hasPlanFor(g.needs) ? t('With your {plan}', { plan: NEEDS[g.needs] }) : t('Needs {plan}', { plan: NEEDS[g.needs] })) : tryIt ? t('Open to everyone') : null;
  const facts = [
    g.worth ? t('Usually {price}', { price: g.worth }) : null,
    g.limited ? t('Keys while they last') : null,
    g.trial ? t('Timed trial') : tryIt ? t('The full game for the weekend; progress carries over if you buy it') : null,
    g.store === 'psplus' ? t('Stays in your library while you have PS Plus') : null,
    g.store === 'humble' ? t('Yours to keep once claimed') : null,
  ].filter(Boolean);
  const also = freeAlsoIn(g);
  const claim = g.store === 'prime' ? t('Claim with Prime') : g.store === 'psplus' ? t('Add on PS Store') : tryIt ? t('Get it on Xbox') : t('Claim on {store}', { store: store.short });
  return el('div', { class: `free-card ${mark ? 'dim' : ''}` },
    art,
    el('div', { class: 'free-body' },
      el('div', { class: 'free-tags' }, el('span', { class: 'badge', style: `background:${store.color}` }, store.short),
        mark === 'claimed' ? el('span', { class: 'badge done' }, tryIt ? t('Played') : t('Claimed')) : null,
        needs ? el('span', { class: `free-needs ${g.needs && !hasPlanFor(g.needs) ? 'missing' : ''}` }, needs) : null),
      el('h4', {}, g.title),
      el('div', { class: `free-when ${soon && !g.upcoming ? 'urgent' : ''}` }, when),
      facts.length ? el('div', { class: 'muted' }, facts.join(' · ')) : null,
      also ? el('div', { class: 'muted' }, t('Also in {services}', { services: also })) : null,
      el('div', { class: 'free-actions' },
        g.url ? el('button', { class: g.upcoming || mark ? 'mark' : 'primary', onclick: () => api.openExternal(g.url) }, g.upcoming ? (g.store === 'psplus' && /blog\./.test(g.url) ? t('Announcement ↗') : t('Store page ↗')) : `${claim} ↗`) : null,
        g.upcoming ? null : mark
          ? el('button', { class: 'mark', onclick: () => setFreeMark(g, null) }, t('Undo'))
          : [el('button', { class: 'mark', title: t('Hide it and skip its reminder'), onclick: () => setFreeMark(g, 'claimed') }, tryIt ? t('✓ Played') : t('✓ Claimed')),
            el('button', { class: 'mark', title: t('Hide it and skip its reminder'), onclick: () => setFreeMark(g, 'skip') }, t('Not interested'))])));
}

function renderFree() {
  const content = $('#content');
  content.replaceChildren();
  // Ending soonest first; no end date last.
  const byEnd = (a, b) => (a.end || '9').localeCompare(b.end || '9') || a.title.localeCompare(b.title, I18n.locale());
  const shown = free.games.filter(freeShown);
  const hidden = free.games.filter((g) => !hasPlanFor(g.needs));
  const now = shown.filter((g) => !g.upcoming && !freeMark(g) && g.kind !== 'try').sort(byEnd);
  const weekend = shown.filter((g) => !g.upcoming && !freeMark(g) && g.kind === 'try').sort(byEnd);
  const next = shown.filter((g) => g.upcoming).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  const done = shown.filter((g) => !g.upcoming && freeMark(g)).sort(byEnd);
  const checked = free.at ? t('checked {date}', { date: new Date(free.at).toLocaleString(I18n.locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }) }) : t('checking now…');
  $('#summary').textContent = `${tn(now.length, '{n} free to keep right now', '{n} free to keep right now')}${weekend.length ? ` · ${tn(weekend.length, '{n} free to play this weekend', '{n} free to play this weekend')}` : ''} · ${checked}`;
  const SOURCE_NAMES = { epic: t("Epic's list"), gamerpower: t('GamerPower (Steam, GOG and Prime)'), psplus: t("PlayStation's monthly games list"), psblog: t('the PlayStation Blog'), fpd: t('Xbox Wire (Free Play Days)'), humble: 'Humble Choice' };
  const failed = Object.keys(free.errors || {});
  if (failed.length) {
    content.append(el('p', { class: 'muted' }, t('Couldn\'t reach {sources} this time, so you see what it found before.', { sources: failed.map((k) => SOURCE_NAMES[k] || k).join(t(' or ')) })));
  }
  content.append(el('p', { class: 'muted free-lead' },
    tEl('Games you keep for good once claimed, plus your plans\' monthly games and free weekends. Epic\'s weekly games come from Epic\'s own store list; Steam, GOG and Prime Gaming (claimed through Amazon Luna) giveaways from {link}. PS Plus monthly games come from PlayStation\'s own list and the PlayStation Blog, Humble Choice games from Humble\'s page, and Xbox Free Play Days from Xbox Wire. You get an alert when new ones appear and on the last day of ones you haven\'t marked claimed.', {
      link: el('button', { class: 'link inline', onclick: () => api.openExternal('https://www.gamerpower.com/') }, 'GamerPower'),
    })));
  const section = (title, hint, items) => {
    if (!items.length) return;
    content.append(el('div', { class: 'section-head' }, el('h3', {}, title, el('span', { class: 'muted' }, ` ${items.length}`)), el('span', { class: 'muted' }, hint)),
      el('div', { class: 'free-grid' }, items.map(freeCard)));
  };
  section(t('Free to keep now'), t('Ending soonest first.'), now);
  section(t('Free to play this weekend'), t('Xbox Free Play Days: the full game for a few days.'), weekend);
  section(t('Coming next'), t('Epic\'s next free games and next month\'s PS Plus games.'), next);
  section(t('Claimed or not interested'), '', done);
  if (hidden.length) {
    const plans = [...new Set(hidden.map((g) => NEEDS[g.needs]))].join(t(' or '));
    content.append(el('p', { class: 'muted' },
      ui.freeAll ? tn(hidden.length, 'Showing {n} that needs {plans}, which you don\'t have. ', 'Showing {n} that need {plans}, which you don\'t have. ', { plans }) : tn(hidden.length, '{n} more needs {plans}, which you don\'t have. ', '{n} more need {plans}, which you don\'t have. ', { plans }),
      el('button', { class: 'link inline', onclick: () => { ui.freeAll = !ui.freeAll; render(true); } }, ui.freeAll ? t('Hide them') : t('Show them'))));
  }
  if (!free.games.length) content.append(el('div', { class: 'empty' }, free.at ? t('No giveaways right now.') : t('Looking for giveaways…')));
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
// onPick(key), when given, makes slices and legend rows clickable; picked is the chosen key.
function donut(slices, centre, caption, { onPick, picked } = {}) {
  const total = slices.reduce((sum, x) => sum + x.value, 0);
  const svg = svgEl('svg', { viewBox: '0 0 42 42', class: 'donut', role: 'img' });
  svg.append(svgEl('circle', { cx: 21, cy: 21, r: 15.915, fill: 'none', class: 'donut-track', 'stroke-width': 6 }));
  let offset = 25; // start at 12 o'clock
  for (const x of slices) {
    if (!x.value) continue;
    const pct = (x.value / total) * 100;
    const on = picked != null && picked === x.key;
    const ring = svgEl('circle', { cx: 21, cy: 21, r: 15.915, fill: 'none', style: `stroke:${x.color}`, 'stroke-width': on ? 7.5 : 6, 'stroke-dasharray': `${pct} ${100 - pct}`, 'stroke-dashoffset': offset, class: onPick ? 'slice' : '' });
    ring.append(svgEl('title', {}, `${x.label}: ${x.value}`));
    if (onPick) ring.addEventListener('click', () => onPick(x.key));
    svg.append(ring);
    offset -= pct;
  }
  svg.append(svgEl('text', { x: 21, y: 20.5, class: 'donut-num' }, centre), svgEl('text', { x: 21, y: 26, class: 'donut-cap' }, caption));
  const legend = el('ul', { class: `legend ${onPick ? 'pickable' : ''}` }, slices.filter((x) => x.value).map((x) => el('li', {
    class: picked != null && picked === x.key ? 'on' : '',
    onclick: onPick ? () => onPick(x.key) : null,
    title: onPick ? t('Show these games') : '',
  },
    el('span', { class: 'dot', style: `background:${x.color}` }),
    el('span', { class: 'legend-name' }, x.label),
    el('span', { class: 'legend-num' }, `${x.value}`, el('span', { class: 'muted' }, ` · ${share(x.value / total)}`)))));
  return el('div', { class: 'chart' }, svg, legend);
}

const STATUS_COLOR = { completed: '#f2c94c', playing: '#3ccf91', played: '#2a9d8f', dropped: '#e07a5f', wishlist: '#6aa8ff', untouched: 'var(--untouched)', ignored: '#6b7280' };
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

// ---------- goals ----------
// Every goal sentence, whole, per period (word order differs between languages).
const PER_TEXT = {
  week: {
    games: (n) => tn(n, 'Beat {n} game a week', 'Beat {n} games a week'),
    hours: (n) => tn(n, 'Beat {n} hour of games a week', 'Beat {n} hours of games a week'),
    done: () => t('Done this week ✓'),
    status: (left, done, target) => tn(left, '{done} of {target} this week · {n} day left', '{done} of {target} this week · {n} days left', { done, target }),
    streak: (n) => tn(n, '🔥 {n} week in a row', '🔥 {n} weeks in a row'),
    best: (n) => tn(n, 'Best: {n} week in a row', 'Best: {n} weeks in a row'),
    last: (n) => tn(n, 'The last {n} week', 'The last {n} weeks'),
  },
  month: {
    games: (n) => tn(n, 'Beat {n} game a month', 'Beat {n} games a month'),
    hours: (n) => tn(n, 'Beat {n} hour of games a month', 'Beat {n} hours of games a month'),
    done: () => t('Done this month ✓'),
    status: (left, done, target) => tn(left, '{done} of {target} this month · {n} day left', '{done} of {target} this month · {n} days left', { done, target }),
    streak: (n) => tn(n, '🔥 {n} month in a row', '🔥 {n} months in a row'),
    best: (n) => tn(n, 'Best: {n} month in a row', 'Best: {n} months in a row'),
    last: (n) => tn(n, 'The last {n} month', 'The last {n} months'),
  },
  year: {
    games: (n) => tn(n, 'Beat {n} game a year', 'Beat {n} games a year'),
    hours: (n) => tn(n, 'Beat {n} hour of games a year', 'Beat {n} hours of games a year'),
    done: () => t('Done this year ✓'),
    status: (left, done, target) => tn(left, '{done} of {target} this year · {n} day left', '{done} of {target} this year · {n} days left', { done, target }),
    streak: (n) => tn(n, '🔥 {n} year in a row', '🔥 {n} years in a row'),
    best: (n) => tn(n, 'Best: {n} year in a row', 'Best: {n} years in a row'),
    last: (n) => tn(n, 'The last {n} year', 'The last {n} years'),
  },
};
const goalTitle = (g) => (g.unit === 'hours' ? PER_TEXT[g.per].hours(g.count) : PER_TEXT[g.per].games(g.count));
function periodLabel(start, per) {
  const d = new Date(`${start}T00:00:00`);
  if (per === 'year') return start.slice(0, 4);
  if (per === 'month') return d.toLocaleDateString(I18n.locale(), { month: 'short', year: 'numeric' });
  return t('Week of {date}', { date: d.toLocaleDateString(I18n.locale(), { day: 'numeric', month: 'short' }) });
}

function finishedList() {
  return statsGames().filter((g) => markOf(g.id) === 'completed').map((g) => ({ id: g.id, title: g.title, date: finishedOf(g.id), hours: timeTaken(g) }));
}

function goalsPanel() {
  const goals = state.goals || [];
  const finished = finishedList();
  const undated = finished.filter((f) => !f.date).length;
  const today = todayIso();
  const saveGoals = async (list) => { await saveState({ goals: list }); render(true); };
  const fmtAmount = (goal, n) => (goal.unit === 'hours' ? t('{n} h', { n: Math.round(n) }) : `${n}`);

  const rows = goals.map((goal) => {
    const p = Goals.progress(goal, finished, today);
    const per = PER_TEXT[goal.per];
    const c = p.current;
    const pctDone = Math.min(100, (c.done / p.target) * 100);
    const status = c.met ? per.done() : per.status(c.left, fmtAmount(goal, c.done), fmtAmount(goal, p.target));
    const byId = new Map(finished.map((f) => [f.id, f.title]));
    const strip = p.history.slice(-12).map((x, i, arr) => {
      const now = i === arr.length - 1;
      const names = x.games.map((id) => byId.get(id)).filter(Boolean);
      return el('span', { class: `goal-cell ${x.met ? 'met' : ''} ${now ? 'now' : ''}`, title: `${periodLabel(x.start, goal.per)}: ${fmtAmount(goal, x.done)}${names.length ? ` (${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''})` : ''}` });
    });
    return el('div', { class: 'goal' },
      el('div', { class: 'goal-head' },
        el('strong', {}, goalTitle(goal)),
        el('button', { class: 'link danger inline', title: t('Remove this goal'), onclick: () => saveGoals(goals.filter((x) => x.id !== goal.id)) }, '✕')),
      el('div', { class: 'bar goal-bar' }, el('span', { class: 'bar-done', style: `width:${pctDone}%` })),
      el('div', { class: 'goal-meta' },
        el('span', {}, status),
        el('span', { class: 'goal-streak', title: per.best(p.best) },
          p.streak ? per.streak(p.streak) : t('No streak yet'), el('span', { class: 'muted' }, t(' · best {n}', { n: p.best })))),
      el('div', { class: 'goal-strip', title: per.last(strip.length) }, strip));
  });

  const count = el('input', { type: 'number', min: '1', step: '1', value: '2', class: 'goal-count' });
  const unit = el('select', {}, el('option', { value: 'games' }, t('games')), el('option', { value: 'hours' }, t('hours of games')));
  const PER_OPTION = { week: t('week'), month: t('month'), year: t('year') };
  const per = el('select', {}, ['week', 'month', 'year'].map((x) => el('option', { value: x }, PER_OPTION[x])));
  per.value = 'month';
  const add = el('button', { class: 'primary' }, t('Add goal'));
  add.onclick = () => {
    const n = Math.round(Number(count.value));
    if (!(n > 0)) return;
    saveGoals([...goals, { id: `g${Date.now().toString(36)}`, count: n, unit: unit.value, per: per.value, since: today }]);
  };
  return el('div', { class: 'panel goals' },
    el('h2', {}, t('Goals')),
    intro(goals.length
      ? t('Games count in the week, month or year you marked them completed. Hours are your hours played where you\'ve entered them or Steam has them, otherwise How Long To Beat times.')
      : t('Set a goal, like beating two games a month, and see how you\'re doing and how many months in a row you\'ve made it. Games count in the week, month or year you mark them completed.')),
    rows,
    el('div', { class: 'form goal-add' }, tEl('Beat {count} {unit} a {per}', { count, unit, per }).map((x) => (typeof x === 'string' ? (x.trim() ? el('span', {}, x.trim()) : null) : x)), add),
    undated ? el('p', { class: 'muted' }, tn(undated, '{n} completed game has no finish date (marked before goals existed), so it doesn\'t count. Open a game and set when you finished it.', '{n} completed games have no finish date (marked before goals existed), so they don\'t count. Open a game and set when you finished it.')) : null);
}

const STATS_PLATFORM_LABEL = { xbox: tk('Xbox'), pc: tk('PC'), playstation: tk('PlayStation'), switch: tk('Switch'), mobile: tk('Mobile'), vr: tk('VR'), cloud: tk('Cloud'), other: tk('Other') };
const statsPlatformName = (p) => t(STATS_PLATFORM_LABEL[p] || p);

function renderStats() {
  const content = $('#content');
  content.replaceChildren();
  const keys = unlocked();
  const subscribed = allServices().filter((s) => [...keys].some((k) => k.startsWith(`${s.id}:`))).map((s) => s.id);
  const helpers = {
    markOf: (g) => markOf(g.id),
    myServices: (g) => serviceOffers(g).filter((o) => offerIsMine(o, keys)).map((o) => o.service),
    myPlatforms: (g) => new Set(offersOf(g).filter((o) => offerIsMine(o, keys)).flatMap((o) => [...Stats.platformsOf(o)])),
    hours: (g) => (markOf(g.id) === 'completed' ? timeTaken(g) : beatHours(g)),
    score: mcScore,
    viaSub: (g) => viaSub(g, keys),
    subscribed,
  };
  const everything = statsGames();
  const all = Stats.compute(everything, helpers);
  // Platforms you have games on, in your plans or marked.
  const platforms = all.platforms.filter((r) => r.inPlans || r.marked);
  if (ui.statsPlatform !== 'all' && !platforms.some((r) => r.platform === ui.statsPlatform)) ui.statsPlatform = 'all';
  const chosen = ui.statsPlatform;
  // One platform: only its games, and only the services offering them there.
  const onChosen = (o) => Stats.platformsOf(o).has(chosen);
  const st = chosen === 'all' ? all : Stats.compute(everything.filter((g) => Stats.platformsOf(g).has(chosen)), {
    ...helpers,
    myServices: (g) => [...new Set(offersOf(g).filter((o) => offerIsMine(o, keys) && onChosen(o)).map((o) => o.service))],
    myPlatforms: () => new Set([chosen]),
  });
  const { totals } = st;
  const nameOf = (id) => (id === Stats.OTHER ? t('Not in your plans') : serviceById(id)?.name || id);
  const colorOf = (id) => (id === Stats.OTHER ? '#4b5263' : serviceById(id)?.color || '#666');
  const withGames = st.services.filter((r) => r.inPlans);
  $('#summary').textContent = withGames.length
    ? tn(withGames.length, '{count} games in your plans across {n} service', '{count} games in your plans across {n} services', { count: totals.inPlans })
    : t('Pick your plans in Settings to see how far through them you are');
  if (chosen !== 'all') $('#summary').textContent += ` · ${statsPlatformName(chosen)}`;

  content.append(goalsPanel());
  if (platforms.length > 1) {
    const pickPlatform = (p) => () => { ui.statsPlatform = p; renderStats(); };
    content.append(el('div', { class: 'stats-platforms' },
      el('span', { class: 'muted' }, t('Platform')),
      el('div', { class: 'seg' },
        el('button', { class: chosen === 'all' ? 'on' : '', onclick: pickPlatform('all') }, t('All platforms')),
        platforms.map((r) => el('button', { class: chosen === r.platform ? 'on' : '', onclick: pickPlatform(r.platform) }, statsPlatformName(r.platform))))));
  }
  if (!totals.completed && !totals.played) {
    content.append(el('div', { class: 'empty' }, chosen === 'all'
      ? t('Mark games as played or completed (or import your Steam library in Settings) and your statistics will show up here.')
      : t('You haven\'t marked any {platform} games as played or completed yet.', { platform: statsPlatformName(chosen) })));
    return;
  }

  // A clicked slice or genre lists its games under its chart; clicking it again closes the list.
  const pick = ui.statsPick;
  const picker = (chart) => (key) => {
    ui.statsPick = pick && pick.chart === chart && pick.key === key ? null : { chart, key };
    renderStats();
  };
  const pickedKey = (chart) => (pick && pick.chart === chart ? pick.key : null);
  const STATUS_LABEL = { completed: t('Completed'), playing: t('Now playing'), played: t('Played'), dropped: t('Dropped'), wishlist: t('To play'), ignored: t('Ignored'), untouched: t('Not started') };
  const pickedGames = (chart) => {
    if (!pick || pick.chart !== chart) return null;
    if (chart === 'completed') {
      const row = st.completedBy.find((x) => x.service === pick.key);
      return row && { title: t('Completed: {name}', { name: nameOf(pick.key) }), list: row.games };
    }
    if (chart === 'tiles') {
      if (pick.key === 'steam') return st.steamGames.length ? { title: t('On Steam'), list: st.steamGames } : null;
      if (pick.key === 'viaSub') return st.completedViaSub.length ? { title: t('Completed through a subscription'), list: st.completedViaSub } : null;
      return st.marked[pick.key]?.length ? { title: STATUS_LABEL[pick.key], list: st.marked[pick.key] } : null;
    }
    if (chart === 'plans') return st.planGames[pick.key]?.length ? { title: t('Your plans: {status}', { status: STATUS_LABEL[pick.key] }), list: st.planGames[pick.key] } : null;
    const row = st.genres.find((x) => x.genre === pick.key);
    return row && { title: t('Completed: {name}', { name: t(row.genre) }), list: row.games };
  };
  const pickPanel = (chart) => {
    const found = pickedGames(chart);
    if (!found) return null;
    const list = [...found.list].sort((a, b) => a.title.localeCompare(b.title, I18n.locale(), { sensitivity: 'base' }));
    const shown = list.slice(0, 60);
    return el('div', { class: 'panel stats-pick' },
      el('div', { class: 'panel-head' },
        el('h2', {}, `${found.title} · ${list.length}`),
        el('button', { class: 'link', onclick: () => { ui.statsPick = null; renderStats(); } }, t('Close'))),
      el('div', { class: 'grid' }, shown.map((g) => card(g, keys))),
      list.length > shown.length ? el('p', { class: 'muted' }, t('Showing {shown} of {total}', { shown: shown.length, total: list.length })) : null);
  };

  const tile = (value, label, title, key) => (key
    ? el('button', { class: `tile pickable ${pickedKey('tiles') === key ? 'on' : ''}`, title: title ? `${title}\n${t('Show these games')}` : t('Show these games'), onclick: () => picker('tiles')(key) }, el('div', { class: 'tile-num' }, value), el('div', { class: 'tile-label' }, label))
    : el('div', { class: 'tile', title: title || '' }, el('div', { class: 'tile-num' }, value), el('div', { class: 'tile-label' }, label)));
  content.append(el('div', { class: 'tiles' },
    tile(totals.completed, t('completed'), '', totals.completed ? 'completed' : null),
    totals.completed ? tile(st.completedViaSub.length, t('completed through a subscription'), t('Completed games ticked as played through a subscription on the Value page'), st.completedViaSub.length ? 'viaSub' : null) : null,
    tile(totals.playing, t('now playing'), '', totals.playing ? 'playing' : null),
    totals.played ? tile(totals.played, t('played'), t('Marked as played but not completed'), 'played') : null,
    totals.dropped ? tile(totals.dropped, t('dropped'), t('Started, but you stopped'), 'dropped') : null,
    st.finishRate != null ? tile(pct(st.finishRate), t('finish rate'), t('Completed out of every game you have started')) : null,
    st.time.completedTimed ? tile(t('{n}h', { n: Math.round(st.time.completed) }), t('of games finished'), t('Hours played, or How Long To Beat time, of {n} of your completed games', { n: st.time.completedTimed })) : null,
    st.averageScore != null ? tile(st.averageScore, t('average Metacritic'), t('Average score of the games you completed')) : null,
    totals.inPlans ? tile(share(st.plans.completed / totals.inPlans), t('of your plans done'), t('{done} completed out of {total} games in your plans', { done: st.plans.completed, total: totals.inPlans })) : null,
    state.steam?.owned ? tile(st.steamOwned, t('owned on Steam'), t('Games in your plans that you also own on Steam'), st.steamOwned ? 'steam' : null) : null));
  content.append(pickPanel('tiles') || '');

  content.append(el('div', { class: 'chart-row' },
    el('div', { class: 'panel' },
      el('h2', {}, t('Completed by service')),
      el('p', { class: 'muted' }, t('A game in several of your services counts for the first one listed on its card.')),
      donut(st.completedBy.map((x) => ({ key: x.service, label: nameOf(x.service), value: x.count, color: colorOf(x.service) })), totals.completed, t('completed'), { onPick: picker('completed'), picked: pickedKey('completed') })),
    el('div', { class: 'panel' },
      el('h2', {}, t('Your plans by status')),
      el('p', { class: 'muted' }, t('Every game in your plans, by how far you got with it.')),
      totals.inPlans
        ? donut(['completed', 'playing', 'played', 'dropped', 'wishlist', 'ignored', 'untouched'].map((k) => ({ key: k, label: STATUS_LABEL[k], value: st.plans[k], color: STATUS_COLOR[k] })),
          totals.inPlans, t('in plans'), { onPick: picker('plans'), picked: pickedKey('plans') })
        : el('p', { class: 'muted' }, chosen !== 'all' && keys.size ? t('None of your plans has {platform} games.', { platform: statsPlatformName(chosen) }) : t('No plans picked yet.')))));
  content.append(pickPanel('completed') || pickPanel('plans') || '');

  if (withGames.length) {
    content.append(el('div', { class: 'panel' },
      el('h2', {}, t('Progress per service')),
      withGames.map((r) => el('div', { class: 'svc-progress', style: `--svc:${colorOf(r.service)}` },
        el('div', { class: 'svc-progress-name' }, nameOf(r.service)),
        el('div', { class: 'bar', title: t('{completed} completed, {played} started, of {total}', { completed: r.completed, played: r.played, total: r.inPlans }) },
          el('span', { class: 'bar-done', style: `width:${r.inPlans ? (r.completed / r.inPlans) * 100 : 0}%` }),
          el('span', { class: 'bar-playing', style: `width:${r.inPlans ? (r.played / r.inPlans) * 100 : 0}%` })),
        el('div', { class: 'svc-progress-num' }, t('{completed} of {total} completed · {played} started', { completed: r.completed, total: r.inPlans, played: r.played }))))));
  }

  // Progress per platform, when looking at all of them. A game on several counts for each.
  const onPlatforms = platforms.filter((r) => r.inPlans);
  if (chosen === 'all' && onPlatforms.length > 1) {
    content.append(el('div', { class: 'panel' },
      el('h2', {}, t('Progress per platform')),
      el('p', { class: 'muted' }, t('Games in your plans on each platform. A game on several platforms counts for each; Switch Online games count as Switch.')),
      onPlatforms.map((r) => el('div', { class: 'svc-progress' },
        el('button', { class: 'link svc-progress-name', onclick: () => { ui.statsPlatform = r.platform; renderStats(); } }, statsPlatformName(r.platform)),
        el('div', { class: 'bar', title: t('{completed} completed, {played} started, of {total}', { completed: r.completed, played: r.played, total: r.inPlans }) },
          el('span', { class: 'bar-done', style: `width:${(r.completed / r.inPlans) * 100}%` }),
          el('span', { class: 'bar-playing', style: `width:${(r.played / r.inPlans) * 100}%` })),
        el('div', { class: 'svc-progress-num' }, t('{completed} of {total} completed · {played} started', { completed: r.completed, total: r.inPlans, played: r.played }),
          r.marked > r.completed + r.played ? el('span', { class: 'muted', title: t('Played or completed, but not in a plan you have: bought, from another tier, or marked by an import') }, ` · ${tn(r.marked - r.completed - r.played, '{n} more outside your plans', '{n} more outside your plans')}`) : null)))));
  }

  if (st.genres.length) {
    const top = st.genres.slice(0, 8);
    const most = top[0].count;
    content.append(el('div', { class: 'panel' },
      el('h2', {}, t('What you finish')),
      el('p', { class: 'muted' }, t('Genres of your completed games (a game can have more than one).')),
      top.map((x) => el('div', { class: `svc-progress ${pickedKey('genre') === x.genre ? 'on' : ''}` },
        el('button', { class: 'link svc-progress-name', title: t('Show these games'), onclick: () => picker('genre')(x.genre) }, t(x.genre)),
        el('div', { class: 'bar' }, el('span', { class: 'bar-genre', style: `width:${(x.count / most) * 100}%` })),
        el('div', { class: 'svc-progress-num' }, `${x.count}`)))));
    content.append(pickPanel('genre') || '');
  }

  if (st.time.playingTimed) {
    content.append(el('p', { class: 'muted stats-note' }, t('The {n} games you\'re playing that have a How Long To Beat time add up to about {hours} hours to beat.', { n: st.time.playingTimed, hours: Math.round(st.time.playing) })));
  }
}

// ---------- value ----------
const regionCurrency = () => state.settings.currency || null;
function money(amount, digits) {
  const currency = regionCurrency();
  if (!currency) return amount.toLocaleString(I18n.locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
  const d = digits ?? (amount >= 100 ? 0 : 2);
  return new Intl.NumberFormat(I18n.locale(), { style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d }).format(amount);
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
  const set = viaSubSet(g.id);
  if (typeof set === 'boolean') return set;
  return isMine(g, keys) && !g.steam;
}

function renderValue() {
  const content = $('#content');
  content.replaceChildren();
  const keys = unlocked();
  const includePlayed = !!state.settings.valueIncludePlayed;
  const beaten = statsGames().filter((g) => Value.counted(markOf(g.id), includePlayed));
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
    hours: valueHours,
    share: (g) => (markOf(g.id) === 'dropped' ? droppedShare(g) : 1),
    costs: state.costs || {},
    today: todayIso(),
    includePlayed,
  });
  const lookingUp = priceProgress && priceProgress.done < priceProgress.total ? t(' Looking up prices: {done} of {total}.', { done: priceProgress.done, total: priceProgress.total }) : '';
  $('#summary').textContent = `${regionCurrency() ? t('Today\'s full store prices in {currency}, not sale prices.', { currency: regionCurrency() }) : t('Today\'s full store prices, not sale prices.')}${lookingUp}`;

  const tile = (value, label, title, cls = '') => el('div', { class: `tile ${cls}`, title: title || '' }, el('div', { class: 'tile-num' }, value), el('div', { class: 'tile-label' }, label));
  const ahead = v.saved >= 0;
  content.append(el('div', { class: 'tiles' },
    tile(money(v.worth), tn(v.games, 'to buy the {n} game you beat', 'to buy the {n} games you beat'), v.priced < v.games ? t('{n} without a price yet', { n: v.games - v.priced }) : ''),
    tile(v.paid ? money(v.paid) : '—', t('paid in subscriptions'), v.paid ? '' : t('Enter what you pay below')),
    v.paid ? tile(money(Math.abs(v.saved)), ahead ? t('saved by subscribing') : t('more than buying them'), '', ahead ? 'good' : 'bad') : null,
    v.perGame ? tile(money(v.perGame), t('per game beaten'), t('What each game cost you through subscriptions')) : null,
    v.perHour ? tile(money(v.perHour, 2), t('an hour played'), v.timed < v.games
      ? t('What you paid in subscriptions over about {hours} hours of play: your hours played, or How Long To Beat times, for {timed} of the {total} games, the rest counted at their average', { hours: Math.round(v.hoursEst), timed: v.timed, total: v.games })
      : t('What you paid in subscriptions over about {hours} hours of play: your hours played, or How Long To Beat times', { hours: Math.round(v.hoursEst) })) : null,
    v.boughtPerHour ? tile(money(v.boughtPerHour, 2), t('an hour if bought'), t('Store prices over hours played (or How Long To Beat times), for the games that have both')) : null));

  const playedBox = el('input', { type: 'checkbox' });
  playedBox.checked = includePlayed;
  playedBox.addEventListener('change', async () => { await saveState({ settings: { ...state.settings, valueIncludePlayed: playedBox.checked } }); render(true); });
  content.append(el('label', { class: 'check-row value-toggle' }, playedBox, el('span', {}, t('Count games you played but didn\'t finish'))),
    intro(t('Dropped games count for the part you played: your hours over How Long To Beat\'s time, or a quarter of the price when either is missing.')));

  content.append(costsPanel(v), beatenPanel(v));
}

// What each plan costs you, to compare against: one or more stretches of
// paying per plan (a gap when you'd stopped), each at its own price.
const thisMonth = () => todayIso().slice(0, 7);
// The picker's last option: an amount you typed, or a way to type one.
const listedLabel = (p, choices) => (choices.length ? t('Your own price, a month') : t('Price a month'));
// A listed price in the picker: "Ultimate: €29.99 for 3 months (€10.00 a month)".
const choiceLabel = (c) => {
  const v = { plan: t(c.name), price: money(c.amount, 2), monthly: money(c.monthly, 2) };
  const text = c.months === 1 ? t('{plan}: {price} a month', v)
    : c.months === 12 ? t('{plan}: {price} for a year ({monthly} a month)', v)
      : tn(c.months, '{plan}: {price} for {n} month ({monthly} a month)', '{plan}: {price} for {n} months ({monthly} a month)', v);
  return c.unsure ? t('{label} (unconfirmed)', { label: text }) : text;
};
const monthBefore = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7); };

function costsPanel(v) {
  const byService = new Map(v.services.map((r) => [r.service, r]));
  const saved = (id) => Value.periodsOf(state.costs?.[id]);
  const shown = allServices().filter((s) => state.subscriptions[s.id] || saved(s.id).length || ui.valueAdded?.has(s.id));
  const savePeriods = async (id, periods) => {
    await saveState({ costs: { ...(state.costs || {}), [id]: { periods } } });
    render(true);
  };
  const currency = regionCurrency();

  const block = (s) => {
    const r = byService.get(s.id);
    const periods = saved(s.id);
    // A plan with nothing entered yet starts with one empty stretch.
    const list = periods.length ? periods : [{ from: null, to: state.subscriptions[s.id] ? null : monthBefore(thisMonth()), monthly: null }];
    const update = (i, patch) => savePeriods(s.id, list.map((p, j) => (j === i ? { ...p, ...patch } : p)));
    const tierName = (t) => s.tiers.find((x) => x.id === t)?.name || t;
    const choices = PlanPrices.options(s, currency, { tierName });

    const row = (p, i) => {
      const picker = el('select', { class: 'price-pick', title: t('List prices as of {date}', { date: PlanPrices.AS_OF }) },
        el('option', { value: '' }, choices.length ? t('Pick your plan…') : t('Enter the price')),
        [...new Set(choices.map((c) => c.name))].map((name) => el('optgroup', { label: t(name) },
          choices.filter((c) => c.name === name).map((c) => el('option', { value: `${c.plan}:${c.months}` },
            choiceLabel(c))))),
        el('option', { value: 'custom' }, listedLabel(p, choices)));
      // A listed price only while the amount still matches it (prices change).
      const listed = p.plan && choices.some((c) => `${c.plan}:${c.months}` === p.plan && c.monthly === p.monthly);
      picker.value = listed ? p.plan : (p.monthly != null || !choices.length ? 'custom' : '');
      // The amount box shows for a price of your own; a listed price says it all.
      const monthly = el('input', { type: 'number', min: '0', step: '0.01', placeholder: t('a month'), value: p.monthly ?? '' });
      const own = el('span', { class: 'own-price', title: t('What you paid a month') }, monthly);
      own.hidden = picker.value !== 'custom';
      picker.addEventListener('change', () => {
        const c = choices.find((x) => `${x.plan}:${x.months}` === picker.value);
        if (c) update(i, { monthly: c.monthly, plan: picker.value });
        else if (picker.value === 'custom') {
          own.hidden = false;
          monthly.focus();
        }
      });
      monthly.addEventListener('change', () => update(i, { monthly: monthly.value === '' ? null : Number(monthly.value), plan: null }));
      const from = el('input', { type: 'month', value: p.from || '', max: thisMonth() });
      from.addEventListener('change', () => update(i, { from: from.value || null }));
      const ongoing = el('input', { type: 'checkbox' });
      ongoing.checked = !p.to;
      const to = p.to ? el('input', { type: 'month', value: p.to, max: thisMonth(), min: p.from || '' }) : el('span', { class: 'period-now' }, t('now'));
      to.addEventListener('change', () => update(i, { to: to.value || null }));
      ongoing.addEventListener('change', () => update(i, { to: ongoing.checked ? null : (p.from && p.from > monthBefore(thisMonth()) ? p.from : monthBefore(thisMonth())) }));
      const paid = r?.periods?.find((x) => x.from === p.from && x.to === p.to && x.monthly === p.monthly);
      return el('div', { class: 'period' },
        el('div', { class: 'period-price' }, picker, own),
        el('div', { class: 'period-dates' },
          el('span', { class: 'muted' }, t('from')), from, el('span', { class: 'muted' }, t('to')), to,
          el('label', { class: 'check-row inline' }, ongoing, el('span', {}, t('still paying')))),
        el('div', { class: 'period-sum' },
          el('span', { class: 'muted' }, paid?.months ? tn(paid.months, '{n} mo, {price}', '{n} mo, {price}', { price: money(paid.paid) }) : p.monthly && !p.from ? t('Set a start') : ''),
          list.length > 1 || periods.length ? el('button', { class: 'link danger inline', title: t('Remove this period'), onclick: () => savePeriods(s.id, list.filter((_, j) => j !== i)) }, '✕') : null));
    };

    const verdict = r && r.paid ? (r.value >= r.paid ? t('saved {price}', { price: money(r.value - r.paid) }) : t('{price} more than buying', { price: money(r.paid - r.value) })) : '';
    const last = list[list.length - 1];
    return el('div', { class: 'cost-block', style: `--svc:${s.color}` },
      el('div', { class: 'cost-head' },
        el('div', { class: 'cost-name' }, el('span', { class: 'dot', style: `background:${s.color}` }), s.name, state.subscriptions[s.id] ? null : el('span', { class: 'tier' }, t('not in your plans now'))),
        el('div', { class: 'cost-sum' },
          r?.paid ? el('div', {}, tn(r.months, '{price} paid over {n} month', '{price} paid over {n} months', { price: money(r.paid) })) : el('div', { class: 'muted' }, t('Not counted yet')),
          r?.games ? el('div', { class: 'muted' }, `${t('{n} beaten, worth {price}', { n: r.games, price: money(r.value) })}${verdict ? ` · ${verdict}` : ''}`) : null,
          r?.perHour ? el('div', { class: 'muted', title: r.timed < r.games ? t('Hours for {timed} of {total} games; the rest counted at their average', { timed: r.timed, total: r.games }) : t('From your hours played, or How Long To Beat times') }, t('{price} an hour over about {hours} hours', { price: money(r.perHour, 2), hours: Math.round(r.hoursEst) })) : null)),
      list.map(row),
      el('button', { class: 'link inline add-period', onclick: () => {
        // Usually an earlier stretch: ended, with the same price to start from.
        const end = list.filter((p) => p.from).map((p) => p.from).sort()[0];
        savePeriods(s.id, [...(periods.length ? list : []), { from: null, to: end ? monthBefore(end) : monthBefore(thisMonth()), monthly: last?.monthly ?? null, ...(last?.plan ? { plan: last.plan } : {}) }]);
      } }, t('+ Add another period')));
  };

  const others = allServices().filter((s) => !shown.includes(s));
  const addPast = el('select', {}, el('option', { value: '' }, t('Add a plan you paid for before…')), others.map((s) => el('option', { value: s.id }, s.name)));
  addPast.addEventListener('change', () => {
    if (!addPast.value) return;
    ui.valueAdded = new Set([...(ui.valueAdded || []), addPast.value]);
    render(true);
  });
  return el('div', { class: 'panel' },
    el('h2', {}, t('What you pay')),
    intro(t('Pick each plan and its price (the list shows today\'s prices; change the amount if you paid something else), and when you started. ')
      + t('If you stopped and came back later, untick "still paying", set when it ended and add another period. ')
      + t('Yearly plans count as their price spread over 12 months. Leave out plans that come included with another, like EA Play with Game Pass Ultimate.')),
    shown.length ? shown.map(block) : el('p', { class: 'muted' }, t('Pick your plans in Settings, or add one you paid for before below.')),
    others.length ? el('div', { class: 'form add-past' }, addPast) : null);
}

// Every beaten game, its price, and whether it counts.
function beatenPanel(v) {
  const keys = unlocked();
  const all = statsGames().filter((g) => Value.counted(markOf(g.id), !!state.settings.valueIncludePlayed));
  const counted = new Set(v.list.map((x) => x.game.id));
  all.sort((a, b) => (counted.has(b.id) - counted.has(a.id)) || ((priceOf(b)?.amount || 0) - (priceOf(a)?.amount || 0)) || a.title.localeCompare(b.title, I18n.locale()));
  const rows = all.map((g) => {
    const on = counted.has(g.id);
    const box = el('input', { type: 'checkbox', title: t('Played through a subscription') });
    box.checked = on;
    box.addEventListener('change', async () => {
      const next = { ...(state.viaSub || {}) };
      for (const x of markIds(g.id)) delete next[x];
      next[g.id] = box.checked;
      await saveState({ viaSub: next });
      render(true);
    });
    const p = priceOf(g);
    const looked = prices[g.id];
    const input = el('input', { type: 'number', min: '0', step: '0.01', class: 'price-input', placeholder: looked ? t('enter price') : t('looking up…'), value: p?.manual ? p.amount : '' });
    input.addEventListener('change', async () => {
      const overrides = { ...(state.priceOverrides || {}) };
      if (input.value === '') delete overrides[g.id];
      else overrides[g.id] = Number(input.value);
      await saveState({ priceOverrides: overrides });
      render(true);
    });
    const shown = p && !p.manual
      ? el('span', { class: 'price' }, el('button', { class: 'link inline', title: t('Full price on {store}', { store: p.source }), onclick: () => p.url && api.openExternal(p.url) }, money(p.amount, 2)), el('span', { class: 'muted' }, ` ${p.source}`),
        el('button', { class: 'link inline price-edit', title: t('Use a different price'), onclick: (e) => { e.currentTarget.parentElement.replaceWith(input); input.focus(); } }, t('edit')))
      : input;
    const h = valueHours(g);
    const dropped = markOf(g.id) === 'dropped';
    const part = dropped ? droppedShare(g) : 1;
    const source = dropped && !playedHours(g) ? t('A quarter of How Long To Beat\'s time') : timeSource(g);
    const time = h ? el('span', { class: 'beaten-hours muted', title: p?.amount > 0 ? t('{source}, and the price over those hours', { source }) : source },
      `${t('{n} h', { n: h < 1 ? '<1' : Math.round(h) })}${p?.amount > 0 ? ` · ${t('{price}/h', { price: money((p.amount * part) / Math.max(h, 0.5), 2) })}` : ''}`) : el('span', { class: 'beaten-hours' });
    const markTag = markOf(g.id) === 'played' ? el('span', { class: 'tier' }, t('played'))
      : markOf(g.id) === 'playing' ? el('span', { class: 'tier' }, t('now playing'))
      : dropped ? el('span', { class: 'tier dropped', title: playedHours(g) && beatHours(g) ? t('Counts for the part you played: your hours over How Long To Beat\'s time') : t('Counts for a quarter of its price: add your hours played in its details to count the part you played') }, t('dropped · {percent}%', { percent: Math.round(part * 100) }))
      : null;
    const node = el('div', { class: `beaten-row ${on ? '' : 'off'}` },
      el('label', { class: 'beaten-check' }, box, el('span', { class: 'beaten-title', title: g.title }, g.title)),
      el('div', { class: 'meta' }, serviceOffers(g).slice(0, 3).map((o) => serviceTag(o)), markTag),
      time,
      shown);
    return { g, on, node };
  });
  // Search and the ticked/unticked filter hide rows in place, so typing keeps its focus.
  const search = el('input', { type: 'search', class: 'beaten-search', placeholder: t('Search your games…'), value: ui.valueQuery || '' });
  const which = el('select', { class: 'beaten-which' },
    [['all', t('All games')], ['on', t('Ticked: played through a subscription')], ['off', t('Unticked: bought or played elsewhere')]].map(([v, label]) => el('option', { value: v }, label)));
  which.value = ui.valueWhich || 'all';
  const count = el('p', { class: 'muted beaten-count' });
  const filter = () => {
    const q = search.value.trim().toLowerCase();
    let shownRows = 0;
    for (const r of rows) {
      const show = (!q || r.g.title.toLowerCase().includes(q)) && (which.value === 'all' || (which.value === 'on') === r.on);
      r.node.hidden = !show;
      if (show) shownRows += 1;
    }
    count.textContent = q || which.value !== 'all' ? t('Showing {shown} of {total}', { shown: shownRows, total: rows.length }) : '';
    count.hidden = !count.textContent;
  };
  search.addEventListener('input', () => { ui.valueQuery = search.value; filter(); });
  which.addEventListener('change', () => { ui.valueWhich = which.value; filter(); });
  filter();
  return el('div', { class: 'panel' },
    el('h2', {}, t('Games you beat')),
    intro(t('Untick games you bought or played some other way; they don\'t count. Games you mark as completed start unticked, so tick the ones a subscription paid for. Prices come from the service\'s own store, else Steam; Switch Online classics aren\'t sold anywhere, so enter what they\'re worth to you.')),
    rows.length ? [el('div', { class: 'form beaten-tools' }, search, which), count, ...rows.map((r) => r.node)] : el('p', { class: 'muted' }, t('Mark games as completed and they show up here.')));
}

// Settings in tabs, one subject each.
const SETTINGS_TABS = [['plans', tk('Plans')], ['region', tk('Region and language')], ['look', tk('Appearance')], ['accounts', tk('Accounts')], ['app', tk('Background and updates')], ['backup', tk('Backup and sync')], ['sources', tk('Data sources')]];

function renderSubs() {
  $('#summary').textContent = t('Everything here is saved on this computer.');
  const content = $('#content');
  content.replaceChildren();
  const tab = SETTINGS_TABS.some(([id]) => id === ui.settingsTab) ? ui.settingsTab : 'plans';
  content.append(el('div', { class: 'tabs', role: 'tablist' }, SETTINGS_TABS.map(([id, label]) => el('button', {
    class: `tab ${id === tab ? 'on' : ''}`,
    role: 'tab',
    'aria-selected': String(id === tab),
    onclick: () => { ui.settingsTab = id; $('#content').scrollTop = 0; render(); },
  }, t(label)))));
  if (tab !== 'plans') {
    const panels = { region: () => [regionPanel()], look: () => [appearancePanel()], accounts: () => [steamPanel(), achievementsPanel('xbox'), achievementsPanel('psn')], app: () => [backgroundPanel(), updatePanel()], backup: () => [syncPanel(), backupPanel()], sources: () => [sourcesPanel()] };
    content.append(...panels[tab]());
    return;
  }

  const rows = allServices().map((s) => {
    const current = state.subscriptions[s.id] || '';
    const pick = async (tierId) => {
      await saveState({ subscriptions: { ...state.subscriptions, [s.id]: tierId || undefined } });
      render(true);
    };
    const cat = catalogs.find((c) => c.service === s.id);
    const count = cat ? cat.games.length : (state.customGames || []).filter((g) => g.service === s.id).length;
    return el('div', { class: 'sub-row', style: `--svc:${s.color}` },
      el('div', { class: 'sub-name' }, el('strong', {}, s.name), el('span', { class: 'muted' }, tn(count, '{n} game', '{n} games'))),
      el('div', { class: 'seg' },
        el('button', { class: current ? '' : 'on', onclick: () => pick('') }, t('Not subscribed')),
        s.tiers.map((t) => el('button', { class: current === t.id ? 'on' : '', onclick: () => pick(t.id) }, t.name))),
      s.custom ? el('button', { class: 'link danger', onclick: () => removeCustomService(s) }, t('Remove')) : null);
  });

  content.append(el('div', { class: 'panel' },
    el('div', { class: 'panel-head' }, el('h2', {}, t('My subscriptions')), el('button', { class: 'link', onclick: startOnboarding }, t('Run the welcome setup again'))),
    rows));
  content.append(playTimePanel(), gameLengthPanel(), customServicePanel(), customGamePanel());
}

// Dark, light, or whatever the system uses. The main process sets Electron's
// theme, and the styles follow it.
function appearancePanel() {
  const current = state.settings.theme || 'dark';
  const pick = (theme) => async () => {
    await saveState({ settings: { ...state.settings, theme } });
    render(true);
  };
  const options = [['dark', t('Dark')], ['light', t('Light')], ['system', system.platform === 'win32' ? t('Same as Windows') : t('Same as the system')]];
  return el('div', { class: 'panel' },
    el('h2', {}, t('Appearance')),
    el('p', { class: 'muted' }, t('Colour theme for Subscroll\'s window.')),
    el('div', { class: 'seg', style: '--svc:#6aa8ff' }, options.map(([id, label]) => el('button', { class: current === id ? 'on' : '', onclick: pick(id) }, label))));
}

// How long you play a day: used instead of the estimate from imports.
function playTimePanel() {
  const pace = playPace();
  return el('div', { class: 'panel' },
    el('h2', {}, t('How much you play')),
    el('p', { class: 'muted' }, t('About how long you play games a day. Subscroll uses it to tell whether you can finish games before they leave, instead of working it out from your Steam playtime and the games you complete. Leave it empty to let Subscroll work it out.')),
    el('div', { class: 'form' }, el('label', { class: 'pace-hours' }, el('span', {}, t('You play')), playTimeControl())),
    el('p', { class: 'muted' }, pace.source === 'setting'
      ? t('Using what you set: about {pace} a day.', { pace: fmtPerDay(pace.perDay) })
      : t('Worked out for now: about {pace} a day, {source}.', { pace: fmtPerDay(pace.perDay), source: paceSource(pace) })));
}

// Which How Long To Beat time counts: main story by default, 100% for completionists.
function gameLengthPanel() {
  const current = hltbKind();
  const pick = (kind) => async () => {
    await saveState({ settings: { ...state.settings, hltbTime: kind === 'main' ? null : kind } });
    render(true);
  };
  const options = [['main', t('Main story')], ['plus', t('Main + extras')], ['all', t('Completionist (100%)')]];
  return el('div', { class: 'panel' },
    el('h2', {}, t('Game length')),
    el('p', { class: 'muted' }, t('Which How Long To Beat time Subscroll shows on cards and uses for time to beat: whether you can finish a game before it leaves, Plan ahead, To play and Now playing, Statistics and cost per hour. If you play everything to 100%, pick Completionist. A game without that time uses the next longer one.')),
    el('div', { class: 'seg', style: '--svc:#6aa8ff' }, options.map(([id, label]) => el('button', { class: current === id ? 'on' : '', onclick: pick(id) }, label))));
}

// Tray, start at login and alerts.
// What the app can do on this computer: { platform, startAtLogin: its label, or null }.
let system = { platform: 'win32', startAtLogin: null };
function backgroundPanel() {
  const toggle = (key, label, hint, fallback) => {
    const box = el('input', { type: 'checkbox' });
    box.checked = state.settings[key] ?? fallback;
    box.addEventListener('change', () => saveState({ settings: { ...state.settings, [key]: box.checked } }));
    return el('label', { class: 'check-row' }, box, el('span', {}, el('strong', {}, label), el('span', { class: 'muted' }, ` ${hint}`)));
  };
  return el('div', { class: 'panel' },
    el('h2', {}, t('Background')),
    el('p', { class: 'muted' }, t('Subscroll can keep running in the system tray and check the lists once a day, so you hear about new and leaving games without opening it.')),
    el('div', { class: 'checks' },
      toggle('closeToTray', t('Keep running in the tray when the window is closed.'), t('Quit from the tray icon\'s menu.'), true),
      system.startAtLogin ? toggle('startWithWindows', `${t(system.startAtLogin)}.`, t('Starts in the tray, without opening the window.'), false) : null,
      toggle('alerts', t('Alerts.'), t('A notification when games join a service in your plans, or games in your plans start leaving. Completed and ignored games are left out.'), true),
      toggle('freeAlerts', t('Free game alerts.'), t('A notification when new games are free to keep, and on the last day of ones you haven\'t marked claimed.'), true),
      toggle('saleAlerts', t('Sale alerts.'), t('A notification when a To play game that isn\'t in your plans goes on sale (Microsoft Store, PlayStation Store or Steam).'), true)));
}

// ---------- newer version ----------
// { current, latest: { version, page, download }, newer, checkedAt, error,
//   canInstall, downloading: { version, got, total }, ready: { version }, downloadError }
let update = null;
const openDownload = () => api.openExternal(update.latest.download?.url || update.latest.page);
const percent = (d) => (d && d.total ? Math.min(100, Math.round((d.got / d.total) * 100)) : 0);
const restartButton = (cls) => el('button', { class: cls, onclick: () => api.installUpdate() }, t('Restart to update'));
async function startDownload() {
  update = await api.downloadUpdate();
  renderUpdateBanner();
  $('#update-panel')?.replaceWith(updatePanel());
}

// A line in the sidebar while a newer version is out, until you close it.
function renderUpdateBanner() {
  const box = $('#update-banner');
  const ready = update?.ready;
  const v = (ready && ready.version) || (update?.newer && update.latest.version);
  if (!v || (!ready && state.settings.updateDismissed === v)) {
    box.replaceChildren();
    return;
  }
  let text;
  let actions;
  if (ready) {
    text = [el('strong', {}, t('Subscroll {version} is ready', { version: v })), el('span', { class: 'muted' }, t('Restart to update, or it updates the next time Subscroll starts.'))];
    actions = [restartButton('primary')];
  } else if (update.downloading) {
    text = [el('strong', {}, t('Downloading Subscroll {version}…', { version: v })), el('span', { class: 'muted' }, t('{percent}% done', { percent: percent(update.downloading) }))];
    actions = [];
  } else {
    text = [el('strong', {}, t('Subscroll {version} is out', { version: v })), el('span', { class: 'muted' }, t('You have {version}.', { version: update.current }))];
    actions = [update.canInstall ? el('button', { class: 'primary', onclick: startDownload }, t('Update')) : el('button', { class: 'primary', onclick: openDownload }, t('Download'))];
  }
  box.replaceChildren(
    el('div', { class: 'update-text' }, text),
    el('div', { class: 'update-actions' }, actions,
      el('button', { class: 'link', onclick: () => api.openExternal(update.latest?.page || update.releases) }, t('What\'s new'))),
    ready ? null : el('button', { class: 'link close', title: t('Hide until the next version'), onclick: async () => { await saveState({ settings: { ...state.settings, updateDismissed: v } }); renderUpdateBanner(); } }, '✕'));
}

function updateLine() {
  if (!update) return t('Not checked yet.');
  if (update.ready) return t('Subscroll {version} is downloaded and installs when you restart.', { version: update.ready.version });
  if (update.downloading) return t('Downloading Subscroll {version}: {percent}% done.', { version: update.downloading.version, percent: percent(update.downloading) });
  const when = update.checkedAt ? new Date(update.checkedAt).toLocaleString(I18n.locale()) : null;
  if (update.newer) {
    const failed = update.downloadError ? ` ${t('The download failed: {error}', { error: update.downloadError })}` : '';
    return `${t('Subscroll {version} is out.', { version: update.latest.version })}${failed}`;
  }
  if (update.error && !when) return t('Couldn\'t check: {error}', { error: update.error });
  if (!when) return t('Not checked yet.');
  return `${t('You have the latest version (checked {when}).', { when })}${update.error ? ` ${t('The last check failed: {error}', { error: update.error })}` : ''}`;
}

function updatePanel() {
  const box = el('input', { type: 'checkbox' });
  box.checked = state.settings.updateCheck !== false;
  box.addEventListener('change', () => saveState({ settings: { ...state.settings, updateCheck: box.checked } }));
  const auto = el('input', { type: 'checkbox' });
  auto.checked = state.settings.autoUpdate !== false;
  auto.disabled = !box.checked;
  box.addEventListener('change', () => { auto.disabled = !box.checked; });
  auto.addEventListener('change', () => saveState({ settings: { ...state.settings, autoUpdate: auto.checked } }));
  const line = el('p', { class: 'muted' }, updateLine());
  const button = el('button', {}, t('Check now'));
  button.onclick = async () => {
    button.disabled = true;
    line.textContent = t('Checking…');
    try {
      update = await api.checkUpdate();
    } catch (e) {
      update = { ...(update || {}), error: e.message };
    }
    button.disabled = false;
    renderUpdateBanner();
    $('#update-panel')?.replaceWith(updatePanel());
  };
  const installs = !!system.selfUpdate;
  const file = system.platform === 'linux' ? 'AppImage' : 'exe';
  let action = null;
  if (update?.ready) action = restartButton('primary');
  else if (update?.newer && update.canInstall && !update.downloading) action = el('button', { class: 'primary', onclick: startDownload }, t('Download and install {version}', { version: update.latest.version }));
  else if (update?.newer && !update.canInstall) action = el('button', { class: 'primary', onclick: openDownload }, t('Download {version}', { version: update.latest.version }));
  const panel = el('div', { class: 'panel' },
    el('h2', {}, t('Updates')),
    el('p', { class: 'muted' }, installs
      ? t('You have Subscroll {version}. New versions are published on GitHub, and the app checks twice a day. It downloads a new version next to this {file}, checks it against GitHub\'s checksum, and switches to it when you restart Subscroll (or the next time it starts); the old {file} is then deleted. Your plans, marks and settings carry over.', { version: system.version || update?.current || '', file })
      : t('You have Subscroll {version}. New versions are published on GitHub; the app checks twice a day and tells you when one is out. Your plans, marks and settings carry over.', { version: system.version || update?.current || '' })),
    installs && system.platform === 'win32' ? el('p', { class: 'muted' }, t('Pinned Subscroll to the taskbar or made a shortcut? Rename the exe to Subscroll.exe first: updates then keep that name, so the shortcut keeps working.')) : null,
    el('label', { class: 'check-row' }, box, el('span', {}, el('strong', {}, t('Check for new versions.')))),
    installs ? el('label', { class: 'check-row' }, auto, el('span', {}, el('strong', {}, t('Download and install new versions by itself.')), ' ', t('Turn this off to choose when.'))) : null,
    line,
    el('div', { class: 'row-actions' }, button, action,
      el('button', { class: 'link', onclick: () => api.openExternal(update?.latest?.page || update?.releases || 'https://github.com/viruztt/subscroll/releases') }, update?.newer ? t('What\'s new') : t('All releases'))));
  panel.id = 'update-panel';
  return panel;
}

// Steam library import: owned games get a badge, played ones a mark.
function steamPanel() {
  const s = state.steam;
  const profile = el('input', { placeholder: t('Steam profile link or Steam ID'), value: s?.profile || '' });
  const key = el('input', { type: 'password', placeholder: s?.key ? t('API key saved (enter a new one to replace it)') : t('Steam Web API key'), autocomplete: 'off' });
  const status = el('p', { class: 'muted' });
  status.id = 'steam-status';
  if (s?.importedAt) status.textContent = tn(s.count, 'Last imported {date}: {n} game in your Steam library.', 'Last imported {date}: {n} games in your Steam library.', { date: new Date(s.importedAt).toLocaleString(I18n.locale()) });
  const button = el('button', { class: 'primary' }, s ? t('Import again') : t('Import'));
  button.onclick = async () => {
    button.disabled = true;
    status.textContent = t('Reading your Steam library…');
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
    const markedText = marked ? tn(marked, '{n} was newly marked as played', '{n} were newly marked as played') : t('none needed marking as played');
    if (fresh) fresh.textContent = `${tn(owned, 'Found {n} game on Steam.', 'Found {n} games on Steam.')} ${tn(inCatalogue, '{n} of them is in the services here, and {marked}.', '{n} of them are in the services here, and {marked}.', { marked: markedText })}`;
  };
  const forget = async () => {
    state = await api.forgetSteam();
    rebuildGames();
    render(true);
  };
  const keyLink = el('button', { class: 'link inline', onclick: () => api.openExternal('https://steamcommunity.com/dev/apikey') }, 'steamcommunity.com/dev/apikey');
  return el('div', { class: 'panel' },
    el('h2', {}, t('Steam library')),
    el('p', { class: 'muted' },
      t('Games you own on Steam get an "On Steam" badge, and games you\'ve played there for {minutes} minutes or more are marked as played (once, so you can still unmark them). It\'s read again with the daily refresh. ', { minutes: STEAM_PLAYED_MINUTES }),
      tEl('You need a free Web API key from {link} (sign in, type any domain such as localhost, and copy the key), and your Steam profile\'s Game details set to Public.', { link: keyLink })),
    el('div', { class: 'form' }, profile, key, button,
      s ? el('button', { class: 'link danger', onclick: forget }, t('Forget Steam')) : null),
    status);
}

// Xbox achievements (OpenXBL key) and PlayStation trophies (NPSSO code).
// Sentences are functions, so they're translated when shown.
const ACHIEVEMENTS = {
  xbox: {
    title: tk('Xbox achievements'), field: 'key', forget: tk('Forget Xbox'), reading: tk('Reading your achievements…'),
    placeholder: tk('OpenXBL API key'), saved: tk('API key saved (enter a new one to replace it)'),
    link: 'https://xbl.io', linkText: 'xbl.io',
    imported: (n, date) => tn(n, 'Last imported {date}: {n} game with achievements.', 'Last imported {date}: {n} games with achievements.', { date }),
    found: (n) => tn(n, 'Found {n} game with Xbox achievements.', 'Found {n} games with Xbox achievements.'),
    intro: () => t('Games you\'ve earned Xbox achievements in are marked as played, and games at 100% as completed. Each game is marked once, so you can still change it. It\'s read again with the daily refresh. '),
    how: (link) => tEl('You need a free API key from {link} (sign in with your Xbox account, open your profile and create an API key). OpenXBL is a free service that reads your achievements from Xbox Live; its free plan allows 150 requests an hour, far more than Subscroll uses.', { link }),
  },
  psn: {
    title: tk('PlayStation trophies'), field: 'npsso', forget: tk('Forget PlayStation'), reading: tk('Reading your trophies…'),
    placeholder: tk('NPSSO code'), saved: tk('NPSSO code saved (enter a new one to replace it)'),
    link: 'https://ca.account.sony.com/api/v1/ssocookie', linkText: 'ca.account.sony.com/api/v1/ssocookie',
    imported: (n, date) => tn(n, 'Last imported {date}: {n} game with trophies.', 'Last imported {date}: {n} games with trophies.', { date }),
    found: (n) => tn(n, 'Found {n} game with PlayStation trophies.', 'Found {n} games with PlayStation trophies.'),
    intro: () => t('Games you\'ve earned PlayStation trophies in are marked as played, and games at 100% (or with the platinum trophy) as completed. Each game is marked once, so you can still change it. It\'s read again with the daily refresh. '),
    how: (link) => tEl('You need your NPSSO code: open {link} while signed in at playstation.com, and copy the 64-character "npsso" value. Treat it like a password: it signs in to your PlayStation account. Sony makes it run out after about two months, after which you paste a new one.', { link }),
  },
};

function achievementsPanel(kind) {
  const c = ACHIEVEMENTS[kind];
  const a = state[kind];
  const secret = el('input', { type: 'password', placeholder: a?.[c.field] ? t(c.saved) : t(c.placeholder), autocomplete: 'off' });
  const status = el('p', { class: 'muted' });
  status.id = `${kind}-status`;
  if (a?.importedAt) status.textContent = c.imported(a.count, new Date(a.importedAt).toLocaleString(I18n.locale()));
  const button = el('button', { class: 'primary' }, a ? t('Import again') : t('Import'));
  button.onclick = async () => {
    button.disabled = true;
    status.textContent = t(c.reading);
    const r = await api.importAchievements(kind, secret.value);
    button.disabled = false;
    if (!r.ok) {
      status.textContent = r.error;
      return;
    }
    state = r.state;
    rebuildGames();
    render(true);
    const { titles, inCatalogue, played, completed } = r.summary;
    const playedText = played ? tn(played, '{n} newly marked as played', '{n} newly marked as played') : '';
    const completedText = completed ? tn(completed, '{n} as completed', '{n} as completed') : '';
    const news = playedText && completedText ? t('{played} and {completed}', { played: playedText, completed: completedText }) : playedText || completedText;
    const fresh = document.querySelector(`#${kind}-status`);
    if (fresh) fresh.textContent = `${c.found(titles)} ${news ? tn(inCatalogue, '{n} of them is in the services here: {news}.', '{n} of them are in the services here: {news}.', { news }) : tn(inCatalogue, '{n} of them is in the services here, and none needed new marks.', '{n} of them are in the services here, and none needed new marks.')}`;
  };
  const forget = async () => {
    state = await api.forgetAchievements(kind);
    rebuildGames();
    render(true);
  };
  return el('div', { class: 'panel' },
    el('h2', {}, t(c.title)),
    el('p', { class: 'muted' },
      c.intro(),
      c.how(el('button', { class: 'link inline', onclick: () => api.openExternal(c.link) }, c.linkText))),
    el('div', { class: 'form' }, secret, button,
      a ? el('button', { class: 'link danger', onclick: forget }, t(c.forget)) : null),
    status);
}

// "Xbox: 12 of 50 achievements (24%)" in the game drawer.
function achievementRows(g) {
  const key = Unify.matchKey(g.title);
  return ['xbox', 'psn'].flatMap((kind) => {
    const a = state[kind]?.titles?.[key];
    if (!a) return [];
    const label = kind === 'xbox' ? 'Xbox' : t('Trophies');
    const count = kind === 'xbox'
      ? (a.total ? tn(a.total, '{earned} of {n} achievement', '{earned} of {n} achievements', { earned: a.earned }) : tn(a.earned, '{n} achievement', '{n} achievements'))
      : (a.total ? tn(a.total, '{earned} of {n} trophy', '{earned} of {n} trophies', { earned: a.earned }) : tn(a.earned, '{n} trophy', '{n} trophies'));
    return [el('dt', {}, label), el('dd', {}, a.completed ? t('{count}, {progress}% (completed)', { count, progress: a.progress }) : t('{count}, {progress}%', { count, progress: a.progress }))];
  });
}

// Sync through a folder a cloud drive keeps the same everywhere (src/sync.js).
let syncStatus = null;
function syncPanel() {
  const panel = el('div', { class: 'panel', id: 'sync-panel' }, el('h2', {}, t('Sync between devices')));
  panel.append(el('p', { class: 'muted' }, t('Pick a folder that Google Drive, OneDrive, Dropbox or iCloud keeps the same on all your devices, then pick the same folder in Subscroll on each of them. Your plans, marks, To play list, stars, notes, goals and settings then stay in step. When two devices change the same game, the latest change wins. Scores, prices and catalogues aren\'t synced: each device looks them up itself.')));
  const st = syncStatus;
  if (!st) {
    api.getSync().then((x) => { syncStatus = x; $('#sync-panel')?.replaceWith(syncPanel()); }).catch(() => {});
    return panel;
  }
  const after = async (r) => {
    if (!r || r.ok === false) return;
    syncStatus = r.status;
    state = r.state;
    rebuildGames();
    render(true);
  };
  const when = (iso) => new Date(iso).toLocaleString(I18n.locale(), { dateStyle: 'medium', timeStyle: 'short' });
  if (!st.folder) {
    panel.append(el('p', {}, t('Not syncing. Everything stays on this computer.')),
      el('div', { class: 'form' }, el('button', { class: 'primary', onclick: async () => after(await api.chooseSyncFolder()) }, t('Choose folder…'))));
    return panel;
  }
  const box = el('input', { type: 'checkbox' });
  box.checked = !!st.accounts;
  box.addEventListener('change', async () => after(await api.setSyncAccounts(box.checked)));
  const lines = [t('Syncing through {folder}', { folder: st.folder }), t('This device: {name}.', { name: st.name })];
  if (st.error) lines.push(t('Can\'t sync: {error}', { error: st.error }));
  else if (st.lastSync) lines.push(t('Last synced {time}.', { time: when(st.lastSync) }));
  lines.push(st.devices.length ? t('Other devices: {names}.', { names: st.devices.map((d) => d.name).join(', ') }) : t('No other device has synced through this folder yet.'));
  panel.append(
    el('div', { class: 'sync-lines' }, lines.map((x, i) => el('p', { class: i ? 'muted' : '' }, x))),
    el('div', { class: 'checks' }, el('label', { class: 'check-row' }, box, el('span', {}, el('strong', {}, t('Include Steam, Xbox and PlayStation links.')), el('span', { class: 'muted' }, ` ${t('Their keys are then saved in the sync folder too, so only tick this for a folder that only you can open.')}`)))),
    el('div', { class: 'form' },
      el('button', { class: 'primary', onclick: async () => after(await api.syncNow()) }, t('Sync now')),
      el('button', { onclick: async () => after(await api.chooseSyncFolder()) }, t('Change folder…')),
      el('button', { class: 'link danger', onclick: async () => after(await api.stopSync()) }, t('Stop syncing'))));
  return panel;
}

// The last export or import result, kept while the page is rebuilt.
let profileNote = '';
// Everything Subscroll keeps about you in one file, to keep safe or move to another PC.
function backupPanel() {
  const size = (b) => (b >= 1048576 ? t('{size} MB', { size: (b / 1048576).toFixed(1) }) : t('{size} KB', { size: Math.max(1, Math.round(b / 1024)) }));
  const status = el('p', { class: 'muted' }, profileNote);
  const lookups = el('input', { type: 'checkbox', checked: '' });
  const exportIt = async () => {
    const r = await api.exportBackup({ lookups: lookups.checked });
    if (r.ok) status.textContent = profileNote = tn(r.marks, 'Exported {n} marked game, your plans and settings ({size}) to {file}', 'Exported {n} marked games, your plans and settings ({size}) to {file}', { size: size(r.bytes), file: r.file });
  };
  const restore = async () => {
    const r = await api.importBackup();
    if (r.error) {
      status.textContent = profileNote = r.error;
    } else if (r.ok) {
      profileNote = r.looked
        ? tn(r.marks, 'Imported {n} marked game, your plans and settings, plus {looked}.', 'Imported {n} marked games, your plans and settings, plus {looked}.', { looked: tn(r.looked, '{n} looked-up detail such as scores and prices', '{n} looked-up details such as scores and prices') })
        : tn(r.marks, 'Imported {n} marked game, your plans and settings.', 'Imported {n} marked games, your plans and settings.');
      state = r.state;
      rebuildGames();
      // Rebuilds this panel, which shows the note.
      render(true);
    }
  };
  status.id = 'backup-status';
  return el('div', { class: 'panel' },
    el('h2', {}, t('Export & import profile')),
    el('p', { class: 'muted' },
      t('Everything Subscroll keeps about you in one JSON file: plans, marks, To play list, your own services and games, settings, Value page costs, Steam link, free games you claimed, and when games joined or left each list. ')
      + t('Keep it safe or move it to another PC. Importing replaces your plans, marks and settings on this PC, and adds the history and looked-up data to what it already has. ')
      + t('The file includes your Steam, OpenXBL and PlayStation sign-in keys if you added them, so keep it to yourself.')),
    el('div', { class: 'checks' }, el('label', { class: 'check-row' }, lookups, el('span', {}, el('strong', {}, t('Include looked-up data.')), el('span', { class: 'muted' }, t(' Scores, play times, prices, descriptions and covers, so the other PC needn\'t look them all up again. Makes the file bigger.'))))),
    el('div', { class: 'form' },
      el('button', { class: 'primary', onclick: exportIt }, t('Export profile…')),
      el('button', { onclick: restore }, t('Import profile…'))),
    status);
}

function customServicePanel() {
  const name = el('input', { placeholder: t('Service name, e.g. Google Play Pass or Amazon Luna') });
  const tiers = el('input', { placeholder: t('Plans, cheapest first, comma separated (optional)') });
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
    el('h2', {}, t('Add another service')),
    el('p', { class: 'muted' }, t('For services without a public game list, add the service here and its games below.')),
    el('div', { class: 'form' }, name, tiers, el('button', { class: 'primary', onclick: add }, t('Add service'))));
}

async function removeCustomService(s) {
  if (!confirm(t('Remove {service} and its games?', { service: s.name }))) return;
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
  const title = el('input', { placeholder: t('Game title') });
  const svc = el('select', {}, custom.map((s) => el('option', { value: s.id }, s.name)));
  const tier = el('select');
  const fillTiers = () => {
    const s = custom.find((c) => c.id === svc.value);
    tier.replaceChildren(...s.tiers.map((t) => el('option', { value: t.id }, t.name)));
  };
  svc.addEventListener('change', fillTiers);
  fillTiers();
  const platform = el('input', { placeholder: t('Platform (optional)') });
  const leave = el('input', { type: 'date', title: t('Leaving date (optional)') });
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
    el('h2', {}, t('Add a game to your own service')),
    el('div', { class: 'form' }, title, svc, tier, platform, leave, el('button', { class: 'primary', onclick: add }, t('Add game'))));
}

function regionPanel() {
  const note = el('span', { class: 'muted' });
  const picker = countryPicker(async (picked) => {
    await saveState({ settings: { ...state.settings, ...picked } });
    rebuildGames();
    note.textContent = t('Refreshing the lists for this country…');
    await refresh();
    note.textContent = '';
  });
  // The app's language: the system's (when it's one of these), or one you pick.
  const language = el('select', {},
    el('option', { value: 'auto' }, t('System language ({language})', { language: I18n.LANGS.find((l) => l.id === I18n.pick(navigator.language))?.name || 'English' })),
    I18n.LANGS.map((l) => el('option', { value: l.id }, l.name)));
  language.value = state.settings.uiLanguage || 'auto';
  language.addEventListener('change', async () => {
    await saveState({ settings: { ...state.settings, uiLanguage: language.value } });
    // Everything on screen is built in the old language; start again in the new one.
    try { sessionStorage.setItem('subscroll-view', 'subs'); sessionStorage.setItem('subscroll-tab', 'region'); } catch { /* opens on Browse instead */ }
    location.reload();
  });
  return el('div', { class: 'panel' },
    el('h2', {}, t('Region and language')),
    el('p', { class: 'muted' }, t('Game Pass and PS Plus catalogues differ a little by country. Switch Online only differs in Japan, which has some games the rest of the world doesn\'t (and the other way round).')),
    el('div', { class: 'form' }, el('label', {}, t('Country '), picker.country), note),
    picker.note,
    el('div', { class: 'form language-row' }, el('label', {}, t('Language '), language)));
}

// Before anything is drawn: the language, and the static text in index.html.
function applyLanguage() {
  I18n.setLanguage(state.settings.uiLanguage || 'auto', navigator.languages || [navigator.language]);
  document.documentElement.lang = I18n.language();
  I18n.translatePage(document);
  $('#refresh-btn').textContent = t('Refresh your subscriptions');
}

function sourcesPanel() {
  const rows = catalogs.map((c) => {
    const s = serviceById(c.service);
    const when = c.fetchedAt ? new Date(c.fetchedAt).toLocaleString(I18n.locale()) : t('unknown');
    const source = SOURCE_LABEL[c.source] ? t(SOURCE_LABEL[c.source]) : c.source;
    return el('li', {}, el('strong', {}, s.name), tn(c.games.length, ': {n} game from the {source}, updated {when}', ': {n} games from the {source}, updated {when}', { source, when }));
  });
  return el('div', { class: 'panel' },
    el('h2', {}, t('Where the lists come from')),
    el('ul', { class: 'sources' }, rows),
    el('p', { class: 'muted' },
      t('Game Pass, EA Play and Ubisoft+ come from Microsoft\'s catalogue service (so EA Play and Ubisoft+ show their Xbox and Microsoft Store editions), PS Plus from playstation.com\'s game lists. If Game Pass or PS Plus are unreachable the app falls back to community mirrors on GitHub. '),
      t('Nintendo publishes no list, so Switch Online comes from Wikipedia\'s "Nintendo Classics" article, with box art from the libretro-thumbnails collection. '),
      t('Netflix games are the apps Netflix publishes on the App Store. Apple Arcade comes from Wikipedia\'s "Apple Arcade" article, with icons and details from the App Store, looked up a few at a time. '),
      tEl('Crunchyroll Game Vault is Crunchyroll\'s App Store account, Humble Choice the month\'s page on humblebundle.com. Google and Amazon publish no lists, so Google Play Pass comes from the playpassBrowser project and Amazon Luna from GameScriptions. Meta Horizon+ comes from Quest+ History, which tracks its Games Catalog and monthly games, and Antstream Arcade from the games page on antstream.com. {link}.', {
        link: el('button', { class: 'link inline', onclick: () => api.openExternal('https://github.com/viruztt/subscroll#credits') }, t('Every source and credit')),
      })));
}

function openDrawer(g) {
  drawerGame = g;
  const drawer = $('#drawer');
  const leave = leaveInfo(g);
  const offers = serviceOffers(g);
  const keys = unlocked();
  // Per service when the game is in more than one.
  const plans = offers.length === 1 ? plansFor(g).map((t) => t.name).join(', ')
    : offers.map((o) => el('div', {}, t('{service}: {plans}', { service: serviceById(o.service)?.name || o.service, plans: plansFor(o).map((t) => t.name).join(', ') || '—' })));
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
      el('button', { class: 'close', onclick: close, title: t('Close') }, '✕'),
      drawerRoll ? rollBar() : null,
      cover(g),
      el('h2', {}, g.title),
      serviceMeta(g, keys),
      playBar(g),
      el('dl', {},
        el('dt', {}, t('Included in')), el('dd', {}, plans.length ? plans : '—'),
        el('dt', {}, t('Platforms')), el('dd', {}, g.platforms.map(platformName).join(', ') || '—'),
        g.versions?.length ? [el('dt', {}, t('Versions')), el('dd', {}, g.versions.join(', '))] : null,
        offersOf(g).find((o) => o.system) ? [el('dt', {}, t('Original system')), el('dd', {}, offersOf(g).find((o) => o.system).system)] : null,
        cloudRow(g),
        gfnRow(g),
        achievementRows(g),
        g.steam ? [el('dt', {}, 'Steam'), el('dd', {}, el('button', { class: 'link inline', onclick: () => api.openExternal(`https://store.steampowered.com/app/${g.steam.appid}/`) }, g.steam.minutes ? t('Owned, {hours} played', { hours: fmtHours(g.steam.minutes / 60) }) : t('Owned, not played yet'), ' ↗'))] : null,
        g.genreTags?.length ? [el('dt', {}, t('Genre')), el('dd', {}, g.genreTags.map((x) => t(x)).join(', '))]
          : g.genres?.length ? [el('dt', {}, t('Genre')), el('dd', {}, g.genres.join(', '))] : null,
        studioRows(g),
        g.releaseDate ? [el('dt', {}, t('Released')), el('dd', {}, fmtDate(g.releaseDate))] : null,
        isComing(g) ? [el('dt', {}, t('Coming')), el('dd', {}, fmtDate(g.comingOn))] : null,
        g.firstSeen && !isComing(g) ? [el('dt', {}, t('Added')), el('dd', {}, fmtDate(g.firstSeen))] : null,
        ratingRows(g),
        finishedRows(g),
        cheapestRows(g),
        leave ? [el('dt', {}, t('Leaving')), el('dd', {}, leave.date ? fmtDate(leave.date) : leave.from?.length ? t('{services}: soon, no date announced', { services: leave.from.join(', ') }) : t('soon, no date announced'))] : null,
        predictRows(g),
        finishRows(g)),
      markButtons(g, true),
      notesSection(g),
      detailsSection(g),
      offers.filter((o) => o.storeUrl).map((o) => el('button', { class: 'link', onclick: () => api.openExternal(o.storeUrl) },
        o.service === 'nso' ? t('Open the Wikipedia list ↗') : offers.length > 1 ? t('Open on {service} ↗', { service: serviceById(o.service)?.short || o.service }) : t('Open store page ↗'))),
      g.custom ? el('button', { class: 'link danger', onclick: deleteCustom }, t('Delete this game')) : null));
  drawer.classList.remove('hidden');
}

// A predicted leave date in the details.
function predictRows(g) {
  const p = predictionOf(g);
  if (!p) return null;
  return [el('dt', {}, t('Could leave')), el('dd', {}, predictionLine(p), el('div', { class: 'muted' }, predictionReason(p)))];
}

// "Can you finish it in time?" in the details.
function finishRows(g) {
  const v = finishVerdict(g);
  if (!v) return null;
  const pace = playPace();
  return [el('dt', {}, t('Finish in time?')), el('dd', {},
    el('div', {}, verdictText(v)),
    el('div', { class: `deadline ${v.status}` }, t(VERDICT_LABEL[v.status])),
    el('div', { class: 'muted' }, t('You play about {pace} a day, {source}.', { pace: fmtPerDay(pace.perDay), source: paceSource(pace) }),
      v.estimated ? ` ${t('Xbox gives no date, so this assumes the next 15th or end of the month, when Game Pass games usually leave.')}` : ''))];
}

// Your star rating and notes, saved as you type.
function notesSection(g) {
  const note = noteOf(g.id) || {};
  const stars = el('div', { class: 'stars-input', role: 'radiogroup', 'aria-label': t('Your rating') });
  const drawStars = (n) => stars.replaceChildren(...[1, 2, 3, 4, 5].map((i) => el('button', {
    class: `star ${i <= (n || 0) ? 'on' : ''}`,
    title: n === i ? t('Clear your rating') : tn(i, '{n} star', '{n} stars'),
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
  const text = el('textarea', { class: 'note-text', rows: 3, placeholder: t('Your notes: where you got to, what to try, who recommended it…') });
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
  const steamH = g.steam?.minutes ? g.steam.minutes / 60 : 0;
  const hours = el('input', { type: 'number', min: '0', step: '0.5', class: 'hours-input', placeholder: steamH ? String(Math.round(steamH * 10) / 10) : '', 'aria-label': t('Hours played') });
  if (note.hours > 0) hours.value = String(note.hours);
  hours.addEventListener('change', async () => {
    const n = Number(hours.value);
    const next = hours.value.trim() && n > 0 && n < 100000 ? Math.round(n * 10) / 10 : null;
    if ((noteOf(g.id)?.hours || null) === next) return;
    if (!next) hours.value = '';
    await setNote(g.id, { hours: next });
    render(true);
  });
  const hoursHint = steamH
    ? t('Steam says {time}. Leave empty to use that, or enter your own if you also played elsewhere.', { time: fmtHours(steamH) })
    : t('Used for cost per hour, your goals and whether you can finish in time, instead of How Long To Beat.');
  return el('section', { class: 'notes' },
    el('div', { class: 'notes-head' }, el('span', { class: 'muted' }, t('Your rating')), stars),
    el('label', { class: 'notes-head hours-row' }, el('span', { class: 'muted' }, t('Hours played')), hours),
    el('p', { class: 'muted hours-hint' }, hoursHint),
    text);
}

// Play / install buttons. Steam is asked whether the game is installed.
const steamInstalledCache = new Map();
function playBar(g) {
  const bar = el('div', { class: 'play-bar' });
  const draw = (installed) => {
    const actions = Play.playActions(g, { installed, platform: system.platform });
    bar.replaceChildren(...actions.map((a) => el('button', {
      class: a.primary ? 'primary' : 'mark',
      title: a.url,
      onclick: async () => {
        const r = await api.launch(a.url);
        if (r.ok) return;
        bar.querySelector('.play-error')?.remove();
        bar.append(el('span', { class: 'muted play-error' }, a.kind === 'steam' ? t('Couldn\'t open Steam. Is it installed?') : a.kind === 'xbox' ? t('Couldn\'t open the Xbox app. Is it installed?') : t('Couldn\'t open that link.')));
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
    ...(dev ? [el('dt', {}, t('Developer')), el('dd', {}, dev)] : []),
    ...(pub && pub !== dev ? [el('dt', {}, t('Publisher')), el('dd', {}, pub)] : []),
  ];
}

function ratingRows(g) {
  const r = ratings[g.id];
  const link = (url, ...children) => (url ? el('button', { class: 'link inline', onclick: () => api.openExternal(url) }, ...children) : el('span', {}, ...children));
  const rows = [];
  if (r?.mc > 0) {
    rows.push(el('dt', {}, 'Metacritic'), el('dd', {}, link(r.mcUrl, el('span', { class: `score ${scoreClass(r.mc)}` }, r.mc), ' ↗')));
  } else if (r?.mcUrl) {
    rows.push(el('dt', {}, 'Metacritic'), el('dd', {}, link(r.mcUrl, t('Not scored yet ↗'))));
  }
  if (r?.hltb) {
    // The time Subscroll uses is in bold.
    const used = HLTB_ORDER[hltbKind()].find((k) => r.hltb[k] != null);
    const parts = [['main', t('Main'), r.hltb.main], ['plus', t('+ Extras'), r.hltb.plus], ['all', '100%', r.hltb.all]]
      .filter(([, , h]) => h != null)
      .flatMap(([k, label, h], i) => [i ? ' · ' : '', k === used ? el('strong', {}, `${label} ${fmtHours(h)}`) : `${label} ${fmtHours(h)}`]);
    rows.push(el('dt', {}, t('Time to beat')), el('dd', {}, link(r.hltbUrl, ...parts, ' ↗')));
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
    slot.append(el('p', { class: 'muted loading' }, t('Loading description and screenshots…')));
    return slot;
  }
  if (d.description) {
    slot.append(el('p', { class: 'description' }, d.description));
    if (d.descriptionSource) {
      slot.append(el('button', { class: 'link small', onclick: () => api.openExternal(d.descriptionSource) }, t('From Wikipedia ↗')));
    }
  } else {
    slot.append(el('p', { class: 'muted' }, t('No description found for this game.')));
  }
  const shots = d.screenshots || [];
  if (shots.length) {
    const gallery = el('div', { class: `shots ${g.service === 'nso' ? 'retro' : ''}` });
    for (const src of shots) {
      const img = el('img', { src, loading: 'lazy', alt: t('Screenshot'), onclick: () => openLightbox(gallery, img, g) });
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

// A screenshot shown large. With more than one, ‹ › and the arrow keys step
// through the ones that loaded, going round at the ends.
function openLightbox(gallery, first, g) {
  const srcs = () => [...gallery.querySelectorAll('img')].map((i) => i.src);
  let index = Math.max(0, srcs().indexOf(first.src));
  const img = el('img', { alt: '' });
  const count = el('div', { class: 'lightbox-count' });
  const box = el('div', { class: `lightbox ${g.service === 'nso' ? 'retro' : ''}`, onclick: () => box.remove() }, img, count);
  const show = () => {
    const list = srcs();
    index = (index + list.length) % list.length;
    img.src = list[index];
    count.textContent = list.length > 1 ? t('{n} of {total}', { n: index + 1, total: list.length }) : '';
    box.classList.toggle('single', list.length < 2);
  };
  box.step = (dir) => {
    index += dir;
    show();
  };
  const arrow = (dir, label, text) => el('button', {
    class: `lightbox-arrow ${dir < 0 ? 'prev' : 'next'}`,
    title: label,
    'aria-label': label,
    onclick: (e) => {
      e.stopPropagation();
      box.step(dir);
    },
  }, text);
  box.append(arrow(-1, t('Previous screenshot'), '‹'), arrow(1, t('Next screenshot'), '›'));
  show();
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
    if (['completed', 'ignored', 'dropped'].includes(markOf(g.id)) || isComing(g)) return false;
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
  if (ui.genre !== 'all') parts.push(t(ui.genre));
  if (ui.length !== 'all') {
    const label = Genres.LENGTHS.find((l) => l.id === ui.length)?.label;
    parts.push(label && t(label).toLowerCase());
  }
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function rollBar() {
  const subs = unlocked().size > 0;
  return el('div', { class: 'roll-bar' },
    el('span', { class: 'muted' }, subs
      ? tn(drawerRoll.pool, 'Rolled from {n} game in your subscriptions{scope}, completed, dropped and ignored ones left out', 'Rolled from {n} games in your subscriptions{scope}, completed, dropped and ignored ones left out', { scope: rollScope() })
      : tn(drawerRoll.pool, 'Rolled from {n} game{scope}, completed, dropped and ignored ones left out', 'Rolled from {n} games{scope}, completed, dropped and ignored ones left out', { scope: rollScope() })),
    el('button', { class: 'primary', onclick: roll }, t('🎲 Roll again')));
}

function roll() {
  const pool = rollPool();
  clearTimeout(rollTimer);
  if (pool.length === 0) {
    drawerGame = null;
    $('#drawer').replaceChildren(
      el('div', { class: 'drawer-backdrop', onclick: closeDrawer }),
      el('div', { class: 'drawer-panel' },
        el('button', { class: 'close', onclick: closeDrawer, title: t('Close') }, '✕'),
        el('h2', {}, t('Nothing to roll')),
        el('p', { class: 'muted' }, t('No games match: everything in your subscriptions is completed, or the filters leave nothing.'))));
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
  $('#toolbar').classList.toggle('hidden', !toolbarNeeded());

  const chips = $('#service-chips');
  // With "Games outside my subscriptions" hidden, only your services get a chip; a
  // hidden one is dropped from the filter so it can't narrow the list unseen.
  const keys = unlocked();
  const yours = (s) => [...keys].some((k) => k.startsWith(`${s.id}:`));
  const chipServices = ui.mineOnly && keys.size ? allServices().filter(yours) : allServices();
  for (const id of [...ui.services]) if (!chipServices.some((s) => s.id === id)) ui.services.delete(id);
  chips.replaceChildren(...chipServices.map((s) => el('button', {
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
  pf.replaceChildren(el('option', { value: 'all' }, t('Any platform')), ...platformsList().map((p) => el('option', { value: p }, platformName(p))),
    el('option', { value: 'cloud' }, platformName('cloud')));
  pf.value = current;

  // Only genres some game actually has.
  const present = new Set(games.flatMap((g) => g.genreTags || []));
  const gf = $('#genre-filter');
  gf.replaceChildren(el('option', { value: 'all' }, t('Any genre')), ...Genres.GENRES.filter((n) => present.has(n)).map((n) => el('option', { value: n }, t(n))));
  gf.value = present.has(ui.genre) ? ui.genre : 'all';
  if (gf.value !== ui.genre) ui.genre = 'all';
  const lf = $('#length-filter');
  if (!lf.options.length) lf.replaceChildren(el('option', { value: 'all' }, t('Any length')), ...Genres.LENGTHS.map((l) => el('option', { value: l.id }, t(l.label))));
  lf.value = ui.length;

  const leaving = games.filter((g) => leaveInfo(g) && (!ui.mineOnly || isMine(g, keys))).length;
  $('#leaving-count').textContent = leaving || '';
  $('#coming-count').textContent = games.filter((g) => isComing(g) && (!ui.mineOnly || isMine(g, keys))).length || '';
  // Games on your To play list you can start now.
  $('#playing-count').textContent = games.filter((g) => markOf(g.id) === 'playing').length || '';
  $('#toplay-count').textContent = games.filter((g) => markOf(g.id) === 'wishlist' && !isComing(g) && isMine(g, keys)).length || '';
  $('#free-count').textContent = openFree().length || '';

  const sync = catalogs.map((c) => {
    const s = serviceById(c.service);
    // Services added later have no bundled list until their first refresh.
    if (!c.games.length) return el('div', {}, tEl('{service}: {status}', { service: s.short, status: el('span', { class: 'muted' }, t('not loaded yet')) }));
    const when = c.fetchedAt ? new Date(c.fetchedAt).toLocaleDateString(I18n.locale()) : '—';
    return el('div', {}, tEl('{service}: {date} {source}', { service: s.short, date: when, source: el('span', { class: 'muted' }, t('({source})', { source: SHORT_SOURCE[c.source] ? t(SHORT_SOURCE[c.source]) : c.source })) }));
  });
  $('#sync-list').replaceChildren(...sync);
  for (const b of document.querySelectorAll('#layout-seg button')) b.classList.toggle('on', (b.dataset.layout === 'list') === listView());
  $('#sync-summary').replaceChildren(...syncSummary());
}

// The filters only show on pages listing games, and not while a list is
// empty before any filter (your To play list or My games when you've
// marked nothing yet).
function toolbarNeeded() {
  if (['subs', 'stats', 'value', 'foryou', 'free', 'plan'].includes(ui.view)) return false;
  if (ui.view === 'toplay') return games.some((g) => markOf(g.id) === 'wishlist') || departed.some((d) => state.marks[d.id] === 'wishlist');
  if (ui.view === 'mine') return games.some((g) => markOf(g.id) !== 'none');
  if (ui.view === 'playing') return games.some((g) => markOf(g.id) === 'playing');
  if (ui.view === 'coming') return games.some(isComing);
  if (ui.view === 'leaving') return games.some((g) => leaveInfo(g));
  return true;
}

// Ctrl+F (or /) jumps to the search box: the page's own one (Value's
// "Games you beat"), else the toolbar's, from Browse when the page has none.
function focusSearch() {
  const own = $('#content input[type=search]');
  if (own) {
    own.scrollIntoView({ block: 'center' });
    own.focus();
    own.select();
    return;
  }
  if (!toolbarNeeded()) {
    ui.view = 'browse';
    $('#content').scrollTop = 0;
    render();
  }
  $('#search').focus();
  $('#search').select();
}

// The sidebar's one line about how fresh the catalogues are: the oldest
// one's date ("today", "3 days ago"), and how many haven't loaded yet.
function syncSummary() {
  const loaded = catalogs.filter((c) => c.games.length && c.fetchedAt);
  const missing = catalogs.filter((c) => !c.games.length).length;
  const parts = [];
  if (loaded.length) {
    const oldest = loaded.map((c) => c.fetchedAt).sort()[0];
    const day = (d) => Date.parse(new Date(d).toLocaleDateString('sv')); // local calendar day
    const days = Math.max(0, Math.round((day(Date.now()) - day(oldest)) / 86400000));
    const when = new Intl.RelativeTimeFormat(I18n.locale(), { numeric: 'auto' }).format(-days, 'day');
    parts.push(el('span', { title: t('When each catalogue was last downloaded: click for details') }, t('Updated {when}', { when })));
  }
  if (missing) parts.push(el('span', { class: 'muted' }, ` ${tn(missing, '· {n} not loaded', '· {n} not loaded')}`));
  return parts.length ? parts : [el('span', {}, t('Catalogues'))];
}

// keepScroll: redraw in place (after marking a game, new results…) rather
// than starting the list from the top.
function render(keepScroll = false) {
  syncSaleWatch();
  const content = $('#content');
  const top = content.scrollTop;
  if (!keepScroll) ui.shown = PAGE_SIZE;
  renderChrome();
  ({ foryou: renderForYou, browse: renderBrowse, coming: renderComing, leaving: renderLeaving, changes: renderChanges, mine: renderMine, playing: renderPlaying, toplay: renderToPlay, plan: renderPlan, free: renderFree, calendar: renderCalendar, stats: renderStats, value: renderValue, subs: renderSubs })[ui.view]();
  compactSummary();
  addShareButton();
  if (tv) renderTv();
  if (keepScroll) content.scrollTop = top;
  if (drawerGame) openDrawer(drawerGame);
  // Lists arriving during onboarding fill in its counts and picks.
  if (onboarding) renderOnboarding();
}

// A click on an alert opens the page it's about.
api.onShowView((view) => {
  ui.view = view;
  // Update alerts open Settings on its updates tab.
  if (view === 'subs') ui.settingsTab = 'app';
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
    status.textContent = names.length ? t('{sites} stopped answering, will try again later', { sites: new Intl.ListFormat(I18n.locale(), { type: 'conjunction' }).format(names) }) : '';
    status.title = (p?.stopped || []).join('\n');
    return;
  }
  status.textContent = t('Fetching scores and times: {done} of {total}', { done: p.done, total: p.total });
}

// PS Plus join dates being read from the PlayStation Blog (src/providers/psblog.js).
function showPsBlogProgress(p) {
  const status = $('#psblog-status');
  status.title = '';
  if (!p) status.textContent = '';
  else if (p.error) {
    status.textContent = t("Couldn't reach the PlayStation Blog for PS Plus join dates, will try again later");
    status.title = p.error;
  } else if (p.total === null) status.textContent = t('Looking for PS Plus join dates on the PlayStation Blog…');
  else status.textContent = t('Reading PS Plus join dates: {done} of {total} blog posts', { done: p.done, total: p.total });
}
api.onPsBlogProgress(showPsBlogProgress);
api.getPsBlogProgress().then(showPsBlogProgress).catch(() => {});

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
// 'mine': the catalogues your plans cover; 'all': every catalogue. A retry
// after a failure repeats the same kind.
let refreshScope = 'mine';
async function refresh(scope = refreshScope) {
  refreshScope = scope;
  closeRefreshMenu();
  const btn = $('#refresh-btn');
  btn.disabled = true;
  $('#refresh-more').disabled = true;
  btn.title = '';
  btn.textContent = t('Refreshing…');
  try {
    const { results, catalog } = await api.refresh(scope);
    catalogs = catalog;
    rebuildGames();
    ratings = (await api.getRatings()).ratings;
    const failed = results.filter((r) => !r.ok);
    btn.textContent = failed.length ? t('Some lists failed, retry') : t('Refresh your subscriptions');
    if (!failed.length) refreshScope = 'mine';
    if (failed.length) btn.title = failed.map((r) => `${r.service}: ${r.errors.join('; ')}`).join('\n');
    render(true);
  } catch (err) {
    btn.textContent = t('Refresh failed, retry');
    btn.title = String(err);
  } finally {
    btn.disabled = false;
    $('#refresh-more').disabled = false;
  }
}

// The "Hide…" button counts what it's hiding.
function showHideCount() {
  const n = [...document.querySelectorAll('#hide-menu input')].filter((x) => x.checked).length;
  $('#hide-count').textContent = n || '';
  $('#hide-btn').title = n ? tn(n, '{n} kind of game hidden', '{n} kinds of game hidden') : t('Nothing hidden');
}
function closeHideMenu() {
  $('#hide-menu').hidden = true;
  $('#hide-btn').setAttribute('aria-expanded', 'false');
}

function closeRefreshMenu() {
  $('#refresh-menu').hidden = true;
  $('#refresh-more').setAttribute('aria-expanded', 'false');
}

api.onRefreshProgress(({ service, state: s }) => {
  if (s === 'running') $('#refresh-btn').textContent = t('Refreshing {service}…', { service: serviceById(service)?.name || service });
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
  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { ui.search = e.target.value; render(); }, 120);
  });
  $('#status-filter').addEventListener('change', (e) => { ui.status = e.target.value; render(); });
  $('#platform-filter').addEventListener('change', (e) => { ui.platform = e.target.value; render(); });
  $('#genre-filter').addEventListener('change', (e) => { ui.genre = e.target.value; render(); });
  $('#length-filter').addEventListener('change', (e) => { ui.length = e.target.value; render(); });
  $('#sort').addEventListener('change', (e) => { ui.sort = e.target.value; render(); });
  $('#mine-only').addEventListener('change', (e) => { ui.mineOnly = e.target.checked; showHideCount(); render(); });
  for (const [id, setting] of [['#hide-departed', 'hideDeparted'], ['#hide-completed', 'hideCompleted'], ['#hide-dropped', 'hideDropped'], ['#hide-ignored', 'hideIgnored']]) {
    $(id).addEventListener('change', async (e) => {
      await saveState({ settings: { ...state.settings, [setting]: e.target.checked } });
      showHideCount();
      render(true);
    });
  }
  $('#layout-seg').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-layout]');
    if (!b) return;
    await saveState({ settings: { ...state.settings, listView: b.dataset.layout === 'list' } });
    render(true);
  });
  $('#hide-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#hide-menu');
    menu.hidden = !menu.hidden;
    $('#hide-btn').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#hide-wrap')) closeHideMenu(); });
  $('#refresh-btn').addEventListener('click', () => refresh());
  $('#refresh-more').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#refresh-menu');
    menu.hidden = !menu.hidden;
    $('#refresh-more').setAttribute('aria-expanded', String(!menu.hidden));
  });
  $('#refresh-all').addEventListener('click', () => refresh('all'));
  document.addEventListener('click', (e) => { if (!e.target.closest('#refresh-split')) closeRefreshMenu(); });
  $('#roll-btn').addEventListener('click', roll);
  $('#tv-btn').addEventListener('click', openTv);
  document.addEventListener('keydown', (e) => {
    const typing = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
    if (((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing)) {
      e.preventDefault();
      focusSearch();
      return;
    }
    const shot = document.querySelector('.lightbox');
    if (shot && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      shot.step(e.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (e.key !== 'Escape') return;
    const box = document.querySelector('.lightbox');
    if (box) box.remove();
    else if ($('#share')) closeShare();
    else if (!$('#hide-menu').hidden) closeHideMenu();
    else closeDrawer();
  });
}

async function init() {
  let sys;
  ({ services, tierBadges, system: sys } = await api.getServices());
  if (sys) system = sys;
  state = await api.getState();
  applyTheme();
  applyLanguage();
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
  $('#hide-dropped').checked = !!state.settings.hideDropped;
  showHideCount();
  if (!hasSubs) ui.view = 'subs';
  // Back where you were after switching language.
  try {
    const back = sessionStorage.getItem('subscroll-view');
    if (back) ui.view = back;
    ui.settingsTab = sessionStorage.getItem('subscroll-tab') || ui.settingsTab;
    sessionStorage.removeItem('subscroll-view');
    sessionStorage.removeItem('subscroll-tab');
  } catch { /* not available */ }
  wire();
  render();
  loadFree().catch(() => {});
  api.getUpdate().then((st) => { update = st; renderUpdateBanner(); }).catch(() => {});
  api.onSyncStatus((st) => {
    syncStatus = st;
    $('#sync-panel')?.replaceWith(syncPanel());
  });
  api.onUpdateChanged((st) => {
    update = st;
    renderUpdateBanner();
    $('#update-panel')?.replaceWith(updatePanel());
  });

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
