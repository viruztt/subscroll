const { app, BrowserWindow, ipcMain, net, shell } = require('electron');
const path = require('path');
const { Store } = require('./store');
const { Catalog } = require('./catalog');
const { SERVICES, TIER_BADGES } = require('./services');
const http = require('./providers/http');

let store;
let catalog;
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
    for (const service of ['gamepass', 'psplus']) {
      win?.webContents.send('refresh-progress', { service, state: 'running' });
      const result = await catalog.refresh(service, settings);
      results.push(result);
      win?.webContents.send('refresh-progress', { service, state: result.ok ? 'done' : 'failed', result });
    }
    store.update({ lastRefresh: new Date().toISOString() });
    return results;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

function registerIpc() {
  ipcMain.handle('get-services', () => ({ services: SERVICES, tierBadges: TIER_BADGES }));
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
  ipcMain.handle('open-external', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  const dataDir = app.getPath('userData');
  store = new Store(dataDir);
  catalog = new Catalog(dataDir);
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
