(() => {
  if (window.__l2dCompanion) return
  window.__l2dCompanion = true

  const BASE = '/live2d'
  const PET = window.__L2D_PET__ === true
  const BRIDGE = window.__petBridge ?? null
  const MODEL_QUERY = new URLSearchParams(location.search).get('model')
  const BASE_W = 300
  const BASE_H = 400

  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = resolve
    s.onerror = () => reject(new Error('failed to load ' + src))
    document.head.appendChild(s)
  })

  const store = {
    getPos() { try { return JSON.parse(localStorage.getItem('l2d-pos')) } catch { return null } },
    setPos(v) { try { localStorage.setItem('l2d-pos', JSON.stringify(v)) } catch { } },
    getScale() { const v = parseFloat(localStorage.getItem(PET ? 'l2d-pet-scale' : 'l2d-scale')); return Number.isFinite(v) ? v : 1 },
    setScale(v) { try { localStorage.setItem(PET ? 'l2d-pet-scale' : 'l2d-scale', String(v)) } catch { } },
  }

  const DEFAULT_QUIPS = {
    thinking: ['思考中…'],
    working: ['工作中…!'],
    done: ['完成啦~'],
    waiting: ['主人，需要确认一下…'],
    error: ['唔…好像卡住了…'],
    overtime: ['还在努力…'],
    sleeping: ['(Zzz…)'],
    click: ['呀!'],
    pat: ['呜…'],
    drag: ['哇啊啊…'],
    greet: ['主人好呀~'],
    greet_morning: ['主人早上好~'],
    greet_night: ['还在忙呀…'],
    idle: ['好无聊呀…'],
    busy: ['咱正忙着呢…'],
  }
  let QUIPS = DEFAULT_QUIPS
  let ROTATION = { holdMs: 6000, intervalMs: 9000, doneHoldMs: 6500 }
  let BEHAVIOR = { sleepAfterMs: 300000, seriousAfterMs: 45000, overtimeAfterMs: 120000 }
  async function loadQuips() {
    try {
      const cfg = await (await fetch(BASE + '/quips.json', { cache: 'no-store' })).json()
      if (cfg && typeof cfg === 'object') {
        if (cfg.pools && typeof cfg.pools === 'object') {
          const pools = {}
          for (const [key, value] of Object.entries(cfg.pools)) {
            if (Array.isArray(value) && value.length > 0 && value.every((s) => typeof s === 'string')) pools[key] = value
          }
          QUIPS = { ...DEFAULT_QUIPS, ...pools }
        }
        if (cfg.rotation && typeof cfg.rotation === 'object') ROTATION = { ...ROTATION, ...cfg.rotation }
        if (cfg.behavior && typeof cfg.behavior === 'object') BEHAVIOR = { ...BEHAVIOR, ...cfg.behavior }
      }
    } catch { }
  }
  const quip = (kind) => {
    const pool = QUIPS[kind]
    return pool && pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : ''
  }

  // ── 语义槽位绑定层：profile.json 精确覆盖 → .model3.json 自动嗅探 → 缺槽静默跳过 ──
  const SNIFF_EXPR = {
    default: ['default', 'normal', '通常'],
    happy: ['happy', 'smile', 'joy', '开心', '喜悦', '笑'],
    excited: ['kirakira', 'excited', 'star'],
    shy: ['shy', 'blush', '害羞'],
    doubt: ['doubt', 'think', 'confuse', '疑'],
    troubled: ['troubled', 'annoy', 'worry', '困扰', '为难'],
    serious: ['serious', '严肃'],
    surprised: ['surprise', '惊'],
    dark: ['dark', 'gloom', '阴沉'],
    sleep: ['sleep', '眠'],
  }
  const SNIFF_MOTION = {
    think: ['think', 'pose'],
    excited: ['wakuwaku', 'excited', 'joy'],
    shake: ['shake'],
    dizzy: ['dizzy'],
    nod: ['nod'],
    sleep: ['sleep'],
    glitch: ['glitch', 'effect'],
  }
  let BINDING = { expr: {}, motion: {}, clickPool: [] }

  function resolveBinding(modelJson, profile) {
    const refs = modelJson?.FileReferences ?? {}
    const exprAvail = (refs.Expressions ?? []).map((e) => e.Name).filter(Boolean)
    const motionGroups = refs.Motions ?? {}
    const out = { expr: {}, motion: {}, clickPool: [] }
    for (const [slot, keys] of Object.entries(SNIFF_EXPR)) {
      const fromProfile = profile?.expressions?.[slot]
      if (typeof fromProfile === 'string' && exprAvail.includes(fromProfile)) {
        out.expr[slot] = fromProfile
        continue
      }
      const hit = exprAvail.find((n) => keys.some((k) => n.toLowerCase().includes(k)))
      if (hit) out.expr[slot] = hit
    }
    if (!out.expr.default && exprAvail.length > 0) out.expr.default = exprAvail[0]
    const motionAt = (g, i) => Array.isArray(motionGroups[g]) && motionGroups[g][i] ? true : false
    for (const [slot, keys] of Object.entries(SNIFF_MOTION)) {
      const fromProfile = profile?.motions?.[slot]
      if (Array.isArray(fromProfile) && motionAt(fromProfile[0], fromProfile[1])) {
        out.motion[slot] = [fromProfile[0], fromProfile[1]]
        continue
      }
      outer:
      for (const [g, arr] of Object.entries(motionGroups)) {
        for (let i = 0; i < arr.length; i++) {
          const f = String(arr[i].File ?? '').toLowerCase()
          if (keys.some((k) => f.includes(k))) {
            out.motion[slot] = [g, i]
            break outer
          }
        }
      }
    }
    if (!out.motion.think) {
      const pg = Object.keys(motionGroups).find((g) => g.toLowerCase().includes('pose'))
      if (pg) out.motion.think = [pg, 0]
    }
    const poolFromProfile = profile?.motions?.clickPool
    if (Array.isArray(poolFromProfile) && poolFromProfile.length > 0) {
      out.clickPool = poolFromProfile.filter((p) => Array.isArray(p) && motionAt(p[0], p[1])).map((p) => [p[0], p[1]])
    } else {
      const rg = Object.keys(motionGroups).find((g) => /reaction|tap/i.test(g))
      if (rg) {
        out.clickPool = motionGroups[rg]
          .map((entry, i) => [rg, i, String(entry.File ?? '')])
          .filter(([, , f]) => !/angry/i.test(f))
          .map(([g, i]) => [g, i])
      }
    }
    return out
  }

  async function loadBinding(modelPath) {
    const dir = modelPath.split('/').slice(0, -1).join('/')
    let modelJson = null
    let profile = null
    try { modelJson = await (await fetch(`${BASE}/model/${modelPath}`, { cache: 'no-store' })).json() } catch { }
    try { profile = await (await fetch(`${BASE}/model/${dir}/profile.json`, { cache: 'no-store' })).json() } catch { }
    return resolveBinding(modelJson, profile)
  }

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

  const STATE_DEF = {
    offline: { expr: 'dark' },
    thinking: { expr: 'doubt', motion: 'think', pool: 'thinking', rotate: true },
    working: { expr: 'excited', motion: 'excited', pool: 'working', rotate: true, remotionMs: 22000 },
    waiting: { expr: 'doubt', motion: 'shake', pool: 'waiting', rotate: true, remotionMs: 16000 },
    error: { expr: 'troubled', motion: 'dizzy', pool: 'error', rotate: true, transientMs: 4500, then: 'thinking' },
    done: { expr: 'happy', motion: 'nod', pool: 'done', transientMs: 6000, then: 'idle' },
    sleeping: { expr: 'sleep', motion: 'sleep', pool: 'sleeping', rotate: true },
    idle: { expr: 'default' },
  }

  async function main() {
    await loadQuips()
    await loadScript(BASE + '/vendor/pixi.min.js')
    await loadScript(BASE + '/vendor/live2dcubismcore.min.js')
    await loadScript(BASE + '/vendor/pixi-live2d-cubism4.min.js')

    const box = document.createElement('div')
    box.id = 'l2d-companion'
    if (PET) {
      Object.assign(box.style, { position: 'fixed', inset: '0', zIndex: 1 })
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

    const bubble = document.createElement('div')
    Object.assign(bubble.style, {
      position: 'absolute', padding: '6px 14px', borderRadius: '14px',
      background: 'rgba(255,255,255,.95)', color: '#334', font: '13px/1.5 sans-serif',
      whiteSpace: 'nowrap', pointerEvents: 'none', opacity: '0',
      transform: 'translate(-50%,-100%) scale(.8)', transformOrigin: '50% 100%',
      transition: 'opacity .25s ease, transform .25s ease',
      boxShadow: '0 2px 12px rgba(0,0,0,.25)', zIndex: 2,
    })
    box.appendChild(bubble)

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
    function setLamp(s) {
      const L = STATE_LAMP[s] ?? STATE_LAMP.idle
      lampDot.style.background = L.color
      lampDot.style.boxShadow = `0 0 6px ${L.color}`
      lampDot.style.animation = L.anim
      lampLabel.textContent = L.label
    }
    setLamp('idle')

    let bubbleTimer = 0
    let lastBubbleAt = 0
    function placeBubble(x, y) {
      const w = PET ? window.innerWidth : BASE_W
      const h = PET ? window.innerHeight : BASE_H
      bubble.style.left = Math.min(Math.max(x, 80), w - 80) + 'px'
      bubble.style.top = Math.min(Math.max(y, 48), h - 16) + 'px'
    }
    function showBubble(text, holdMs = 3500) {
      if (!text) return
      lastBubbleAt = performance.now()
      const b = model.getBounds()
      placeBubble(b.x + b.width / 2, b.y + b.height * 0.08)
      bubble.textContent = text
      bubble.style.opacity = '1'
      bubble.style.transform = 'translate(-50%,-100%) scale(1)'
      clearTimeout(bubbleTimer)
      bubbleTimer = setTimeout(() => {
        bubble.style.opacity = '0'
        bubble.style.transform = 'translate(-50%,-100%) scale(.8)'
      }, holdMs)
    }

    const app = new PIXI.Application({
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    })
    app.view.style.width = '100%'
    app.view.style.height = '100%'
    app.view.style.display = 'block'
    box.appendChild(app.view)

    let modelPath = MODEL_QUERY
    if (!modelPath) {
      try {
        const cfg = await (await fetch(BASE + '/config', { cache: 'no-store' })).json()
        modelPath = cfg.model
      } catch { }
    }
    if (!modelPath) modelPath = 'nori/ARGNori.model3.json'
    BINDING = await loadBinding(modelPath)
    const model = await PIXI.live2d.Live2DModel.from(`${BASE}/model/${modelPath}`, { autoInteract: false })
    app.stage.addChild(model)
    const naturalW = model.internalModel.originalWidth
    const naturalH = model.internalModel.originalHeight

    let scale = store.getScale()
    let targetScale = scale

    let lastPointer = null
    let dragging = false
    const HOVER_MARGIN = 48
    const modelBounds = () => model.getBounds()
    function evalIgnore() {
      if (!BRIDGE || lastPointer === null || dragging) return
      const r = app.view.getBoundingClientRect()
      const b = modelBounds()
      const x = lastPointer.x - r.left
      const y = lastPointer.y - r.top
      const inside = x >= b.x - HOVER_MARGIN && x <= b.x + b.width + HOVER_MARGIN
        && y >= b.y - HOVER_MARGIN && y <= b.y + b.height + HOVER_MARGIN
      BRIDGE.setIgnore(!inside)
    }

    function layout() {
      const w = PET ? window.innerWidth : BASE_W
      const h = PET ? window.innerHeight : BASE_H
      app.renderer.resize(w, h)
      const s = Math.min(w / naturalW, h / naturalH) * 0.92 * (BRIDGE ? 1 : scale)
      model.scale.set(s)
      model.x = (w - model.width) / 2
      model.y = PET ? (h - model.height) : (h - model.height) / 2
    }
    layout()
    let petBaseW = 340
    let petBaseH = 460
    if (BRIDGE) {
      setTimeout(() => {
        const b = model.getBounds()
        if (b.width > 0 && b.height > 0) {
          petBaseW = Math.min(1200, Math.max(160, Math.round(petBaseH * (b.width / b.height))))
          BRIDGE.resizeTo(Math.round(petBaseW * scale), Math.round(petBaseH * scale))
        }
      }, 200)
    }
    window.addEventListener('resize', () => {
      layout()
      evalIgnore()
      if (!PET && box.style.left !== '') {
        box.style.left = Math.min(Math.max(parseFloat(box.style.left), -BASE_W / 2), window.innerWidth - BASE_W / 3) + 'px'
        box.style.top = Math.min(Math.max(parseFloat(box.style.top), 0), window.innerHeight - BASE_H / 3) + 'px'
      }
    })

    app.ticker.add(() => {
      const dt = app.ticker.deltaMS / 1000
      if (Math.abs(targetScale - scale) > 0.001) {
        scale += (targetScale - scale) * Math.min(1, dt * 7)
        if (BRIDGE) {
          BRIDGE.resizeTo(Math.round(petBaseW * scale), Math.round(petBaseH * scale))
          evalIgnore()
        } else {
          layout()
        }
      }
    })

    const setExpr = (slot) => {
      const name = slot ? BINDING.expr[slot] : undefined
      if (!name) return
      try { model.expression(name) } catch { }
    }
    const playMotion = (slot) => {
      const m = slot ? BINDING.motion[slot] : undefined
      if (!m) return
      model.motion(m[0], m[1]).catch(() => { })
    }

    // ── 状态机 ──────────────────────────────────────────────
    let state = 'idle'
    const busy = () => ['thinking', 'working', 'waiting', 'error'].includes(state)
    let stateSince = Date.now()
    let idleSince = Date.now()
    let rotateTimer = 0
    let remotionTimer = 0
    let transientTimer = 0
    let lastRawAt = 0

    const stateExpr = () => STATE_DEF[state]?.expr ?? 'default'

    function enter(next) {
      if (next === state) return
      const woke = state === 'sleeping' && next !== 'sleeping'
      state = next
      stateSince = Date.now()
      setLamp(next)
      clearInterval(rotateTimer)
      rotateTimer = 0
      clearInterval(remotionTimer)
      remotionTimer = 0
      clearTimeout(transientTimer)
      transientTimer = 0

      const def = STATE_DEF[next]
      if (!def) return
      if (next === 'idle') {
        idleSince = Date.now()
        setExpr(def.expr)
        return
      }
      if (woke) {
        setExpr('surprised')
        setTimeout(() => setExpr(stateExpr()), 1200)
      } else {
        setExpr(def.expr)
      }
      if (def.motion) {
        if (next === 'error' && Math.random() < 0.4 && BINDING.motion.glitch) playMotion('glitch')
        else playMotion(def.motion)
      }
      if (def.rotate) {
        showBubble(quip(def.pool), ROTATION.holdMs)
        rotateTimer = setInterval(() => {
          if (document.hidden) return
          if (next === 'working') {
            const elapsed = Date.now() - stateSince
            if (elapsed > BEHAVIOR.overtimeAfterMs) {
              setExpr('troubled')
              showBubble(quip('overtime'), ROTATION.holdMs)
              return
            }
            if (elapsed > BEHAVIOR.seriousAfterMs) setExpr('serious')
          }
          showBubble(quip(def.pool), ROTATION.holdMs)
        }, ROTATION.intervalMs)
      }
      if (def.remotionMs) {
        remotionTimer = setInterval(() => {
          if (!document.hidden && def.motion) playMotion(def.motion)
        }, def.remotionMs)
      }
      if (def.transientMs && def.then) {
        transientTimer = setTimeout(() => enter(def.then), def.transientMs)
      }
    }

    setInterval(() => {
      if (state === 'idle' && Date.now() - idleSince > BEHAVIOR.sleepAfterMs) enter('sleeping')
    }, 30000)

    // ── 交互 ────────────────────────────────────────────────
    let busyQuipAt = 0
    function busyBlock() {
      const now = performance.now()
      if (now - busyQuipAt > 8000) {
        busyQuipAt = now
        showBubble(quip('busy'), 2000)
      }
    }

    function clickReact() {
      if (busy()) { busyBlock(); return }
      const pool = BINDING.clickPool
      if (pool.length > 0) {
        const [g, i] = pool[Math.floor(Math.random() * pool.length)]
        model.motion(g, i).catch(() => { })
      }
      if (Math.random() < 0.5) showBubble(quip('click'), 1500)
    }

    let patAt = 0
    let patRestore = 0
    function tryPat(clientX, clientY) {
      if (busy()) return
      const r = app.view.getBoundingClientRect()
      const b = modelBounds()
      const x = clientX - r.left
      const y = clientY - r.top
      const inHead = x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height * 0.3
      const now = performance.now()
      if (inHead && now - patAt > 2000) {
        patAt = now
        setExpr('shy')
        showBubble(quip('pat'), 1800)
        clearTimeout(patRestore)
        patRestore = setTimeout(() => setExpr(stateExpr()), 1800)
      }
    }

    let lastGaze = null
    window.addEventListener('pointermove', (e) => {
      lastPointer = { x: e.clientX, y: e.clientY }
      const r = app.view.getBoundingClientRect()
      model.focus(e.clientX - r.left, e.clientY - r.top)
      evalIgnore()
      tryPat(e.clientX, e.clientY)
    })
    if (BRIDGE && BRIDGE.onCursor) {
      BRIDGE.onCursor((data) => {
        lastGaze = { x: data.x - data.bounds.x, y: data.y - data.bounds.y }
        model.focus(lastGaze.x, lastGaze.y)
      })
    }

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
          setExpr('shy')
          if (Math.random() < 0.5) showBubble(quip('drag'), 1500)
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
          setExpr(stateExpr())
        } else {
          clickReact()
        }
        drag = null
      })
    } else if (BRIDGE) {
      let drag = null
      const endDrag = () => {
        if (!drag) return
        if (drag.moved) setExpr(stateExpr())
        else clickReact()
        drag = null
        dragging = false
      }
      box.addEventListener('pointerdown', (e) => {
        drag = { x: e.screenX, y: e.screenY, moved: false }
        dragging = true
        box.setPointerCapture(e.pointerId)
      })
      box.addEventListener('pointermove', (e) => {
        if (!drag) return
        const dx = e.screenX - drag.x
        const dy = e.screenY - drag.y
        if (!drag.moved && Math.hypot(dx, dy) > 4) {
          drag.moved = true
          setExpr('shy')
          if (Math.random() < 0.5) showBubble(quip('drag'), 1500)
        }
        if (drag.moved) {
          BRIDGE.moveBy(dx, dy)
          drag.x = e.screenX
          drag.y = e.screenY
        }
      })
      box.addEventListener('pointerup', endDrag)
      box.addEventListener('pointercancel', endDrag)
      window.addEventListener('blur', () => { drag = null; dragging = false })
    } else {
      box.addEventListener('pointerup', () => clickReact())
    }

    box.addEventListener('dblclick', () => {
      if (busy()) { busyBlock(); return }
      setExpr('excited')
      playMotion('excited')
      showBubble(quip('click'), 1500)
      setTimeout(() => setExpr(stateExpr()), 2500)
    })

    box.addEventListener('wheel', (e) => {
      e.preventDefault()
      targetScale = Math.min(2.5, Math.max(0.4, targetScale * Math.exp(-e.deltaY * 0.0012)))
      store.setScale(targetScale)
    }, { passive: false })

    // ── 状态流（raw 事件优先，coarse 状态兜底） ──────────────
    function onRawEvent(ev) {
      lastRawAt = Date.now()
      switch (ev) {
        case 'turn/start': enter('thinking'); break
        case 'assistant/chunk': if (!busy()) enter('thinking'); break
        case 'tool/call':
        case 'tool-workflow/run-start':
        case 'subagent/descriptor': enter('working'); break
        case 'approval/asked': enter('waiting'); break
        case 'approval/decided': enter('working'); break
        case 'llm/retry-started': enter('error'); break
        case 'turn/end': enter('done'); break
      }
    }

    try {
      const es = new EventSource(BASE + '/state-stream')
      es.onerror = () => { lastRawAt = 0; enter('offline') }
      es.onmessage = (m) => {
        try {
          const data = JSON.parse(m.data)
          if (typeof data.ev === 'string') {
            onRawEvent(data.ev)
          } else if (typeof data.state === 'string' && Date.now() - lastRawAt > 10000) {
            if (data.state !== state) enter(data.state)
          }
        } catch { }
      }
    } catch { }

    if (BRIDGE && Math.abs(scale - 1) > 0.001) {
      BRIDGE.resizeTo(Math.round(340 * scale), Math.round(460 * scale))
    }

    const hour = new Date().getHours()
    const greetPool = hour >= 23 || hour < 5 ? 'greet_night' : hour >= 5 && hour < 11 ? 'greet_morning' : 'greet'
    showBubble(quip(greetPool), 4000)
    setInterval(() => {
      if (state === 'idle'
        && !document.hidden
        && performance.now() - lastBubbleAt > 60000
        && Math.random() < 0.5) {
        showBubble(quip('idle'), 3000)
      }
    }, 120000)

    setInterval(() => { if (!document.hidden) loadQuips() }, 30000)

    window.__l2d = {
      model, app, showBubble,
      enter,
      get state() { return state },
      get scale() { return scale },
      get targetScale() { return targetScale },
      get bounds() { const b = model.getBounds(); return { x: b.x, y: b.y, w: b.width, h: b.height } },
      get binding() { return BINDING },
      get gaze() { return lastGaze },
    }
    console.log('[l2d] companion ready')
  }

  main().catch((err) => console.error('[l2d] boot failed:', err))
})()
