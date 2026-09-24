const { app, BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createPassthrough } = require('./passthrough.cjs')

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
// GPU 故障会话的模型渲染兜底：允许 SwiftShader 软件 WebGL（Chromium 128+ 默认禁用）。
// 硬件 GPU 可用时依旧优先走 GPU，本开关只是放行软件回退——2026-09-13 生产实证：
// 会话级 WebGL blocklist 下无此开关则 initStage 失败、桌宠全程 headless 隐形。
app.commandLine.appendSwitch('enable-unsafe-swiftshader')

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
  // overlay-pet：窗口铺满主屏工作区、永不移动——透明窗呈现丢帧的触发条件
  // 「按住鼠标的物理消息流 × 窗口移动」在架构上不存在。模型位置=画布坐标，
  // 由渲染层记忆（localStorage l2d-pet-pos）。指针穿透照旧按模型区域切换。
  // 尺寸与原点必须同源取 workArea：旧实现「尺寸 workArea、原点 bounds」在任务栏位于
  // 左/上时原点错配（bounds.x/y=0 而 workArea.x/y=任务栏厚度），窗口整体偏移出屏。
  const disp = screen.getPrimaryDisplay()
  win = new BrowserWindow({
    width: disp.workArea.width,
    height: disp.workArea.height,
    x: disp.workArea.x,
    y: disp.workArea.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,   // fail-closed：穿透证实前不显示（见下方证实门；22:51 全屏捕获事故根治）
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
  win.setIgnoreMouseEvents(true)   // 初始恒穿透（盲写）；运行期由单源决策接管，证实门兜底
  // Linux WM 偶发把全屏 overlay 窗最小化且 skipTaskbar 无入口找回 → 立即弹回；
  // Windows 无框窗不触发 minimize 事件，该守卫跨平台无害
  win.on('minimize', () => {
    console.error('[l2d-pet] minimized by WM, restoring')
    if (!win.isDestroyed()) win.restore()
  })
  // 最小化还原同样重置 X 层穿透态（实验室实证：minimize/restore 循环后命中回本窗）——
  // 还原后立即重申，不等 5s 稳态重申兜底
  win.on('restore', () => passthrough.reassert())
  // 显示器参数变化（分辨率/缩放/拔插屏）：窗口跟随新主屏，渲染层 resize 自会重排。
  // 必须去抖：事件到达的那一刻 WM 转场尚未完成，此刻读到的是旧尺寸；按旧值 setBounds
  // 会让无框透明窗在瞬态里被误判 FULLSCREEN，Cinnamon 随之藏掉面板
  // （2026-09-16 翻转本旋转实证）。定时器内重新取当下的 display 对象与工作区，
  // 绝不复用闭包旧值。
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
  // l2d-ignore 通道保留为应急逃生门：运行期穿透开关已由下方单源决策接管（passthrough）
  ipcMain.on('l2d-ignore', (event, ignore) => {
    if (fromPet(event)) win.setIgnoreMouseEvents(Boolean(ignore))
  })
  // ── 穿透单源决策：渲染层只上报「交互矩形集」，主进程用 OS 光标位置比对矩形集
  // 自行驱动 setIgnoreMouseEvents——判定不再依赖 DOM 事件到达，X11 input-shape
  // 盲写失同步时由行为核验重试 + 安全态兜底（详见 pet/passthrough.cjs 头注）。
  // 状态迁移回推渲染层：锁钮三态与 dwellDebug 探针靠它保鲜。
  const passthrough = createPassthrough({
    apply: (ignore) => { if (win !== null && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore) },
    notify: (state) => { if (win !== null && !win.isDestroyed()) win.webContents.send('l2d-interact-state', state) },
    log: (...args) => console.error(new Date().toISOString().slice(11, 23), ...args),
    debug: (...args) => { if (process.env.L2D_DEBUG === '1') console.log(new Date().toISOString().slice(11, 23), ...args) },
    // 窗口 1px 微移 wiggle：X11 Configure 事件强制 Chromium 重同步光标读数缓存
    // （getCursorScreenPoint 冻结自愈，见 passthrough.cjs 头注 d）；1px 往返视觉无感。
    // 自移编排（第六轮实证）：往返 300ms 与重申防抖 300ms 病态对齐——去程 move 的
    // toggle 在返程重置前空放、返程后又双双被防抖饿死。freezeProbe 已静音事件重申
    // 500ms，此处往返全部落地后 50ms 补一刀无防抖 reassertNow，确定性愈合
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
  // 渲染层关键错误转发留痕（渲染进程 console 不进宿主日志，排障时不可见）
  ipcMain.on('l2d-renderer-error', (event, msg) => {
    if (fromPet(event) && typeof msg === 'string') console.error('[l2d-pet] renderer:', msg.slice(0, 500))
  })
  // 窗口移动/尺寸变化会重置 X 层穿透态（2026-09-12 第四轮实证：Edge/Chrome 同症，
  // 属 X/WM 层语义）——任何 move/resize（含 wiggle 自身）后立即重申当前态
  win.on('move', () => passthrough.reassert())
  win.on('resize', () => passthrough.reassert())
  // 导航/重载同样重置穿透态（实证：启动期 map 后 ~206ms 的失守即渲染器附加所致；
  // healthTick 的 reloadPage 是运行期重演）——导航全程各节点一律重申
  win.webContents.on('did-navigate', () => passthrough.reassert())
  win.webContents.on('did-start-loading', () => passthrough.reassert())
  win.webContents.on('did-finish-load', () => passthrough.reassert())
  win.webContents.on('did-fail-load', () => passthrough.reassert())
  // ── 穿透证实门（fail-closed，22:51 事故根治）：窗口穿透未证实前不稳定显示。
  // Linux：X 命中测试要求窗口 mapped，故流程=盲写穿透 → map → 探针命中读回校验：
  // 连续 2 拍未命中本窗=证实（凭据增写 passthroughProvenAt 供宿主判健康）；
  // 任一拍命中本窗=盲写失守 → 立即 hide + 重申 + 重试——故障会话里窗口永不
  // 稳定显示（隐形即无害），带病重生不再捕获屏幕。
  // 非 Linux：穿透证实受 API 能力约束（B2 实测坐实）——Electron 43.4.0 只有
  // setIgnoreMouseEvents（只写），没有 isIgnoreMouseEvents 读回 API。故先做能力探测：
  //   有读回 API（未来 Electron 补上）→ 真读回门：盲写后轮询读回，连续 2 拍读到 true
  //     才登记证实；超时 3s 未证实则如实上报 + 凭据记 unproven + 降级 show。
  //   无读回 API（43.4.0 实况）→ 乐观直通：立即 markProven + show（父提交 53b71a3 时序），
  //     标签如实标注「乐观声明」，不谎称读过；凭据照写 passthroughProvenAt，避免宿主
  //     index.js:1463-1470 的带病重生保护假阳性。
  // 反例铁律：无条件调用不存在的读回 API = 每拍 TypeError → 永不证实 → show 被推迟且
  // 凭据永远无 passthroughProvenAt → 该保护反被假阳性触发。──
  // show:false 未 realize 时 native handle 可能读不出——惰性读取（创建时试一次，
  // 证实门每拍重试直到拿到）；petWid=0 期间命中比对不采信（降级为 Electron 读回）
  let petWid = 0
  let petTopWid = 0   // 客户窗的 root 直子祖先（reparenting WM 的框架窗；无 reparent 时=petWid）
  // reparenting WM（openbox 实证：客户 0x2006ef vs 框架 0x2006ee；mutter 同类）下
  // XQueryPointer/xdotool 命中读回返回的是框架窗而非客户窗——只比客户 id 会把捕获
  // 误判为穿透（证实门假通过、校验环全盲，fail-closed 静默失效）。一次性解析
  // xwininfo -root -tree 取本窗的 root 直子祖先；无 reparent 时祖先即客户窗
  // 本身（petTopWid=petWid），与非 reparenting 环境旧行为逐字节等价。
  // 工具缺失/解析失败降级 petTopWid=petWid（旧行为），不阻断证实门。
  // 时机铁律：必须在窗口 mapped 之后解析——map 前窗口是 root 直子，WM 的 reparent
  // （框架创建）发生在 map 时，提前解析会把 petTopWid 误钉成客户窗（首轮实证踩中）。
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
      if (process.env.L2D_DEBUG === '1') console.error(`[l2d-pet] resolved window ids: client=0x${petWid.toString(16)} top=0x${petTopWid.toString(16)}`)
    } catch { petTopWid = petWid }
  }
  const refreshPetWid = () => {
    if (petWid !== 0 || process.platform !== 'linux') return
    try {
      const handle = win.getNativeWindowHandle()
      if (handle && handle.length >= 4) petWid = handle.readUInt32LE(0)
    } catch { }
  }
  // 命中判定：读回 id 命中客户窗或其框架祖先都算命中本窗（两种 WM 语义通吃）
  const isPetHit = (w) => w !== 0 && (w === petWid || (petTopWid !== 0 && w === petTopWid))
  refreshPetWid()
  let lastProbeWid = 0        // 探针最近一次命中窗口 id（0=未产出/不可判）
  let lastProbeAt = 0         // 探针读回时刻（证实判定要求新于最近 show，防隐藏期陈旧读回假通过）
  let proofShownAt = 0        // 证实门最近一次 show 的时刻
  let proofHits = 0           // 连续「未命中本窗」拍数
  let proofWarnedAt = 0
  const markProven = (via) => {
    console.error(`[l2d-pet] passthrough proven (${via})`)
    resolvePetTopWid(true)   // 证实落锤前强制重解框架祖先（防 map 初期 reparent 竞态残留）
    // 凭据增写证实时间戳：宿主重生前据此判「上次是否带病死亡」。
    // 同时落一个布尔（与时间戳同生共死）：读凭据的人不必靠「字段缺席」反推未证实。
    try {
      if (L2D_PIDFILE !== '') {
        const cur = JSON.parse(fs.readFileSync(L2D_PIDFILE, 'utf8'))
        if (cur?.pid === process.pid) {
          cur.passthroughProven = true
          cur.passthroughProvenAt = Date.now()
          fs.writeFileSync(L2D_PIDFILE, JSON.stringify(cur))
        }
      }
    } catch { }
  }
  let passthroughProven = false   // 全平台一律「未证实」起步（fail-closed）
  if (process.platform === 'linux') {
    win.show()   // map 以验证（窗口期亚秒级；失守即收拢，见下）
    proofShownAt = Date.now()
    const proofTimer = setInterval(() => {
      if (passthroughProven || win === null || win.isDestroyed()) { clearInterval(proofTimer); return }
      refreshPetWid()
      // 注意：本环境实证 isIgnoreMouseEvents() 读回会同步死锁主进程（mojo WidgetHost
      // 异常态），Linux 证实门只做 X 层命中读回 + 盲写重申，不碰 Electron 读回
      win.setIgnoreMouseEvents(true)
      if (petWid === 0 || lastProbeWid === 0) return   // 窗口 id 未取到/探针未产出，等下一拍
      if (!win.isVisible()) { win.show(); proofShownAt = Date.now(); return }   // 失守收拢后重新 map；探针采样需窗口在位，下一拍再判
      if (petTopWid === 0) resolvePetTopWid()   // map 后首拍解析框架祖先（reparent 已发生）
      if (lastProbeAt <= proofShownAt) return   // 读回早于本次显示=隐藏期陈旧值，采信会把失守误判成证实
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
        markProven('x11 hit-test')
      }
    }, 500)
  } else {
    // ── 非 Linux（win32/darwin）：能力探测决定路径 ──
    // 铁律（B2 实测坐实）：Electron 43.4.0 的 BrowserWindow 只有 setIgnoreMouseEvents
    // （只写），**没有 isIgnoreMouseEvents 读回 API**——electron.d.ts:3332/6122 仅有 setter，
    // 整个 electron 包内 isIgnoreMouseEvents 零命中；本仓 pet/passthrough.cjs 头注与
    // 行为核验注释亦早载「Electron 无 isIgnoreMouseEvents 读回」。
    // 故绝不能无条件调用读回：不存在时每拍抛 TypeError → 永不证实 → show 被推迟 +
    // 凭据永远拿不到 passthroughProvenAt → 宿主 index.js:1464 的带病重生保护假阳性。
    // 两条路径：
    //  有读回 API（未来 Electron 补上）：真读回门——盲写后轮询读回，连续 2 拍 true 才
    //    登记证实；3s 未证实则留痕 + 凭据如实记 unproven + 降级 show。
    //  无读回 API（43.4.0 实况）：乐观直通——立即登记证实并 show（父提交 53b71a3 时序），
    //    标签如实标注「乐观声明」，不假装读过。
    win.setIgnoreMouseEvents(true)
    if (typeof win.isIgnoreMouseEvents === 'function') {
      // 读回按 ~100ms 一拍轮询，连续 2 拍读到 true 才登记证实（单拍可能是 set 尚未落地
      // 的瞬时真值）；超时 3s 未证实即认账——不假装成功。
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
          // 读回本身抛异常=不可信，绝不计入证实
          console.error('[l2d-pet] passthrough readback threw:', error)
          ignored = false
        }
        if (ignored) {
          if (++readbacks >= READBACK_NEEDED) {
            passthroughProven = true
            clearInterval(readbackTimer)
            markProven('electron readback')
            win.show()
          }
          return
        }
        readbacks = 0   // 读到 false 即归零：证实要求「连续」而非「累计」
        if (Date.now() < readbackDeadline) return
        clearInterval(readbackTimer)
        // 超时未证实：错误必须留痕（主进程侧上报通道=console.error → pet.log，
        // 与渲染层 l2d-renderer-error 的落点同一通道），凭据如实记 unproven，
        // 再降级 show 保证 UX 不死锁（用户至少能看见桌宠，而不是一个永不出现的窗）。
        // markProven 未被调用 → passthroughProvenAt 缺席，宿主据此判「上次带病死亡」。
        console.error(`[l2d-pet] passthrough readback FAILED (isIgnoreMouseEvents() never read true within ${READBACK_TIMEOUT_MS / 1000}s); showing degraded window, credential recorded unproven`)
        try {
          if (L2D_PIDFILE !== '') {
            const cur = JSON.parse(fs.readFileSync(L2D_PIDFILE, 'utf8'))
            if (cur?.pid === process.pid) {
              delete cur.passthroughProvenAt   // 如实记 unproven：不留任何证实戳
              cur.passthroughProven = false
              fs.writeFileSync(L2D_PIDFILE, JSON.stringify(cur))
            }
          }
        } catch { }
        win.show()
      }, READBACK_INTERVAL_MS)
    } else {
      // 乐观直通：本平台无读回 API，穿透证实只能是乐观声明——如实标注，不谎称读过。
      // 凭据照写 passthroughProvenAt（与父提交 53b71a3 一致），避免带病重生保护假阳性。
      console.error('[l2d-pet] no mouse-ignore readback API on this platform; passthrough proof is an optimistic claim (non-linux)')
      passthroughProven = true
      markProven('no-readback-api optimistic (non-linux)')
      win.show()
    }
  }
  // 外部光标探针（Linux/X11）：getCursorScreenPoint 读数走 Chromium 事件流缓存，
  // 穿透窗收不到事件时滞后/冻结（2026-09-12 生产实证）。xdotool 直读 X 服务器
  // 不受影响，作为决策器的独立光标源；顺带解析 WINDOW 命中字段喂 X 层校验环
  // 与证实门。Windows/macOS 无此问题且无 xdotool，仅 Linux 启用。
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
          // 证实未完成/窗口隐藏期不喂校验环：探测期的捕获读数归证实门处置，
          // 校验环此时采信只会与 hide/show 重试循环互相误报
          if (passthroughProven && win !== null && !win.isDestroyed() && win.isVisible()) {
            passthrough.observedHit(isPetHit(lastProbeWid))
          }
        }
      })
    }
    extProbeTimer = setInterval(probeCursor, 500)
  }
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
    const p = passthrough.cursor() ?? screen.getCursorScreenPoint()
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
    passthrough.setCardAreas(areas)   // 死区同步进单源决策器
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

  let lastMain = null
  let lastPush = null
  let diagTicks = 0
  setInterval(() => {
    if (win === null || win.isDestroyed()) return
    const p = screen.getCursorScreenPoint()
    const mainMoved = lastMain !== null && (lastMain.x !== p.x || lastMain.y !== p.y)
    lastMain = p
    // 单源决策先于光标推送：停留计时到期等判定不能依赖「光标在动」，静止 tick 也要跑
    const decision = passthrough.tick(p.x, p.y, mainMoved) ?? p
    if (process.env.L2D_DEBUG === '1' && ++diagTicks % 90 === 0) {
      console.log(`[l2d-pet] poll diag: cursor=${p.x},${p.y} moved=${mainMoved} state=${JSON.stringify(passthrough.snapshot())}`)
    }
    // 推送源跟随决策仲裁：主读数活推主读数（33ms 顺滑）；冻结时推仲裁源（xdotool 接管，
    // 渲染层 nowInside 迁移沿不断流，按钮簇照常出现）。Windows 无探针，decision 恒=p，行为不变
    const out = mainMoved ? p : decision
    if (lastPush !== null && lastPush.x === out.x && lastPush.y === out.y) return
    lastPush = out
    win.webContents.send('l2d-cursor', { x: out.x, y: out.y, bounds: win.getBounds() })
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
