const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, nativeTheme, net, shell } = require('electron');
const path = require('path');
const { Store, readJson, writeJson } = require('./store');
const { Catalog, SERVICES: CATALOG_SERVICES } = require('./catalog');
const arcade = require('./providers/applearcade');
const psblog = require('./providers/psblog');
const { DetailsCache } = require('./details');
const { Ratings } = require('./ratings');
const { SERVICES, TIER_BADGES, unlockedTiers, offerOpen } = require('./services');
const http = require('./providers/http');
const { makeBackup, parseBackup, mergeHistory, mergeLookups, backupName } = require('./backup');
const steam = require('./steam');
const achievements = require('./achievements');
const alerts = require('./alerts');
const { Prices } = require('./prices');
const { Wiki, wanted: wikiWanted } = require('./wiki');
const { FreeGames, freeAlerts, hasPlan } = require('./freegames');
const { Cloud } = require('./cloud');
const { GeForceNow } = require('./gfn');
const Play = require('../renderer/play');
const sales = require('./sales');
const { execFile } = require('child_process');
const { listTitles } = alerts;
const fs = require('fs');
const linux = require('./linux');
const updates = require('./updates');
const selfupdate = require('./selfupdate');
const Goals = require('../renderer/goals');
const I18n = require('../renderer/i18n');
require('../renderer/locales');

const { t, tn, tk, locale } = I18n;

const LOGIN_LABEL = process.platform === 'win32' ? tk('Start with Windows') : tk('Start when you log in');

let store;
let catalog;
let details;
let ratings;
let prices;
let wiki;
let freeGames;
let cloud;
let gfn;
let win;
let tray;
let quitting = false;

// Use Chromium's network stack: honours system proxy settings and certificates.
http.setFetch((url, opts) => net.fetch(url, opts));

const ICON = path.join(__dirname, '..', 'renderer', 'icon.png');
// A real .ico next to the app (packaged builds), which the Windows taskbar
// reads more reliably than a PNG.
const ICO = app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : path.join(__dirname, '..', 'build', 'icon.ico');
// Windows keeps the taskbar icon it last resolved for an app id. Builds before
// 4266ef1 pointed it at a temp folder that no longer exists, which left
// 'local.subscroll' stuck on a blank icon, so this id is new.
const APP_ID = 'local.subscroll.app';

// The portable exe unpacks into a temp folder whose name changes with every
// build and which is deleted on exit. Windows remembers the taskbar icon path
// for the app id, so pointing it there left a blank icon once that folder was
// gone. Keep a copy of the icon in the app's own data folder, which never moves.
function stableIcon() {
  const dest = path.join(app.getPath('userData'), 'icon.ico');
  try {
    const data = fs.readFileSync(ICO);
    let same = false;
    try { same = fs.readFileSync(dest).equals(data); } catch {}
    if (!same) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }
    return dest;
  } catch {
    return ICO;
  }
}
// Started with Windows: stay in the tray until the user opens the window.
const startHidden = process.argv.includes('--hidden');
// Started by the copy it replaced: delete that copy's file once it's gone.
const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] || null : null;
};
const updatedFrom = argAfter('--updated-from');

// Dark (the default), light, or the system's choice. The window's styles and
// title bar follow Electron's theme. Returns whether it's dark.
function applyTheme() {
  const theme = store.get().settings.theme;
  nativeTheme.themeSource = ['light', 'system'].includes(theme) ? theme : 'dark';
  return nativeTheme.shouldUseDarkColors;
}

function createWindow() {
  win = new BrowserWindow({
    show: !startHidden,
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: applyTheme() ? '#0f1115' : '#f3f4f7',
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
  // portable exe has none, so the button came out blank. Give it an icon file
  // directly, from a folder that outlives this run (see stableIcon).
  if (process.platform === 'win32') {
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: stableIcon(),
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
      notify({ title: t('Subscroll is still running'), body: t('It keeps checking your services in the background. Right-click the tray icon to quit.') });
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
  const fill = (g) => gfn.fill(cloud.fill(wiki.fill(g)));
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
    isMine: (g) => offerOpen(keys, g),
    markOf: (g) => marks[g.id] || 'none',
  })).catch(() => {});
}

// The catalogues your plans cover (PC Game Pass brings EA Play's), or every
// one when you've picked no plans.
function myCatalogs() {
  const { subscriptions, customServices } = store.get();
  const services = new Set([...unlockedTiers(subscriptions, customServices)].map((k) => k.split(':')[0]));
  const mine = CATALOG_SERVICES.filter((s) => services.has(s));
  return mine.length ? mine : CATALOG_SERVICES;
}

let refreshing = null;
// `only`: the services to refresh; all of them when left out.
async function refreshAll(only = null) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const settings = store.get().settings;
    const before = new Set(catalogGames().map((g) => g.id));
    const waitingBefore = wishlistNow().waiting;
    const results = [];
    const services = only ? CATALOG_SERVICES.filter((s) => only.includes(s)) : CATALOG_SERVICES;
    for (const service of services) {
      win?.webContents.send('refresh-progress', { service, state: 'running' });
      const result = await catalog.refresh(service, settings);
      results.push(result);
      win?.webContents.send('refresh-progress', { service, state: result.ok ? 'done' : 'failed', result });
    }
    // The daily check counts only full refreshes.
    if (services.length === CATALOG_SERVICES.length) store.update({ lastRefresh: new Date().toISOString() });
    startRatings();
    enrichArcade();
    startWiki();
    refreshSteam();
    refreshAchievements();
    refreshCloud();
    refreshPsBlog();
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
  // The Mac menu bar fits an 18-point icon.
  const size = process.platform === 'darwin' ? 18 : 32;
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: size, height: size }));
  tray.on('click', () => showWindow());
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const { settings, lastRefresh } = store.get();
  tray.setToolTip(lastRefresh ? t('Subscroll: lists checked {date}', { date: new Date(lastRefresh).toLocaleString(locale()) }) : 'Subscroll');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('Open Subscroll'), click: () => showWindow() },
    { label: refreshing ? t('Refreshing…') : t('Refresh now'), enabled: !refreshing, click: () => refreshAll().catch(() => {}) },
    { type: 'separator' },
    { label: t(LOGIN_LABEL), type: 'checkbox', checked: !!settings.startWithWindows, visible: canStartAtLogin(), click: (item) => setSettings({ startWithWindows: item.checked }) },
    { label: t('Alerts'), type: 'checkbox', checked: settings.alerts !== false, click: (item) => setSettings({ alerts: item.checked }) },
    { type: 'separator' },
    ...(updateStatus().ready ? [{ label: t('Restart to update to {version}', { version: updateStatus().ready.version }), click: () => installUpdate() }] : []),
    { label: t('Quit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

// The tray menu and notifications follow the window's language setting.
function applyLanguage() {
  let system = [];
  try {
    system = app.getPreferredSystemLanguages();
  } catch {
    system = [app.getLocale()];
  }
  I18n.setLanguage(store.get().settings.uiLanguage || 'auto', system);
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
// On Linux the same goes for the AppImage, through an autostart entry, and a
// Mac adds the app to its Login Items.
// (The setting keeps its old name, startWithWindows, so saved choices carry over.)
const canStartAtLogin = () => app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin' || (process.platform === 'linux' && !!process.env.APPIMAGE));
function applyLoginItem() {
  if (!canStartAtLogin()) return;
  const on = !!store.get().settings.startWithWindows;
  if (process.platform === 'linux') {
    linux.setAutostart(on, process.env.APPIMAGE);
    return;
  }
  if (process.platform === 'darwin') {
    // Only when it changes: macOS refuses the call for apps outside Applications.
    if (app.getLoginItemSettings().openAtLogin !== on) app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
    return;
  }
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setLoginItemSettings({ openAtLogin: on, path: exe, args: ['--hidden'] });
}

// Lists refresh on schedule even while the window is closed.
function scheduleRefresh() {
  const check = () => {
    const { settings, lastRefresh } = store.get();
    const hours = Number(settings.autoRefreshHours) || 24;
    if (!lastRefresh || Date.now() - new Date(lastRefresh) > hours * 3600000) refreshAll().catch(() => {});
    if (freeGames.due()) refreshFree().catch(() => {});
    checkSales().catch(() => {});
    checkUpdate().catch(() => {});
  };
  setTimeout(check, 60 * 1000);
  setInterval(check, 30 * 60 * 1000);
}

// ---- Newer version ----
// GitHub's latest release, twice a day. The portable exe and the AppImage
// download it in the background (unless that's turned off) and switch to it
// when you restart Subscroll or the next time it starts; other copies show a
// download link. Either way you hear about each version once.
const selfFile = () => selfupdate.currentFile({ packaged: app.isPackaged });
let downloading = null;
const updateStatus = () => updates.status(store.get().update, app.getVersion(), { canInstall: !!selfFile(), downloading });
const sendUpdate = () => {
  win?.webContents.send('update-changed', updateStatus());
  updateTray();
};
const autoInstall = () => store.get().settings.autoUpdate !== false;

async function checkUpdate(force = false) {
  const { settings, update: saved } = store.get();
  if (!force && (settings.updateCheck === false || !updates.due(saved?.checkedAt))) return updateStatus();
  try {
    const latest = await updates.fetchLatest(process.platform);
    store.update({ update: { ...(store.get().update || {}), latest, checkedAt: new Date().toISOString(), error: null } });
  } catch (e) {
    // Tried again at the next half-hourly check.
    store.update({ update: { ...(store.get().update || {}), error: e.message } });
  }
  const st = updateStatus();
  sendUpdate();
  if (st.newer && st.canInstall && autoInstall()) {
    if (!st.ready || st.ready.version !== st.latest.version) downloadUpdate().catch(() => {});
  } else if (st.newer && store.get().updateNotified !== st.latest.version) {
    store.update({ updateNotified: st.latest.version });
    if (settings.alerts !== false && !(win?.isVisible() && win.isFocused())) {
      notify({ title: t('Subscroll {version} is out', { version: st.latest.version }), body: t('You have {current}. Open Subscroll to download the new version.', { current: st.current }), view: 'subs' });
    }
  }
  return st;
}

// Downloads the latest version next to this file and keeps it for a restart.
async function downloadUpdate() {
  const st = updateStatus();
  const current = selfFile();
  if (downloading || !st.newer || !st.canInstall || !current) return st;
  const { version, download: asset } = st.latest;
  downloading = { version, got: 0, total: asset.size || 0 };
  sendUpdate();
  let last = 0;
  try {
    const file = selfupdate.readyPath(current, asset.name);
    const old = st.ready && st.ready.file !== file ? st.ready.file : null;
    await selfupdate.download(asset, file, {
      onProgress: (got, total) => {
        downloading = { version, got, total };
        if (Date.now() - last > 500) {
          last = Date.now();
          win?.webContents.send('update-changed', updateStatus());
        }
      },
    });
    // An older download that was never installed.
    if (old) fs.rmSync(old, { force: true });
    store.update({ update: { ...(store.get().update || {}), ready: { version, file, sha256: asset.sha256 }, downloadError: null } });
    downloading = null;
    sendUpdate();
    const { settings } = store.get();
    if (store.get().updateNotified !== version) {
      store.update({ updateNotified: version });
      if (settings.alerts !== false && !(win?.isVisible() && win.isFocused())) {
        notify({ title: t('Subscroll {version} is ready', { version }), body: t('Restart Subscroll to update, or it updates the next time it starts.'), view: 'subs' });
      }
    }
  } catch (e) {
    downloading = null;
    store.update({ update: { ...(store.get().update || {}), downloadError: e.code === 'EACCES' || e.code === 'EPERM' ? t('Subscroll can\'t save files in {folder}. Move it to a folder you can write to, such as Downloads.', { folder: path.dirname(current) }) : e.message } });
    sendUpdate();
  }
  return updateStatus();
}

// Swaps in the downloaded version and restarts into it. False when there's
// nothing to install (or its file has gone).
function installUpdate({ hidden = false } = {}) {
  const { ready } = updateStatus();
  const current = selfFile();
  if (!ready || !current || !fs.existsSync(ready.file)) {
    if (ready) store.update({ update: { ...(store.get().update || {}), ready: null } });
    return false;
  }
  const { launch, old } = selfupdate.install(ready.file, current);
  store.update({ update: { ...(store.get().update || {}), ready: null } });
  app.relaunch({ execPath: launch, args: ['--updated-from', old, ...(hidden ? ['--hidden'] : [])] });
  quitting = true;
  app.quit();
  return true;
}

// After an update: delete the old file, and anything left from a download
// for a version this copy already is.
function cleanUpUpdate() {
  if (updatedFrom) selfupdate.removeOld(updatedFrom, selfFile()).catch(() => {});
  const saved = store.get().update;
  if (saved?.ready && !updateStatus().ready) {
    const self = selfFile();
    if (saved.ready.file && (!self || path.resolve(saved.ready.file) !== path.resolve(self))) fs.rmSync(saved.ready.file, { force: true });
    store.update({ update: { ...saved, ready: null } });
  }
}

// ---- Sale alerts ----
// To play games outside your plans (the window keeps the list current) are
// looked up in their stores twice a day; a new or lower sale price is news.
async function checkSales() {
  const { saleWatch = [], settings } = store.get();
  if (!saleWatch.length) return;
  const { currency } = settings;
  await prices.lookup(saleWatch, { market: settings.market, language: settings.language, psLocale: settings.psLocale, currency }, { maxHours: sales.CHECK_HOURS });
  const r = sales.saleAlerts(saleWatch, prices.all(), store.get().saleAlerted || {}, { currency });
  store.update({ saleAlerted: r.alerted });
  if (!r.fresh.length || settings.alerts === false || settings.saleAlerts === false || (win?.isVisible() && win.isFocused())) return;
  const fmt = (x, cur) => { try { return new Intl.NumberFormat(locale(), { style: 'currency', currency: cur }).format(x); } catch { return x.toFixed(2); } };
  if (r.fresh.length === 1) {
    const [g] = r.fresh;
    const price = fmt(g.sale, g.currency);
    const body = g.saleEnds
      ? t('{price}, {off}% off, until {date}', { price, off: g.off, date: new Date(g.saleEnds).toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) })
      : t('{price}, {off}% off', { price, off: g.off });
    notify({ view: 'toplay', title: t('On sale: {title}', { title: g.title }), body });
  } else {
    notify({ view: 'toplay', title: tn(r.fresh.length, 'On sale from your To play list: {n} game', 'On sale from your To play list: {n} games'), body: listTitles(r.fresh.map((g) => t('{title} ({off}% off)', { title: g.title, off: g.off }))) });
  }
}

// ---- Cloud play ----
// The list of streamable Xbox games is read once a day.
// So is GeForce NOW's list of supported games.
function refreshCloud() {
  if (cloud.due()) cloud.refresh().then(() => win?.webContents.send('catalog-changed')).catch(() => {});
  if (gfn.due()) gfn.refresh().then(() => win?.webContents.send('catalog-changed')).catch(() => {});
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
  const keepers = picked.added.filter((g) => g.kind !== 'try');
  const weekend = picked.added.filter((g) => g.kind === 'try');
  if (keepers.length) notify({ view: 'free', title: tn(keepers.length, 'Free to keep: {n} game', 'Free to keep: {n} games'), body: listTitles(keepers.map((g) => g.title)) });
  if (weekend.length) notify({ view: 'free', title: tn(weekend.length, 'Free Play Days: {n} game', 'Free Play Days: {n} games'), body: listTitles(weekend.map((g) => g.title)) });
  if (picked.ending.length) notify({ view: 'free', title: tn(picked.ending.length, 'Last day to claim: {n} game', 'Last day to claim: {n} games'), body: listTitles(picked.ending.map((g) => g.title)) });
  return r;
}

// Steam notes each installed game in the registry. null when it can't tell.
function steamInstalled(appid) {
  if (process.platform === 'linux') return Promise.resolve(linux.steamInstalled(appid));
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

// ---- Xbox achievements and PlayStation trophies ----
// kind: 'xbox' (OpenXBL key) or 'psn' (NPSSO code); saved as state.xbox / state.psn.
async function importAchievementsFor(kind, secret) {
  const { [kind]: current = {}, marks } = store.get();
  const r = await achievements.importAchievements(kind, secret, catalogGames(), current || {}, marks);
  const before = store.get().marks;
  const next = { ...before, ...r.marks };
  for (const id of r.clear) delete next[id];
  // Newly completed games are dated by when they were last played, else today.
  const finishedOn = Goals.stampFinished(store.get().finishedOn || {}, before, next, new Date().toISOString().slice(0, 10));
  for (const [id, day] of Object.entries(r.finished || {})) if (next[id] === 'completed' && before[id] !== 'completed') finishedOn[id] = day;
  store.update({ [kind]: r.account, marks: next, finishedOn });
  return r.summary;
}

// Read again with the daily refresh, as Steam is.
async function refreshAchievements() {
  for (const kind of ['xbox', 'psn']) {
    const a = store.get()[kind];
    const secret = a && (a.key || a.npsso);
    if (!secret) continue;
    try {
      await importAchievementsFor(kind, secret);
      win?.webContents.send('state-changed', store.get());
    } catch {
      // Tried again with the next refresh; the last import stays.
    }
  }
}

// ---- PS Plus join dates from the PlayStation Blog, read slowly in the background ----
// The first read takes a few minutes (one post every 5 seconds); after
// that only new monthly posts are read, once a day.
// The sidebar shows how far it got: { done, total } while reading,
// { error } when the blog couldn't be reached, null otherwise.
let psBlogRunning = false;
let psBlogProgress = null;
function setPsBlogProgress(p) {
  psBlogProgress = p;
  win?.webContents.send('psblog-progress', p);
}
async function refreshPsBlog() {
  if (psBlogRunning || !psblog.due(catalog.dir)) return;
  psBlogRunning = true;
  try {
    // Join dates are applied every few posts, so predictions fill in as it goes.
    let applied = 0;
    const onProgress = (p) => {
      setPsBlogProgress(p);
      if (p.done - applied >= 10) {
        applied = p.done;
        catalog.reapplyPsJoinDates();
        win?.webContents.send('catalog-changed');
      }
    };
    const read = await psblog.update(catalog.dir, { onProgress });
    setPsBlogProgress(null);
    if (read) {
      catalog.reapplyPsJoinDates();
      win?.webContents.send('catalog-changed');
    }
  } catch (err) {
    // Tried again after the next refresh.
    setPsBlogProgress({ error: err.message });
  } finally {
    psBlogRunning = false;
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
  const nintendo = store.get().settings.nintendo || 'west';
  return catalog.loadAll()
    .flatMap((c) => c.games)
    .filter((g) => g.service !== 'nso' || (g.regions || ['west']).includes(nintendo));
}

function startRatings() {
  const { subscriptions, customServices } = store.get();
  const keys = unlockedTiers(subscriptions, customServices);
  // Games in the user's plans are looked up first.
  ratings.start(catalogGames(), (g) => offerOpen(keys, g));
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
  ipcMain.handle('get-services', () => ({ services: SERVICES, tierBadges: TIER_BADGES, system: { platform: process.platform, version: app.getVersion(), startAtLogin: canStartAtLogin() ? LOGIN_LABEL : null, selfUpdate: !!selfFile() } }));
  ipcMain.handle('get-state', () => store.get());
  ipcMain.handle('update-state', (_e, patch) => {
    // Only user-owned fields can be written from the window.
    const allowed = ['subscriptions', 'marks', 'leaveDates', 'customServices', 'customGames', 'settings', 'costs', 'priceOverrides', 'viaSub', 'freebies', 'notes', 'finishedOn', 'goals', 'predictionLog'];
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
    const before = store.get().marks;
    const next = store.update(clean);
    // A newly completed game is looked up for "Because you beat".
    if (clean.marks && Object.keys(clean.marks).some((id) => clean.marks[id] === 'completed' && before[id] !== 'completed')) startWiki();
    if (clean.settings) {
      applyTheme();
      applyLanguage();
      applyLoginItem();
      updateTray();
    }
    return next;
  });
  ipcMain.handle('get-catalog', () => catalogPayload());
  ipcMain.handle('get-psblog-progress', () => psBlogProgress);
  ipcMain.handle('get-free', () => freeGames.list());
  ipcMain.handle('refresh-free', () => refreshFree());
  ipcMain.handle('refresh', async (_e, scope) => {
    const results = await refreshAll(scope === 'mine' ? myCatalogs() : null);
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
      title: t('Export your Subscroll profile'),
      defaultPath: path.join(app.getPath('documents'), backupName()),
      filters: [{ name: t('Subscroll profile'), extensions: ['json'] }],
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
      title: t('Import a Subscroll profile'),
      properties: ['openFile'],
      filters: [{ name: t('Subscroll profile'), extensions: ['json'] }],
    });
    if (canceled || !filePaths.length) return { ok: false };
    let backup;
    try {
      backup = parseBackup(await fs.promises.readFile(filePaths[0], 'utf8'));
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const count = (marks) => Object.keys(marks).length;
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [t('Import'), t('Cancel')],
      defaultId: 0,
      cancelId: 1,
      message: backup.exportedAt
        ? t('Import the profile from {date}?', { date: new Date(backup.exportedAt).toLocaleDateString(locale()) })
        : t('Import the profile?'),
      detail: t('Your plans, settings and {mine} marked games on this PC are replaced by the profile\'s {theirs} marked games. ', { mine: count(store.get().marks), theirs: count(backup.state.marks) })
        + t('List history and looked-up scores, prices and descriptions are added to what this PC already has.'),
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
  ipcMain.handle('import-achievements', async (_e, { kind, secret }) => {
    if (kind !== 'xbox' && kind !== 'psn') return { ok: false, error: 'Unknown account' };
    try {
      const saved = store.get()[kind];
      const summary = await importAchievementsFor(kind, String(secret || '').trim() || saved?.key || saved?.npsso);
      return { ok: true, summary, state: store.get() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // Marks stay; only the key and the trophy list go.
  ipcMain.handle('forget-achievements', (_e, kind) => (kind === 'xbox' || kind === 'psn' ? store.update({ [kind]: null }) : store.get()));
  ipcMain.handle('get-prices', () => prices.all());
  // Looked up in the background; results arrive as 'prices' messages.
  ipcMain.handle('lookup-prices', (_e, games) => {
    const { settings } = store.get();
    prices.lookup(Array.isArray(games) ? games : [], { market: settings.market, language: settings.language, psLocale: settings.psLocale, currency: settings.currency }).catch(() => {});
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
  ipcMain.handle('get-update', () => updateStatus());
  ipcMain.handle('check-update', () => checkUpdate(true));
  ipcMain.handle('download-update', () => downloadUpdate());
  ipcMain.handle('install-update', () => installUpdate());
  ipcMain.handle('watch-sales', (_e, list) => {
    store.update({ saleWatch: sales.cleanWatch(list) });
    checkSales().catch(() => {});
  });
}

// The app was first called "Subscription Catalogue". Keep its data folder
// so subscriptions, marks and cached lookups survive the rename.
app.setPath('userData', path.join(app.getPath('appData'), 'Subscription Catalogue'));

// One copy at a time: starting it again (or from Windows startup) shows
// the window that's already running.
// Right after an update the old copy may still be quitting, so the new one
// waits a little for it.
let firstCopy = app.requestSingleInstanceLock();
if (!firstCopy && !updatedFrom) app.quit();
app.on('second-instance', () => {
  if (firstCopy) showWindow();
});
async function waitForLock() {
  for (let i = 0; !firstCopy && i < 40; i++) {
    await new Promise((ok) => setTimeout(ok, 500));
    firstCopy = app.requestSingleInstanceLock();
  }
  return firstCopy;
}

app.setAppUserModelId(APP_ID);
app.on('before-quit', () => { quitting = true; });

app.whenReady().then(async () => {
  if (!firstCopy && !(await waitForLock())) {
    app.quit();
    return;
  }
  const dataDir = app.getPath('userData');
  store = new Store(dataDir);
  applyLanguage();
  // A version downloaded last time installs now, before anything opens.
  if (!updatedFrom && autoInstall() && installUpdate({ hidden: startHidden })) return;
  cleanUpUpdate();
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
  gfn = new GeForceNow(dataDir);
  wiki = new Wiki(dataDir, { onFound: (n) => { if (n) win?.webContents.send('catalog-changed'); } });
  registerIpc();
  createWindow();
  createTray();
  applyLoginItem();
  scheduleRefresh();
  setTimeout(enrichArcade, 5000);
  setTimeout(startWiki, 8000);
  setTimeout(refreshCloud, 10000);
  setTimeout(refreshPsBlog, 12000);
  // Imports made before this feature lack the last two weeks of Steam playtime (for
  // "Can I finish it in time?"), so read the library again now.
  const steamSaved = store.get().steam;
  if (steamSaved?.key && steamSaved.recentMinutes === undefined) setTimeout(refreshSteam, 3000);
  // Clicking the Dock icon brings the window back, even when it was closed to the menu bar.
  app.on('activate', () => showWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit();
});
