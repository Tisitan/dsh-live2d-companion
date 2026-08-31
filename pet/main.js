const { app, BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const TARGET = process.env.L2D_URL
  || ('http://127.0.0.1:3080/live2d/pet.html'
    + (process.env.L2D_MODEL ? '?model=' + encodeURIComponent(process.env.L2D_MODEL) : ''))
// 宿主 spawn 时注入的凭据文件位置；独立运行不设则跳过（不影响手动启动场景）
const L2D_PIDFILE = process.env.L2D_PIDFILE ?? ''
if (process.env.L2D_DEBUG === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}
// 软渲染逃生门：部分 GPU/驱动组合下透明无边框窗移动必闪（Electron/Windows 已知顽疾，
// 与移动频率无关）。L2D_SOFT=1 临时测试；面板开关写盘 pet-config.json 持久化常驻。
// 代价：渲染吃 CPU（默认小窗无感，大缩放窗口下线性上涨），笔记本略费电。
const configFile = () => path.join(app.getPath('userData'), 'pet-config.json')
let petConfig = {}
try {
  const raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) petConfig = raw   // 合法 JSON 的 null/数组也是坏配置
} catch { }
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
  // 拿锁即立户：PID 文件 = 宿主跨重启的收养凭据。抢锁失败的实例绝不覆写（宿主靠它认领本进程）
  try {
    if (L2D_PIDFILE !== '') {
      fs.mkdirSync(path.dirname(L2D_PIDFILE), { recursive: true })
      fs.writeFileSync(L2D_PIDFILE, JSON.stringify({ pid: process.pid, exe: process.execPath, bornAt: Date.now(), url: TARGET }))
    }
  } catch (error) {
    console.error('[l2d-pet] credential write failed:', error)
  }
  // 退场清理：属主校验后再删——抢锁失败的实例 quit 也走 will-quit，不能拆掉持有者的凭据。
  // relaunch 类退场（软渲染切换/手动重启）走 app.exit(0) 不经 will-quit：凭据由接管的新实例覆写，
  // 偶发残留指向死进程时由宿主的 stale 探活判定自愈
  app.on('will-quit', () => {
    if (L2D_PIDFILE === '') return
    try {
      const cur = JSON.parse(fs.readFileSync(L2D_PIDFILE, 'utf8'))
      if (cur?.pid === process.pid) fs.rmSync(L2D_PIDFILE, { force: true })
    } catch { }
  })
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
  // 手动重启：与软渲染切换同一条「放锁→relaunch→exit」路径
  ipcMain.on('l2d-restart', (event) => {
    if (!fromPet(event)) return
    try { app.releaseSingleInstanceLock() } catch { }
    app.relaunch()
    app.exit(0)
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

  // ── 游戏卫星窗（每游戏独立一窗）──
  // 对局卡独立小窗：输入捕获范围物理上只有卡片大小，overlay 的穿透状态机不再参与；
  // focusable:true 让下拉/输入原生可用。卡片与 overlay 通过 BroadcastChannel 同源互通
  // （气泡台词转发到小人头上）。
  // 每游戏独立尺寸表（useContentSize 语义=内容区像素），与各游戏渲染器 canvasSize 对应：
  //   gomoku / chess：500×500 正方盘 + 卡头/状态条/评论列 → 760×650
  const CARD_SIZES = {
    gomoku: { width: 760, height: 650 },
    chess: { width: 760, height: 650 },
  }
  const cardWins = new Map()    // gameId → { win, expectedSize, guardTimer }
  // gameId 白名单：格式粗筛（registry id 规则 /^[a-z0-9-]+$/）+ 尺寸表命中，非法一律落 gomoku
  const normalizeGameId = (raw) => {
    if (typeof raw !== 'string' || !/^[a-z0-9-]+$/.test(raw)) return 'gomoku'
    return Object.prototype.hasOwnProperty.call(CARD_SIZES, raw) ? raw : 'gomoku'
  }
  // 卡片区域实时推送（多窗=矩形数组）：overlay 把这些区域当穿透死区——否则 overlay 压在
  // 卡片上方（screen-saver 层 > floating 层），光标停留会触发模型区解锁，把卡片点击全吃掉。
  // 兼容语义：0 窗 null / 1 窗单矩形（旧接收端行为不变）/ 多窗矩形数组（新接收端逐个判）
  const pushCardArea = () => {
    if (win === null || win.isDestroyed()) return
    const areas = []
    for (const entry of cardWins.values()) {
      if (entry.win && !entry.win.isDestroyed()) areas.push(entry.win.getBounds())
    }
    win.webContents.send('l2d-game-area', areas.length === 1 ? areas[0] : areas.length > 0 ? areas : null)
  }
  // IPC sender 反查：close/moveby 等来自卡片窗的消息，用 sender 在多窗表里找归属窗（找不到拒收）
  const cardEntryBySender = (event) => {
    for (const entry of cardWins.values()) {
      if (entry.win && !entry.win.isDestroyed() && event.sender === entry.win.webContents) return entry
    }
    return null
  }
  ipcMain.handle('l2d-game-bounds', (event) => {
    if (!fromPet(event)) return null
    const areas = []
    for (const entry of cardWins.values()) {
      if (entry.win && !entry.win.isDestroyed()) areas.push(entry.win.getBounds())
    }
    return areas.length === 1 ? areas[0] : areas.length > 0 ? areas : null
  })
  ipcMain.on('l2d-game-open', (event, rawGameId) => {
    if (!fromPet(event)) return
    const gameId = normalizeGameId(rawGameId)
    const existing = cardWins.get(gameId)
    if (existing) {
      if (existing.win && !existing.win.isDestroyed()) { existing.win.show(); pushCardArea(); return }
      clearTimeout(existing.guardTimer)   // 残骸条目（窗已亡未清）：先拆再重建
      cardWins.delete(gameId)
    }
    const disp = screen.getPrimaryDisplay().workArea
    const size = CARD_SIZES[gameId]
    // 新窗级联偏移：默认位右下角起，按已开窗数每窗 (+28,+28) 防完全重叠；出屏回落默认位
    const baseX = disp.x + disp.width - (size.width + 16)
    const baseY = disp.y + Math.max(0, Math.round((disp.height - size.height) / 2))
    let x = baseX + cardWins.size * 28
    let y = baseY + cardWins.size * 28
    if (x + size.width > disp.x + disp.width || y + size.height > disp.y + disp.height) { x = baseX; y = baseY }
    const cardWin = new BrowserWindow({
      width: size.width,
      height: size.height,
      useContentSize: true,   // 尺寸语义=内容区：减少客户区↔框架换算面（分数 DPI 对账稳定化）
      x, y,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      focusable: true,           // 恒 true：setFocusable 切换在分数 DPI 下有窗口管理副作用
      backgroundColor: '#ffffff',
      hasShadow: false,          // DWM 阴影的隐形边框是分数 DPI 框架对账误差来源（overlay 窗同款配置从不自激）
      roundedCorners: false,     // 减少 DWM 框架度量参与面，分数 DPI 下对账更稳（单窗案排查后保留）
      webPreferences: {
        preload: path.join(__dirname, 'preload-card.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    const entry = { win: cardWin, expectedSize: null, guardTimer: null, loadRetries: 0 }   // 本窗自己的 DPI 治疗链状态
    cardWins.set(gameId, entry)
    // 与 overlay 同级且后设置 → 压在透明 overlay 之上。卡片是不透明窗本就该在上：
    // 否则透明穿透窗叠在不透明窗上，Windows 光标判定在夹层抖动（标题栏光标跳变病灶）
    cardWin.setAlwaysOnTop(true, 'screen-saver')
    cardWin.setMenu(null)
    cardWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // 锁视觉缩放：捏合手势在拖拽标题栏时极易被误判成 pinch 把整页放大；卫星窗锁死 1:1
    cardWin.webContents.setVisualZoomLevelLimits(1, 1).catch(() => { })
    cardWin.webContents.on('will-navigate', (e, target) => {
      if (!target.startsWith(targetOrigin + '/')) e.preventDefault()
    })
    // 渲染器崩溃：关窗退场（closed 钩子自清表+收缩死区，🎮 可重开）——×按钮/拖动都靠页面，
    // 页死即不可交互，留壳只会钉一块白窗在屏幕上
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
      setTimeout(() => { if (!cardWin.isDestroyed()) cardWin.loadURL(cardUrl).catch(() => { }) }, 2000 * entry.loadRetries)
    })
    // 渲染器就绪后重锁：webContents 创建前设置的视觉缩放锁可能被首个导航静默丢弃；
    // 同时记本窗实测尺寸（每窗一份 expectedSize，拖拽期钉死用）
    cardWin.webContents.on('did-finish-load', () => {
      cardWin?.webContents.setVisualZoomLevelLimits(1, 1).catch(() => { })
      entry.expectedSize = cardWin && !cardWin.isDestroyed() ? cardWin.getSize() : null
      entry.loadRetries = 0
    })
    // 尺寸看门狗（每窗一份）：分数 DPI 下 Chromium↔Windows 的框架对账会残留 ±1px 级
    // 抽搐（雪崩已被 hasShadow:false + 拖拽钉尺寸打断），任何路径引起的尺寸偏移
    // 80ms 平息后一律钉回本窗实测尺寸——窗口设计上固定尺寸，视觉层零容忍
    cardWin.on('resize', () => {
      clearTimeout(entry.guardTimer)
      entry.guardTimer = setTimeout(() => {
        if (cardWin.isDestroyed() || !entry.expectedSize) return
        const s = cardWin.getSize()
        if (s[0] !== entry.expectedSize[0] || s[1] !== entry.expectedSize[1]) {
          cardWin.setSize(entry.expectedSize[0], entry.expectedSize[1])
        }
      }, 80)
    })
    cardWin.on('closed', () => {
      clearTimeout(entry.guardTimer)
      if (cardWins.get(gameId) === entry) cardWins.delete(gameId)
      pushCardArea()   // 死区数组随关窗收缩
    })
    const cardUrl = new URL(`/live2d/game-card.html?game=${encodeURIComponent(gameId)}`, TARGET).href
    cardWin.loadURL(cardUrl).catch(() => { })
    pushCardArea()
  })
  ipcMain.on('l2d-game-close', (event) => {
    const entry = cardEntryBySender(event)   // 多窗反查：sender 属于哪张卡就关哪张，找不到拒收
    if (entry) entry.win.close()
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
    const entry = cardEntryBySender(event)   // 多窗反查：按 sender 找归属窗，找不到拒收
    if (!entry || entry.win.isDestroyed()) return
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    const [x, y] = entry.win.getPosition()
    if (entry.expectedSize) {
      // 拖拽钉尺寸：setBounds 同时钉住本窗加载完成时的实测尺寸（位置照动、尺寸免谈）
      entry.win.setBounds({ x: Math.round(x + dx), y: Math.round(y + dy), width: entry.expectedSize[0], height: entry.expectedSize[1] })
    } else {
      entry.win.setPosition(Math.round(x + dx), Math.round(y + dy))
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
  win.webContents.on('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
    if (!isMainFrame) return
    const delay = Math.min(30000, 2000 * 2 ** loadRetries)
    loadRetries += 1
    setTimeout(reloadPage, delay)
  })
  win.webContents.on('did-finish-load', () => { loadRetries = 0; pageMisses = 0 })
  // 渲染进程崩溃/假死看门狗：直接退出释放单实例锁，比留僵尸透明窗卡死下次启动强
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[l2d-pet] render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`)
    app.quit()
  })
  win.webContents.on('unresponsive', () => {
    console.error('[l2d-pet] renderer unresponsive')
    app.quit()
  })
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
  let pageMisses = 0
  const probePage = async () => {
    if (win === null || win.isDestroyed()) return
    const alive = await Promise.race([
      win.webContents.executeJavaScript('window.__L2D_PAGE_LIVE === true').then((v) => v === true, () => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 4000)),
    ])
    if (alive) {
      if (pageMisses > 0) console.error(`[l2d-pet] page liveness recovered after ${pageMisses} miss(es)`)
      pageMisses = 0
      return
    }
    pageMisses += 1
    console.error(`[l2d-pet] page liveness probe miss #${pageMisses}`)
    if (pageMisses === 2) reloadPage()
    if (pageMisses >= 5) {
      console.error('[l2d-pet] page unrecoverable after 5 probe misses, quitting')
      app.quit()
    }
  }
  app.on('child-process-gone', (_event, details) => {
    console.error(`[l2d-pet] child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`)
    if (details.type === 'Renderer') void probePage()
  })
  // 自递归 tick 而非 setInterval：上一轮 fetch/探针未决时不叠并发（慢网络下计数不失真）
  const healthTick = async () => {
    try {
      const r = await fetch(origin + '/live2d/state', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
      failures = r.ok ? 0 : failures + 1
    } catch {
      failures += 1
    }
    // 80 秒宽限（低配机重启 DSH 可能超过 40 秒）：先自愈重载页面；
    // 持续 120 秒仍不通认定宿主已死才退出（宿主下次启动会重新 spawn）
    if (failures >= 10) reloadPage()
    if (failures >= 15) app.quit()
    await probePage()
    setTimeout(() => { void healthTick() }, 8000)
  }
  setTimeout(() => { void healthTick() }, 8000)
})

app.on('window-all-closed', () => app.quit())
}
