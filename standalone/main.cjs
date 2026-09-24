const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createPassthrough } = require('../pet/passthrough.cjs')
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
// GPU 故障会话兜底：允许 SwiftShader 软件 WebGL（同 pet/main.js，两形态行为一致铁律）
app.commandLine.appendSwitch('enable-unsafe-swiftshader')

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

/** 显式唤出桌宠（托盘「显示桌宠」/ 托盘单击 / second-instance）。
 *  win32 用 showInactive：唤出但不抢前台焦点（120 实测修复——用户从托盘叫出桌宠时
 *  不该把正在用的窗口踢到后台）。其他平台保持 show() 语义不变。
 *  证实门路径的 show 不走此处：那里有「必须先 map 才能做命中读回」的语义。 */
function showPet() {
  if (win === null || win.isDestroyed()) return
  if (process.platform === 'win32') win.showInactive()
  else win.show()
}

function createTray() {
  // PNG 资源而非 data:image/svg+xml —— Windows 托盘对 SVG data URL 支持不稳
  // （nativeImage 在部分 Electron/Windows 组合下解出空图，托盘图标整块空白）。
  // 图标由 standalone/make-tray-icon.mjs 用 node 内置 zlib 生成，无任何 npm 依赖。
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png')).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('Live2D 独立桌宠')
  const stateItems = [
    ['闲置', 'idle'], ['思考', 'thinking'], ['工作', 'working'], ['等待确认', 'waiting'],
    ['完成', 'done'], ['报错', 'error'], ['睡眠', 'sleeping'],
  ].map(([label, value]) => ({ label, click: () => standalone.setState(value) }))
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示桌宠', click: () => showPet() },
    { label: '切换状态', submenu: stateItems },
    { type: 'separator' },
    { label: '打开模型目录', click: () => shell.openPath(standalone.modelDir) },
    { label: '退出', click: () => app.quit() },
  ]))
  tray.on('click', () => showPet())
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

  // 与 DSH 桌宠保持同一套 overlay 架构：透明窗口固定铺满主屏工作区，拖拽只改变
  // 画布中的模型坐标。窗口从不随物理鼠标消息移动，从根因上避开 DWM 闪烁。
  // 四元组同源取 workArea（与 pet/main.js 语义对齐）：旧实现全取 bounds，会把窗口
  // 铺到任务栏之下（任务栏区域也被覆盖），且与 pet 侧的 workArea 语义不一致。
  const area = screen.getPrimaryDisplay().workArea
  win = new BrowserWindow({
    width: area.width, height: area.height,
    x: area.x, y: area.y,
    frame: false, transparent: true, alwaysOnTop: true, resizable: false,
    skipTaskbar: true, hasShadow: false,
    // 键盘面动态放行（win32 only，同 pet/main.js）：NOACTIVATE 创建治「点击桌宠抢前台」；
    // focusable:false 在 win32 隐含 skipTaskbar:true（本就 true，无损失）。
    // linux 不动（d.ts：focusable:false 语义是「停止与 wm 交互、所有工作区恒置顶」）
    ...(process.platform === 'win32' ? { focusable: false } : {}),
    show: false,   // fail-closed：穿透证实前不显示（同 pet/main.js 证实门）
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)   // 初始恒穿透（盲写）；运行期由单源决策接管，证实门兜底（同 pet/main.js）
  // Linux WM 偶发把全屏 overlay 窗最小化且 skipTaskbar 无入口找回 → 立即弹回。
  // 该守卫跨平台**必需**（旧注释「Windows 无框窗不触发 minimize 事件」已被实测证伪）：
  // 2026-09-24 Win11 25H2 实测——Win+D / 显示桌面会触发无框透明窗的 minimize 事件，
  // 连续两次 Win+D 触发两次 minimize，靠本守卫 win.restore() 正常救场；
  // 同次实测显式 SC_MINIMIZE / SW_MINIMIZE 路径不触发该事件（同 pet/main.js）
  win.on('minimize', () => {
    console.error('[l2d-pet] minimized by WM, restoring')
    if (!win.isDestroyed()) win.restore()
  })
  // 最小化还原同样重置 X 层穿透态（同 pet/main.js）——还原后立即重申
  win.on('restore', () => passthrough.reassert())
  // 显示器参数变化（分辨率/缩放/拔插屏）：窗口跟随新主屏工作区，渲染层 resize 自会重排。
  // 与 pet/main.js 同款完整治疗，两形态语义对齐：
  // 必须去抖——事件到达的那一刻 WM/DWM 转场尚未完成，此刻读到的是旧尺寸；按旧值
  // setBounds 会让无框透明窗在瞬态里被误判 FULLSCREEN（Linux 侧 Cinnamon 随之藏掉
  // 面板，2026-09-16 翻转本旋转实证）。定时器内重新取当下的 display 对象与工作区，
  // 绝不复用闭包旧值；WM 若仍把本窗标成全屏则立刻自摘。
  let metricsTimer = null
  screen.on('display-metrics-changed', () => {
    clearTimeout(metricsTimer)
    metricsTimer = setTimeout(() => {
      if (win === null || win.isDestroyed()) return
      win.setBounds(screen.getPrimaryDisplay().workArea)
      // 防御：WM 若仍把本窗标成全屏，立刻自摘——面板消失的唯一成因
      if (win && !win.isDestroyed() && win.isFullScreen()) win.setFullScreen(false)
    }, 500)
  })
  // ── 键盘面动态放行（win32 only，同 pet/main.js）──
  // overlay 以 focusable:false 创建（NOACTIVATE：点击不抢前台），但 NOACTIVATE 下
  // input/select 吃不到键盘焦点，故打开含输入控件的面板时临时放行。
  // 按来源 OR 汇总：chat / settings / quips 可同时打开，单布尔会误撤另一面板的焦点。
  // 非 win32 直接 return（linux 的 focusable 语义不同，必须零变化）。
  // ⚠️ 未知面（留给 120 回归）：卫星窗时代运行期 setFocusable 切换在分数 DPI 下曾是
  // 框架扰动源，故被冻结（README「卫星窗：分数 DPI 尺寸稳定化」）。overlay 风险面不同
  // （全屏固定尺寸、resizable:false、永不 resize），但须在 120 实机确认无自激 resize。
  const focusSurfaces = new Set()
  const syncOverlayFocusable = () => {
    if (win === null || win.isDestroyed()) return
    const want = focusSurfaces.size > 0
    win.setFocusable(want)
    if (want) win.focus()   // 面板打开=显式打字意图
  }
  ipcMain.on('l2d-overlay-focusable', (event, source, on) => {
    if (process.platform !== 'win32') return
    if (!fromPet(event) || typeof source !== 'string') return
    if (on) focusSurfaces.add(source)
    else focusSurfaces.delete(source)
    syncOverlayFocusable()
  })
  // 安全网：导航/重载后渲染层面板状态全失效，清空来源表避免焦点被永久放行
  win.webContents.on('did-start-loading', () => {
    if (focusSurfaces.size === 0) return
    focusSurfaces.clear()
    syncOverlayFocusable()
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
  // l2d-ignore 通道保留为应急逃生门：运行期穿透开关已由单源决策接管（同 pet/main.js）。
  ipcMain.on('l2d-ignore', (event, ignore) => {
    // 勿加 {forward:true}：electron#48035 光标闪烁铁律（pet/main.js 有载），穿透态光标由主进程轮询驱动
    if (fromPet(event)) win.setIgnoreMouseEvents(Boolean(ignore))
  })
  // ── 穿透单源决策（同 pet/main.js）：渲染层上报交互矩形集，主进程 OS 光标比对
  // 直接驱动 setIgnoreMouseEvents；决策器共享 pet/passthrough.cjs 保证两形态一致。
  const passthrough = createPassthrough({
    apply: (ignore) => { if (win !== null && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore) },
    notify: (state) => { if (win !== null && !win.isDestroyed()) win.webContents.send('l2d-interact-state', state) },
    log: (...args) => console.error(...args),
    debug: (...args) => { if (process.env.L2D_DEBUG === '1') console.log(...args) },
    // 窗口 1px 微移 wiggle：解冻 getCursorScreenPoint 读数（同 pet/main.js；
    // 自移编排：freezeProbe 静音事件重申 500ms，往返落地后 50ms reassertNow 收尾）
    wiggle: () => {
      if (win === null || win.isDestroyed()) return
      const b = win.getBounds()
      win.setBounds({ x: b.x + 1, y: b.y, width: b.width, height: b.height })
      setTimeout(() => {
        if (win !== null && !win.isDestroyed()) win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height })
        setTimeout(() => passthrough.reassertNow(), 50)
      }, 300)
    },
  })
  ipcMain.on('l2d-rects', (event, rects) => {
    if (fromPet(event)) passthrough.setRects(rects)
  })
  ipcMain.on('l2d-heartbeat', (event, at) => {
    if (fromPet(event)) passthrough.heartbeat(at)
  })
  // 渲染层关键错误转发留痕（同 pet/main.js）
  ipcMain.on('l2d-renderer-error', (event, msg) => {
    if (fromPet(event) && typeof msg === 'string') console.error('[l2d-pet] renderer:', msg.slice(0, 500))
  })
  // 窗口移动/尺寸变化会重置 X 层穿透态（同 pet/main.js）——move/resize 后立即重申
  win.on('move', () => passthrough.reassert())
  win.on('resize', () => passthrough.reassert())
  // 导航/重载同样重置穿透态（同 pet/main.js）
  win.webContents.on('did-navigate', () => passthrough.reassert())
  win.webContents.on('did-start-loading', () => passthrough.reassert())
  win.webContents.on('did-finish-load', () => passthrough.reassert())
  win.webContents.on('did-fail-load', () => passthrough.reassert())
  // ── 穿透证实门（fail-closed，同 pet/main.js）：穿透未证实前窗口不稳定显示 ──
  // show:false 未 realize 时 native handle 可能读不出——惰性读取（同 pet/main.js）
  let petWid = 0
  let petTopWid = 0   // 客户窗的 root 直子祖先（reparenting WM 框架窗；无 reparent 时=petWid）
  // reparenting WM 下命中读回返回框架窗而非客户窗（openbox 实证）——只比客户 id
  // 会把捕获误判为穿透（同 pet/main.js，两形态行为一致铁律）。
  // 时机铁律：必须在窗口 mapped 之后解析（reparent 发生在 map 时，提前解析会把
  // petTopWid 误钉成客户窗——首轮实证踩中）。
  const resolvePetTopWid = (force = false) => {
    if (petWid === 0 || process.platform !== 'linux') return
    if (petTopWid !== 0 && !force) return
    try {
      const { execFileSync } = require('node:child_process')
      const tree = execFileSync('xwininfo', ['-root', '-tree'], { timeout: 3000, encoding: 'utf8' })
      const entries = []
      for (const line of tree.split('\n')) {
        const m = /^(\s+)(0x[0-9a-f]+)\s/i.exec(line)
        if (m) entries.push({ indent: m[1].length, wid: parseInt(m[2], 16) })
      }
      const idx = entries.findIndex((e) => e.wid === petWid)
      if (idx >= 0) {
        const minIndent = Math.min(...entries.map((e) => e.indent))
        for (let i = idx; i >= 0; i--) {
          if (entries[i].indent === minIndent) { petTopWid = entries[i].wid; break }
        }
      }
      if (petTopWid === 0) petTopWid = petWid
    } catch { petTopWid = petWid }
  }
  const refreshPetWid = () => {
    if (petWid !== 0 || process.platform !== 'linux') return
    try {
      const handle = win.getNativeWindowHandle()
      if (handle && handle.length >= 4) petWid = handle.readUInt32LE(0)
    } catch { }
  }
  const isPetHit = (w) => w !== 0 && (w === petWid || (petTopWid !== 0 && w === petTopWid))
  refreshPetWid()
  let lastProbeWid = 0
  let lastProbeAt = 0
  let proofShownAt = 0
  let proofHits = 0
  let proofWarnedAt = 0
  let passthroughProven = false   // 全平台一律「未证实」起步（fail-closed，同 pet/main.js）
  if (process.platform === 'linux') {
    win.show()
    proofShownAt = Date.now()
    const proofTimer = setInterval(() => {
      if (passthroughProven || win === null || win.isDestroyed()) { clearInterval(proofTimer); return }
      refreshPetWid()
      // 不碰 isIgnoreMouseEvents() 读回（本环境实证可同步死锁主进程，同 pet/main.js）
      win.setIgnoreMouseEvents(true)
      if (petWid === 0 || lastProbeWid === 0) return
      if (!win.isVisible()) { win.show(); proofShownAt = Date.now(); return }
      if (petTopWid === 0) resolvePetTopWid()   // map 后首拍解析框架祖先（同 pet/main.js）
      if (lastProbeAt <= proofShownAt) return
      if (isPetHit(lastProbeWid)) {
        proofHits = 0
        win.hide()
        win.setIgnoreMouseEvents(true)
        if (Date.now() - proofWarnedAt > 30000) {
          proofWarnedAt = Date.now()
          console.error('[l2d-pet] passthrough proof FAILED (X hit-test lands on pet window); window hidden, reasserting and retrying')
        }
      } else if (++proofHits >= 2) {
        passthroughProven = true
        resolvePetTopWid(true)   // 证实落锤前强制重解框架祖先（同 pet/main.js）
        console.error('[l2d-pet] passthrough proven (x11 hit-test)')
      }
    }, 500)
  } else {
    // ── 非 Linux（win32/darwin）：能力探测决定路径（同 pet/main.js，两形态对称）──
    // Electron 43.4.0 只有 setIgnoreMouseEvents（只写），没有 isIgnoreMouseEvents 读回
    // API（electron.d.ts:3332/6122 仅有 setter）。无条件调用不存在的 API = 每拍 TypeError
    // → 永不证实 → show 被推迟。故先探测：
    //   有读回 API → 真读回门（2 拍/3s 规则）；无读回 API → 乐观直通并如实标注。
    win.setIgnoreMouseEvents(true)
    if (typeof win.isIgnoreMouseEvents === 'function') {
      const READBACK_INTERVAL_MS = 100
      const READBACK_NEEDED = 2
      const READBACK_TIMEOUT_MS = 3000
      let readbacks = 0
      const readbackDeadline = Date.now() + READBACK_TIMEOUT_MS
      const readbackTimer = setInterval(() => {
        if (passthroughProven || win === null || win.isDestroyed()) { clearInterval(readbackTimer); return }
        win.setIgnoreMouseEvents(true)   // 每拍重申：读回门期间目标态恒为穿透
        let ignored = false
        try {
          ignored = win.isIgnoreMouseEvents() === true
        } catch (error) {
          console.error('[l2d-pet] passthrough readback threw:', error)   // 读回抛异常=不可信，不计证实
          ignored = false
        }
        if (ignored) {
          if (++readbacks >= READBACK_NEEDED) {
            passthroughProven = true
            clearInterval(readbackTimer)
            console.error('[l2d-pet] passthrough proven (electron readback)')
            win.show()
          }
          return
        }
        readbacks = 0   // 读到 false 即归零：证实要求「连续」而非「累计」
        if (Date.now() < readbackDeadline) return
        clearInterval(readbackTimer)
        // 超时未证实：留错误日志 + 降级 show（不死锁 UX；错误必须可见）。
        // 本形态无 PID 凭据文件（standalone 不走宿主的带病重生保护），故无凭据可记。
        console.error(`[l2d-pet] passthrough readback FAILED (isIgnoreMouseEvents() never read true within ${READBACK_TIMEOUT_MS / 1000}s); showing degraded window`)
        win.show()
      }, READBACK_INTERVAL_MS)
    } else {
      // 乐观直通：本平台无读回 API，穿透证实只能是乐观声明——如实标注，不谎称读过
      console.error('[l2d-pet] no mouse-ignore readback API on this platform; passthrough proof is an optimistic claim (non-linux)')
      passthroughProven = true
      console.error('[l2d-pet] passthrough proven (no-readback-api optimistic (non-linux))')
      win.show()
    }
  }
  // 外部光标探针（Linux/X11，同 pet/main.js）：主读数滞后/冻结时以 xdotool 为独立光标源；
  // 顺带解析 WINDOW 命中字段喂 X 层校验环与证实门
  if (process.platform === 'linux') {
    const { execFile } = require('node:child_process')
    let probeFailures = 0
    let extProbeTimer = null
    const probeCursor = () => {
      execFile('xdotool', ['getmouselocation', '--shell'], { timeout: 1500 }, (err, stdout) => {
        if (err) {
          if (++probeFailures >= 3) {
            console.error('[l2d-pet] xdotool probe unavailable, cursor fallback to main reading')
            if (extProbeTimer !== null) clearInterval(extProbeTimer)
          }
          return
        }
        probeFailures = 0
        const x = /X=(\d+)/.exec(stdout)
        const y = /Y=(\d+)/.exec(stdout)
        const wid = /WINDOW=(\d+)/.exec(stdout)
        if (x && y) passthrough.externalCursor(Number(x[1]), Number(y[1]))
        if (wid && petWid !== 0) {
          lastProbeWid = Number(wid[1])
          lastProbeAt = Date.now()
          // 证实未完成/窗口隐藏期不喂校验环（同 pet/main.js）
          if (passthroughProven && win !== null && !win.isDestroyed() && win.isVisible()) {
            passthrough.observedHit(isPetHit(lastProbeWid))
          }
        }
      })
    }
    extProbeTimer = setInterval(probeCursor, 500)
  }
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
    const point = passthrough.cursor() ?? screen.getCursorScreenPoint()
    return { x: point.x, y: point.y, bounds: win.getBounds() }
  })

  // 游戏卫星窗：复杂游戏 UI 与透明 overlay 物理隔离，避免穿透、焦点和拖动互抢。
  // gameId 作为通用入口保留；game-card 现有五子棋/国象两个游戏，按查询参数切换。
  const pushCardArea = () => {
    if (win === null || win.isDestroyed()) return
    const areas = []
    for (const entry of cardWins.values()) {
      if (entry.win && !entry.win.isDestroyed()) areas.push(entry.win.getBounds())
    }
    passthrough.setCardAreas(areas)   // 死区同步进单源决策器
    win.webContents.send('l2d-game-area', areas.length === 1 ? areas[0] : areas.length > 0 ? areas : null)
  }
  ipcMain.handle('l2d-game-bounds', (event) => {
    if (!fromPet(event)) return null
    const areas = []
    for (const entry of cardWins.values()) {
      if (entry.win && !entry.win.isDestroyed()) areas.push(entry.win.getBounds())
    }
    return areas.length === 1 ? areas[0] : areas.length > 0 ? areas : null
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
      backgroundColor: '#ffffff', hasShadow: false, roundedCorners: false,
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
  let lastMain = null
  let lastPush = null
  const cursorTimer = setInterval(() => {
    if (win === null || win.isDestroyed()) return
    const point = screen.getCursorScreenPoint()
    const mainMoved = lastMain !== null && (lastMain.x !== point.x || lastMain.y !== point.y)
    lastMain = point
    // 单源决策先于光标推送：静止 tick 也要跑（停留计时到期不依赖光标移动）（同 pet/main.js）
    const decision = passthrough.tick(point.x, point.y, mainMoved) ?? point
    // 推送源跟随决策仲裁（同 pet/main.js）：主读数冻结时以 xdotool 仲裁源续推，按钮簇迁移沿不断流
    const out = mainMoved ? point : decision
    if (lastPush !== null && lastPush.x === out.x && lastPush.y === out.y) return
    lastPush = out
    win.webContents.send('l2d-cursor', { x: out.x, y: out.y, bounds: win.getBounds() })
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
  app.on('second-instance', () => showPet())
  app.whenReady().then(createWindow).catch(error => {
    dialog.showErrorBox('Live2D 桌宠启动失败', String(error?.stack || error))
    app.quit()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => { void standalone?.close() })
}
