const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getServices: () => ipcRenderer.invoke('get-services'),
  getState: () => ipcRenderer.invoke('get-state'),
  updateState: (patch) => ipcRenderer.invoke('update-state', patch),
  getCatalog: () => ipcRenderer.invoke('get-catalog'),
  refresh: () => ipcRenderer.invoke('refresh'),
  getDetails: (game) => ipcRenderer.invoke('get-details', game),
  getRatings: () => ipcRenderer.invoke('get-ratings'),
  onRatings: (fn) => ipcRenderer.on('ratings', (_e, msg) => fn(msg)),
  onCatalogChanged: (fn) => ipcRenderer.on('catalog-changed', () => fn()),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  exportBackup: () => ipcRenderer.invoke('export-backup'),
  importBackup: () => ipcRenderer.invoke('import-backup'),
  importSteam: (profile, key) => ipcRenderer.invoke('import-steam', { profile, key }),
  forgetSteam: () => ipcRenderer.invoke('forget-steam'),
  onStateChanged: (fn) => ipcRenderer.on('state-changed', (_e, s) => fn(s)),
  onShowView: (fn) => ipcRenderer.on('show-view', (_e, view) => fn(view)),
  getPrices: () => ipcRenderer.invoke('get-prices'),
  lookupPrices: (games) => ipcRenderer.invoke('lookup-prices', games),
  onPrices: (fn) => ipcRenderer.on('prices', (_e, msg) => fn(msg)),
  onRefreshProgress: (fn) => ipcRenderer.on('refresh-progress', (_e, msg) => fn(msg)),
});
