const { app, BrowserWindow, ipcMain, net, shell } = require('electron');
const path = require('path');
const { Store } = require('./store');
const { Catalog, SERVICES: CATALOG_SERVICES } = require('./catalog');
const arcade = require('./providers/applearcade');
const { DetailsCache } = require('./details');
const { Ratings } = require('./ratings');
const { SERVICES, TIER_BADGES, unlockedTiers } = require('./services');
const { REGIONS, regionById } = require('./regions');
const http = require('./providers/http');

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
    title: 'Subscription Catalogue',
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
    return results;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
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
  ipcMain.handle('open-external', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });
}

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
