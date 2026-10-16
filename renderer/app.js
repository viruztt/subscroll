/* global api */
const $ = (sel) => document.querySelector(sel);
const PAGE_SIZE = 120;
const SOURCE_LABEL = { live: 'official source', mirror: 'community mirror', bundled: 'bundled list' };

const ui = {
  view: 'browse',
  search: '',
  services: new Set(), // empty = all
  status: 'all',
  platform: 'all',
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
    if (tier) tier.includes.forEach((inc) => keys.add(`${s.id}:${inc}`));
  }
  return keys;
}

const isMine = (g, keys) => g.tiers.some((t) => keys.has(`${g.service}:${t}`));

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

function leaveInfo(g) {
  const date = state.leaveDates[g.id];
  if (date) return { date, soon: daysUntil(date) <= 31, past: daysUntil(date) < 0 };
  if (g.leavingSoon) return { date: null, soon: true };
  return null;
}

function markOf(id) {
  return state.marks[id] || 'none';
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
  games = out;
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

function filtered(list) {
  const keys = unlocked();
  const q = ui.search.trim().toLowerCase();
  return list.filter((g) => {
    if (ui.services.size && !ui.services.has(g.service)) return false;
    if (ui.mineOnly && !isMine(g, keys)) return false;
    if (hideDeparted() && (g.leftOn || leaveInfo(g)?.past)) return false;
    if (hideCompleted() && markOf(g.id) === 'completed') return false;
    if (ui.status !== 'all' && markOf(g.id) !== ui.status) return false;
    if (ui.platform !== 'all' && !g.platforms.includes(ui.platform)) return false;
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

function placeholder(g) {
  const s = serviceById(g.service);
  return el('div', { class: 'cover placeholder', style: `--svc:${s ? s.color : '#444'}` },
    el('span', {}, g.service === 'nso' ? g.platforms[0] : g.title));
}

function cover(g) {
  if (!g.image) return placeholder(g);
  const src = g.service === 'gamepass' ? `${g.image}?w=300&h=450&q=80` : g.image;
  // Retro box art comes in every shape, so show it whole instead of cropping.
  const img = el('img', { class: `cover ${g.service === 'nso' ? 'contain' : ''}`, src, loading: 'lazy', alt: '' });
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

function markButtons(g) {
  const mark = markOf(g.id);
  const set = (value) => async (e) => {
    e.stopPropagation();
    const marks = { ...state.marks };
    if (mark === value) delete marks[g.id];
    else marks[g.id] = value;
    await saveState({ marks });
    render();
  };
  return el('div', { class: 'marks' },
    el('button', { class: `mark ${mark === 'played' ? 'on' : ''}`, title: 'Mark as played', onclick: set('played') }, '▶ Played'),
    el('button', { class: `mark ${mark === 'completed' ? 'on done' : ''}`, title: 'Mark as completed', onclick: set('completed') }, '★ Completed'));
}

function card(g, keys) {
  const leave = leaveInfo(g);
  const mine = isMine(g, keys);
  const badges = [];
  if (leave) {
    const text = leave.date ? (leave.past ? `Left ${fmtDate(leave.date)}` : `Leaves ${fmtDate(leave.date)}`) : 'Leaving soon';
    badges.push(el('span', { class: `badge ${leave.soon ? 'warn' : ''}` }, text));
  }
  if (g.firstSeen && daysUntil(g.firstSeen) >= -30) badges.push(el('span', { class: 'badge new' }, 'New'));
  if (g.leftOn) badges.push(el('span', { class: 'badge gone' }, `Left ${fmtDate(g.leftOn)}`));
  const open = () => { drawerRoll = null; openDrawer(g); };
  return el('article', { class: `card ${mine ? 'mine' : ''} mark-${markOf(g.id)}`, 'data-id': g.id, onclick: open },
    el('div', { class: 'cover-wrap' }, cover(g), el('div', { class: 'badges' }, badges)),
    el('div', { class: 'body' },
      el('div', { class: 'title', title: g.title }, g.title),
      el('div', { class: 'meta' }, serviceTag(g), el('span', { class: 'tier' }, tierLabel(g))),
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
  return subs ? `${list.length} games · ${mine} included in your subscriptions` : `${list.length} games · set your subscriptions to see what you can play`;
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

function renderMine() {
  const list = sorted(filtered(games.filter((g) => markOf(g.id) !== 'none')));
  const done = list.filter((g) => markOf(g.id) === 'completed').length;
  $('#summary').textContent = `${list.length} games marked · ${done} completed`;
  renderGrid(list, 'Mark games as played or completed and they will be collected here.');
}

function renderSubs() {
  $('#summary').textContent = 'Pick the plan you have for each service. Everything is saved on this computer.';
  const content = $('#content');
  content.replaceChildren();

  const rows = allServices().map((s) => {
    const current = state.subscriptions[s.id] || '';
    const pick = async (tierId) => {
      await saveState({ subscriptions: { ...state.subscriptions, [s.id]: tierId || undefined } });
      render();
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
  content.append(customServicePanel(), customGamePanel(), regionPanel(), sourcesPanel());
}

function customServicePanel() {
  const name = el('input', { placeholder: 'Service name, e.g. Ubisoft+ or Apple Arcade' });
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
    render();
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
  render();
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
    render();
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
      'Game Pass comes from Microsoft\'s catalogue service, PS Plus from playstation.com\'s game lists. If those are unreachable the app falls back to community mirrors on GitHub. ',
      'Nintendo publishes no list, so Switch Online comes from Wikipedia\'s "Nintendo Classics" article, with box art from the libretro-thumbnails collection.'));
}

function openDrawer(g) {
  drawerGame = g;
  const drawer = $('#drawer');
  const leave = leaveInfo(g);
  const plans = plansFor(g).map((t) => t.name).join(', ');
  const close = closeDrawer;
  const deleteCustom = async () => {
    await saveState({ customGames: state.customGames.filter((c) => c.id !== g.id) });
    rebuildGames();
    close();
    render();
  };
  drawer.replaceChildren(
    el('div', { class: 'drawer-backdrop', onclick: close }),
    el('div', { class: 'drawer-panel' },
      el('button', { class: 'close', onclick: close, title: 'Close' }, '✕'),
      drawerRoll ? rollBar() : null,
      cover(g),
      el('h2', {}, g.title),
      el('div', { class: 'meta' }, serviceTag(g), el('span', { class: 'tier' }, tierLabel(g))),
      el('dl', {},
        el('dt', {}, 'Included in'), el('dd', {}, plans || '—'),
        el('dt', {}, 'Platforms'), el('dd', {}, g.platforms.map(platformName).join(', ') || '—'),
        g.genres?.length ? [el('dt', {}, 'Genre'), el('dd', {}, g.genres.join(', '))] : null,
        g.releaseDate ? [el('dt', {}, 'Released'), el('dd', {}, fmtDate(g.releaseDate))] : null,
        g.firstSeen ? [el('dt', {}, 'Added'), el('dd', {}, fmtDate(g.firstSeen))] : null,
        ratingRows(g),
        leave ? [el('dt', {}, 'Leaving'), el('dd', {}, leave.date ? fmtDate(leave.date) : 'Soon, no date announced')] : null),
      markButtons(g),
      detailsSection(g),
      g.storeUrl ? el('button', { class: 'link', onclick: () => api.openExternal(g.storeUrl) }, g.service === 'nso' ? 'Open the Wikipedia list ↗' : 'Open store page ↗') : null,
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
    const pending = api.getDetails(g)
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
    if (markOf(g.id) === 'completed') return false;
    if (ui.services.size && !ui.services.has(g.service)) return false;
    if (ui.platform !== 'all' && !g.platforms.includes(ui.platform)) return false;
    return true;
  });
}

function rollScope() {
  const parts = [];
  if (ui.services.size) parts.push([...ui.services].map((id) => serviceById(id)?.name || id).join(', '));
  if (ui.platform !== 'all') parts.push(platformName(ui.platform));
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function rollBar() {
  const subs = unlocked().size > 0;
  return el('div', { class: 'roll-bar' },
    el('span', { class: 'muted' }, `Rolled from ${drawerRoll.pool} ${subs ? 'games in your subscriptions' : 'games'}${rollScope()}, completed ones left out`),
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
        el('p', { class: 'muted' }, 'No games match: everything in your subscriptions is completed, or the service and platform filters leave nothing.')));
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
  $('#toolbar').classList.toggle('hidden', ui.view === 'subs');

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

  const keys = unlocked();
  const leaving = games.filter((g) => leaveInfo(g) && (!ui.mineOnly || isMine(g, keys))).length;
  $('#leaving-count').textContent = leaving || '';

  const sync = catalogs.map((c) => {
    const s = serviceById(c.service);
    const when = c.fetchedAt ? new Date(c.fetchedAt).toLocaleDateString() : '—';
    return el('div', {}, `${s.name}: ${when}`, el('span', { class: 'muted' }, ` (${SOURCE_LABEL[c.source] || c.source})`));
  });
  $('#sync').replaceChildren(...sync);
}

function render(keepScroll = false) {
  if (!keepScroll) ui.shown = PAGE_SIZE;
  renderChrome();
  ({ browse: renderBrowse, leaving: renderLeaving, changes: renderChanges, mine: renderMine, subs: renderSubs })[ui.view]();
  if (drawerGame) openDrawer(drawerGame);
}

// ---------- Metacritic / How Long To Beat ----------
let reorderTimer = null;

function showRatingProgress(p) {
  const status = $('#ratings-status');
  if (!p || p.finished) {
    status.textContent = p?.failed ? 'Metacritic / How Long To Beat unreachable, will retry later' : '';
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
  $('#sort').addEventListener('change', (e) => { ui.sort = e.target.value; render(); });
  $('#mine-only').addEventListener('change', (e) => { ui.mineOnly = e.target.checked; render(); });
  for (const [id, setting] of [['#hide-departed', 'hideDeparted'], ['#hide-completed', 'hideCompleted']]) {
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
  if (!hasSubs) ui.view = 'subs';
  wire();
  render();

  const hours = Number(state.settings.autoRefreshHours) || 24;
  const last = state.lastRefresh ? new Date(state.lastRefresh) : null;
  if (!last || Date.now() - last > hours * 3600000) refresh();
}

init();
