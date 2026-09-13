/**
 * interact.js —— 交互层。
 *
 * 覆盖：点击反应（clickPool 随机动作）、双击卖萌、摸头（头部 30% 区域）、
 * 拖拽（挂件=DOM 位移 / 桌宠=IPC 移窗）、滚轮缩放、指针穿透矩形集上报、
 * 全局视线跟随（桌宠=主进程光标轮询 IPC / 挂件=窗口内 pointermove）。
 * 忙碌时（ctx.busy()）点击与双击被拦截为 busy 台词，摸头静默无视。
 *
 * 穿透判定已收编为主进程单源决策（pet/passthrough.cjs）：本模块只负责
 * 「交互矩形集维护 + 上报」与拖拽生命周期，不再直接切换穿透。
 */

import { PET, BRIDGE, BASE_W, BASE_H, store, quip } from './config.js'

/** 悬停穿透判定在模型包围盒外扩的像素余量（滚轮缩放不至于出框即失效）。 */
const HOVER_MARGIN = 48

/** UI 可交互控件选择器：命中检测（uiHit）与矩形集上报（collectRects）同源共用。 */
const UI_SELECTOR = '#l2d-model-toggle, #l2d-pin-toggle, #l2d-help-toggle, #l2d-game-toggle, #l2d-pet-menu, #l2d-game-menu, #l2d-model-panel, #l2d-help-card, #l2d-viewer, #l2d-chat-toggle, #l2d-chat-panel, #l2d-quips-card, #l2d-game'

/**
 * 初始化交互并挂到 ctx（evalIgnore 供 stage 的 ticker/resize 回调使用）。
 * @param {Object} ctx 共享上下文
 */
export function initInteract(ctx) {
  const box = ctx.box
  let lastPointer = null
  let dragging = false

  /** UI 命中检测：面板/预览等控件无论是否贴模型都必须可点（大窗口时齿轮远离模型包围盒）。 */
  function uiHit() {
    if (lastPointer === null) return false
    const el = document.elementFromPoint(lastPointer.x, lastPointer.y)
    return !!(el && el.closest(UI_SELECTOR))
  }

  /** 指针（画布坐标）是否落在模型包围盒+余量内（chrome 显隐等装饰判定用）。 */
  function insideModel(x, y) {
    const r = ctx.app.view.getBoundingClientRect()
    const b = ctx.modelBounds()
    const px = x - r.left
    const py = y - r.top
    return px >= b.x - HOVER_MARGIN && px <= b.x + b.width + HOVER_MARGIN
      && py >= b.y - HOVER_MARGIN && py <= b.y + b.height + HOVER_MARGIN
  }

  /** 手动穿透：模型区恒穿透，仅 UI 可点（穿透钮自己得留着，否则关不回来）。 */
  ctx.pinned = PET && store.getPinned()

  // ── 穿透判定：主进程单源决策（Linux/X11 input-shape 失同步根治）──
  // 渲染层职责收窄为「交互矩形集维护 + 上报」：模型包围盒+48px ∪ 可命中 UI 矩形
  // ∪ pinned/dragging 标志，经 IPC 交主进程；主进程用 OS 光标位置比对矩形集自行
  // setIgnoreMouseEvents（语义等价：UI 即时可点 / 模型区停留 600ms 且位移<24px
  // 放行 / 出框滞回回收 / 卫星窗死区恒穿透，见 pet/passthrough.cjs）。判定不再
  // 依赖 DOM 事件到达，穿透态下状态机照跑。UI 翻转点（面板/菜单/卡片开关、pin
  // 切换、拖拽起止）都会调 evalIgnore → 立即上报；ticker/resize 等高频调用点由
  // 「内容变化才发送」的差分自然节流。
  let interactive = false  // 当前交互态：主进程决策的回读，仅供锁钮/探针显示
  ctx.lastIgnore = true
  let winOrigin = { x: 0, y: 0 }   // overlay 窗原点（屏坐标）：客户区坐标 → 屏坐标换算
  let lastSentRects = ''
  /** elementFromPoint 等价的「可命中」检测：隐藏按钮（opacity:0+pointer-events:none）与收起的卡片（visibility/display）一律不占解锁区。 */
  function hitTestable(el) {
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.pointerEvents !== 'none'
  }
  const toScreenRect = (r) => ({
    x: Math.round(r.left + winOrigin.x), y: Math.round(r.top + winOrigin.y),
    w: Math.round(r.width), h: Math.round(r.height),
  })
  function collectRects() {
    const b = ctx.modelBounds?.()
    let model = null
    if (b && b.width > 0) {
      const r = ctx.app.view.getBoundingClientRect()
      model = {
        x: Math.round(r.left + b.x - HOVER_MARGIN + winOrigin.x),
        y: Math.round(r.top + b.y - HOVER_MARGIN + winOrigin.y),
        w: Math.round(b.width + HOVER_MARGIN * 2),
        h: Math.round(b.height + HOVER_MARGIN * 2),
      }
    }
    const ui = []
    for (const el of document.querySelectorAll(UI_SELECTOR)) {
      if (!hitTestable(el)) continue
      ui.push(toScreenRect(el.getBoundingClientRect()))
    }
    return { model, ui, pinned: !!ctx.pinned, dragging }
  }
  function syncRects() {
    if (!BRIDGE?.pushRects) return   // 旧桥缺该接口时静默（独立宿主未升级等场景）
    const next = JSON.stringify(collectRects())
    if (next === lastSentRects) return
    lastSentRects = next
    BRIDGE.pushRects(JSON.parse(next))
  }
  /** 穿透评估（兼容旧调用点）：矩形集维护 + 变化上报；判定本体在主进程。 */
  ctx.evalIgnore = () => {
    if (!BRIDGE) return
    syncRects()
  }
  // 矩形集保鲜轮询：模型/按钮位置可能经「无事件路径」变化（呼吸动画、切换动画、
  // 扩展操纵、拖拽冲刷后的收敛），事件驱动的 evalIgnore 调用点覆盖不到这些帧。
  // 150ms 差分轮询兜底——无变化时 stringify 对比即返回，成本可忽略
  setInterval(() => syncRects(), 150)
  // 状态迁移回推：锁钮三态与调试探针的数据源（决策结果以主进程为准）
  let lastDwellFrom = null
  BRIDGE?.onInteractState?.((state) => {
    interactive = !!state?.interactive
    ctx.lastIgnore = !interactive
    lastDwellFrom = state?.dwell ?? null
    ctx.syncPinBtn?.()
  })
  // 调试探针：穿透状态机快照（interactive/from 为主进程决策回推；lp 为渲染层最近光标）
  ctx.dwellDebug = () => ({ timing: lastDwellFrom !== null, from: lastDwellFrom, interactive, lp: lastPointer })

  // 真实输入时间戳 + 心跳：主进程行为核验的证据源。穿透态下事件不达、时间戳
  // 停走，恰是「穿透生效」的证据；交互态下光标一动必然刷新（详见 passthrough.cjs）
  let lastInputAt = 0
  const markInput = () => { lastInputAt = Date.now() }
  for (const type of ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown']) {
    window.addEventListener(type, markInput, { capture: true, passive: true })
  }
  setInterval(() => BRIDGE?.heartbeat?.(lastInputAt), 2000)

  // ── 忙碌拦截：8 秒冷却，避免刷屏 ──
  let busyQuipAt = 0
  let wokeAt = 0
  function busyBlock() {
    const now = performance.now()
    if (now - busyQuipAt > 8000) {
      busyQuipAt = now
      ctx.showBubble(quip('busy'), 2000, 2)
    }
  }

  /** 点击反应：随机播放点击池动作，50% 概率搭一句吐槽。 */
  function clickReact(wokeFromSleep = false) {
    // 睡眠时点击=唤醒+专属台词（PR#3）；pokeActivity 的静默唤醒让位给有台词版
    if (wokeFromSleep || ctx.getState() === 'sleeping') {
      if (ctx.getState() === 'sleeping') ctx.enter('idle')
      wokeAt = performance.now()
      ctx.showBubble('唔......你回来啦？', 2200, 2)
      return
    }
    // 双击会产生第二次 pointerup；刚唤醒后短暂吞掉普通点击，避免连续冒两句。
    if (performance.now() - wokeAt < 600) return
    ctx.pokeActivity?.()   // 用户活动=重置睡眠计时
    if (ctx.busy()) { busyBlock(); return }
    const pool = ctx.binding.clickPool
    if (pool.length > 0) {
      const [g, i] = pool[Math.floor(Math.random() * pool.length)]
      ctx.model.motion(g, i).catch(() => { })
    }
    if (Math.random() < 0.5) ctx.showBubble(quip('click'), 1500, 2)
  }

  // ── 摸头：仅点击头部 30% 区域触发害羞，2 秒冷却 ──
  let patAt = 0
  let patRestore = 0
  function tryPat(clientX, clientY) {
    // 睡眠时任意点击都应优先唤醒；点击头部不能被摸头逻辑截走。
    if (ctx.getState() === 'sleeping') { clickReact(); return true }
    ctx.pokeActivity?.()   // 用户活动=重置睡眠计时
    const r = ctx.app.view.getBoundingClientRect()
    const b = ctx.modelBounds()
    const x = clientX - r.left
    const y = clientY - r.top
    const inHead = x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height * 0.3
    if (!inHead) return false
    // 忙碌时点击头部仍属于摸头，但静默忽略，不回落成普通点击提示。
    if (ctx.busy()) return true
    const now = performance.now()
    if (now - patAt > 2000) {
      patAt = now
      ctx.setExpr('shy')
      ctx.showBubble(quip('pat'), 1800, 2)
      clearTimeout(patRestore)
      patRestore = setTimeout(() => ctx.setExpr(ctx.stateExpr()), 1800)
    }
    return true
  }

  // 窗口内指针：只做视线跟随与穿透评估；悬停不触发任何互动。
  window.addEventListener('pointermove', (e) => {
    lastPointer = { x: e.clientX, y: e.clientY }
    const r = ctx.app.view.getBoundingClientRect()
    ctx.model.focus(e.clientX - r.left, e.clientY - r.top)
    ctx.evalIgnore()
  })

  // 桌宠全局视线：主进程轮询 OS 光标坐标，换算为窗内坐标（整屏追踪）
  // 同时充当穿透评估的坐标保鲜源：指针静止/移到副屏时 window 级 pointermove 不再来，
  // 没有这路喂给，停留计时会在指针实际已离开的情况下误放行
  // 首帧位置主动拉取：轮询只推「变化」，页面加载前的首帧推送会被丢弃
  // 按钮显隐的进出迁移沿（穿透态下 forwarded 事件不进 box，改由轮询驱动，
  // 否则穿透模式下 ⚙/穿透 钮永远隐身再也点不到；只在迁移沿触发，防定时器被反复重置）
  let wasInside = false

  // 卫星窗死区已随单源决策上收主进程（pushCardArea → passthrough.setCardAreas），
  // 渲染层不再自行判定卡片区域——光标在卡片上时 overlay 恒穿透由主进程保证。

  if (BRIDGE && BRIDGE.onCursor) {
    BRIDGE.onCursor((data) => {
      winOrigin = { x: data.bounds.x, y: data.bounds.y }
      ctx.lastGaze = { x: data.x - data.bounds.x, y: data.y - data.bounds.y }
      ctx.model.focus(ctx.lastGaze.x, ctx.lastGaze.y)
      lastPointer = { x: ctx.lastGaze.x, y: ctx.lastGaze.y }
      ctx.evalIgnore()
      // 「在内」= 模型邻近区 或 任一 UI 控件上（悬在菜单/卡片上时不算离开，防误收）
      const nowInside = insideModel(lastPointer.x, lastPointer.y) || uiHit()
      if (nowInside !== wasInside) {
        wasInside = nowInside
        if (nowInside) ctx.showChrome?.()
        else ctx.hideChrome?.()
      }
    })
    BRIDGE.getCursor?.().then((data) => {
      if (!data) return
      winOrigin = { x: data.bounds.x, y: data.bounds.y }   // 首帧窗口原点：矩形集上报的换算基准
      ctx.lastGaze = { x: data.x - data.bounds.x, y: data.y - data.bounds.y }
      ctx.model.focus(ctx.lastGaze.x, ctx.lastGaze.y)
      ctx.evalIgnore()   // 加载后首次上报：决策器的矩形集就绪前恒穿透（安全默认）
    }).catch(() => { })
  }

  // ── 拖拽：挂件=DOM 位移（带边界钳制与位置记忆）；桌宠=IPC 移动窗口 ──
  // 桌宠拖拽期间冻结穿透评估，避免窗口跟随导致松手事件丢失（粘手事故教训）
  let draggingAt = 0        // 拖拽最近活跃时刻（pointerdown/move 刷新）：悬挂看门狗计时基准
  let forceEndDrag = null   // 分支内的 endDrag 句柄：看门狗强制收尾用
  if (!PET) {
    let drag = null
    box.addEventListener('pointerdown', (e) => {
      const wokeFromSleep = ctx.getState() === 'sleeping'
      ctx.pokeActivity?.()
      drag = { x: e.clientX, y: e.clientY, rect: box.getBoundingClientRect(), moved: false, wokeFromSleep }
      box.setPointerCapture(e.pointerId)
    })
    box.addEventListener('pointermove', (e) => {
      if (!drag) return
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      if (!drag.moved && Math.hypot(dx, dy) > 6) {
        drag.moved = true
        box.style.cursor = 'grabbing'
        ctx.setExpr('shy')
        if (Math.random() < 0.5) ctx.showBubble(quip('drag'), 1500, 2)
      }
      if (drag.moved) {
        const nx = Math.min(Math.max(drag.rect.left + dx, -BASE_W / 2), window.innerWidth - BASE_W / 3)
        const ny = Math.min(Math.max(drag.rect.top + dy, 0), window.innerHeight - BASE_H / 3)
        box.style.left = nx + 'px'
        box.style.top = ny + 'px'
        box.style.right = 'auto'
        box.style.bottom = 'auto'
      }
    })
    const endDrag = (e) => {
      if (!drag) return
      if (drag.moved) {
        store.setPos({ x: parseFloat(box.style.left), y: parseFloat(box.style.top) })
        box.style.cursor = 'grab'
        ctx.setExpr(ctx.stateExpr())
      } else if (e) {
        // 未拖动的点击：先判摸头（头部 30%），否则普通点击反应
        if (drag.wokeFromSleep) clickReact(true)
        else if (!tryPat(e.clientX, e.clientY)) clickReact()
      }
      drag = null
      ctx.evalIgnore()   // 收尾补判：盒子位移后矩形集（模型包围盒）立即上报
    }
    box.addEventListener('pointerup', (e) => endDrag(e))
    // 触屏 pointercancel / 窗口失焦也要收尾，否则 drag 悬挂成悬空拖动
    box.addEventListener('pointercancel', () => endDrag())
    window.addEventListener('blur', () => endDrag())
    forceEndDrag = () => endDrag()
  } else if (BRIDGE) {
    let drag = null
    // overlay-pet 拖拽：桌宠窗口铺满主屏、永不移动（透明窗呈现丢帧的触发条件
    // 「按住鼠标的物理消息流 × 窗口移动」在架构上不存在），模型在画布内 1:1
    // 跟手——没有锚定、没有接力、没有笼子。松手只记位置（画布坐标），窗口
    // 从头到尾纹丝不动。位移按动画帧合并冲刷，频率封顶刷新率。
    let movePending = false
    const flushMove = () => {
      movePending = false
      if (!drag) return
      let dx = drag.curX - drag.flushX
      let dy = drag.curY - drag.flushY
      if (dx === 0 && dy === 0) return
      drag.flushX = drag.curX
      drag.flushY = drag.curY
      // 钳在屏幕边界内（允许半身探出），呼吸动画的包围盒波动仅影响边缘 1-2px
      const b = ctx.modelBounds()
      const ow = b.width * 0.5
      const oh = b.height * 0.5
      dx = Math.min(Math.max(dx, -ow - b.x), window.innerWidth - (b.x + b.width) + ow)
      dy = Math.min(Math.max(dy, -oh - b.y), window.innerHeight - (b.y + b.height) + oh)
      if (dx === 0 && dy === 0) return
      ctx.model.x += dx
      ctx.model.y += dy
    }
    const endDrag = (e) => {
      if (!drag) return
      flushMove()  // 收尾冲刷：指针停在最后一帧的位移不丢
      if (drag.moved) {
        // 位置记忆 = 模型中心画布坐标（overlay 架构：窗口永不动，模型即位置）
        const b = ctx.modelBounds()
        store.setPetPos({ cx: b.x + b.width / 2, cy: b.y + b.height / 2 })
        ctx.setExpr(ctx.stateExpr())
      } else if (e?.type === 'pointerup') {
        if (drag.wokeFromSleep) clickReact(true)
        else if (!tryPat(e.clientX, e.clientY)) clickReact()
      }
      drag = null
      dragging = false
      ctx.evalIgnore()   // 松手即补判：拖拽冻结解除后矩形集（含 dragging 标志）立即上报
    }
    box.addEventListener('pointerdown', (e) => {
      const wokeFromSleep = ctx.getState() === 'sleeping'
      ctx.pokeActivity?.()
      drag = { x: e.screenX, y: e.screenY, curX: e.screenX, curY: e.screenY, flushX: e.screenX, flushY: e.screenY, moved: false, wokeFromSleep }
      dragging = true
      draggingAt = Date.now()
      box.setPointerCapture(e.pointerId)
      ctx.evalIgnore()   // 拖拽冻结标志立即上报：主进程判定冻结依赖它
    })
    box.addEventListener('pointermove', (e) => {
      if (!drag) return
      drag.curX = e.screenX
      drag.curY = e.screenY
      draggingAt = Date.now()   // 拖拽活跃证明：悬挂看门狗的计时基准
      if (!drag.moved && Math.hypot(drag.curX - drag.x, drag.curY - drag.y) > 4) {
        drag.moved = true
        ctx.setExpr('shy')
        if (Math.random() < 0.5) ctx.showBubble(quip('drag'), 1500, 2)
      }
      if (drag.moved && !movePending) {
        movePending = true
        requestAnimationFrame(flushMove)
      }
    })
    box.addEventListener('pointerup', endDrag)
    box.addEventListener('pointercancel', endDrag)
    window.addEventListener('blur', () => {
      if (drag?.moved) {
        const b = ctx.modelBounds()
        store.setPetPos({ cx: b.x + b.width / 2, cy: b.y + b.height / 2 })
      }
      drag = null
      dragging = false
      ctx.evalIgnore()   // blur 兜底收尾同样补判（穿透窗上 blur 可能收不到，看门狗兜底）
    })
    forceEndDrag = () => endDrag()
  } else {
    box.addEventListener('pointerup', (e) => { if (!tryPat(e.clientX, e.clientY)) clickReact() })
  }

  // 拖拽悬挂看门狗：>30s 无 pointerup/pointermove 即强制收尾并补判穿透。
  // 穿透窗永不聚焦收不到 blur（Linux 上尤甚），这是 blur 兜底失效后的最后保险
  setInterval(() => {
    if (!dragging || forceEndDrag === null || Date.now() - draggingAt <= 30000) return
    console.error('[l2d] drag stale >30s, force endDrag')
    BRIDGE?.reportError?.('[l2d] drag stale >30s, force endDrag (dragging since ' + new Date(draggingAt).toISOString() + ')')
    forceEndDrag()
    dragging = false
    ctx.evalIgnore()
  }, 5000)

  // 双击：兴奋脸 + 兴奋动作卖萌
  box.addEventListener('dblclick', () => {
    if (ctx.busy()) { busyBlock(); return }
    ctx.setExpr('excited')
    ctx.playMotion('excited')
    ctx.showBubble(quip('click'), 1500, 2)
    setTimeout(() => ctx.setExpr(ctx.stateExpr()), 2500)
  })

  // 滚轮缩放：delta 比例因子（Chromium 会把一格滚轮拆成多个事件）
  // 两道防误触：① 拖拽期间锁缩放（触控板拖动手势易夹带 wheel）
  // ② 桌宠形态仅 Ctrl+滚轮缩放（触控板滚动漂移是普通 wheel，彻底免疫；
  //    误触一旦持久化会重启沿用——闸死入口即根治）；网页挂件保留普通滚轮
  let scaleSaveTimer = 0
  box.addEventListener('wheel', (e) => {
    e.preventDefault()
    if (dragging) return
    if (BRIDGE && !e.ctrlKey) return
    ctx.targetScale = Math.min(2.5, Math.max(0.4, ctx.targetScale * Math.exp(-e.deltaY * 0.0012)))
    // 防抖落盘：一格滚轮=一串事件，逐事件写 localStorage 是写盘放大
    clearTimeout(scaleSaveTimer)
    scaleSaveTimer = setTimeout(() => store.setScale(ctx.targetScale), 300)
  }, { passive: false })
}
