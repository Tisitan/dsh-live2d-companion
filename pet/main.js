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
// 抗拖动闪屏：关掉 Windows 原生遮挡计算——拖动时遮挡关系高频变化，
// Chromium 会误判窗口被遮挡而掐停渲染器出帧（窗口在动、画面停更 = 闪）。
// 对正常机器无副作用，与主进程限频合并双保险。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

let win = null
const stateFile = () => path.join(app.getPath('userData'), 'window-pos.json')

function loadPos() {
  try {
    const p = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
    // 防丢窗：保存位置不在任何显示器的合理范围内（拔过外接屏/分辨率变了）就回默认位
    const onScreen = screen.getAllDisplays().some((d) =>
      p.x > d.bounds.x - WIN_W / 2 && p.x < d.bounds.x + d.bounds.width - WIN_W / 2 &&
      p.y > d.bounds.y - 40 && p.y < d.bounds.y + d.bounds.height - 40)
    return onScreen ? p : null
  } catch { }
  return null
}

function savePos() {
  if (win === null || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  try { fs.writeFileSync(stateFile(), JSON.stringify({ x, y })) } catch { }
}

// 位置写盘防抖：拖动期间 'moved' 高频触发，逐事件同步写 JSON 会引入磁盘卡顿
let savePosTimer = null
function scheduleSavePos() {
  clearTimeout(savePosTimer)
  savePosTimer = setTimeout(savePos, 300)
}

// 拖动位移主进程合并限频：透明窗每次 setPosition 都是一次 DWM 重合成，
// 高刷新率显示器下渲染进程 rAF 可达 144-165Hz → 重合成次数同步放大 → 闪烁。
// 固定约 30Hz 冲刷（与显示器刷新率脱钩），亚像素余量保留不丢位移。
let moveTimer = null
let pendingMoveX = 0
let pendingMoveY = 0

function flushWindowMove() {
  moveTimer = null
  if (win === null || win.isDestroyed()) {
    pendingMoveX = 0
    pendingMoveY = 0
    return
  }
  const dx = Math.round(pendingMoveX)
  const dy = Math.round(pendingMoveY)
  pendingMoveX -= dx
  pendingMoveY -= dy
  if (dx === 0 && dy === 0) return
  const [x, y] = win.getPosition()
  win.setPosition(x + dx, y + dy, false)
  // Windows 上程序化 setPosition 不触发 'moved' 事件——在这里联动防抖写盘，
  // 否则拖拽后的位置永远不会落盘（position persistence 静默失效）
  scheduleSavePos()
}

// 仅接受桌宠页面自身发来的 IPC
function fromPet(event) {
  return win !== null && !win.isDestroyed() && event.sender === win.webContents
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
      sandbox: true,
      // 失焦/被判定遮挡时不节流渲染器，配合上方遮挡开关防拖动闪屏
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  // 窗口锁定：禁开新窗、禁跳转到宿主源以外的地址（加载的是 http 页面，纵深防御）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const targetOrigin = new URL(TARGET).origin
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(targetOrigin + '/')) event.preventDefault()
  })

  // preload 在页面启动阶段就会调 IPC（软渲染读取/首帧光标），必须先注册再加载页面
  ipcMain.on('l2d-ignore', (event, ignore) => {
    if (fromPet(event)) win.setIgnoreMouseEvents(Boolean(ignore), { forward: true })
  })
  ipcMain.on('l2d-quit', (event) => {
    if (fromPet(event)) app.quit()
  })
  // 软渲染开关：disableHardwareAcceleration 只能在启动前生效 → 写盘后整体重启
  ipcMain.handle('l2d-soft-get', (event) => (fromPet(event) ? petConfig.soft === true : false))
  ipcMain.on('l2d-soft-set', (event, on) => {
    if (!fromPet(event)) return
    petConfig.soft = !!on
    try { fs.writeFileSync(configFile(), JSON.stringify(petConfig)) } catch { }
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle('l2d-cursor-get', (event) => {
    if (!fromPet(event)) return null
    const p = screen.getCursorScreenPoint()
    return { x: p.x, y: p.y, bounds: win.getBounds() }
  })
  ipcMain.on('l2d-move', (event, dx, dy) => {
    if (!fromPet(event) || !Number.isFinite(dx) || !Number.isFinite(dy)) return
    // 单事件位移钳制，防异常大跳变
    pendingMoveX += Math.max(-200, Math.min(200, dx))
    pendingMoveY += Math.max(-200, Math.min(200, dy))
    if (moveTimer === null) moveTimer = setTimeout(flushWindowMove, 33)
  })
  ipcMain.on('l2d-resize', (event, w, h) => {
    if (!fromPet(event) || !Number.isFinite(w) || !Number.isFinite(h)) return
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
  win.on('moved', scheduleSavePos)
  win.on('close', () => {
    if (moveTimer !== null) {
      clearTimeout(moveTimer)
      flushWindowMove()
    }
    clearTimeout(savePosTimer)
    savePos()
  })
  win.on('closed', () => { win = null })

  // 加载自愈：宿主未就绪/重载失败时指数退避重试，不再干等 80 秒自杀——
  // 宿主晚于桌宠启动、宿主重启中途页面 404 等瞬态都能自己爬回来
  let loadRetries = 0
  const reloadPage = () => {
    if (win === null || win.isDestroyed()) return
    win.loadURL(TARGET).catch(() => { })
  }
  win.webContents.on('did-fail-load', () => {
    const delay = Math.min(30000, 2000 * 2 ** loadRetries)
    loadRetries += 1
    setTimeout(reloadPage, delay)
  })
  win.webContents.on('did-finish-load', () => { loadRetries = 0 })
  win.loadURL(TARGET).catch(() => { })

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
    // 80 秒宽限（低配机重启 DSH 可能超过 40 秒）：先自愈重载页面；
    // 持续 120 秒仍不通认定宿主已死才退出（宿主下次启动会重新 spawn）
    if (failures >= 10) reloadPage()
    if (failures >= 15) app.quit()
  }, 8000)
})

app.on('window-all-closed', () => app.quit())
}
