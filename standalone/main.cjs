const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createStandaloneServer } = require('./server.cjs')

const WIN_W = 340
const WIN_H = 460
let win = null
let tray = null
let standalone = null
let moveTimer = null
let pendingMoveX = 0
let pendingMoveY = 0
let savePosTimer = null

if (process.env.L2D_DEBUG === '1') app.commandLine.appendSwitch('remote-debugging-port', '9222')

// 软渲染逃生门：部分 Windows GPU/驱动组合下，透明无边框窗口移动会闪烁。
// 开关必须在 Electron ready 前生效，因此启动时先读取持久化配置。
function configFile() {
  return path.join(app.getPath('userData'), 'pet-config.json')
}
let petConfig = {}
try { petConfig = JSON.parse(fs.readFileSync(configFile(), 'utf8')) } catch { }
if (process.env.L2D_SOFT === '1' || petConfig.soft === true) app.disableHardwareAcceleration()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

function stateFile() {
  return path.join(app.getPath('userData'), 'window-pos.json')
}

function loadPos() {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (Number.isFinite(value.x) && Number.isFinite(value.y)) return value
  } catch { }
  return null
}

function savePos() {
  if (win === null || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  try { fs.writeFileSync(stateFile(), JSON.stringify({ x, y })) } catch { }
}

function scheduleSavePos() {
  clearTimeout(savePosTimer)
  savePosTimer = setTimeout(savePos, 300)
}

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
  // Windows 的透明窗口高频 setPosition 容易触发 DWM 重合成闪烁。
  // 主进程统一按约 30fps 合并位移，并明确关闭位置动画。
  win.setPosition(x + dx, y + dy, false)
}

function fromPet(event) {
  return win !== null && !win.isDestroyed() && event.sender === win.webContents
}

async function verifyAssets() {
  if (!standalone.hasCore) {
    const vendorDir = path.join(__dirname, '..', 'public', 'vendor')
    const result = await dialog.showMessageBox({
      type: 'warning', title: '缺少 Cubism Core',
      message: '桌宠需要 Live2D 官方的 live2dcubismcore.min.js。',
      detail: `请从 Live2D 官方渠道下载，并放到：\n${vendorDir}`,
      buttons: ['打开目录', '退出'], defaultId: 0, cancelId: 1,
    })
    if (result.response === 0) await shell.openPath(vendorDir)
    return false
  }
  if (!standalone.hasModel) {
    const result = await dialog.showMessageBox({
      type: 'info', title: '还没有 Live2D 模型',
      message: '请先放入一个 Cubism 4/5 模型。',
      detail: `把完整模型文件夹复制到：\n${standalone.modelDir}\n\n目录中需要包含 .model3.json、贴图、动作和表情等文件。`,
      buttons: ['打开模型目录', '退出'], defaultId: 0, cancelId: 1,
    })
    if (result.response === 0) await shell.openPath(standalone.modelDir)
    return false
  }
  return true
}

function createTray() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#7257d5"/><circle cx="11" cy="14" r="2" fill="white"/><circle cx="21" cy="14" r="2" fill="white"/><path d="M10 21 Q16 26 22 21" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('Live2D 独立桌宠')
  const stateItems = [
    ['闲置', 'idle'], ['思考', 'thinking'], ['工作', 'working'], ['等待确认', 'waiting'],
    ['完成', 'done'], ['报错', 'error'], ['睡眠', 'sleeping'],
  ].map(([label, value]) => ({ label, click: () => standalone.setState(value) }))
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示桌宠', click: () => win?.show() },
    { label: '切换状态', submenu: stateItems },
    { type: 'separator' },
    { label: '打开模型目录', click: () => shell.openPath(standalone.modelDir) },
    { label: '退出', click: () => app.quit() },
  ]))
  tray.on('click', () => win?.show())
}

async function createWindow() {
  const publicDir = path.join(__dirname, '..', 'public')
  standalone = await createStandaloneServer({ publicDir, dataDir: app.getPath('userData') })
  if (process.env.L2D_SMOKE_TEST === '1') {
    await standalone.close()
    standalone = null
    app.quit()
    return
  }
  if (!await verifyAssets()) {
    app.quit()
    return
  }

  const area = screen.getPrimaryDisplay().workArea
  const saved = loadPos()
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    x: saved?.x ?? area.x + area.width - WIN_W - 24,
    y: saved?.y ?? area.y + area.height - WIN_H - 24,
    frame: false, transparent: true, alwaysOnTop: true, resizable: false,
    skipTaskbar: true, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(standalone.origin + '/')) event.preventDefault()
  })
  const modelQuery = process.env.L2D_MODEL ? `&model=${encodeURIComponent(process.env.L2D_MODEL)}` : ''

  // 所有 preload 会在页面启动阶段调用的 IPC 都必须先注册，再加载页面。
  // 否则 CPU 模式和首帧光标读取会因“尚无处理器”而静默失败。
  ipcMain.on('l2d-ignore', (event, ignore) => {
    if (fromPet(event)) win.setIgnoreMouseEvents(Boolean(ignore), { forward: true })
  })
  ipcMain.on('l2d-quit', event => {
    if (fromPet(event)) app.quit()
  })
  ipcMain.handle('l2d-soft-get', event => fromPet(event) ? petConfig.soft === true : false)
  ipcMain.on('l2d-soft-set', (event, on) => {
    if (!fromPet(event)) return
    petConfig.soft = Boolean(on)
    try { fs.writeFileSync(configFile(), JSON.stringify(petConfig, null, 2) + '\n') } catch { }
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle('l2d-cursor-get', event => {
    if (!fromPet(event)) return null
    const point = screen.getCursorScreenPoint()
    return { x: point.x, y: point.y, bounds: win.getBounds() }
  })
  ipcMain.on('l2d-move', (event, dx, dy) => {
    if (!fromPet(event) || !Number.isFinite(dx) || !Number.isFinite(dy)) return
    pendingMoveX += Math.max(-200, Math.min(200, dx))
    pendingMoveY += Math.max(-200, Math.min(200, dy))
    if (moveTimer === null) moveTimer = setTimeout(flushWindowMove, 33)
  })
  ipcMain.on('l2d-resize', (event, w, h) => {
    if (!fromPet(event) || !Number.isFinite(w) || !Number.isFinite(h)) return
    const width = Math.min(Math.max(Math.round(w), 160), 1200)
    const height = Math.min(Math.max(Math.round(h), 220), 1600)
    const bounds = win.getBounds()
    if (width !== bounds.width || height !== bounds.height) {
      win.setBounds({
        x: Math.round(bounds.x - (width - bounds.width) / 2),
        y: Math.round(bounds.y + bounds.height - height), width, height,
      })
    }
  })

  await win.loadURL(standalone.target + modelQuery)

  // 拖动期间不再每个 moved 事件同步写磁盘，停下后再保存一次位置。
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
  let lastCursor = null
  const cursorTimer = setInterval(() => {
    if (win === null || win.isDestroyed()) return
    const point = screen.getCursorScreenPoint()
    if (lastCursor !== null && lastCursor.x === point.x && lastCursor.y === point.y) return
    lastCursor = point
    win.webContents.send('l2d-cursor', { x: point.x, y: point.y, bounds: win.getBounds() })
  }, 33)
  win.on('closed', () => clearInterval(cursorTimer))
  createTray()

  if (process.env.L2D_RENDER_TEST === '1') {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const ready = await win.webContents.executeJavaScript('Boolean(window.__l2d?.model)').catch(() => false)
      if (ready) {
        console.log('Live2D renderer test: ready')
        app.exit(0)
        return
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    console.error('Live2D renderer test: timed out')
    app.exit(2)
  }
}

if (gotLock) {
  app.on('second-instance', () => win?.show())
  app.whenReady().then(createWindow).catch(error => {
    dialog.showErrorBox('Live2D 桌宠启动失败', String(error?.stack || error))
    app.quit()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => { void standalone?.close() })
}
