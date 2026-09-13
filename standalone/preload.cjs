const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__petBridge', {
  setIgnore: (ignore) => ipcRenderer.send('l2d-ignore', ignore),
  // 穿透单源决策（同 pet/preload.js）：矩形集上报 + 心跳 + 状态迁移回推
  pushRects: (rects) => ipcRenderer.send('l2d-rects', rects),
  heartbeat: (lastInputAt) => ipcRenderer.send('l2d-heartbeat', lastInputAt),
  onInteractState: (cb) => ipcRenderer.on('l2d-interact-state', (_e, state) => cb(state)),
  reportError: (msg) => ipcRenderer.send('l2d-renderer-error', msg),
  onCursor: (cb) => ipcRenderer.on('l2d-cursor', (_e, data) => cb(data)),
  getCursor: () => ipcRenderer.invoke('l2d-cursor-get'),
  quit: () => ipcRenderer.send('l2d-quit'),
  restart: () => ipcRenderer.send('l2d-restart'),
  getSoft: () => ipcRenderer.invoke('l2d-soft-get'),
  setSoft: (on) => ipcRenderer.send('l2d-soft-set', on),
  openGame: (gameId = 'gomoku') => ipcRenderer.send('l2d-game-open', gameId),
  onCardArea: (cb) => ipcRenderer.on('l2d-game-area', (_e, bounds) => cb(bounds)),
  getCardArea: () => ipcRenderer.invoke('l2d-game-bounds'),
  getDiaryConfig: () => ipcRenderer.invoke('l2d-diary-config-get'),
  chooseDiaryDir: () => ipcRenderer.invoke('l2d-diary-dir-choose'),
  setDiaryAuto: (on) => ipcRenderer.invoke('l2d-diary-auto-set', on),
  saveDiary: (entry) => ipcRenderer.invoke('l2d-diary-save', entry),
})
