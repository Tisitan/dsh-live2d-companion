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
  win.setIgnoreMouseEvents(true)   // 勿加 {forward:true}：electron#48035 光标闪烁
  // 显示器参数变化（分辨率/缩放/拔插屏）：窗口跟随新主屏，渲染层 resize 自会重排
  screen.on('display-metrics-changed', () => {
    if (win === null || win.isDestroyed()) return
    win.setBounds(screen.getPrimaryDisplay().bounds)
  })
  // 窗口锁定：禁开新窗、禁跳转到宿主源以外的地址（加载的是 http 页面，纵深防御）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // 锁视觉缩放：overlay 铺满全屏，捏合手势一旦触发页面缩放，命中判定坐标系
  // 会整体错位（点不准小人）；桌宠自带的 Ctrl+滚轮模型缩放走应用层，不受影响
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => { })
  // 渲染器就绪后重锁：创建前设置可能被首个导航丢弃（与卫星窗同病理）
  win.webContents.on('did-finish-load', () => {
    win?.webContents.setVisualZoomLevelLimits(1, 1).catch(() => { })
  })
  const targetOrigin = new URL(TARGET).origin
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(targetOrigin + '/')) event.preventDefault()
  })

  // preload 在页面启动阶段就会调 IPC（软渲染读取/首帧光标），必须先注册再加载页面
  // 注意：绝不能用 {forward:true}——forward 让穿透窗仍参与鼠标消息流，其覆盖下的
  // 任何窗口光标都会在 CSS 光标与默认箭头间高速闪烁（electron#48035，v20 起未修，
  // 43 实测仍犯）。穿透态的光标追踪由主进程 33ms OS 轮询驱动，forward 本就是冗余
  ipcMain.on('l2d-ignore', (event, ignore) => {
    if (fromPet(event)) win.setIgnoreMouseEvents(Boolean(ignore))
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
    // 先放锁再重启：新进程若在旧进程退出前启动，持锁竞争会被弹回导致桌宠回不来
    try { app.releaseSingleInstanceLock() } catch { }
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle('l2d-cursor-get', (event) => {
    if (!fromPet(event)) return null
    const p = screen.getCursorScreenPoint()
    return { x: p.x, y: p.y, bounds: win.getBounds() }
  })

  // ── 游戏卫星窗 ──
  // 对局卡独立小窗：输入捕获范围物理上只有卡片大小，overlay 的穿透状态机不再参与；
  // focusable:false 使点卡片永不抢前台游戏焦点。卡片与 overlay 通过 BroadcastChannel
  // 同源互通（气泡台词转发到小人头上）。
  let cardWin = null
  let cardExpectedSize = null   // 加载完成时的实测尺寸：拖拽期钉死，防对账循环改尺寸
  // 卡片区域实时推送：overlay 把该区域当穿透死区——否则 overlay 压在卡片上方（screen-saver
  // 层 > floating 层），光标在卡片上停留会触发 overlay 的模型区解锁，把卡片点击全吃掉
  const pushCardArea = () => {
    if (win === null || win.isDestroyed()) return
    const b = cardWin && !cardWin.isDestroyed() ? cardWin.getBounds() : null
    win.webContents.send('l2d-game-area', b)
  }
  ipcMain.handle('l2d-game-bounds', (event) => {
    if (!fromPet(event)) return null
    return cardWin && !cardWin.isDestroyed() ? cardWin.getBounds() : null
  })
  ipcMain.on('l2d-game-open', (event) => {
    if (!fromPet(event)) return
    if (cardWin && !cardWin.isDestroyed()) { cardWin.show(); pushCardArea(); return }
    const disp = screen.getPrimaryDisplay().workArea
    cardWin = new BrowserWindow({
      width: 760,
      height: 650,
      useContentSize: true,   // 尺寸语义=内容区：减少客户区↔框架换算面（分数 DPI 对账稳定化）
      x: disp.x + disp.width - 776,
      y: disp.y + Math.round((disp.height - 650) / 2),
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      focusable: true,           // 恒 true：setFocusable 切换在分数 DPI 下有窗口管理副作用
      backgroundColor: '#ffffff',
      hasShadow: false,          // DWM 阴影的隐形边框是分数 DPI 框架对账误差来源（overlay 窗同款配置从不自激）
      // roundedCorners 保持关闭：自激 resize 案中圆角非元凶，但排查后保留——
      // 尽量减少 DWM 框架度量参与面，分数 DPI 下对账更稳
      webPreferences: {
        preload: path.join(__dirname, 'preload-card.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    // 与 overlay 同级且后设置 → 压在透明 overlay 之上。卡片是不透明窗本就该在上：
    // 否则透明穿透窗叠在不透明窗上，Windows 光标判定在夹层抖动（标题栏光标跳变病灶）
    cardWin.setAlwaysOnTop(true, 'screen-saver')
    cardWin.setMenu(null)
    cardWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // 锁视觉缩放：触控板/触屏的捏合手势在拖拽标题栏时极易被误判成 pinch，
    // Chromium 默认视觉缩放会把整页放大（"一拖动就放大"的嫌疑路径）；
    // 卫星窗没有任何需要页面级缩放的场景，锁死 1:1
    cardWin.webContents.setVisualZoomLevelLimits(1, 1).catch(() => { })
    // 渲染器就绪后重锁：webContents 创建前设置的视觉缩放锁可能被首个导航静默丢弃
    cardWin.webContents.on('did-finish-load', () => {
      cardWin?.webContents.setVisualZoomLevelLimits(1, 1).catch(() => { })
      cardExpectedSize = cardWin && !cardWin.isDestroyed() ? cardWin.getSize() : null
    })
    cardWin.webContents.on('will-navigate', (e, target) => {
      if (!target.startsWith(targetOrigin + '/')) e.preventDefault()
    })
    // 尺寸看门狗：分数 DPI 下 Chromium↔Windows 的框架对账会残留 ±1px 级抽搐
    // （雪崩已被 hasShadow:false + 拖拽钉尺寸打断），任何路径引起的尺寸偏移
    // 80ms 平息后一律钉回实测尺寸——窗口设计上固定尺寸，视觉层零容忍
    let cardSizeGuardTimer = null
    cardWin.on('resize', () => {
      clearTimeout(cardSizeGuardTimer)
      cardSizeGuardTimer = setTimeout(() => {
        if (!cardWin || cardWin.isDestroyed() || !cardExpectedSize) return
        const s = cardWin.getSize()
        if (s[0] !== cardExpectedSize[0] || s[1] !== cardExpectedSize[1]) {
          cardWin.setSize(cardExpectedSize[0], cardExpectedSize[1])
        }
      }, 80)
    })
    cardWin.on('closed', () => { cardWin = null; pushCardArea() })
    cardWin.loadURL(new URL('/live2d/game-card.html', TARGET).href).catch(() => { })
    pushCardArea()
  })
  ipcMain.on('l2d-game-close', (event) => {
    if (cardWin && !cardWin.isDestroyed() && event.sender === cardWin.webContents) cardWin.close()
  })
  // 运行期焦点能力切换【禁用】：setFocusable 切 WS_EX_NOACTIVATE 会触发 Windows
  // 重算窗口框架——分数 DPI（RDP 150%）下属于窗口尺寸对账的扰动源（自激 resize
  // 案排查期冻结）。创建态 focusable:true 让下拉/输入原生可用，编排层不再需要；
  // 页面请求照常接收但忽略。
  ipcMain.on('l2d-game-focusable', () => { })
  // IPC 移窗：app-region:drag 不可靠（吞点击/本版未生效），moveBy 是老桌宠验证方案；
  // 卫星窗不透明，移动无透明窗的 DWM 丢帧问题。
  // 分数 DPI 下纯 setPosition 会触发 Chromium↔Windows 尺寸对账循环（窗口疯长），
  // 故拖拽全程用 setBounds 把尺寸钉死在加载完成时的实测值——位置照动、尺寸免谈。
  ipcMain.on('l2d-game-moveby', (event, dx, dy) => {
    if (!cardWin || cardWin.isDestroyed() || event.sender !== cardWin.webContents) return
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    const [x, y] = cardWin.getPosition()
    if (cardExpectedSize) {
      cardWin.setBounds({ x: Math.round(x + dx), y: Math.round(y + dy), width: cardExpectedSize[0], height: cardExpectedSize[1] })
    } else {
      cardWin.setPosition(Math.round(x + dx), Math.round(y + dy))
    }
    pushCardArea()   // 死区跟随窗口移动
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
  // 渲染进程崩溃/假死看门狗：直接退出释放单实例锁，比留僵尸透明窗卡死下次启动强
  win.webContents.on('render-process-gone', () => app.quit())
  win.webContents.on('unresponsive', () => app.quit())
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
