/**
 * interact.js —— 交互层。
 *
 * 覆盖：点击反应（clickPool 随机动作）、双击卖萌、摸头（头部 30% 区域）、
 * 拖拽（挂件=DOM 位移 / 桌宠=IPC 移窗）、滚轮缩放、指针穿透评估、
 * 全局视线跟随（桌宠=主进程光标轮询 IPC / 挂件=窗口内 pointermove）。
 * 忙碌时（ctx.busy()）点击与双击被拦截为 busy 台词，摸头静默无视。
 */

import { PET, BRIDGE, BASE_W, BASE_H, store, quip } from './config.js'

/** 悬停穿透判定在模型包围盒外扩的像素余量（滚轮缩放不至于出框即失效）。 */
const HOVER_MARGIN = 48

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
    return !!(el && el.closest('#l2d-model-toggle, #l2d-pet-menu, #l2d-model-panel, #l2d-help-card, #l2d-viewer, #l2d-chat-toggle, #l2d-chat-panel, #l2d-quips-card'))
  }

  /** 指针穿透评估：指针在模型包围盒（含余量）或面板控件上才接收事件，否则镂空让桌面。 */
  ctx.evalIgnore = () => {
    if (!BRIDGE || lastPointer === null || dragging) return
    const r = ctx.app.view.getBoundingClientRect()
    const b = ctx.modelBounds()
    const x = lastPointer.x - r.left
    const y = lastPointer.y - r.top
    const inside = x >= b.x - HOVER_MARGIN && x <= b.x + b.width + HOVER_MARGIN
      && y >= b.y - HOVER_MARGIN && y <= b.y + b.height + HOVER_MARGIN
    ctx.lastIgnore = !(inside || uiHit())  // 暴露给调试探针
    BRIDGE.setIgnore(ctx.lastIgnore)
  }

  // ── 忙碌拦截：8 秒冷却，避免刷屏 ──
  let busyQuipAt = 0
  function busyBlock() {
    const now = performance.now()
    if (now - busyQuipAt > 8000) {
      busyQuipAt = now
      ctx.showBubble(quip('busy'), 2000)
    }
  }

  /** 点击反应：随机播放点击池动作，50% 概率搭一句吐槽。 */
  function clickReact() {
    if (ctx.busy()) { busyBlock(); return }
    const pool = ctx.binding.clickPool
    if (pool.length > 0) {
      const [g, i] = pool[Math.floor(Math.random() * pool.length)]
      ctx.model.motion(g, i).catch(() => { })
    }
    if (Math.random() < 0.5) ctx.showBubble(quip('click'), 1500)
  }

  // ── 摸头：头部 30% 区域划过触发害羞，2 秒冷却 ──
  let patAt = 0
  let patRestore = 0
  function tryPat(clientX, clientY) {
    if (ctx.busy()) return
    const r = ctx.app.view.getBoundingClientRect()
    const b = ctx.modelBounds()
    const x = clientX - r.left
    const y = clientY - r.top
    const inHead = x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height * 0.3
    const now = performance.now()
    if (inHead && now - patAt > 2000) {
      patAt = now
      ctx.setExpr('shy')
      ctx.showBubble(quip('pat'), 1800)
      clearTimeout(patRestore)
      patRestore = setTimeout(() => ctx.setExpr(ctx.stateExpr()), 1800)
    }
  }

  // 窗口内指针：视线跟随 + 穿透评估 + 摸头判定
  window.addEventListener('pointermove', (e) => {
    lastPointer = { x: e.clientX, y: e.clientY }
    const r = ctx.app.view.getBoundingClientRect()
    ctx.model.focus(e.clientX - r.left, e.clientY - r.top)
    ctx.evalIgnore()
    tryPat(e.clientX, e.clientY)
  })

  // 桌宠全局视线：主进程轮询 OS 光标坐标，换算为窗内坐标（整屏追踪）
  // 首帧位置主动拉取：轮询只推「变化」，页面加载前的首帧推送会被丢弃
  if (BRIDGE && BRIDGE.onCursor) {
    BRIDGE.onCursor((data) => {
      ctx.lastGaze = { x: data.x - data.bounds.x, y: data.y - data.bounds.y }
      ctx.model.focus(ctx.lastGaze.x, ctx.lastGaze.y)
    })
    BRIDGE.getCursor?.().then((data) => {
      if (!data) return
      ctx.lastGaze = { x: data.x - data.bounds.x, y: data.y - data.bounds.y }
      ctx.model.focus(ctx.lastGaze.x, ctx.lastGaze.y)
    }).catch(() => { })
  }

  // ── 拖拽：挂件=DOM 位移（带边界钳制与位置记忆）；桌宠=IPC 移动窗口 ──
  // 桌宠拖拽期间冻结穿透评估，避免窗口跟随导致松手事件丢失（粘手事故教训）
  if (!PET) {
    let drag = null
    box.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, rect: box.getBoundingClientRect(), moved: false }
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
        if (Math.random() < 0.5) ctx.showBubble(quip('drag'), 1500)
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
    box.addEventListener('pointerup', () => {
      if (!drag) return
      if (drag.moved) {
        store.setPos({ x: parseFloat(box.style.left), y: parseFloat(box.style.top) })
        box.style.cursor = 'grab'
        ctx.setExpr(ctx.stateExpr())
      } else {
        clickReact()
      }
      drag = null
    })
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
    const endDrag = () => {
      if (!drag) return
      flushMove()  // 收尾冲刷：指针停在最后一帧的位移不丢
      if (drag.moved) {
        // 位置记忆 = 模型中心画布坐标（overlay 架构：窗口永不动，模型即位置）
        const b = ctx.modelBounds()
        store.setPetPos({ cx: b.x + b.width / 2, cy: b.y + b.height / 2 })
        ctx.setExpr(ctx.stateExpr())
      } else {
        clickReact()
      }
      drag = null
      dragging = false
    }
    box.addEventListener('pointerdown', (e) => {
      drag = { x: e.screenX, y: e.screenY, curX: e.screenX, curY: e.screenY, flushX: e.screenX, flushY: e.screenY, moved: false }
      dragging = true
      box.setPointerCapture(e.pointerId)
    })
    box.addEventListener('pointermove', (e) => {
      if (!drag) return
      drag.curX = e.screenX
      drag.curY = e.screenY
      if (!drag.moved && Math.hypot(drag.curX - drag.x, drag.curY - drag.y) > 4) {
        drag.moved = true
        ctx.setExpr('shy')
        if (Math.random() < 0.5) ctx.showBubble(quip('drag'), 1500)
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
    })
  } else {
    box.addEventListener('pointerup', () => clickReact())
  }

  // 双击：兴奋脸 + 兴奋动作卖萌
  box.addEventListener('dblclick', () => {
    if (ctx.busy()) { busyBlock(); return }
    ctx.setExpr('excited')
    ctx.playMotion('excited')
    ctx.showBubble(quip('click'), 1500)
    setTimeout(() => ctx.setExpr(ctx.stateExpr()), 2500)
  })

  // 滚轮缩放：delta 比例因子（Chromium 会把一格滚轮拆成多个事件）
  // 两道防误触：① 拖拽期间锁缩放（触控板拖动手势易夹带 wheel）
  // ② 桌宠形态仅 Ctrl+滚轮缩放（触控板滚动漂移是普通 wheel，彻底免疫；
  //    误触一旦持久化会重启沿用——闸死入口即根治）；网页挂件保留普通滚轮
  box.addEventListener('wheel', (e) => {
    e.preventDefault()
    if (dragging) return
    if (BRIDGE && !e.ctrlKey) return
    ctx.targetScale = Math.min(2.5, Math.max(0.4, ctx.targetScale * Math.exp(-e.deltaY * 0.0012)))
    store.setScale(ctx.targetScale)
  }, { passive: false })
}
