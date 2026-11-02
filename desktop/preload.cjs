const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('conductor', Object.freeze({
  request: (path, method = 'GET', body) => ipcRenderer.invoke('conductor:request', path, method, body),
  desktop: (action, value) => ipcRenderer.invoke('conductor:desktop', action, value),
}));
