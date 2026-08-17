const { app, BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const TARGET = process.env.L2D_URL
  || ('http://127.0.0.1:3080/live2d/pet.html'
    + (process.env.L2D_MODEL ? '?model=' + encodeURIComponent(process.env.L2D_MODEL) : ''))
const WIN_W = 340
const WIN_H = 460

if (process.env.L2D_DEBUG === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}
// 软渲染逃生门：部分 GPU/驱动组合下透明无边框窗移动必闪（Electron/Windows 已知顽疾，
// 与移动频率无关）。L2D_SOFT=1 临时测试；面板开关写盘 pet-config.json 持久化常驻。
// 代价：渲染吃 CPU（默认小窗无感，大缩放窗口下线性上涨），笔记本略费电。
const configFile = () => path.join(app.getPath('userData'), 'pet-config.json')
let petConfig = {}
try { petConfig = JSON.parse(fs.readFileSync(configFile(), 'utf8')) } catch { }
if (process.env.L2D_SOFT === '1' || petConfig.soft === true) {
  app.disableHardwareAcceleration()
}

let win = null
const stateFile = () => path.join(app.getPath('userData'), 'window-pos.json')

function loadPos() {
  try {
    const p = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) return p
  } catch { }
  return null
}

function savePos() {
  if (win === null || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  try { fs.writeFileSync(stateFile(), JSON.stringify({ x, y })) } catch { }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
app.on('second-instance', () => {
  if (win !== null && !win.isDestroyed()) win.show()
})

app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().workAreaSize
  const saved = loadPos()
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: saved?.x ?? area.width - WIN_W - 24,
    y: saved?.y ?? area.height - WIN_H - 24,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadURL(TARGET)

  ipcMain.on('l2d-ignore', (_e, ignore) => {
    if (win !== null && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore, { forward: true })
  })
  ipcMain.on('l2d-quit', () => app.quit())
  // 软渲染开关：disableHardwareAcceleration 只能在启动前生效 → 写盘后整体重启
  ipcMain.handle('l2d-soft-get', () => petConfig.soft === true)
  ipcMain.on('l2d-soft-set', (_e, on) => {
    petConfig.soft = !!on
    try { fs.writeFileSync(configFile(), JSON.stringify(petConfig)) } catch { }
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle('l2d-cursor-get', () => {
    if (win === null || win.isDestroyed()) return null
    const p = screen.getCursorScreenPoint()
    return { x: p.x, y: p.y, bounds: win.getBounds() }
  })
  ipcMain.on('l2d-move', (_e, dx, dy) => {
    if (win === null || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    win.setPosition(Math.round(x + dx), Math.round(y + dy))
  })
  ipcMain.on('l2d-resize', (_e, w, h) => {
    if (win === null || win.isDestroyed()) return
    const width = Math.min(Math.max(Math.round(w), 160), 1200)
    const height = Math.min(Math.max(Math.round(h), 220), 1600)
    const b = win.getBounds()
    if (width !== b.width || height !== b.height) {
      win.setBounds({
        x: Math.round(b.x - (width - b.width) / 2),
        y: Math.round(b.y + b.height - height),
        width,
        height,
      })
    }
  })
  win.on('moved', savePos)
  win.on('closed', () => { win = null })

  let lastCursor = null
  setInterval(() => {
    if (win === null || win.isDestroyed()) return
    const p = screen.getCursorScreenPoint()
    if (lastCursor !== null && lastCursor.x === p.x && lastCursor.y === p.y) return
    lastCursor = p
    win.webContents.send('l2d-cursor', { x: p.x, y: p.y, bounds: win.getBounds() })
  }, 33)

  const origin = new URL(TARGET).origin
  let failures = 0
  setInterval(async () => {
    try {
      const r = await fetch(origin + '/live2d/state', { cache: 'no-store' })
      failures = r.ok ? 0 : failures + 1
    } catch {
      failures += 1
    }
    // 80 秒宽限：低配机重启 DSH 可能超过 40 秒，别在宿主正常重启时误杀桌宠
    if (failures >= 10) app.quit()
  }, 8000)
})

app.on('window-all-closed', () => app.quit())
}
