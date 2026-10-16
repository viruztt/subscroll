const { app, BrowserWindow, dialog, ipcMain, net, shell } = require('electron');
const path = require('path');
const { Store } = require('./store');
const { Catalog, SERVICES: CATALOG_SERVICES } = require('./catalog');
const arcade = require('./providers/applearcade');
const { DetailsCache } = require('./details');
const { Ratings } = require('./ratings');
const { SERVICES, TIER_BADGES, unlockedTiers } = require('./services');
const { REGIONS, regionById } = require('./regions');
const http = require('./providers/http');
const { makeBackup, parseBackup, backupName } = require('./backup');
const steam = require('./steam');
const fs = require('fs');

let store;
let catalog;
let details;
let ratings;
let win;

// Use Chromium's network stack: honours system proxy settings and certificates.
http.setFetch((url, opts) => net.fetch(url, opts));

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'Subscroll',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Store links open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function catalogPayload() {
  return catalog.loadAll().map(({ service, source, fetchedAt, games, history }) => ({
    service, source, fetchedAt, games, history,
  }));
}

let refreshing = null;
async function refreshAll() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const settings = store.get().settings;
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
    refreshSteam();
    return results;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

// ---- Steam library ----
async function importSteam(profile, key) {
  const { steam: current = {}, marks } = store.get();
  const r = await steam.importLibrary({ profile, key }, catalogGames(), current, marks);
  store.update({ steam: r.steam, marks: { ...store.get().marks, ...r.marks } });
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
    const allowed = ['subscriptions', 'marks', 'leaveDates', 'customServices', 'customGames', 'settings'];
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
    return store.update(clean);
  });
  ipcMain.handle('get-catalog', () => catalogPayload());
  ipcMain.handle('refresh', async () => {
    const results = await refreshAll();
    return { results, catalog: catalogPayload() };
  });
  ipcMain.handle('get-details', (_e, game) => details.get(game, store.get().settings));
  ipcMain.handle('get-ratings', () => {
    startRatings();
    return { ratings: ratings.forGames(catalogGames()), progress: ratingProgress };
  });
  ipcMain.handle('export-backup', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save a backup of your plans and marks',
      defaultPath: path.join(app.getPath('documents'), backupName()),
      filters: [{ name: 'Subscroll backup', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false };
    await fs.promises.writeFile(filePath, JSON.stringify(makeBackup(store.get()), null, 1));
    return { ok: true, file: filePath, marks: Object.keys(store.get().marks).length };
  });
  ipcMain.handle('import-backup', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Restore from a backup',
      properties: ['openFile'],
      filters: [{ name: 'Subscroll backup', extensions: ['json'] }],
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
      buttons: ['Restore', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Restore the backup${when}?`,
      detail: `Your plans, settings and ${count(store.get().marks)} marked games on this PC are replaced by the backup's ${count(backup.state.marks)} marked games.`,
    });
    if (response !== 0) return { ok: false };
    const { settings, ...rest } = backup.state;
    store.update({ ...rest, ...(settings ? { settings: { ...store.get().settings, ...settings } } : {}) });
    startRatings();
    return { ok: true, marks: count(backup.state.marks), state: store.get() };
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
  ipcMain.handle('open-external', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });
}

// The app was first called "Subscription Catalogue". Keep its data folder
// so subscriptions, marks and cached lookups survive the rename.
app.setPath('userData', path.join(app.getPath('appData'), 'Subscription Catalogue'));

app.whenReady().then(() => {
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
  registerIpc();
  createWindow();
  setTimeout(enrichArcade, 5000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
