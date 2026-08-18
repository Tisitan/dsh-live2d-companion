const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__petBridge', {
  setIgnore: (ignore) => ipcRenderer.send('l2d-ignore', ignore),
  onCursor: (cb) => ipcRenderer.on('l2d-cursor', (_e, data) => cb(data)),
  getCursor: () => ipcRenderer.invoke('l2d-cursor-get'),
  quit: () => ipcRenderer.send('l2d-quit'),
  getSoft: () => ipcRenderer.invoke('l2d-soft-get'),
  setSoft: (on) => ipcRenderer.send('l2d-soft-set', on),
})
