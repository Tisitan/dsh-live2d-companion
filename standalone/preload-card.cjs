const { contextBridge, ipcRenderer } = require('electron')

// 独立版游戏卫星窗桥：窗口生命周期、焦点能力和拖动全部交给主进程。
contextBridge.exposeInMainWorld('__cardBridge', {
  close: () => ipcRenderer.send('l2d-game-close'),
  setFocusable: (on) => ipcRenderer.send('l2d-game-focusable', on),
  moveBy: (dx, dy) => ipcRenderer.send('l2d-game-moveby', dx, dy),
})
