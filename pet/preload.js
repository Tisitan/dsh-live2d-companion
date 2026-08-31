const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__petBridge', {
  setIgnore: (ignore) => ipcRenderer.send('l2d-ignore', ignore),
  onCursor: (cb) => ipcRenderer.on('l2d-cursor', (_e, data) => cb(data)),
  getCursor: () => ipcRenderer.invoke('l2d-cursor-get'),
  quit: () => ipcRenderer.send('l2d-quit'),
  restart: () => ipcRenderer.send('l2d-restart'),
  getSoft: () => ipcRenderer.invoke('l2d-soft-get'),
  setSoft: (on) => ipcRenderer.send('l2d-soft-set', on),
  // 游戏卫星窗：overlay 纯装饰化，对局卡独立小窗（焦点/穿透问题物理隔离）；
  // gameId 透传主进程选窗（gomoku/chess，非法值主进程回落 gomoku）
  openGame: (gameId) => ipcRenderer.send('l2d-game-open', gameId),
  onGameFocus: (cb) => ipcRenderer.on('l2d-game-focus', () => cb()),
  // 卫星窗屏幕区域推送（开/移动/关）：该区域对 overlay 是穿透死区，防停留解锁吃卡片点击
  onCardArea: (cb) => ipcRenderer.on('l2d-game-area', (_e, b) => cb(b)),
  getCardArea: () => ipcRenderer.invoke('l2d-game-bounds'),
})
