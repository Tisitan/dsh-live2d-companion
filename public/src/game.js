// 游戏中心壳（全游戏无关）：卡片 DOM/设置条/解说声道/轮询/动画驱动在此；
// 棋盘绘制与点击映射由 public/src/games/<id>.js 渲染器动态装载，新游戏登记即插。
import { BASE, STANDALONE } from './config.js'

export function attachGame(ctx) {
  if (ctx.openGame) return   // 幂等：重复挂载不重复插 DOM/监听
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
#l2d-game .l2d-game-strip {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 14px; border-top: 1px solid rgba(0,0,0,.06); border-bottom: 1px solid rgba(0,0,0,.08);
}
#l2d-game .l2d-game-strip label { font-size: 12px; color: #778; }
#l2d-game .l2d-game-cfg-hint {
  padding: 5px 14px; font-size: 11.5px; line-height: 1.5; color: #99a;
  border-bottom: 1px solid rgba(0,0,0,.06); min-height: 17px;
}
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
  <input class="l2d-game-title-input" maxlength="12" placeholder="主人" title="对手对你的称呼：注入在线解说与离线台词" />
  <select class="l2d-game-mode" title="对弈模式：在线=本地AI执子+你的人格解说；离线=本地AI+本地台词秒回">
    <option value="online">在线对弈</option>
    <option value="offline">离线速玩</option>
  </select>
  <select class="l2d-game-preset" title="解说人格：选择你的 agent 预设（只影响解说风格）"></select>
  <select class="l2d-game-model" title="解说模型：来自 DSH 模型清单"></select>
  <select class="l2d-game-diff" title="难度：简单/普通/困难=本地 AI 强度；阿尔法狗=你的模型亲自执子对抗（仅在线）">
    <option value="easy">简单</option>
    <option value="normal" selected>普通</option>
    <option value="hard">困难</option>
    <option value="alphago">阿尔法狗</option>
  </select>
  <button type="button" class="l2d-game-new">新开一局</button>
</div>
<div class="l2d-game-cfg-hint"></div>
<div class="l2d-game-body">
  <div class="l2d-game-stage"><canvas width="500" height="500"></canvas></div>
  <div class="l2d-game-side">
    <div class="l2d-game-status">加载中…</div>
    <div class="l2d-game-log"></div>
    <div class="l2d-game-hint"></div>
  </div>
</div>`
  document.body.appendChild(card)

  const canvas = card.querySelector('canvas')
  const g2d = canvas.getContext('2d')
  const statusEl = card.querySelector('.l2d-game-status')
  const logEl = card.querySelector('.l2d-game-log')
  const hintEl = card.querySelector('.l2d-game-hint')
  const presetSelect = card.querySelector('.l2d-game-preset')
  const modelSelect = card.querySelector('.l2d-game-model')
  const modeSelect = card.querySelector('.l2d-game-mode')
  const diffSelect = card.querySelector('.l2d-game-diff')
  const titleInput = card.querySelector('.l2d-game-title-input')
  const chipsBox = card.querySelector('.l2d-game-chips')
  const newBtn = card.querySelector('.l2d-game-new')
  const cfgHintEl = card.querySelector('.l2d-game-cfg-hint')

  // ── 配置项人类注释：鼠标悬停/聚焦某项即在下方的注释条显示人话说明（面板 .l2d-hint 的游戏版）──
  const CFG_HINT_DEFAULT = '设置都会记住，下次开局自动带上；鼠标放到某项上可以看说明。'
  const CFG_HINTS = [
    [chipsBox, '玩什么点这里。切换对下一局生效（当前这盘不受打扰）。'],
    [titleInput, '小人下棋时怎么叫你——解说、狠话、认输台词里都用这个名字。'],
    [modeSelect, STANDALONE
      ? 'OpenCode 解说=本地AI执子，OpenCode 的 Nori 每手说一句；未连接或超时自动回退本地台词。离线速玩完全不耗模型额度。'
      : '在线对弈=本地AI执子+你的模型边下边聊（每手多等几秒，有戏）；难度选阿尔法狗时模型直接亲自执子对抗。离线速玩=本地AI+本地台词秒回，不耗模型额度。'],
    [presetSelect, '选谁来陪你下棋——语气人格来自这个预设，只影响说话风格，不影响棋力。'],
    [modelSelect, '解说/阿尔法狗用的模型，清单来自你的 DSH 模型配置。'],
    [diffSelect, '简单/普通/困难=本地AI强度（真实分档）；阿尔法狗=你的模型亲自执子对抗（仅在线可用，走子最慢但最有戏——它超时或乱答时本地困难AI会悄悄兜底，不会卡死）。'],
    [newBtn, '按当前设置重开一盘。'],
  ]
  cfgHintEl.textContent = CFG_HINT_DEFAULT
  for (const [el, text] of CFG_HINTS) {
    el.addEventListener('mouseenter', () => { cfgHintEl.textContent = text })
    el.addEventListener('focus', () => { cfgHintEl.textContent = text })
    el.addEventListener('mouseleave', () => { cfgHintEl.textContent = CFG_HINT_DEFAULT })
    el.addEventListener('blur', () => { cfgHintEl.textContent = CFG_HINT_DEFAULT })
  }

  // ── 通用偏好持久化：称呼/模式/难度/游戏选择跨局记住，预设与模型跟随 DSH 现状不落盘 ──
  const PREFS_KEY = 'l2d-game-prefs'
  let prefs = {}
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) prefs = raw   // 防污染值（null/数字/数组）
  } catch { }
  if (typeof prefs.userTitle === 'string') titleInput.value = prefs.userTitle
  if (prefs.mode === 'online' || prefs.mode === 'offline') modeSelect.value = prefs.mode
  if (STANDALONE) {
    modeSelect.replaceChildren(
      new Option('OpenCode 解说', 'online'),
      new Option('离线速玩', 'offline'),
    )
    modeSelect.value = prefs.mode === 'online' ? 'online' : 'offline'
    modeSelect.title = '本地 AI 负责合法落子；在线时由 OpenCode Nori 解说，失败自动回退本地台词'
    // 独立版暂不开放模型亲自执子的阿尔法狗档；OpenCode 只做解说。
    diffSelect.querySelector('option[value="alphago"]')?.remove()
  }
  if (['easy', 'normal', 'hard', 'alphago'].includes(prefs.difficulty)) diffSelect.value = prefs.difficulty
  if (STANDALONE && diffSelect.value === 'alphago') diffSelect.value = 'normal'   // 旧偏好残留兜底
  // 离线模式与阿尔法狗互斥：切离线时若正选阿尔法狗，自动落回普通
  modeSelect.addEventListener('change', () => {
    if (modeSelect.value === 'offline' && diffSelect.value === 'alphago') diffSelect.value = 'normal'
  })
  // 宿主显式指定（卫星窗 URL ?game= 经 game-card.js 传入 ctx.gameId）优先于本地偏好
  let selectedGame = typeof ctx.gameId === 'string' && /^[a-z0-9-]{1,40}$/i.test(ctx.gameId) ? ctx.gameId
    : typeof prefs.game === 'string' ? prefs.game : 'gomoku'
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        userTitle: titleInput.value.trim(),
        mode: modeSelect.value,
        difficulty: diffSelect.value,
        game: selectedGame,
      }))
    } catch { }
  }
  titleInput.addEventListener('change', savePrefs)
  diffSelect.addEventListener('change', savePrefs)

  // 离线=纯本地：人格/模型选择只对在线解说有意义
  function syncModeUI() {
    const offline = modeSelect.value === 'offline'
    presetSelect.style.display = STANDALONE || offline ? 'none' : ''
    modelSelect.style.display = STANDALONE || offline ? 'none' : ''
  }
  modeSelect.addEventListener('change', () => { syncModeUI(); savePrefs() })
  syncModeUI()
  // ── 渲染器装载：public/src/games/<id>.js 动态 import，id 白名单字符防路径注入 ──
  const renderers = {}
  let activeRenderer = null
  let activeGameId = null
  async function ensureRenderer(id) {
    if (!/^[a-z0-9-]+$/.test(id ?? '')) return null
    if (renderers[id] === undefined) {
      try { renderers[id] = (await import(`./games/${id}.js`)).default.create() }
      catch {
        // 失败不缓存（下一次尝试重新 import）；给主人可见的报错而非沉默
        statusEl.textContent = `游戏「${id}」的渲染器加载失败——请刷新页面重试`
        return null
      }
    }
    return renderers[id]
  }

  /** @type {any} 最近一次服务端对局状态 */
  let state = null
  /** @type {any} AI 走子动画上下文 {aiMove, t0}；null=无动画 */
  let fx = null
  let rafId = 0
  /** 走子请求在途闸：轮询响应在闸内不得覆盖本地 state（迟到快照会抹 busy/回退棋盘/骗回滚删真子） */
  let moveInFlight = false
  /** 已播报解说条数（计数制取代 prevCount 传参：轮询整体替换 state 后也不重播/漏播） */
  let spokenCount = 0
  /** 最近一次状态拉取错误（renderStatus 优先展示，不然紧随的 render 会把失败文案刷掉） */
  let lastError = ''

  /** 激活某游戏的渲染器（游戏切换/新局/对账时调用）。 */
  async function activateRenderer(id) {
    if (id === activeGameId) return
    const r = await ensureRenderer(id)
    if (!r) return
    activeGameId = id
    activeRenderer = r
    fx = null
    r.reset?.()   // 清掉渲染器内部选中态（如国象的棋子选择）
    canvas.width = r.canvasSize ?? 500
    canvas.height = r.canvasSize ?? 500
    hintEl.textContent = r.hint ?? ''
  }

  function render() {
    cancelAnimationFrame(rafId)
    renderStatus()
    renderLog()
    newBtn.disabled = !!state?.busy
    if (activeRenderer && state) {
      const animating = activeRenderer.draw(g2d, canvas, state, fx)
      if (animating) rafId = requestAnimationFrame(render)
      else fx = null
    }
  }

  function renderStatus() {
    statusEl.className = 'l2d-game-status'
    if (lastError) { statusEl.textContent = lastError; return }
    if (!state || state.status === 'idle') { statusEl.textContent = '选好游戏与称呼，点击「新开一局」'; return }
    if (state.status === 'over') {
      statusEl.textContent = state.winner === 1 ? (activeRenderer?.winText ?? '你赢了！🎉')
        : state.winner === 2 ? (activeRenderer?.loseText ?? '这局是咱的胜利~')
        : (activeRenderer?.drawText ?? '平局收场')
      const cls = state.winner === 1 ? 'win' : state.winner === 2 ? 'lose' : ''
      if (cls) statusEl.classList.add(cls)   // classList.add('') 会抛 DOMException
      return
    }
    if (state.busy) { statusEl.textContent = '思考中…'; statusEl.classList.add('thinking'); return }
    statusEl.textContent = `轮到你（${activeRenderer?.sideLabel ?? ''}）`
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

  // ── 游戏目录 chips：hub 统一入口；点选决定「新开一局」的游戏（进行中的对局不受影响）──
  async function loadGames() {
    try {
      const r = await fetch(BASE + '/game/list', { cache: 'no-store' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) return
      chipsBox.replaceChildren()
      for (const g of d.games ?? []) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'l2d-game-chip' + (g.id === selectedGame ? ' on' : '')
        chip.textContent = g.name ?? g.id
        chip.disabled = !g.available
        chip.title = `下一局玩「${g.name ?? g.id}」（进行中的对局不受影响）`
        chip.addEventListener('click', () => {
          selectedGame = g.id
          savePrefs()
          chipsBox.querySelectorAll('.l2d-game-chip').forEach((c) => c.classList.toggle('on', c === chip))
          void ensureRenderer(g.id)   // 预载渲染器
        })
        chipsBox.appendChild(chip)
      }
    } catch { }
  }
  // ── 非模态拖动：头部即把手，拖过即自由定位（钳制防拖丢）──
  const head = card.querySelector('.l2d-game-head')
  head.addEventListener('pointerdown', (e) => {
    if (window.__l2dCardWin) return   // 卫星窗：拖动交给 OS，DOM 内拖动禁用
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
      window.removeEventListener('pointercancel', up)
      ctx.evalIgnore?.()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  })

  // ── 解说声道：对局话语从 Live2D 小人的气泡说出（优先级 1：压状态轮播，让任务完成）──
  function speak(text, priority = 1) {
    const ms = Math.min(4000 + text.length * 120, 10000)
    ctx.showBubble?.(text, ms, priority)
  }
  /** 思考中的自言自语（在线模式走子后立播；第一人称通用池，不限棋种）。 */
  const THINK_QUIPS = ['唔…让咱想想…', '思考中思考中…', '嗯…走哪里好呢', '让咱看看局势…', '哼哼，有主意了…吧？']
  /** 状态更新后，把增量 agent 解说逐条播到气泡（计数制：spokenCount 跟随 state 长度收敛）。 */
  function speakNew() {
    const items = state?.commentary ?? []
    spokenCount = Math.min(spokenCount, items.length)   // 快照整体替换后计数收敛防越界
    for (const item of items.slice(spokenCount)) {
      if (item.from === 'agent') speak(item.text)
    }
    spokenCount = items.length
  }

  async function refreshState() {
    try {
      const r = await fetch(BASE + '/game/state', { cache: 'no-store' })
      if (r.ok) {
        const d = await r.json()
        // 走子在途：迟到轮询快照不得覆盖（会抹 busy/回退棋盘/骗乐观回滚删真子）
        if (!moveInFlight) {
          state = d
          if (d.game && d.game !== activeGameId) void activateRenderer(d.game).then(render)
        }
        lastError = ''
      } else if (state === null) {
        lastError = '宿主拒绝了状态读取（HTTP ' + r.status + '）'
      }
    } catch {
      if (state === null) lastError = '与宿主失联…检查 DSH 是否在运行'
    }
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
    if (modeSelect.value === 'offline' && diffSelect.value === 'alphago') {
      lastError = '阿尔法狗要在线模式哦——它由你的模型亲自执子；切「在线对弈」再来'
      render()
      return
    }
    newBtn.disabled = true
    statusEl.textContent = '正在开局…'
    try {
      const r = await fetch(BASE + '/game/new', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          game: selectedGame,
          preset: presetSelect.value || undefined,
          model: modelSelect.value || undefined,
          mode: modeSelect.value,
          difficulty: diffSelect.value,
          userTitle: titleInput.value.trim() || undefined,
        }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
      await activateRenderer(d.game ?? selectedGame)
      activeRenderer?.reset?.()   // 同棋种连开新局也要清渲染器选中态（activate 同 id 会早退）
      spokenCount = 0
      lastError = ''
      state = d
    } catch (error) {
      state = { status: 'idle', commentary: [{ from: 'system', text: '开局失败：' + error.message }] }
    }
    render()
  })

  canvas.addEventListener('click', async (e) => {
    if (!state || state.status !== 'playing' || state.busy) return
    if (!activeRenderer) return
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width   // 响应式缩放时坐标映射回画布系
    const scaleY = canvas.height / rect.height
    const r = activeRenderer.clickToMove(state, (e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY)
    if (!r) return
    if (r.pending) { render(); return }   // 选中态变化（国象点选棋子），只重绘
    const move = r.move
    // 乐观渲染仅五子棋类简单落子（渲染器自带钩子才用）；国象规则复杂，用 fx.playerMove 即时动画过渡
    activeRenderer.applyOptimistic?.(state, move)
    if (!activeRenderer.applyOptimistic) {
      fx = { playerMove: move, t0: performance.now() }   // 自己的走子立刻滑过去，不等 LLM
    }
    state.busy = true
    moveInFlight = true   // 在途闸：响应到达前轮询快照不得覆盖本地
    render()
    if (state.mode !== 'offline') speak(THINK_QUIPS[Math.floor(Math.random() * THINK_QUIPS.length)])
    try {
      const res = await fetch(BASE + '/game/move', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(move),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status)
      state = { ...d, busy: false }
      // 落子动画与解说语句同帧出现：fx 驱动渲染器动画，speakNew 同 tick 播报
      fx = d.aiMove ? { aiMove: d.aiMove, t0: performance.now() } : null
    } catch (error) {
      if (activeRenderer.rollbackOptimistic) activeRenderer.rollbackOptimistic(state, move)
      state.busy = false
      state.commentary = [...(state.commentary ?? []), { from: 'system', text: '回合失败：' + error.message }]
      fx = null
    }
    moveInFlight = false   // 收闸：之后轮询恢复对账
    render()
    speakNew()
  })

  // ── 开卡期间 5s 轮询对账：宿主重启/他处开局后旧棋盘不留痕 ──
  let pollTimer = 0
  function startPoll() {
    clearInterval(pollTimer)
    pollTimer = setInterval(() => {
      if (state?.busy) return   // 回合进行中不轮询：本地乐观帧与思考态由 move 流程自持
      void refreshState()
    }, 5000)
  }

  card.querySelector('.l2d-game-close').addEventListener('click', () => {
    card.classList.remove('open')
    clearInterval(pollTimer)
    pollTimer = 0
    ctx.evalIgnore?.()
  })

  /** 面板菜单入口：开卡并拉取最新状态与游戏目录/预设/模型清单。 */
  ctx.openGame = () => {
    card.classList.add('open')
    ctx.evalIgnore?.()
    void loadGames()
    if (!STANDALONE) {
      void loadPresets()
      void loadModels()
    }
    void ensureRenderer(selectedGame)
    void refreshState()
    startPoll()
  }
}
