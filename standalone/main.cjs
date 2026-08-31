const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createStandaloneServer } = require('./server.cjs')

let win = null
let tray = null
let standalone = null
let diaryFileName = ''

// ── 游戏卫星窗多窗注册表（与 pet/main.js 同款架构）──
// 每游戏独立尺寸表（useContentSize 语义=内容区像素），与各游戏渲染器 canvasSize 对应：
//   gomoku / chess：500×500 正方盘 + 卡头/状态条/评论列 → 760×650
const CARD_SIZES = {
  gomoku: { width: 760, height: 650 },
  chess: { width: 760, height: 650 },
}
const cardWins = new Map()    // gameId → { win, expectedSize, guardTimer }
// gameId 白名单：格式粗筛 + 尺寸表命中，非法一律落 gomoku
const normalizeGameId = (raw) => {
  if (typeof raw !== 'string' || !/^[a-z0-9-]+$/.test(raw)) return 'gomoku'
  return Object.prototype.hasOwnProperty.call(CARD_SIZES, raw) ? raw : 'gomoku'
}
// IPC sender 反查：close/moveby 等来自卡片窗的消息，用 sender 在多窗表里找归属窗（找不到拒收）
const cardEntryBySender = (event) => {
  for (const entry of cardWins.values()) {
    if (entry.win && !entry.win.isDestroyed() && event.sender === entry.win.webContents) return entry
  }
  return null
}

if (process.env.L2D_DEBUG === '1') app.commandLine.appendSwitch('remote-debugging-port', '9222')

// 软渲染逃生门：部分 Windows GPU/驱动组合下，透明无边框窗口移动会闪烁。
// 开关必须在 Electron ready 前生效，因此启动时先读取持久化配置。
function configFile() {
  return path.join(app.getPath('userData'), 'pet-config.json')
}
let petConfig = {}
try {
  const raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) petConfig = raw   // 合法 JSON 的 null/数组也是坏配置
} catch { }
function savePetConfig() {
  try { fs.writeFileSync(configFile(), JSON.stringify(petConfig, null, 2) + '\n') } catch { }
}
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
  // 渲染进程崩溃/假死看门狗：直接退出释放单实例锁，比留僵尸全屏透明窗卡死下次启动强（同 pet/main.js）
  win.webContents.on('render-process-gone', () => app.quit())
  win.webContents.on('unresponsive', () => app.quit())
  const modelQuery = process.env.L2D_MODEL ? `&model=${encodeURIComponent(process.env.L2D_MODEL)}` : ''

  // 所有 preload 会在页面启动阶段调用的 IPC 都必须先注册，再加载页面。
  // 否则 CPU 模式和首帧光标读取会因“尚无处理器”而静默失败。
  ipcMain.on('l2d-ignore', (event, ignore) => {
    // 勿加 {forward:true}：electron#48035 光标闪烁铁律（pet/main.js 有载），穿透态光标由主进程轮询驱动
    if (fromPet(event)) win.setIgnoreMouseEvents(Boolean(ignore))
  })
  ipcMain.on('l2d-quit', event => {
    if (fromPet(event)) app.quit()
  })
  // 手动重启：与软渲染切换同一条 relaunch→exit 路径
  ipcMain.on('l2d-restart', event => {
    if (!fromPet(event)) return
    // 先放锁再重启：新进程若在旧进程退出前启动，持锁竞争会被弹回导致桌宠回不来
    try { app.releaseSingleInstanceLock() } catch { }
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle('l2d-soft-get', event => fromPet(event) ? petConfig.soft === true : false)
  ipcMain.on('l2d-soft-set', (event, on) => {
    if (!fromPet(event)) return
    petConfig.soft = Boolean(on)
    savePetConfig()
    try { app.releaseSingleInstanceLock() } catch { }   // 同上：放锁先于 relaunch
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle('l2d-diary-config-get', event => {
    if (!fromPet(event)) return null
    return { dir: typeof petConfig.diaryDir === 'string' ? petConfig.diaryDir : '', auto: petConfig.diaryAuto === true }
  })
  ipcMain.handle('l2d-diary-dir-choose', async event => {
    if (!fromPet(event)) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择桌宠日记保存位置',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    petConfig.diaryDir = path.resolve(result.filePaths[0])
    savePetConfig()
    return { dir: petConfig.diaryDir, auto: petConfig.diaryAuto === true }
  })
  ipcMain.handle('l2d-diary-auto-set', (event, on) => {
    if (!fromPet(event)) return null
    petConfig.diaryAuto = Boolean(on)
    savePetConfig()
    return { dir: typeof petConfig.diaryDir === 'string' ? petConfig.diaryDir : '', auto: petConfig.diaryAuto }
  })
  ipcMain.handle('l2d-diary-save', async (event, entry) => {
    if (!fromPet(event)) throw new Error('forbidden')
    const diaryDir = typeof petConfig.diaryDir === 'string' ? path.resolve(petConfig.diaryDir) : ''
    if (!diaryDir) throw new Error('请先选择日记保存位置')
    const summary = typeof entry?.summary === 'string'
      ? entry.summary.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 12000)
      : ''
    if (!summary) throw new Error('日记内容为空')
    await fs.promises.mkdir(diaryDir, { recursive: true })
    if (!diaryFileName) {
      const now = new Date()
      const pad = value => String(value).padStart(2, '0')
      diaryFileName = `diary-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.md`
    }
    const target = path.join(diaryDir, diaryFileName)
    const generated = new Date().toLocaleString('zh-CN', { hour12: false })
    await fs.promises.writeFile(target, `# 桌宠日记\n\n> 更新于 ${generated}\n\n${summary}\n`, 'utf8')
    return { ok: true, path: target, file: diaryFileName }
  })
  ipcMain.handle('l2d-cursor-get', event => {
    if (!fromPet(event)) return null
    const point = screen.getCursorScreenPoint()
    return { x: point.x, y: point.y, bounds: win.getBounds() }
  })

  // 游戏卫星窗：复杂游戏 UI 与透明 overlay 物理隔离，避免穿透、焦点和拖动互抢。
  // gameId 作为通用入口保留；game-card 现有五子棋/国象/词宝谜航三个游戏，按查询参数切换。
  const pushCardArea = () => {
    if (win === null || win.isDestroyed()) return
    const bounds = cardWin && !cardWin.isDestroyed() ? cardWin.getBounds() : null
    win.webContents.send('l2d-game-area', bounds)
  }
  ipcMain.handle('l2d-game-bounds', event => {
    if (!fromPet(event)) return null
    return cardWin && !cardWin.isDestroyed() ? cardWin.getBounds() : null
  })
  ipcMain.on('l2d-game-open', (event, requestedGame) => {
    if (!fromPet(event)) return
    const gameId = normalizeGameId(requestedGame)
    const existing = cardWins.get(gameId)
    if (existing) {
      if (existing.win && !existing.win.isDestroyed()) { existing.win.show(); pushCardArea(); return }
      clearTimeout(existing.guardTimer)   // 残骸条目（窗已亡未清）：先拆再重建
      cardWins.delete(gameId)
    }
    const area = screen.getPrimaryDisplay().workArea
    const size = CARD_SIZES[gameId]
    // 新窗级联偏移：默认位右下角起，按已开窗数每窗 (+28,+28) 防完全重叠；出屏回落默认位
    const baseX = area.x + area.width - (size.width + 16)
    const baseY = area.y + Math.max(0, Math.round((area.height - size.height) / 2))
    let x = baseX + cardWins.size * 28
    let y = baseY + cardWins.size * 28
    if (x + size.width > area.x + area.width || y + size.height > area.y + area.height) { x = baseX; y = baseY }
    const cardWin = new BrowserWindow({
      width: size.width, height: size.height,
      useContentSize: true,
      x, y,
      frame: false, alwaysOnTop: true, resizable: false,
      skipTaskbar: true, focusable: true,
      backgroundColor: '#ffffff', hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload-card.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: false,
      },
    })
    const entry = { win: cardWin, expectedSize: null, guardTimer: null, loadRetries: 0 }   // 本窗自己的 DPI 治疗链状态
    cardWins.set(gameId, entry)
    cardWin.setAlwaysOnTop(true, 'screen-saver')
    cardWin.setMenu(null)
    cardWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    cardWin.webContents.setVisualZoomLevelLimits(1, 1).catch(() => { })
    cardWin.webContents.on('will-navigate', (navEvent, target) => {
      if (!target.startsWith(standalone.origin + '/')) navEvent.preventDefault()
    })
    // 渲染器崩溃：关窗退场（closed 钩子自清表+收缩死区）——×按钮/拖动都靠页面，页死即不可交互
    cardWin.webContents.on('render-process-gone', (_event, details) => {
      console.error(`[l2d-card] render gone: game=${gameId} reason=${details.reason} exitCode=${details.exitCode}`)
      cardWin.close()
    })
    // 主 frame 加载失败有限退避（2s/4s 两次），仍败关窗退场
    cardWin.webContents.on('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
      if (!isMainFrame) return
      entry.loadRetries += 1
      console.error(`[l2d-card] load failed: game=${gameId} attempt=${entry.loadRetries}`)
      if (entry.loadRetries > 2) { cardWin.close(); return }
      setTimeout(() => { if (!cardWin.isDestroyed()) cardWin.loadURL(gameUrl.href).catch(() => { }) }, 2000 * entry.loadRetries)
    })
    // 渲染器就绪后重锁视觉缩放，并记本窗实测尺寸（每窗一份 expectedSize，拖拽期钉死用）
    cardWin.webContents.on('did-finish-load', () => {
      cardWin?.webContents.setVisualZoomLevelLimits(1, 1).catch(() => { })
      entry.expectedSize = cardWin && !cardWin.isDestroyed() ? cardWin.getSize() : null
      entry.loadRetries = 0
    })
    // 尺寸看门狗（每窗一份）：80ms 平息后一律钉回本窗实测尺寸——固定尺寸窗，视觉层零容忍
    cardWin.on('resize', () => {
      clearTimeout(entry.guardTimer)
      entry.guardTimer = setTimeout(() => {
        if (cardWin.isDestroyed() || !entry.expectedSize) return
        const cur = cardWin.getSize()
        if (cur[0] !== entry.expectedSize[0] || cur[1] !== entry.expectedSize[1]) {
          cardWin.setSize(entry.expectedSize[0], entry.expectedSize[1])
        }
      }, 80)
    })
    cardWin.on('closed', () => {
      clearTimeout(entry.guardTimer)
      if (cardWins.get(gameId) === entry) cardWins.delete(gameId)
      pushCardArea()   // 死区数组随关窗收缩
    })
    // 分叉保留：URL 拼装沿用 standalone.origin + searchParams（与 pet 的 TARGET 拼装各自成立）
    const gameUrl = new URL('/live2d/game-card.html', standalone.origin)
    gameUrl.searchParams.set('game', gameId)
    cardWin.loadURL(gameUrl.href).catch(() => { })
    pushCardArea()
  })
  ipcMain.on('l2d-game-close', event => {
    const entry = cardEntryBySender(event)   // 多窗反查：sender 属于哪张卡就关哪张，找不到拒收
    if (entry) entry.win.close()
  })
  // 分数 DPI 下切换 WS_EX_NOACTIVATE 会扰动窗口框架，保持创建态 focusable:true。
  ipcMain.on('l2d-game-focusable', () => { })
  ipcMain.on('l2d-game-moveby', (event, dx, dy) => {
    const entry = cardEntryBySender(event)   // 多窗反查：按 sender 找归属窗，找不到拒收
    if (!entry || entry.win.isDestroyed()) return
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    const [x, y] = entry.win.getPosition()
    if (entry.expectedSize) {
      // 拖拽钉尺寸：setBounds 同时钉住本窗加载完成时的实测尺寸（位置照动、尺寸免谈）
      entry.win.setBounds({
        x: Math.round(x + dx), y: Math.round(y + dy),
        width: entry.expectedSize[0], height: entry.expectedSize[1],
      })
    } else {
      entry.win.setPosition(Math.round(x + dx), Math.round(y + dy))
    }
    pushCardArea()   // 死区跟随窗口移动
  })
  await win.loadURL(standalone.target + modelQuery)

  if (process.env.L2D_SATELLITE_TEST === '1') {
    const testGameId = normalizeGameId(process.env.L2D_SATELLITE_GAME)
    await win.webContents.executeJavaScript(`window.__petBridge.openGame(${JSON.stringify(testGameId)})`)
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const testEntry = cardWins.get(testGameId)
      if (testEntry && testEntry.win && !testEntry.win.isDestroyed()) {
        const ready = await testEntry.win.webContents.executeJavaScript(
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
