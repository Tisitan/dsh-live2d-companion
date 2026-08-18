const { contextBridge, ipcRenderer } = require('electron')

// 游戏卫星窗的 preload：关窗 + 运行期焦点能力切换 + IPC 移窗
// （窗口创建为 focusable:false 保前台游戏；悬停设置条时临时放开，让下拉/输入可用）
contextBridge.exposeInMainWorld('__cardBridge', {
  close: () => ipcRenderer.send('l2d-game-close'),
  setFocusable: (on) => ipcRenderer.send('l2d-game-focusable', on),
  moveBy: (dx, dy) => ipcRenderer.send('l2d-game-moveby', dx, dy),
})
