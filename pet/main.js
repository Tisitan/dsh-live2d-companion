const { app, BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const TARGET = process.env.L2D_URL
  || ('http://127.0.0.1:3080/live2d/pet.html'
    + (process.env.L2D_MODEL ? '?model=' + encodeURIComponent(process.env.L2D_MODEL) : ''))
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
  // overlay-pet：窗口铺满主屏、永不移动——透明窗呈现丢帧的触发条件
  // 「按住鼠标的物理消息流 × 窗口移动」在架构上不存在。模型位置=画布坐标，
  // 由渲染层记忆（localStorage l2d-pet-pos）。指针穿透照旧按模型区域切换。
  const disp = screen.getPrimaryDisplay()
  win = new BrowserWindow({
    width: disp.bounds.width,
    height: disp.bounds.height,
    x: disp.bounds.x,
    y: disp.bounds.y,
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
  // 显示器参数变化（分辨率/缩放/拔插屏）：窗口跟随新主屏，渲染层 resize 自会重排
  screen.on('display-metrics-changed', () => {
    if (win === null || win.isDestroyed()) return
    win.setBounds(screen.getPrimaryDisplay().bounds)
  })
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
