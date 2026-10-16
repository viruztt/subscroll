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

function rebuildGames() {
  departed = [];
  const out = [];
  for (const c of catalogs) {
    for (const g of c.games) {
      if (inMyRegion(g)) out.push({ ...g, firstSeen: c.history?.firstSeen?.[g.id] || g.addedOn || null });
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

const PLATFORM_LABEL = { console: 'Xbox console', pc: 'PC' };
const platformName = (p) => PLATFORM_LABEL[p] || p;

const hideDeparted = () => !!state.settings.hideDeparted;
// "My games" is where completed games are collected, so they stay there.
const hideCompleted = () => !!state.settings.hideCompleted && ui.view !== 'mine';
// Picking "Ignored" in the status filter shows them anyway, to un-ignore.
const hideIgnored = () => state.settings.hideIgnored !== false && ui.view !== 'mine' && ui.status !== 'ignored';

function filtered(list) {
  const keys = unlocked();
  const q = ui.search.trim().toLowerCase();
  return list.filter((g) => {
    if (ui.services.size && !inServices(g, ui.services)) return false;
    if (ui.mineOnly && !isMine(g, keys)) return false;
    if (hideDeparted() && (g.leftOn || leaveInfo(g)?.past)) return false;
    if (hideCompleted() && markOf(g.id) === 'completed') return false;
    if (hideIgnored() && markOf(g.id) === 'ignored') return false;
    if (ui.status === 'steam' ? !g.steam : ui.status !== 'all' && markOf(g.id) !== ui.status) return false;
    if (ui.platform !== 'all' && !g.platforms.includes(ui.platform)) return false;
    if (!fitsGenreAndLength(g)) return false;
    if (q && !g.title.toLowerCase().includes(q)) return false;
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
  const whole = ['nso', 'netflix', 'applearcade'].includes(g.service);
  const img = el('img', { class: `cover ${whole ? 'contain' : ''}`, src, loading: 'lazy', alt: '' });
  // Offline or a dead link: show the same artwork-free tile Nintendo games use.
  img.addEventListener('error', () => img.replaceWith(placeholder(g)), { once: true });
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
    wide ? ignoreButton(g, 'mark ignore') : null);
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
  if (g.leftOn) badges.push(el('span', { class: 'badge gone' }, `Left ${fmtDate(g.leftOn)}`));
  // Regional versions sharing this card.
  if (g.versions?.length > 1) badges.push(el('span', { class: 'badge region', title: 'Regional versions included' }, g.versions.join(' + ')));
  if (g.steam) badges.push(el('span', { class: 'badge steam', title: steamText(g.steam) }, 'On Steam'));
  const open = () => { drawerRoll = null; openDrawer(g); };
  return el('article', { class: `card ${mine ? 'mine' : ''} mark-${markOf(g.id)}`, 'data-id': g.id, onclick: open },
    el('div', { class: 'cover-wrap' }, cover(g), el('div', { class: 'badges' }, badges), ignoreButton(g, 'cover-ignore')),
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

function renderLeaving() {
  const list = filtered(games.filter((g) => leaveInfo(g)));
  list.sort((a, b) => (leaveInfo(a).date || '9999').localeCompare(leaveInfo(b).date || '9999') || a.title.localeCompare(b.title));
  $('#summary').textContent = `${list.length} games leaving. Xbox flags these itself but gives no exact date.`;
  renderGrid(list, 'Nothing is flagged as leaving right now.');
}

function renderChanges() {
  const added = sorted(filtered(games.filter((g) => g.firstSeen)));
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
  content.append(section(`Recently added (${added.length})`, added, 'Nothing new yet. New games show up here after the next refresh finds them.'));
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

const STATUS_COLOR = { completed: '#f2c94c', played: '#3ccf91', untouched: '#3a404d', ignored: '#6b7280' };
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

function renderSubs() {
  $('#summary').textContent = 'Your plans, region, background, Steam and backups. Everything is saved on this computer.';
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

  content.append(el('div', { class: 'panel' }, el('h2', {}, 'My subscriptions'), rows));
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
      toggle('alerts', 'Alerts.', 'A notification when games join a service in your plans, or games in your plans start leaving. Completed and ignored games are left out.', true)));
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

// Save plans and marks to a file, or bring them back on another PC.
function backupPanel() {
  const games = (n) => `${n} marked game${n === 1 ? '' : 's'}`;
  const status = el('p', { class: 'muted' });
  const exportIt = async () => {
    const r = await api.exportBackup();
    if (r.ok) status.textContent = `Saved ${games(r.marks)} and your plans to ${r.file}`;
  };
  const restore = async () => {
    const r = await api.importBackup();
    if (r.error) {
      status.textContent = r.error;
    } else if (r.ok) {
      state = r.state;
      rebuildGames();
      render(true);
      // render() rebuilt this panel; report on the new one.
      const fresh = document.querySelector('#backup-status');
      if (fresh) fresh.textContent = `Restored ${games(r.marks)} and your plans.`;
      return;
    }
  };
  status.id = 'backup-status';
  return el('div', { class: 'panel' },
    el('h2', {}, 'Backup'),
    el('p', { class: 'muted' }, 'Save your plans, marks, settings and your own services and games to a file, to keep it safe or move to another PC. Restoring replaces what is on this PC.'),
    el('div', { class: 'form' },
      el('button', { class: 'primary', onclick: exportIt }, 'Save backup…'),
      el('button', { onclick: restore }, 'Restore from backup…')),
    status);
}

function customServicePanel() {
  const name = el('input', { placeholder: 'Service name, e.g. Humble Choice or Prime Gaming' });
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
      el('dl', {},
        el('dt', {}, 'Included in'), el('dd', {}, plans.length ? plans : '—'),
        el('dt', {}, 'Platforms'), el('dd', {}, g.platforms.map(platformName).join(', ') || '—'),
        g.versions?.length ? [el('dt', {}, 'Versions'), el('dd', {}, g.versions.join(', '))] : null,
        g.steam ? [el('dt', {}, 'Steam'), el('dd', {}, el('button', { class: 'link inline', onclick: () => api.openExternal(`https://store.steampowered.com/app/${g.steam.appid}/`) }, steamText(g.steam).replace('You own this on Steam, ', 'Owned, '), ' ↗'))] : null,
        g.genreTags?.length ? [el('dt', {}, 'Genre'), el('dd', {}, g.genreTags.join(', '))]
          : g.genres?.length ? [el('dt', {}, 'Genre'), el('dd', {}, g.genres.join(', '))] : null,
        g.releaseDate ? [el('dt', {}, 'Released'), el('dd', {}, fmtDate(g.releaseDate))] : null,
        isComing(g) ? [el('dt', {}, 'Coming'), el('dd', {}, fmtDate(g.comingOn))] : null,
        g.firstSeen && !isComing(g) ? [el('dt', {}, 'Added'), el('dd', {}, fmtDate(g.firstSeen))] : null,
        ratingRows(g),
        leave ? [el('dt', {}, 'Leaving'), el('dd', {}, leave.date ? fmtDate(leave.date) : `${leave.from?.length ? `${leave.from.join(', ')}: ` : ''}soon, no date announced`)] : null),
      markButtons(g, true),
      detailsSection(g),
      offers.filter((o) => o.storeUrl).map((o) => el('button', { class: 'link', onclick: () => api.openExternal(o.storeUrl) },
        o.service === 'nso' ? 'Open the Wikipedia list ↗' : offers.length > 1 ? `Open on ${serviceById(o.service)?.short || o.service} ↗` : 'Open store page ↗')),
      g.custom ? el('button', { class: 'link danger', onclick: deleteCustom }, 'Delete this game') : null));
  drawer.classList.remove('hidden');
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
    if (ui.platform !== 'all' && !g.platforms.includes(ui.platform)) return false;
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
  $('#toolbar').classList.toggle('hidden', ui.view === 'subs' || ui.view === 'stats');

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
  pf.replaceChildren(el('option', { value: 'all' }, 'Any platform'), ...platformsList().map((p) => el('option', { value: p }, platformName(p))));
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
  const content = $('#content');
  const top = content.scrollTop;
  if (!keepScroll) ui.shown = PAGE_SIZE;
  renderChrome();
  ({ browse: renderBrowse, coming: renderComing, leaving: renderLeaving, changes: renderChanges, mine: renderMine, stats: renderStats, subs: renderSubs })[ui.view]();
  if (keepScroll) content.scrollTop = top;
  if (drawerGame) openDrawer(drawerGame);
}

// A click on an alert opens the page it's about.
api.onShowView((view) => {
  ui.view = view;
  $('#content').scrollTop = 0;
  render();
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

  const hours = Number(state.settings.autoRefreshHours) || 24;
  const last = state.lastRefresh ? new Date(state.lastRefresh) : null;
  if (!last || Date.now() - last > hours * 3600000) refresh();
}

init();
