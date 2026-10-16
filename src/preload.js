const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getServices: () => ipcRenderer.invoke('get-services'),
  getState: () => ipcRenderer.invoke('get-state'),
  updateState: (patch) => ipcRenderer.invoke('update-state', patch),
  getCatalog: () => ipcRenderer.invoke('get-catalog'),
  refresh: () => ipcRenderer.invoke('refresh'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onRefreshProgress: (fn) => ipcRenderer.on('refresh-progress', (_e, msg) => fn(msg)),
});
