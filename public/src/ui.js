/**
 * ui.js —— DOM 层：挂件容器、气泡、状态灯。
 *
 * initUI 只搭骨架并挂载 ctx.showBubble / ctx.setLamp；
 * 气泡锚定依赖 ctx.model（stage 模块加载完成后才有），首次调用必然晚于模型就绪。
 */

import { PET, BASE_W, BASE_H, store } from './config.js'

/** 状态灯视觉表：颜色 / 文案 / CSS 动画（pulse=呼吸、blink=急促闪烁、breathe=睡眠慢呼吸）。 */
const STATE_LAMP = {
  offline: { color: '#ef4444', label: '离线中', anim: '' },
  idle: { color: '#4ade80', label: '闲置中', anim: '' },
  thinking: { color: '#60a5fa', label: '思考中', anim: 'l2d-pulse 1.6s infinite' },
  working: { color: '#fb923c', label: '工作中', anim: 'l2d-pulse 1.1s infinite' },
  waiting: { color: '#facc15', label: '待确认!', anim: 'l2d-blink 0.9s infinite' },
  error: { color: '#c084fc', label: '卡壳中…', anim: 'l2d-blink 0.5s infinite' },
  done: { color: '#22d3ee', label: '完成啦~', anim: '' },
  sleeping: { color: '#9ca3af', label: '打瞌睡…', anim: 'l2d-breathe 3.5s infinite' },
}

/**
 * 创建容器/气泡/状态灯并挂到 ctx。
 * @param {Object} ctx 共享上下文（写入 box、showBubble、setLamp、getLastBubbleAt）
 */
export function initUI(ctx) {
  // ── 容器：挂件为固定尺寸浮窗（带位置记忆与边界钳制），桌宠铺满透明窗口 ──
  const box = document.createElement('div')
  box.id = 'l2d-companion'
  if (PET) {
    Object.assign(box.style, { position: 'fixed', inset: '0', zIndex: 1, touchAction: 'none', userSelect: 'none' })
  } else {
    Object.assign(box.style, {
      position: 'fixed', zIndex: 9999, width: BASE_W + 'px', height: BASE_H + 'px',
      touchAction: 'none', userSelect: 'none', cursor: 'grab',
    })
    const clampX = (x) => Math.min(Math.max(x, -BASE_W / 2), window.innerWidth - BASE_W / 3)
    const clampY = (y) => Math.min(Math.max(y, 0), window.innerHeight - BASE_H / 3)
    const pos = store.getPos()
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      box.style.left = clampX(pos.x) + 'px'
      box.style.top = clampY(pos.y) + 'px'
    } else {
      box.style.right = '16px'
      box.style.bottom = '0'
    }
  }
  document.body.appendChild(box)
  ctx.box = box

  // ── 气泡：锚定模型头顶，translate 动画进出，自动消隐 ──
  const bubble = document.createElement('div')
  Object.assign(bubble.style, {
    position: 'absolute', padding: '6px 14px', borderRadius: '14px',
    background: 'rgba(255,255,255,.95)', color: '#334', font: '13px/1.5 sans-serif',
    whiteSpace: 'normal', width: 'max-content', maxWidth: 'min(300px, calc(100vw - 16px))',
    minWidth: '56px', maxHeight: '180px', boxSizing: 'border-box', textAlign: 'center',
    overflowWrap: 'anywhere', wordBreak: 'break-word', overflow: 'hidden',
    pointerEvents: 'none', opacity: '0',
    transform: 'translate(-50%,-100%) scale(.8)', transformOrigin: '50% 100%',
    transition: 'opacity .25s ease, transform .25s ease',
    boxShadow: '0 2px 12px rgba(0,0,0,.25)', zIndex: 2,
  })
  box.appendChild(bubble)

  let bubbleTimer = 0
  let lastBubbleAt = 0
  /** 当前气泡优先级：低级不抢高级。0=状态轮播 1=对局解说/思考 2=物理互动/任务完成/报错/操作反馈 */
  let bubblePriority = 0

  /** 气泡定位（钳制在可视区内）。 */
  function placeBubble(x, y) {
    const w = PET ? window.innerWidth : BASE_W
    const h = PET ? window.innerHeight : BASE_H
    const bw = Math.min(bubble.offsetWidth, Math.max(1, w - 16))
    const bh = Math.min(bubble.offsetHeight, Math.max(1, h - 16))
    const half = bw / 2 + 8
    bubble.style.left = Math.min(Math.max(x, half), Math.max(half, w - half)) + 'px'
    bubble.style.top = Math.min(Math.max(y, bh + 8), h - 8) + 'px'
  }

  /**
   * 显示气泡。空文本直接跳过。
   * @param {string} text 台词
   * @param {number} [holdMs=3500] 停留毫秒
   * @param {number} [priority=0] 优先级：低于当前在播气泡则丢弃；同级后来者居上
   * @returns {boolean} 是否播出
   */
  function showBubble(text, holdMs = 3500, priority = 0) {
    if (!text || !ctx.model) return false
    if (priority < bubblePriority) return false
    lastBubbleAt = performance.now()
    bubblePriority = priority
    const b = ctx.model.getBounds()
    const clean = String(text).replace(/\s+/g, ' ').trim()
    bubble.textContent = clean.length > 180 ? clean.slice(0, 179) + '…' : clean
    placeBubble(b.x + b.width / 2, b.y + b.height * 0.08)
    bubble.style.opacity = '1'
    bubble.style.transform = 'translate(-50%,-100%) scale(1)'
    clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(() => {
      bubble.style.opacity = '0'
      bubble.style.transform = 'translate(-50%,-100%) scale(.8)'
      bubblePriority = 0   // 播完回落，低级气泡恢复可播
    }, holdMs)
    return true
  }
  ctx.showBubble = showBubble
  ctx.getLastBubbleAt = () => lastBubbleAt

  // ── 状态灯：左上角迷你胶囊（灯珠 + 小字），pointerEvents:none 不抢交互 ──
  const lampStyle = document.createElement('style')
  lampStyle.textContent = '@keyframes l2d-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.8)}}@keyframes l2d-blink{0%,100%{opacity:1}50%{opacity:.15}}@keyframes l2d-breathe{0%,100%{opacity:.85}50%{opacity:.3}}'
  document.head.appendChild(lampStyle)
  const lamp = document.createElement('div')
  Object.assign(lamp.style, {
    position: 'absolute', top: '6px', left: '8px', display: 'flex', alignItems: 'center',
    gap: '5px', padding: '3px 8px', borderRadius: '8px', background: 'rgba(0,0,0,.35)',
    pointerEvents: 'none', zIndex: 2,
  })
  const lampDot = document.createElement('span')
  Object.assign(lampDot.style, { width: '7px', height: '7px', borderRadius: '50%', flexShrink: '0' })
  const lampLabel = document.createElement('span')
  lampLabel.id = 'l2d-state-label'
  Object.assign(lampLabel.style, { font: '10px/1 sans-serif', color: '#fff', whiteSpace: 'nowrap' })
  lamp.appendChild(lampDot)
  lamp.appendChild(lampLabel)
  box.appendChild(lamp)

  /** @param {string} s 状态名（缺表回退 idle 样式） */
  ctx.setLamp = (s) => {
    const L = STATE_LAMP[s] ?? STATE_LAMP.idle
    lampDot.style.background = L.color
    lampDot.style.boxShadow = `0 0 6px ${L.color}`
    lampDot.style.animation = L.anim
    lampLabel.textContent = L.label
  }
  /**
   * 注册/覆盖状态灯样式（扩展用）。自定义动画名需自行注入 @keyframes。
   * @param {string} name 状态名
   * @param {{color?:string, label?:string, anim?:string}} spec 浅合并进现有表
   */
  ctx.registerLamp = (name, spec) => { STATE_LAMP[name] = { ...STATE_LAMP[name], ...spec } }
  ctx.setLamp('idle')

  // ── 桌宠 UI 跟随：桌宠窗是模型的 PET_MARGIN 倍大（拖拽留白），状态灯/任务灯
  // 锚定模型左侧留白区而非容器角落，rAF 缓动跟随（拖拽时也随行）。
  // 实现见 sessBox 声明之后（引用顺序约束）──

  // ── 多任务指示灯：并行会话时每任务一枚小灯，列在主灯下方 ──
  // ≤1 个会话时隐藏（主灯即会话灯，不重复占地）；超过 8 个折叠为 +N
  const sessBox = document.createElement('div')
  Object.assign(sessBox.style, {
    position: 'absolute', top: '28px', left: '8px', display: 'flex', flexDirection: 'column',
    gap: '3px', pointerEvents: 'none', zIndex: 2,
  })
  box.appendChild(sessBox)

  /** 会话灯用的短状态文案（主灯文案偏卖萌，这里求紧凑）。 */
  const STATE_SHORT = {
    offline: '离线', idle: '闲置', thinking: '思考', working: '工作',
    waiting: '待确认', error: '卡壳', done: '完成', sleeping: '睡眠',
  }

  // 跟随灯挪到 sessBox 声明之后（原顺序靠 rAF 异步才躲过 TDZ，太侥幸）；
  // 页面隐藏时跳过位移计算——Electron 关掉了 backgroundThrottling，rAF 不休眠只能自己节育
  if (PET) {
    let lx = null
    let ly = null
    const followLamp = () => {
      if (!document.hidden) {
        const b = ctx.modelBounds?.()
        if (b && b.width > 0) {
          const lw = lamp.offsetWidth || 80
          const tx = Math.min(Math.max(b.x - lw - 8, 6), Math.max(6, window.innerWidth - lw - 8))
          const ty = Math.min(Math.max(b.y + 4, 6), Math.max(6, window.innerHeight - 60))
          if (lx === null) { lx = tx; ly = ty }
          lx += (tx - lx) * 0.3
          ly += (ty - ly) * 0.3
          lamp.style.left = Math.round(lx) + 'px'
          lamp.style.top = Math.round(ly) + 'px'
          sessBox.style.left = Math.round(lx) + 'px'
          sessBox.style.top = Math.round(ly + 22) + 'px'
        }
      }
      requestAnimationFrame(followLamp)
    }
    requestAnimationFrame(followLamp)
  }

  /**
   * 渲染每任务指示灯（宿主 sessions 帧驱动，stream 模块喂入）。
   * @param {Array<{n:number, state:string}>} list 编号升序的会话状态
   */
  ctx.setSessions = (list) => {
    sessBox.replaceChildren()
    if (!Array.isArray(list) || list.length <= 1) return
    const shown = list.slice(0, 8)
    for (const s of shown) {
      const L = STATE_LAMP[s.state] ?? STATE_LAMP.idle
      const chip = document.createElement('div')
      Object.assign(chip.style, {
        display: 'flex', alignItems: 'center', gap: '4px', padding: '2px 7px',
        borderRadius: '7px', background: 'rgba(0,0,0,.30)', width: 'fit-content',
      })
      const dot = document.createElement('span')
      Object.assign(dot.style, {
        width: '6px', height: '6px', borderRadius: '50%', flexShrink: '0',
        background: L.color, boxShadow: `0 0 5px ${L.color}`,
      })
      const text = document.createElement('span')
      Object.assign(text.style, { font: '9px/1 sans-serif', color: '#fff', whiteSpace: 'nowrap' })
      text.textContent = `任务${s.n}·${STATE_SHORT[s.state] ?? s.state}`
      chip.append(dot, text)
      sessBox.appendChild(chip)
    }
    if (list.length > shown.length) {
      const more = document.createElement('div')
      Object.assign(more.style, { font: '9px/1 sans-serif', color: 'rgba(255,255,255,.75)', padding: '2px 7px' })
      more.textContent = `+${list.length - shown.length} 个任务`
      sessBox.appendChild(more)
    }
  }
}
