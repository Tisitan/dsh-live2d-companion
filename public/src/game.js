// 五子棋对局卡：非模态浮窗（可拖动、不挡别的事）+ 解说走小人气泡（对局话语与桌宠同一声道）。
// 宿主路由 /live2d/game/* 驱动；roomy 恒开后挂件/桌宠两端一致。
import { BASE, STANDALONE } from './config.js'

const CELL = 32      // 格距 px
const MARGIN = 26    // 棋盘边距 px
const SIZE = 15

/**
 * 挂载对局 UI 并挂到 ctx（ctx.openGame 由面板菜单调用）。
 * @param {Object} ctx 共享上下文
 */
export function attachGame(ctx) {
  const style = document.createElement('style')
  style.textContent = `
#l2d-game {
  position: fixed; right: 24px; top: 24px; z-index: 99998; display: none;
  background: rgba(255,255,255,.97); border-radius: 16px;
  box-shadow: 0 16px 60px rgba(0,0,0,.35); overflow: hidden;
  font: 13px/1.6 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: #334;
}
#l2d-game.open { display: block; }
#l2d-game .l2d-game-head {
  display: flex; align-items: center; gap: 8px; padding: 10px 14px 8px;
  cursor: grab; user-select: none;
}
#l2d-game .l2d-game-head:active { cursor: grabbing; }
#l2d-game .l2d-game-title { font-size: 15px; font-weight: 700; color: #223; }
#l2d-game .l2d-game-chips { display: flex; gap: 6px; }
#l2d-game .l2d-game-chip {
  font: inherit; font-size: 12px; padding: 3px 12px; border-radius: 999px; cursor: pointer;
  border: 1px solid rgba(74,127,181,.45); background: #eef4fb; color: #345;
}
#l2d-game .l2d-game-chip.on { background: #4a7fb5; border-color: #4a7fb5; color: #fff; }
#l2d-game .l2d-game-chip:disabled { opacity: .55; cursor: default; }
/* 通用设置条：称呼/模式/预设/模型/难度一处管所有游戏（设置随游戏复用，不做多入口多层） */
#l2d-game .l2d-game-strip {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 14px; border-top: 1px solid rgba(0,0,0,.06); border-bottom: 1px solid rgba(0,0,0,.08);
}
#l2d-game .l2d-game-strip label { font-size: 12px; color: #778; }
#l2d-game .l2d-game-title-input {
  width: 72px; font: inherit; font-size: 12px; color: #334;
  border: 1px solid rgba(0,0,0,.14); border-radius: 8px; padding: 3px 6px; background: #fff;
}
#l2d-game .l2d-game-preset, #l2d-game .l2d-game-model, #l2d-game .l2d-game-mode, #l2d-game .l2d-game-diff {
  flex: 0 0 auto; max-width: 108px; font: inherit; font-size: 12px; color: #334;
  border: 1px solid rgba(0,0,0,.14); border-radius: 8px; padding: 3px 6px; background: #fff;
}
#l2d-game .l2d-game-new {
  font: inherit; font-size: 12.5px; padding: 4px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid rgba(74,127,181,.5); background: #eef4fb; color: #345;
}
#l2d-game .l2d-game-new:hover { background: #dfeaf7; }
#l2d-game .l2d-game-new:disabled { opacity: .5; cursor: default; }
#l2d-game .l2d-game-close {
  margin-left: auto; border: 0; background: none; font-size: 18px; color: #889; cursor: pointer; padding: 2px 6px;
}
#l2d-game .l2d-game-close:hover { color: #334; }
#l2d-game .l2d-game-body { display: flex; gap: 0; }
#l2d-game .l2d-game-stage { padding: 12px 0 12px 12px; }
#l2d-game canvas { display: block; border-radius: 10px; background: #f3e5c3; box-shadow: inset 0 0 0 1px rgba(120,90,40,.35); cursor: pointer; }
#l2d-game .l2d-game-side {
  width: 210px; display: flex; flex-direction: column; padding: 12px; gap: 8px;
  border-left: 1px solid rgba(0,0,0,.06);
}
#l2d-game .l2d-game-status { font-size: 13px; font-weight: 600; color: #456; min-height: 20px; }
#l2d-game .l2d-game-status.thinking { color: #4a7fb5; }
#l2d-game .l2d-game-status.win { color: #2ea043; }
#l2d-game .l2d-game-status.lose { color: #c0392b; }
#l2d-game .l2d-game-log {
  flex: 1; min-height: 160px; max-height: 380px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 5px; padding-right: 4px;
}
#l2d-game .l2d-game-msg { padding: 5px 9px; border-radius: 9px; font-size: 12px; line-height: 1.55; }
#l2d-game .l2d-game-msg.agent { background: #eef4fb; color: #345; align-self: flex-start; max-width: 95%; }
#l2d-game .l2d-game-msg.system { background: transparent; color: #99a; font-size: 11.5px; align-self: center; text-align: center; padding: 2px 6px; }
#l2d-game .l2d-game-hint { color: #aab; font-size: 11px; }
@media (max-width: 760px), (max-height: 620px) {
  #l2d-game { max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto; }
  #l2d-game .l2d-game-body { flex-direction: column; }
  #l2d-game .l2d-game-side { width: auto; min-height: 130px; border-left: 0; border-top: 1px solid rgba(0,0,0,.06); }
  #l2d-game canvas { width: min(500px, calc(100vw - 44px)); height: auto; }
}
`
  document.head.appendChild(style)

  const card = document.createElement('div')
  card.id = 'l2d-game'
  card.innerHTML = `
<div class="l2d-game-head">
  <span class="l2d-game-title">游戏中心</span>
  <div class="l2d-game-chips"></div>
  <button type="button" class="l2d-game-close" title="关闭">×</button>
</div>
<div class="l2d-game-strip">
  <label>称呼</label>
  <input class="l2d-game-title-input" maxlength="12" placeholder="主人" title="对手对你的称呼：注入在线提示词与离线解说" />
  <select class="l2d-game-mode" title="对弈模式：在线=你的 agent 执子（有解说）；离线=本地糯糯秒回">
    <option value="online">在线对弈</option>
    <option value="offline">离线速玩</option>
  </select>
  <select class="l2d-game-preset" title="对手人格：选择你的 agent 预设"></select>
  <select class="l2d-game-model" title="对手模型：来自 DSH 模型清单"></select>
  <select class="l2d-game-diff" title="难度：在线=提示词风格注入；离线=本地 AI 强度">
    <option value="easy">简单</option>
    <option value="normal" selected>普通</option>
    <option value="hard">困难</option>
  </select>
  <button type="button" class="l2d-game-new">新开一局</button>
</div>
<div class="l2d-game-body">
  <div class="l2d-game-stage"><canvas width="500" height="500"></canvas></div>
  <div class="l2d-game-side">
    <div class="l2d-game-status">加载中…</div>
    <div class="l2d-game-log"></div>
    <div class="l2d-game-hint">你执黑先手，点击交叉点落子；咱的解说会用气泡说给你听</div>
  </div>
</div>`
  document.body.appendChild(card)

  const canvas = card.querySelector('canvas')
  const g2d = canvas.getContext('2d')
  const statusEl = card.querySelector('.l2d-game-status')
  const logEl = card.querySelector('.l2d-game-log')
  const presetSelect = card.querySelector('.l2d-game-preset')
  const modelSelect = card.querySelector('.l2d-game-model')
  const modeSelect = card.querySelector('.l2d-game-mode')
  const diffSelect = card.querySelector('.l2d-game-diff')
  const titleInput = card.querySelector('.l2d-game-title-input')
  const chipsBox = card.querySelector('.l2d-game-chips')
  const newBtn = card.querySelector('.l2d-game-new')

  // ── 通用偏好持久化：称呼/模式/难度跨局记住，预设与模型跟随 DSH 现状不落盘 ──
  const PREFS_KEY = 'l2d-game-prefs'
  let prefs = {}
  try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') } catch { }
  if (typeof prefs.userTitle === 'string') titleInput.value = prefs.userTitle
  if (prefs.mode === 'online' || prefs.mode === 'offline') modeSelect.value = prefs.mode
  if (STANDALONE) {
    modeSelect.value = 'offline'
    modeSelect.replaceChildren(new Option('离线速玩（独立版）', 'offline'))
    modeSelect.title = '独立版使用本地对手，不消耗模型额度'
  }
  if (['easy', 'normal', 'hard'].includes(prefs.difficulty)) diffSelect.value = prefs.difficulty
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        userTitle: titleInput.value.trim(),
        mode: modeSelect.value,
        difficulty: diffSelect.value,
      }))
    } catch { }
  }
  titleInput.addEventListener('change', savePrefs)
  diffSelect.addEventListener('change', savePrefs)

  // 离线=本地糯糯亲自下场：人格/模型选择只对在线有意义
  function syncModeUI() {
    const offline = modeSelect.value === 'offline'
    presetSelect.style.display = offline ? 'none' : ''
    modelSelect.style.display = offline ? 'none' : ''
  }
  modeSelect.addEventListener('change', () => { syncModeUI(); savePrefs() })
  syncModeUI()

  // ── 游戏目录 chips：hub 统一入口；新游戏在宿主 /game/list 登记即出现 ──
  async function loadGames() {
    try {
      const r = await fetch(BASE + '/game/list', { cache: 'no-store' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) return
      chipsBox.replaceChildren()
      for (const g of d.games ?? []) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'l2d-game-chip' + (g.id === 'gomoku' ? ' on' : '')
        chip.textContent = g.name ?? g.id
        chip.disabled = !g.available || g.id === 'gomoku'   // 当前局唯一；未来游戏在此分流
        chipsBox.appendChild(chip)
      }
    } catch { }
  }

  /** @type {any} 最近一次服务端对局状态 */
  let state = null
  /** 已「说出口」的解说条数：增量解说走小人气泡，存量不补播 */
  let spokenCount = 0

  // ── 非模态拖动：头部即把手，拖过即自由定位（钳制防拖丢）──
  const head = card.querySelector('.l2d-game-head')
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, select')) return
    e.preventDefault()
    const r = card.getBoundingClientRect()
    const dx = e.clientX - r.left
    const dy = e.clientY - r.top
    const move = (ev) => {
      const left = Math.min(Math.max(ev.clientX - dx, 8 - card.offsetWidth + 80), window.innerWidth - 88)
      const top = Math.min(Math.max(ev.clientY - dy, 8), window.innerHeight - 48)
      card.style.left = Math.round(left) + 'px'
      card.style.top = Math.round(top) + 'px'
      card.style.right = 'auto'
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      ctx.evalIgnore?.()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })

  // ── 解说声道：对局话语从 Live2D 小人的气泡说出（优先级 1：压状态轮播，让任务完成）。
  // 不排队：同级气泡后来者居上直接替换（优先级仲裁已兜底抢话问题），
  // 串行队列会让解说落后棋局好几手——气泡只说「现在」，历史在侧栏流水里。──
  function speak(text, priority = 1) {
    const ms = Math.min(4000 + text.length * 120, 10000)
    ctx.showBubble?.(text, ms, priority)
  }
  /** 思考中的自言自语（在线模式落子后立播：Live2D 角色=对局 agent 本人，第一人称通用池，不限棋种）。 */
  const THINK_QUIPS = ['唔…让咱想想…', '思考中思考中…', '嗯……走哪里好呢', '让咱看看局势…', '哼哼，有主意了…吧？']
  /** 状态更新后，把增量 agent 解说逐条播到气泡。 */
  function speakNew(prevCount) {
    const items = state?.commentary ?? []
    spokenCount = items.length
    for (const item of items.slice(prevCount)) {
      if (item.from === 'agent') speak(item.text)
    }
  }

  const px = (i) => MARGIN + CELL * i

  function drawBoard() {
    const w = canvas.width
    g2d.clearRect(0, 0, w, w)
    g2d.strokeStyle = 'rgba(90, 65, 25, .75)'
    g2d.lineWidth = 1
    for (let i = 0; i < SIZE; i++) {
      g2d.beginPath(); g2d.moveTo(px(i), px(0)); g2d.lineTo(px(i), px(SIZE - 1)); g2d.stroke()
      g2d.beginPath(); g2d.moveTo(px(0), px(i)); g2d.lineTo(px(SIZE - 1), px(i)); g2d.stroke()
    }
    g2d.fillStyle = 'rgba(90, 65, 25, .9)'
    for (const [sx, sy] of [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]]) {
      g2d.beginPath(); g2d.arc(px(sx), px(sy), 3, 0, Math.PI * 2); g2d.fill()
    }
    if (!state || !state.board) return
    const last = state.moves?.[state.moves.length - 1]
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const c = state.board[y][x]
        if (c === 0) continue
        const cx = px(x), cy = px(y), r = CELL / 2 - 2.5
        const grad = g2d.createRadialGradient(cx - r / 3, cy - r / 3, r / 6, cx, cy, r)
        if (c === 1) { grad.addColorStop(0, '#666'); grad.addColorStop(1, '#111') }
        else { grad.addColorStop(0, '#fff'); grad.addColorStop(1, '#cfd4da') }
        g2d.fillStyle = grad
        g2d.beginPath(); g2d.arc(cx, cy, r, 0, Math.PI * 2); g2d.fill()
        g2d.strokeStyle = c === 1 ? 'rgba(0,0,0,.6)' : 'rgba(0,0,0,.25)'
        g2d.stroke()
      }
    }
    if (last) {
      g2d.fillStyle = '#d33'
      g2d.beginPath(); g2d.arc(px(last.x), px(last.y), 3.5, 0, Math.PI * 2); g2d.fill()
    }
  }

  function renderStatus() {
    statusEl.className = 'l2d-game-status'
    if (!state || state.status === 'idle') { statusEl.textContent = '设置好称呼与对手，点击「新开一局」'; return }
    if (state.status === 'over') {
      statusEl.textContent = state.winner === 1 ? '你赢了！五子连珠 🎉' : state.winner === 2 ? '这局是咱的胜利~下次加油哦' : '平局收场'
      const cls = state.winner === 1 ? 'win' : state.winner === 2 ? 'lose' : ''
      if (cls) statusEl.classList.add(cls)   // classList.add('') 会抛 DOMException
      return
    }
    if (state.busy) { statusEl.textContent = '思考中…'; statusEl.classList.add('thinking'); return }
    statusEl.textContent = '轮到你（黑）'
  }

  function renderLog() {
    logEl.replaceChildren()
    for (const item of state?.commentary ?? []) {
      const div = document.createElement('div')
      div.className = `l2d-game-msg ${item.from}`
      div.textContent = item.text
      logEl.appendChild(div)
    }
    logEl.scrollTop = logEl.scrollHeight
  }

  function render() {
    drawBoard()
    renderStatus()
    renderLog()
    newBtn.disabled = !!state?.busy
  }

  async function refreshState() {
    try {
      const r = await fetch(BASE + '/game/state', { cache: 'no-store' })
      if (r.ok) {
        state = await r.json()
        spokenCount = state.commentary?.length ?? 0   // 存量解说不补播
      }
    } catch { }
    render()
  }

  async function loadPresets() {
    try {
      const r = await fetch(BASE + '/game/presets', { cache: 'no-store' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) return
      presetSelect.replaceChildren()
      for (const p of d.presets ?? []) {
        const opt = document.createElement('option')
        opt.value = p.id
        opt.textContent = p.name ?? p.id
        presetSelect.appendChild(opt)
      }
      presetSelect.value = state?.presetId ?? d.defaultId ?? ''
    } catch { }
  }

  async function loadModels() {
    try {
      const r = await fetch(BASE + '/game/models', { cache: 'no-store' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) return
      modelSelect.replaceChildren()
      for (const m of d.models ?? []) {
        const opt = document.createElement('option')
        opt.value = m.id
        opt.textContent = m.name ?? m.id
        modelSelect.appendChild(opt)
      }
      modelSelect.value = d.defaultModel ?? ''
    } catch { }
  }

  newBtn.addEventListener('click', async () => {
    newBtn.disabled = true
    statusEl.textContent = '正在开局…'
    try {
      const r = await fetch(BASE + '/game/new', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          preset: presetSelect.value || undefined,
          model: modelSelect.value || undefined,
          mode: modeSelect.value,
          difficulty: diffSelect.value,
          userTitle: titleInput.value.trim() || undefined,
        }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
      state = d
      spokenCount = state.commentary?.length ?? 0
    } catch (error) {
      state = { status: 'idle', commentary: [{ from: 'system', text: '开局失败：' + error.message }] }
    }
    render()
  })

  canvas.addEventListener('click', async (e) => {
    if (!state || state.status !== 'playing' || state.busy) return
    const rect = canvas.getBoundingClientRect()
    const x = Math.round((e.clientX - rect.left - MARGIN) / CELL)
    const y = Math.round((e.clientY - rect.top - MARGIN) / CELL)
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return
    if (state.board[y][x] !== 0) return
    // 先落子入画（乐观渲染），busy 防连点
    state.board[y][x] = 1
    state.moves.push({ x, y, side: 1 })
    state.busy = true
    render()
    if (state.mode !== 'offline') speak(THINK_QUIPS[Math.floor(Math.random() * THINK_QUIPS.length)])
    const prevCount = state.commentary?.length ?? 0
    try {
      const r = await fetch(BASE + '/game/move', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x, y }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
      state = { ...d, busy: false }   // 响应到达=回合已结束（兼容旧宿主 busy:true 的时序 bug）
    } catch (error) {
      state.busy = false
      state.commentary = [...(state.commentary ?? []), { from: 'system', text: '回合失败：' + error.message }]
    }
    render()
    speakNew(prevCount)
  })

  card.querySelector('.l2d-game-close').addEventListener('click', () => {
    card.classList.remove('open')
    ctx.evalIgnore?.()
  })

  /** 面板菜单入口：开卡并拉取最新状态与游戏目录/预设/模型清单。 */
  ctx.openGame = () => {
    card.classList.add('open')
    ctx.evalIgnore?.()   // 浮卡纳入穿透判定的可交互区
    void loadGames()
    if (!STANDALONE) {
      void loadPresets()
      void loadModels()
    }
    void refreshState()
  }
}
