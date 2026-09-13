const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__petBridge', {
  setIgnore: (ignore) => ipcRenderer.send('l2d-ignore', ignore),
  // 穿透单源决策：渲染层上报交互矩形集（模型包围盒+余量 ∪ UI 矩形 ∪ 状态标志），
  // 主进程用 OS 光标比对自行切换穿透；状态迁移经 onInteractState 回推
  pushRects: (rects) => ipcRenderer.send('l2d-rects', rects),
  heartbeat: (lastInputAt) => ipcRenderer.send('l2d-heartbeat', lastInputAt),
  onInteractState: (cb) => ipcRenderer.on('l2d-interact-state', (_e, state) => cb(state)),
  // 渲染层异常取证：渲染进程 console 不进宿主日志，关键错误转主进程留痕
  reportError: (msg) => ipcRenderer.send('l2d-renderer-error', msg),
  onCursor: (cb) => ipcRenderer.on('l2d-cursor', (_e, data) => cb(data)),
  getCursor: () => ipcRenderer.invoke('l2d-cursor-get'),
  quit: () => ipcRenderer.send('l2d-quit'),
  restart: () => ipcRenderer.send('l2d-restart'),
  getSoft: () => ipcRenderer.invoke('l2d-soft-get'),
  setSoft: (on) => ipcRenderer.send('l2d-soft-set', on),
  // 游戏卫星窗：overlay 纯装饰化，对局卡独立小窗（焦点/穿透问题物理隔离）；
  // gameId 透传主进程选窗（gomoku/chess，非法值主进程回落 gomoku）
  openGame: (gameId) => ipcRenderer.send('l2d-game-open', gameId),
  // 卫星窗屏幕区域推送（开/移动/关）：该区域对 overlay 是穿透死区，防停留解锁吃卡片点击
  onCardArea: (cb) => ipcRenderer.on('l2d-game-area', (_e, b) => cb(b)),
  getCardArea: () => ipcRenderer.invoke('l2d-game-bounds'),
})
