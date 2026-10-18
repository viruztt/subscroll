const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, net, shell } = require('electron');
const path = require('path');
const { Store, readJson, writeJson } = require('./store');
const { Catalog, SERVICES: CATALOG_SERVICES } = require('./catalog');
const arcade = require('./providers/applearcade');
const { DetailsCache } = require('./details');
const { Ratings } = require('./ratings');
const { SERVICES, TIER_BADGES, unlockedTiers } = require('./services');
const { REGIONS, regionById } = require('./regions');
const http = require('./providers/http');
const { makeBackup, parseBackup, mergeHistory, mergeLookups, backupName } = require('./backup');
const steam = require('./steam');
const alerts = require('./alerts');
const { Prices } = require('./prices');
const { Wiki, wanted: wikiWanted } = require('./wiki');
const { FreeGames, freeAlerts, hasPlan } = require('./freegames');
const { Cloud } = require('./cloud');
const Play = require('../renderer/play');
const { execFile } = require('child_process');
const { listTitles } = alerts;
const fs = require('fs');

let store;
let catalog;
let details;
let ratings;
let prices;
let wiki;
let freeGames;
let cloud;
let win;
let tray;
let quitting = false;

// Use Chromium's network stack: honours system proxy settings and certificates.
http.setFetch((url, opts) => net.fetch(url, opts));

const ICON = path.join(__dirname, '..', 'renderer', 'icon.png');
// A real .ico next to the app (packaged builds), which the Windows taskbar
// reads more reliably than a PNG.
const ICO = app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : path.join(__dirname, '..', 'build', 'icon.ico');
const APP_ID = 'local.subscroll';
// Started with Windows: stay in the tray until the user opens the window.
const startHidden = process.argv.includes('--hidden');

function createWindow() {
  win = new BrowserWindow({
    show: !startHidden,
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'Subscroll',
    icon: process.platform === 'win32' ? ICO : ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // Windows draws the taskbar button from the app id's shortcut, and the
  // portable exe has none, so the button came out blank. Give it the icon file
  // directly.
  if (process.platform === 'win32') {
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: ICO,
      appIconIndex: 0,
      relaunchCommand: `"${exe}"`,
      relaunchDisplayName: 'Subscroll',
    });
  }
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Closing the window keeps the app in the tray, refreshing in the background.
  win.on('close', (e) => {
    if (quitting || !tray || !store.get().settings.closeToTray) return;
    e.preventDefault();
    win.hide();
    if (!store.get().trayHintShown) {
      store.update({ trayHintShown: true });
      notify({ title: 'Subscroll is still running', body: 'It keeps checking your services in the background. Right-click the tray icon to quit.' });
    }
  });
  // Store links open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Lists as saved, with what Wikipedia adds (developers, genres, pictures).
function catalogPayload() {
  const fill = (g) => cloud.fill(wiki.fill(g));
  return catalog.loadAll().map(({ service, source, fetchedAt, games, history }) => ({
    service, source, fetchedAt,
    games: games.map(fill),
    history: history && { ...history, departed: (history.departed || []).map(fill) },
  }));
}

// Wikipedia lookups for games you completed and for lists without
// developers or genres.
function startWiki() {
  const { subscriptions, customServices, marks } = store.get();
  const keys = unlockedTiers(subscriptions, customServices);
  const departed = catalog.loadAll().flatMap((c) => c.history?.departed || []);
  wiki.start(wikiWanted([...catalogGames(), ...departed], {
    isMine: (g) => (g.tiers || []).some((t) => keys.has(`${g.service}:${t}`)),
    markOf: (g) => marks[g.id] || 'none',
  })).catch(() => {});
}

let refreshing = null;
async function refreshAll() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const settings = store.get().settings;
    const before = new Set(catalogGames().map((g) => g.id));
    const waitingBefore = wishlistNow().waiting;
    const results = [];
    for (const service of CATALOG_SERVICES) {
      win?.webContents.send('refresh-progress', { service, state: 'running' });
      const result = await catalog.refresh(service, settings);
      results.push(result);
      win?.webContents.send('refresh-progress', { service, state: result.ok ? 'done' : 'failed', result });
    }
    store.update({ lastRefresh: new Date().toISOString() });
    startRatings();
    enrichArcade();
    startWiki();
    refreshSteam();
    refreshCloud();
    sendAlerts(results, before, waitingBefore);
    win?.webContents.send('catalog-changed');
    return results;
  })();
  updateTray();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
    updateTray();
  }
}

// ---- Tray, start with Windows, alerts ----
function showWindow(view) {
  if (!win) createWindow();
  if (view) win.webContents.send('show-view', view);
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

function notify({ title, body, view }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON });
  n.on('click', () => showWindow(view));
  n.show();
}

// Only games that joined in this refresh count as new; a service seen for
// the first time (or from a new source) is a baseline, not news.
function wishlistNow() {
  const { subscriptions, customServices, marks } = store.get();
  return alerts.wishlist(catalogGames(), { keys: unlockedTiers(subscriptions, customServices), marks, today: new Date().toISOString().slice(0, 10) });
}

function sendAlerts(results, before, waitingBefore = new Map()) {
  const { settings, subscriptions, customServices, marks, alertedLeaving } = store.get();
  const changed = new Set(results.filter((r) => r.ok && r.added?.length).map((r) => r.service));
  const games = catalogGames();
  const newIds = new Set(games.filter((g) => changed.has(g.service) && !before.has(g.id)).map((g) => g.id));
  const picked = alerts.pickAlerts({ games, newIds, keys: unlockedTiers(subscriptions, customServices), marks, alertedLeaving });
  picked.ready = alerts.arrived(waitingBefore, wishlistNow());
  // Remember what's leaving now, so each game is announced once.
  store.update({ alertedLeaving: picked.leavingIds });
  // The window shows the same news when it's open.
  if (!settings.alerts || (win?.isVisible() && win.isFocused())) return;
  for (const m of alerts.messages(picked)) notify(m);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 }));
  tray.on('click', () => showWindow());
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const { settings, lastRefresh } = store.get();
  tray.setToolTip(lastRefresh ? `Subscroll: lists checked ${new Date(lastRefresh).toLocaleString()}` : 'Subscroll');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Subscroll', click: () => showWindow() },
    { label: refreshing ? 'Refreshing…' : 'Refresh now', enabled: !refreshing, click: () => refreshAll().catch(() => {}) },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: !!settings.startWithWindows, visible: process.platform === 'win32', click: (item) => setSettings({ startWithWindows: item.checked }) },
    { label: 'Alerts', type: 'checkbox', checked: settings.alerts !== false, click: (item) => setSettings({ alerts: item.checked }) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function setSettings(patch) {
  store.update({ settings: { ...store.get().settings, ...patch } });
  applyLoginItem();
  updateTray();
  win?.webContents.send('state-changed', store.get());
}

// The portable exe unpacks itself to a temp folder each run, so the login
// item points at the exe the user actually has. Each build has its own file
// name, so this is set again on every launch.
function applyLoginItem() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const on = !!store.get().settings.startWithWindows;
  app.setLoginItemSettings({ openAtLogin: on, path: exe, args: ['--hidden'] });
}

// Lists refresh on schedule even while the window is closed.
function scheduleRefresh() {
  const check = () => {
    const { settings, lastRefresh } = store.get();
    const hours = Number(settings.autoRefreshHours) || 24;
    if (!lastRefresh || Date.now() - new Date(lastRefresh) > hours * 3600000) refreshAll().catch(() => {});
    if (freeGames.due()) refreshFree().catch(() => {});
  };
  setTimeout(check, 60 * 1000);
  setInterval(check, 30 * 60 * 1000);
}

// ---- Cloud play ----
// The list of streamable Xbox games is read once a day.
function refreshCloud() {
  if (!cloud.due()) return;
  cloud.refresh().then(() => win?.webContents.send('catalog-changed')).catch(() => {});
}

// ---- Free games to claim ----
// Checked every few hours; tells you about new giveaways and reminds you on
// the last day of ones you haven't claimed.
async function refreshFree() {
  const { settings } = store.get();
  const r = await freeGames.refresh({ country: settings.region || settings.market || 'US', locale: 'en-US', psLocale: settings.psLocale || 'en-us' });
  const { freebies = {}, freeKnown = null, freeReminded = [], subscriptions } = store.get();
  // PS Plus monthly games and Free Play Days only matter with that plan.
  const yours = r.games.filter((g) => hasPlan(g.needs, subscriptions));
  const picked = freeAlerts(yours, { known: freeKnown, reminded: freeReminded, marks: freebies });
  const live = new Set(r.games.map((g) => g.id));
  store.update({
    freeKnown: r.games.map((g) => g.id),
    freeReminded: [...freeReminded.filter((id) => live.has(id)), ...picked.ending.map((g) => g.id)],
  });
  win?.webContents.send('free-changed');
  if (settings.alerts === false || settings.freeAlerts === false || (win?.isVisible() && win.isFocused())) return r;
  const n = (x) => `${x} game${x === 1 ? '' : 's'}`;
  const keepers = picked.added.filter((g) => g.kind !== 'try');
  const weekend = picked.added.filter((g) => g.kind === 'try');
  if (keepers.length) notify({ view: 'free', title: `Free to keep: ${n(keepers.length)}`, body: listTitles(keepers.map((g) => g.title)) });
  if (weekend.length) notify({ view: 'free', title: `Free Play Days: ${n(weekend.length)}`, body: listTitles(weekend.map((g) => g.title)) });
  if (picked.ending.length) notify({ view: 'free', title: `Last day to claim: ${n(picked.ending.length)}`, body: listTitles(picked.ending.map((g) => g.title)) });
  return r;
}

// Steam notes each installed game in the registry. null when it can't tell.
function steamInstalled(appid) {
  if (process.platform !== 'win32' || !/^\d+$/.test(String(appid))) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('reg', ['query', `HKCU\\Software\\Valve\\Steam\\Apps\\${appid}`, '/v', 'Installed'], { timeout: 3000, windowsHide: true }, (err, out) => {
      if (err) {
        // No key: Steam has never seen it on this PC. No Steam at all: unknown.
        execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamExe'], { timeout: 3000, windowsHide: true }, (err2) => resolve(err2 ? null : false));
        return;
      }
      resolve(/Installed\s+REG_DWORD\s+0x1\b/i.test(out));
    });
  });
}

// ---- Steam library ----
async function importSteam(profile, key) {
  const { steam: current = {}, marks } = store.get();
  const r = await steam.importLibrary({ profile, key }, catalogGames(), current, marks);
  const next = { ...store.get().marks, ...r.marks };
  for (const id of r.clear) delete next[id];
  store.update({ steam: r.steam, marks: next });
  return r.summary;
}

// Playtime changes, so the library is read again with the daily refresh.
async function refreshSteam() {
  const { steam: s } = store.get();
  if (!s?.key || !s?.profile) return;
  try {
    await importSteam(s.profile, s.key);
    win?.webContents.send('state-changed', store.get());
  } catch {
    // Tried again with the next refresh; the last import stays.
  }
}

// ---- Apple Arcade icons and details, looked up slowly in the background ----
let arcadeRunning = false;
async function enrichArcade() {
  if (arcadeRunning) return;
  arcadeRunning = true;
  try {
    const { settings } = store.get();
    const games = catalog.load('applearcade').games;
    const changed = () => {
      catalog.reapplyArcade();
      win?.webContents.send('catalog-changed');
    };
    await arcade.lookupMissing(games, catalog.appStoreDir(), (settings.region || settings.market || 'US').toLowerCase(), { onFound: changed });
  } catch {
    // Retried after the next refresh.
  } finally {
    arcadeRunning = false;
  }
}

// ---- Metacritic / How Long To Beat, looked up in the background ----
function catalogGames() {
  const nintendo = regionById(store.get().settings.region)?.nintendo || 'west';
  return catalog.loadAll()
    .flatMap((c) => c.games)
    .filter((g) => g.service !== 'nso' || (g.regions || ['west']).includes(nintendo));
}

function startRatings() {
  const { subscriptions, customServices } = store.get();
  const keys = unlockedTiers(subscriptions, customServices);
  // Games in the user's plans are looked up first.
  ratings.start(catalogGames(), (g) => g.tiers.some((t) => keys.has(`${g.service}:${t}`)));
}

// Results reach the window in batches rather than one message per game.
let ratingBatch = {};
let ratingProgress = null;
let ratingTimer = null;
function flushRatings() {
  clearTimeout(ratingTimer);
  ratingTimer = null;
  win?.webContents.send('ratings', { updates: ratingBatch, progress: ratingProgress });
  ratingBatch = {};
}
const queueRatings = () => { if (!ratingTimer) ratingTimer = setTimeout(flushRatings, 1500); };

function registerIpc() {
  ipcMain.handle('get-services', () => ({ services: SERVICES, tierBadges: TIER_BADGES, regions: REGIONS }));
  ipcMain.handle('get-state', () => store.get());
  ipcMain.handle('update-state', (_e, patch) => {
    // Only user-owned fields can be written from the window.
    const allowed = ['subscriptions', 'marks', 'leaveDates', 'customServices', 'customGames', 'settings', 'costs', 'priceOverrides', 'viaSub', 'freebies'];
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
    const before = store.get().marks;
    const next = store.update(clean);
    // A newly completed game is looked up for "Because you beat".
    if (clean.marks && Object.keys(clean.marks).some((id) => clean.marks[id] === 'completed' && before[id] !== 'completed')) startWiki();
    if (clean.settings) {
      applyLoginItem();
      updateTray();
    }
    return next;
  });
  ipcMain.handle('get-catalog', () => catalogPayload());
  ipcMain.handle('get-free', () => freeGames.list());
  ipcMain.handle('refresh-free', () => refreshFree());
  ipcMain.handle('refresh', async () => {
    const results = await refreshAll();
    return { results, catalog: catalogPayload() };
  });
  ipcMain.handle('get-details', (_e, game) => details.get(game, store.get().settings));
  ipcMain.handle('get-ratings', () => {
    startRatings();
    return { ratings: ratings.forGames(catalogGames()), progress: ratingProgress };
  });
  // The looked-up data, by the name used in profile files.
  const lookupStores = () => ({
    ratings: { data: ratings.data, save: () => ratings.save() },
    prices: { data: prices.cache, save: () => prices.save() },
    wikipedia: { data: wiki.data, save: () => wiki.save() },
    details: { data: details.data, save: () => fs.promises.writeFile(details.file, JSON.stringify(details.data)).catch(() => {}) },
    appstore: (() => {
      const file = path.join(catalog.appStoreDir(), 'appstore.json');
      const data = readJson(file, {});
      return { data, save: () => writeJson(file, data) };
    })(),
  });
  ipcMain.handle('export-backup', async (_e, opts = {}) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export your Subscroll profile',
      defaultPath: path.join(app.getPath('documents'), backupName()),
      filters: [{ name: 'Subscroll profile', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false };
    const history = Object.fromEntries(catalog.loadAll().map((c) => [c.service, c.history || { firstSeen: {}, departed: [] }]));
    const lookups = opts.lookups === false ? null : Object.fromEntries(Object.entries(lookupStores()).map(([k, v]) => [k, v.data]));
    const text = JSON.stringify(makeBackup(store.get(), new Date(), { history, lookups }));
    await fs.promises.writeFile(filePath, text);
    return { ok: true, file: filePath, marks: Object.keys(store.get().marks).length, bytes: Buffer.byteLength(text) };
  });
  ipcMain.handle('import-backup', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import a Subscroll profile',
      properties: ['openFile'],
      filters: [{ name: 'Subscroll profile', extensions: ['json'] }],
    });
    if (canceled || !filePaths.length) return { ok: false };
    let backup;
    try {
      backup = parseBackup(await fs.promises.readFile(filePaths[0], 'utf8'));
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const count = (marks) => Object.keys(marks).length;
    const when = backup.exportedAt ? ` from ${new Date(backup.exportedAt).toLocaleDateString()}` : '';
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Import', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Import the profile${when}?`,
      detail: `Your plans, settings and ${count(store.get().marks)} marked games on this PC are replaced by the profile's ${count(backup.state.marks)} marked games. `
        + 'List history and looked-up scores, prices and descriptions are added to what this PC already has.',
    });
    if (response !== 0) return { ok: false };
    const { settings, ...rest } = backup.state;
    store.update({ ...rest, ...(settings ? { settings: { ...store.get().settings, ...settings } } : {}) });
    for (const [service, h] of Object.entries(backup.history)) catalog.importHistory(service, h, mergeHistory);
    let looked = 0;
    const stores = lookupStores();
    for (const [k, data] of Object.entries(backup.lookups)) {
      const n = mergeLookups(stores[k].data, data);
      if (n) await stores[k].save();
      looked += n;
    }
    if (backup.lookups.appstore) catalog.reapplyArcade();
    applyLoginItem();
    updateTray();
    startRatings();
    startWiki();
    win?.webContents.send('catalog-changed');
    return { ok: true, marks: count(backup.state.marks), looked, state: store.get() };
  });
  ipcMain.handle('import-steam', async (_e, { profile, key }) => {
    try {
      const summary = await importSteam(String(profile || '').trim(), String(key || '').trim() || store.get().steam?.key);
      return { ok: true, summary, state: store.get() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // Marks stay; only the Steam link, key and owned list go.
  ipcMain.handle('forget-steam', () => store.update({ steam: null }));
  ipcMain.handle('get-prices', () => prices.all());
  // Looked up in the background; results arrive as 'prices' messages.
  ipcMain.handle('lookup-prices', (_e, games) => {
    const { settings } = store.get();
    const region = regionById(settings.region);
    prices.lookup(Array.isArray(games) ? games : [], { market: settings.market, language: settings.language, psLocale: settings.psLocale, currency: region?.currency }).catch(() => {});
  });
  ipcMain.handle('open-external', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });
  // Play buttons: Steam and Xbox app links as well as web pages.
  ipcMain.handle('launch', async (_e, url) => {
    if (!Play.allowed(url)) return { ok: false };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('steam-installed', (_e, appid) => steamInstalled(appid));
}

// The app was first called "Subscription Catalogue". Keep its data folder
// so subscriptions, marks and cached lookups survive the rename.
app.setPath('userData', path.join(app.getPath('appData'), 'Subscription Catalogue'));

// One copy at a time: starting it again (or from Windows startup) shows
// the window that's already running.
const firstCopy = app.requestSingleInstanceLock();
if (!firstCopy) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

app.setAppUserModelId(APP_ID);
app.on('before-quit', () => { quitting = true; });

app.whenReady().then(() => {
  if (!firstCopy) return;
  const dataDir = app.getPath('userData');
  store = new Store(dataDir);
  catalog = new Catalog(dataDir);
  details = new DetailsCache(dataDir);
  ratings = new Ratings(dataDir, {
    onUpdate: (updates) => { Object.assign(ratingBatch, updates); queueRatings(); },
    onProgress: (progress) => {
      ratingProgress = progress;
      if (progress.finished) flushRatings();
      else queueRatings();
    },
  });
  prices = new Prices(dataDir, { onUpdate: (updates, progress) => win?.webContents.send('prices', { updates, progress }) });
  freeGames = new FreeGames(dataDir);
  cloud = new Cloud(dataDir);
  wiki = new Wiki(dataDir, { onFound: (n) => { if (n) win?.webContents.send('catalog-changed'); } });
  registerIpc();
  createWindow();
  createTray();
  applyLoginItem();
  scheduleRefresh();
  setTimeout(enrichArcade, 5000);
  setTimeout(startWiki, 8000);
  setTimeout(refreshCloud, 10000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit();
});
