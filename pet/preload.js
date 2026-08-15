const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__petBridge', {
  setIgnore: (ignore) => ipcRenderer.send('l2d-ignore', ignore),
  moveBy: (dx, dy) => ipcRenderer.send('l2d-move', dx, dy),
  resizeTo: (w, h) => ipcRenderer.send('l2d-resize', w, h),
})
