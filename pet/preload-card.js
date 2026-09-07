const { contextBridge, ipcRenderer } = require('electron')

// 游戏卫星窗的 preload：关窗 + IPC 移窗
contextBridge.exposeInMainWorld('__cardBridge', {
  close: () => ipcRenderer.send('l2d-game-close'),
  moveBy: (dx, dy) => ipcRenderer.send('l2d-game-moveby', dx, dy),
})
