const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createStandaloneServer } = require('./server.cjs')

let win = null
let cardWin = null
let cardGameId = ''
let cardExpectedSize = null
let tray = null
let standalone = null

if (process.env.L2D_DEBUG === '1') app.commandLine.appendSwitch('remote-debugging-port', '9222')

// 软渲染逃生门：部分 Windows GPU/驱动组合下，透明无边框窗口移动会闪烁。
// 开关必须在 Electron ready 前生效，因此启动时先读取持久化配置。
function configFile() {
  return path.join(app.getPath('userData'), 'pet-config.json')
}
let petConfig = {}
try { petConfig = JSON.parse(fs.readFileSync(configFile(), 'utf8')) } catch { }
if (process.env.L2D_SOFT === '1' || petConfig.soft === true) app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

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

  // 与 DSH 桌宠保持同一套 overlay 架构：透明窗口固定铺满主屏，拖拽只改变
  // 画布中的模型坐标。窗口从不随物理鼠标消息移动，从根因上避开 DWM 闪烁。
  const area = screen.getPrimaryDisplay().bounds
  win = new BrowserWindow({
    width: area.width, height: area.height,
    x: area.x, y: area.y,
    frame: false, transparent: true, alwaysOnTop: true, resizable: false,
    skipTaskbar: true, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)   // 勿加 {forward:true}：electron#48035 光标闪烁（同 pet/main.js）
  screen.on('display-metrics-changed', () => {
    if (win !== null && !win.isDestroyed()) win.setBounds(screen.getPrimaryDisplay().bounds)
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // 锁视觉缩放：捏合手势误判会把整页放大导致命中坐标系错位（同 pet/main.js）
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => { })
  win.webContents.on('did-finish-load', () => {
    win?.webContents.setVisualZoomLevelLimits(1, 1).catch(() => { })
  })
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
  // 手动重启：与软渲染切换同一条 relaunch→exit 路径
  ipcMain.on('l2d-restart', event => {
    if (!fromPet(event)) return
    app.relaunch()
    app.exit(0)
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

  // 游戏卫星窗：复杂游戏 UI 与透明 overlay 物理隔离，避免穿透、焦点和拖动互抢。
  // gameId 作为通用入口保留；当前 game-card 只有五子棋，后续可按查询参数切换其他游戏。
  const pushCardArea = () => {
    if (win === null || win.isDestroyed()) return
    const bounds = cardWin && !cardWin.isDestroyed() ? cardWin.getBounds() : null
    win.webContents.send('l2d-game-area', bounds)
  }
  ipcMain.handle('l2d-game-bounds', event => {
    if (!fromPet(event)) return null
    return cardWin && !cardWin.isDestroyed() ? cardWin.getBounds() : null
  })
  ipcMain.on('l2d-game-open', (event, requestedGame = 'gomoku') => {
    if (!fromPet(event)) return
    const gameId = typeof requestedGame === 'string' && /^[a-z0-9-]{1,40}$/i.test(requestedGame)
      ? requestedGame : 'gomoku'
    if (cardWin && !cardWin.isDestroyed()) {
      if (cardGameId !== gameId) {
        cardGameId = gameId
        const nextUrl = new URL('/live2d/game-card.html', standalone.origin)
        nextUrl.searchParams.set('game', gameId)
        cardWin.loadURL(nextUrl.href).catch(() => { })
      }
      cardWin.show()
      pushCardArea()
      return
    }
    const area = screen.getPrimaryDisplay().workArea
    cardWin = new BrowserWindow({
      width: 760, height: 650,
      useContentSize: true,
      x: area.x + area.width - 776,
      y: area.y + Math.round((area.height - 650) / 2),
      frame: false, alwaysOnTop: true, resizable: false,
      skipTaskbar: true, focusable: true,
      backgroundColor: '#ffffff', hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload-card.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: false,
      },
    })
    cardWin.setAlwaysOnTop(true, 'screen-saver')
    cardWin.setMenu(null)
    cardWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    cardWin.webContents.setVisualZoomLevelLimits(1, 1).catch(() => { })
    cardWin.webContents.on('did-finish-load', () => {
      cardWin?.webContents.setVisualZoomLevelLimits(1, 1).catch(() => { })
      cardExpectedSize = cardWin && !cardWin.isDestroyed() ? cardWin.getSize() : null
    })
    cardWin.webContents.on('will-navigate', (navEvent, target) => {
      if (!target.startsWith(standalone.origin + '/')) navEvent.preventDefault()
    })
    let cardSizeGuardTimer = null
    cardWin.on('resize', () => {
      clearTimeout(cardSizeGuardTimer)
      cardSizeGuardTimer = setTimeout(() => {
        if (!cardWin || cardWin.isDestroyed() || !cardExpectedSize) return
        const size = cardWin.getSize()
        if (size[0] !== cardExpectedSize[0] || size[1] !== cardExpectedSize[1]) {
          cardWin.setSize(cardExpectedSize[0], cardExpectedSize[1])
        }
      }, 80)
    })
    cardWin.on('closed', () => {
      clearTimeout(cardSizeGuardTimer)
      cardWin = null
      cardGameId = ''
      cardExpectedSize = null
      pushCardArea()
    })
    const gameUrl = new URL('/live2d/game-card.html', standalone.origin)
    gameUrl.searchParams.set('game', gameId)
    cardGameId = gameId
    cardWin.loadURL(gameUrl.href).catch(() => { })
    pushCardArea()
  })
  ipcMain.on('l2d-game-close', event => {
    if (cardWin && !cardWin.isDestroyed() && event.sender === cardWin.webContents) cardWin.close()
  })
  // 分数 DPI 下切换 WS_EX_NOACTIVATE 会扰动窗口框架，保持创建态 focusable:true。
  ipcMain.on('l2d-game-focusable', () => { })
  ipcMain.on('l2d-game-moveby', (event, dx, dy) => {
    if (!cardWin || cardWin.isDestroyed() || event.sender !== cardWin.webContents) return
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    const [x, y] = cardWin.getPosition()
    if (cardExpectedSize) {
      cardWin.setBounds({
        x: Math.round(x + dx), y: Math.round(y + dy),
        width: cardExpectedSize[0], height: cardExpectedSize[1],
      })
    } else {
      cardWin.setPosition(Math.round(x + dx), Math.round(y + dy))
    }
    pushCardArea()
  })
  await win.loadURL(standalone.target + modelQuery)

  if (process.env.L2D_SATELLITE_TEST === '1') {
    await win.webContents.executeJavaScript("window.__petBridge.openGame('gomoku')")
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (cardWin && !cardWin.isDestroyed()) {
        const ready = await cardWin.webContents.executeJavaScript(
          "Boolean(document.querySelector('#l2d-game.open canvas'))",
        ).catch(() => false)
        if (ready) {
          console.log('Live2D satellite game test: ready')
          app.exit(0)
          return
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    console.error('Live2D satellite game test: timed out')
    app.exit(3)
    return
  }

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
