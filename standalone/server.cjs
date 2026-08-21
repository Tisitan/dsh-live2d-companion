const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MAX_JSON_BYTES = 64 * 1024
const MAX_IMPORT_BYTES = 128 * 1024 * 1024
const ALLOWED_STATES = new Set(['idle', 'thinking', 'working', 'waiting', 'error', 'done', 'sleeping', 'offline'])
const ADAPTER_SOURCES = new Set(['codex', 'opencode', 'test'])
const STATE_PRIORITY = { offline: 0, sleeping: 1, idle: 2, done: 3, thinking: 4, working: 5, error: 6, waiting: 7 }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.moc3': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

function safeSegment(value, maxLength = 255) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value !== '.'
    && value !== '..'
    && !value.startsWith('.')
    && !/[\\/:\0]/.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(value)   // Windows 保留名（对齐 index.js）
}

function splitSafePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) return null
  const parts = value.replaceAll('\\', '/').replace(/^\/+/, '').split('/')
  return parts.every(part => safeSegment(part)) ? parts : null
}

function normalizeModelRef(value) {
  const parts = splitSafePath(value)
  if (parts === null || !parts.at(-1).toLowerCase().endsWith('.model3.json')) return null
  return parts.join('/')
}

function sanitizeProfile(profile) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return null
  const clean = {}
  const slotPattern = /^[a-zA-Z][\w-]{0,31}$/
  const motion = (value) => Array.isArray(value)
    && value.length === 2
    && safeSegment(value[0], 64)
    && Number.isInteger(value[1])
    && value[1] >= 0
    && value[1] <= 99 ? [value[0], value[1]] : null

  if (profile.expressions !== undefined) {
    if (profile.expressions === null || typeof profile.expressions !== 'object' || Array.isArray(profile.expressions)) return null
    clean.expressions = {}
    for (const [slot, name] of Object.entries(profile.expressions)) {
      if (!slotPattern.test(slot) || typeof name !== 'string' || name.length === 0 || name.length > 128 || /[\\/:\0]/.test(name)) return null
      clean.expressions[slot] = name
    }
  }

  if (profile.motions !== undefined) {
    if (profile.motions === null || typeof profile.motions !== 'object' || Array.isArray(profile.motions)) return null
    clean.motions = {}
    for (const [slot, value] of Object.entries(profile.motions)) {
      if (!slotPattern.test(slot)) return null
      if (slot === 'clickPool') {
        if (!Array.isArray(value) || value.length > 32) return null
        const pool = value.map(motion)
        if (pool.some(item => item === null)) return null
        clean.motions.clickPool = pool
      } else {
        const item = motion(value)
        if (item === null) return null
        clean.motions[slot] = item
      }
    }
  }
  return clean.expressions === undefined && clean.motions === undefined ? null : clean
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on('end', () => size > limit ? reject(new Error('body too large')) : resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

async function serveFile(res, root, parts, extraHeaders = {}) {
  const target = path.resolve(root, ...parts)
  if (!isInside(root, target)) {
    res.writeHead(403)
    res.end('forbidden')
    return false
  }
  let info
  try {
    info = await fsp.stat(target)
  } catch {
    return false
  }
  if (!info.isFile()) return false
  res.writeHead(200, {
    'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
    ...extraHeaders,
  })
  fs.createReadStream(target).pipe(res)
  return true
}

async function createStandaloneServer({ publicDir, dataDir }) {
  const token = crypto.randomBytes(32).toString('hex')
  const adapterToken = crypto.randomBytes(32).toString('hex')
  const cookieName = 'l2d_standalone_token'
  const modelDir = path.join(dataDir, 'models')
  const bundledModelDir = path.join(publicDir, 'model')
  const selectionFile = path.join(dataDir, 'model-selection.json')
  const adapterFile = path.join(dataDir, 'adapter.json')
  await fsp.mkdir(modelDir, { recursive: true })
  // 游戏注册表（与宿主同一套 games/ 描述符）：新游戏登记即接入独立版
  const gamesBase = path.join(publicDir, '..', 'games')
  const { registerGame, getGame, listGames, defaultQuipKey } = await import(pathToFileURL(path.join(gamesBase, 'registry.mjs')).href)
  registerGame((await import(pathToFileURL(path.join(gamesBase, 'gomoku', 'index.mjs')).href)).default)
  registerGame((await import(pathToFileURL(path.join(gamesBase, 'chess', 'index.mjs')).href)).default)

  const modelRoots = [modelDir, bundledModelDir]
  const clients = new Set()
  const sessions = new Map()
  const settleTimers = new Map()
  const chatQueue = []
  const chatJobs = new Map()
  let nextSessionNumber = 1
  let lastOpenCodeHeartbeat = 0
  let state = 'idle'
  let modelPath = ''
  let game = null

  const sanitizeTitle = raw => typeof raw === 'string' && /^[\p{L}\p{N} _\-~·]{1,12}$/u.test(raw.trim()) ? raw.trim() : '主人'
  const pickGameQuip = list => list[Math.floor(Math.random() * list.length)]
  const DIFF_NAME = { easy: '简单', normal: '普通', hard: '困难' }

  // game = { def: 描述符, engine, ai, difficulty, userTitle, commentary, createdAt }
  function gameSnapshot() {
    if (!game) return { status: 'idle' }
    const over = game.def.isOver(game.engine)
    return {
      status: over.over ? 'over' : 'playing',
      game: game.def.id,
      ...game.def.snapshot(game.engine),
      winner: over.winner,
      busy: game.busy === true,
      mode: game.mode,
      difficulty: game.difficulty,
      presetId: null,
      commentary: game.commentary.slice(-20),
      createdAt: game.createdAt,
    }
  }

  /** 终局系统播报（与宿主同口径）。 */
  function pushGameOutcome() {
    const over = game.def.isOver(game.engine)
    if (!over.over) return
    const lines = game.def.outcomeLines(game.engine)
    game.commentary.push({ from: 'system', text: over.winner === 1 ? lines.playerWin : over.winner === 2 ? lines.aiWin : lines.draw })
  }

  function resolveModel(ref) {
    const normalized = normalizeModelRef(ref)
    if (normalized === null) return null
    const parts = normalized.split('/')
    for (const root of modelRoots) {
      const target = path.resolve(root, ...parts)
      if (isInside(root, target) && fs.existsSync(target)) return { ref: normalized, root, target }
    }
    return null
  }

  async function collectModels() {
    const found = new Map()
    async function walk(root, dir = root) {
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const absolute = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(root, absolute)
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.model3.json')) {
          const ref = path.relative(root, absolute).split(path.sep).join('/')
          if (!found.has(ref)) found.set(ref, { path: ref, dir: path.posix.dirname(ref) === '.' ? '' : path.posix.dirname(ref), file: entry.name })
        }
      }
    }
    for (const root of modelRoots) await walk(root)
    return [...found.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  try {
    const saved = JSON.parse(await fsp.readFile(selectionFile, 'utf8'))
    modelPath = resolveModel(saved.model)?.ref || ''
  } catch { }
  if (!modelPath) modelPath = (await collectModels())[0]?.path || ''

  function authorized(req) {
    const cookies = String(req.headers.cookie || '').split(';').map(item => item.trim())
    return cookies.includes(`${cookieName}=${token}`)
  }

  function adapterAuthorized(req) {
    const value = String(req.headers.authorization || '')
    const supplied = value.startsWith('Bearer ') ? value.slice(7) : ''
    const expected = Buffer.from(adapterToken)
    const actual = Buffer.from(supplied)
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  }

  function cleanText(value) {
    if (typeof value !== 'string') return ''
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
  }

  function cleanChatText(value, maxLength = 1000) {
    if (typeof value !== 'string') return ''
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, maxLength)
  }

  function cleanGameCommentary(value) {
    const text = cleanChatText(value, 240).replace(/\s+/g, ' ').trim()
    if (!text || /最大步骤|步骤数已达到|剩余任务|当前工作|工作总结|推荐的后续|等待.*指令|无法继续操作|maximum[_\s-]*(?:number[_\s-]*of[_\s-]*)?steps?|steps?[_\s-]*(?:limit[_\s-]*)?reached|remaining[_\s-]*tasks?|summari[sz](?:e|ing|ation).*(?:work|tasks?)/i.test(text)) return ''
    const firstLine = text.split(/(?<=[。！？!?])\s*/)[0] || text
    return firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine
  }

  function openCodeConnected() {
    return Date.now() - lastOpenCodeHeartbeat < 15000
  }

  function removeChatJob(id) {
    const job = chatJobs.get(id)
    if (!job) return null
    clearTimeout(job.timer)
    chatJobs.delete(id)
    const queueIndex = chatQueue.indexOf(id)
    if (queueIndex >= 0) chatQueue.splice(queueIndex, 1)
    return job
  }

  /** 向 OpenCode Nori 队列提交内部任务；游戏解说与普通聊天共用传输、分会话处理。 */
  function requestOpenCode(message, channel = 'game', timeoutMs = 25000) {
    if (!openCodeConnected() || chatJobs.size >= 3) return Promise.resolve('')
    const id = crypto.randomUUID()
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (!removeChatJob(id)) return
        resolve('')
      }, timeoutMs)
      chatJobs.set(id, { id, message, channel, timer, claimed: false, resolve })
      chatQueue.push(id)
    })
  }

  async function gameCommentary(placed, aiDone = null, outcome = '') {
    if (!game || game.mode !== 'online') return ''
    const turn = [placed?.desc, aiDone?.desc].filter(Boolean).join('；')
    const prompt = `${game.def.commentatorBrief(game.userTitle)}\n`
      + `本回合：${turn || '对局刚刚结束'}。${outcome ? `结果：${outcome}。` : ''}\n`
      + `当前局面：\n${game.def.boardText(game.engine)}\n`
      + '只回复一句此刻脱口而出的对局台词，不要解释规则，不要复述坐标，不超过40字。'
    return cleanGameCommentary(await requestOpenCode(prompt, 'game', 25000))
  }

  function sessionSnapshot() {
    return [...sessions.values()]
      .sort((a, b) => a.n - b.n)
      .map(({ n, source, state: sessionState }) => ({ n, source, state: sessionState }))
  }

  function aggregateState() {
    let chosen = 'idle'
    for (const session of sessions.values()) {
      if ((STATE_PRIORITY[session.state] ?? 0) > (STATE_PRIORITY[chosen] ?? 0)) chosen = session.state
    }
    return chosen
  }

  function publish(message = null) {
    state = aggregateState()
    const payload = { state, sessions: sessionSnapshot() }
    if (message) payload.message = message
    broadcast(payload)
    return payload
  }

  function clearSettleTimer(key) {
    const timer = settleTimers.get(key)
    if (timer) clearTimeout(timer)
    settleTimers.delete(key)
  }

  function acceptAdapterEvent(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid event')
    const source = typeof input.source === 'string' ? input.source.toLowerCase() : ''
    if (!ADAPTER_SOURCES.has(source)) throw new Error('invalid source')
    const sessionId = cleanText(input.sessionId)
    if (!sessionId || sessionId.length > 160) throw new Error('invalid session')
    const key = `${source}:${sessionId}`
    clearSettleTimer(key)

    if (input.remove === true) {
      sessions.delete(key)
      return publish()
    }

    if (!ALLOWED_STATES.has(input.state)) throw new Error('invalid state')
    const prior = sessions.get(key)
    sessions.set(key, {
      n: prior?.n ?? nextSessionNumber++, source, state: input.state, updatedAt: Date.now(),
    })
    const text = cleanText(input.text)
    const holdMs = Number.isFinite(input.holdMs) ? Math.max(1200, Math.min(15000, Math.round(input.holdMs))) : 6000
    const payload = publish(text ? { text, holdMs, source, sessionId } : null)

    if (input.state === 'done' || input.state === 'error') {
      settleTimers.set(key, setTimeout(() => {
        const current = sessions.get(key)
        if (current && current.state === input.state) {
          current.state = 'idle'
          current.updatedAt = Date.now()
          publish()
        }
        settleTimers.delete(key)
      }, input.state === 'done' ? 8000 : 12000))
    }
    return payload
  }

  // SSE 写帧：半开连接 write 可抛 ERR_STREAM_DESTROYED（宿主版 index.js 已实证会崩进程），
  // 吞掉并剔除死客户端，绝不上抛主进程
  function sseSend(client, frame) {
    try { client.write(frame) } catch { clients.delete(client) }
  }

  function broadcast(payload) {
    const frame = `data: ${JSON.stringify(payload)}\n\n`
    for (const client of clients) sseSend(client, frame)
  }

  // SSE 心跳：25 秒注释帧。客户端被杀死而 TCP 未 RST 的半开连接会在写失败时被剔除
  const sseHeartbeat = setInterval(() => {
    for (const client of clients) sseSend(client, ': ka\n\n')
  }, 25000)

  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('cross-origin-resource-policy', 'same-origin')

    let url
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
      decodeURIComponent(url.pathname)
    } catch {
      json(res, 400, { error: 'invalid URL' })
      return
    }

    const pathname = decodeURIComponent(url.pathname)
    const method = req.method || 'GET'
    if (pathname === '/live2d/adapter' && method === 'POST') {
      if (!adapterAuthorized(req)) {
        json(res, 403, { error: 'forbidden' })
        return
      }
      try {
        const parsed = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || '{}')
        json(res, 200, acceptAdapterEvent(parsed))
      } catch (error) {
        json(res, error.message === 'body too large' ? 413 : 400, { error: error.message })
      }
      return
    }
    if (pathname === '/live2d/chat/heartbeat' && method === 'GET') {
      if (!adapterAuthorized(req)) {
        json(res, 403, { error: 'forbidden' })
        return
      }
      lastOpenCodeHeartbeat = Date.now()
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (pathname === '/live2d/chat/next' && method === 'GET') {
      if (!adapterAuthorized(req)) {
        json(res, 403, { error: 'forbidden' })
        return
      }
      lastOpenCodeHeartbeat = Date.now()
      const id = chatQueue.shift()
      const job = id ? chatJobs.get(id) : null
      if (!job) {
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      job.claimed = true
      json(res, 200, { id, message: job.message, channel: job.channel || 'chat' })
      return
    }
    if (pathname === '/live2d/chat/reply' && method === 'POST') {
      if (!adapterAuthorized(req)) {
        json(res, 403, { error: 'forbidden' })
        return
      }
      lastOpenCodeHeartbeat = Date.now()
      try {
        const parsed = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || '{}')
        const id = typeof parsed.id === 'string' ? parsed.id : ''
        const job = chatJobs.get(id)
        if (!job) {
          json(res, 404, { error: 'chat job not found' })
          return
        }
        removeChatJob(id)
        const reply = cleanChatText(parsed.text)
        const replyError = cleanChatText(parsed.error, 240) || 'OpenCode did not return a reply'
        if (typeof job.resolve === 'function') {
          job.resolve(reply)
        } else if (!job.browserRes.writableEnded) {
          if (reply) json(job.browserRes, 200, { reply })
          else json(job.browserRes, 502, { error: replyError })
        }
        json(res, 200, { accepted: true })
      } catch (error) {
        json(res, error.message === 'body too large' ? 413 : 400, { error: error.message })
      }
      return
    }
    if (method === 'POST' && !authorized(req)) {
      json(res, 403, { error: 'forbidden' })
      return
    }

    if (pathname === '/live2d/chat/status' && method === 'GET') {
      json(res, 200, { connected: openCodeConnected() })
      return
    }

    if (pathname === '/live2d/chat' && method === 'POST') {
      try {
        if (!openCodeConnected()) {
          json(res, 503, { error: 'OpenCode is not connected' })
          return
        }
        if (chatJobs.size >= 3) {
          json(res, 429, { error: 'too many chat requests' })
          return
        }
        const parsed = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || '{}')
        const message = cleanChatText(parsed.message)
        if (!message) throw new Error('message is empty')
        const id = crypto.randomUUID()
        const timer = setTimeout(() => {
          const job = removeChatJob(id)
          if (!job) return
          if (!job.browserRes.writableEnded) json(job.browserRes, 504, { error: 'OpenCode reply timed out' })
        }, 90000)
        const job = { id, message, channel: 'chat', browserRes: res, timer, claimed: false }
        chatJobs.set(id, job)
        chatQueue.push(id)
        res.on('close', () => {
          if (res.writableEnded) return
          removeChatJob(id)
        })
      } catch (error) {
        json(res, error.message === 'body too large' ? 413 : 400, { error: error.message })
      }
      return
    }

    if (pathname === '/live2d/state-stream' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify({ state, model: modelPath, sessions: sessionSnapshot() })}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    if (pathname === '/live2d/state') {
      if (method === 'GET') {
        json(res, 200, { state })
        return
      }
      if (method === 'POST') {
        try {
          const parsed = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || '{}')
          if (!ALLOWED_STATES.has(parsed.state)) throw new Error('invalid state')
          state = parsed.state
          broadcast({ state })
          json(res, 200, { state })
        } catch (error) {
          json(res, 400, { error: error.message })
        }
        return
      }
    }

    if (pathname === '/live2d/game/list' && method === 'GET') {
      json(res, 200, { games: listGames() })
      return
    }

    if (pathname === '/live2d/game/presets' && method === 'GET') {
      json(res, 200, { presets: [], defaultId: '' })
      return
    }

    if (pathname === '/live2d/game/models' && method === 'GET') {
      json(res, 200, { models: [], defaultModel: '', provider: 'standalone' })
      return
    }

    if (pathname === '/live2d/game/state' && method === 'GET') {
      json(res, 200, gameSnapshot())
      return
    }

    if (pathname === '/live2d/game/new' && method === 'POST') {
      try {
        const parsed = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || '{}')
        const gameId = typeof parsed.game === 'string' ? parsed.game : 'gomoku'
        const def = getGame(gameId)
        if (!def) {
          json(res, 400, { error: `unknown game: ${String(gameId).slice(0, 40)}` })
          return
        }
        // 独立版的在线模式由 OpenCode Nori 解说；棋力仍由本地 AI 决定。
        // 阿尔法狗（LLM 亲自执子）暂映射为困难本地 AI，避免模型乱答拖死棋局。
        const difficulty = parsed.difficulty === 'alphago' ? 'hard'
          : ['easy', 'normal', 'hard'].includes(parsed.difficulty) ? parsed.difficulty : 'normal'
        const mode = parsed.mode === 'online' ? 'online' : 'offline'
        game = {
          def,
          engine: def.createEngine(),
          ai: def.createAI(difficulty),
          mode,
          difficulty,
          busy: false,
          userTitle: sanitizeTitle(parsed.userTitle),
          commentary: [{ from: 'system', text: def.startLine?.(difficulty, mode) ?? `对局开始（独立版·${DIFF_NAME[difficulty]}）。` }],
          createdAt: new Date().toISOString(),
        }
        if (mode === 'online' && !openCodeConnected()) {
          game.commentary.push({ from: 'system', text: 'OpenCode 暂未连接，本局会自动使用本地台词；连接后下一手即可启用模型解说。' })
        }
        json(res, 200, gameSnapshot())
      } catch (error) {
        json(res, error.message === 'body too large' ? 413 : 400, { error: error.message })
      }
      return
    }

    if (pathname === '/live2d/game/move' && method === 'POST') {
      // 回合串行闸 + 代际校验（对齐宿主版 index.js）：解说 await 期间开新局，
      // 旧句不得写进新局 commentary；闸防并发双击把引擎走乱
      let g = null
      try {
        if (!game) {
          json(res, 409, { error: '尚未开局' })
          return
        }
        if (game.busy) {
          json(res, 409, { error: '思考中，请稍候' })
          return
        }
        game.busy = true
        g = game
        const parsed = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || '{}')
        const placed = g.def.playerMove(g.engine, parsed)
        if (!placed.ok) {
          g.busy = false
          json(res, 400, { error: placed.reason })
          return
        }
        if (g.def.isOver(g.engine).over) {
          // 玩家制胜手终局：在线优先让 OpenCode Nori 服输；失败再落回本地 lose 池。
          const over = g.def.isOver(g.engine)
          const lines = g.def.outcomeLines(g.engine)
          const said = await gameCommentary(placed, null, over.winner === 1 ? lines.playerWin : lines.draw)
          if (game !== g) { json(res, 409, { error: '对局已更换，请以最新局面为准' }); return }
          if (said) g.commentary.push({ from: 'agent', text: said })
          else if (over.winner === 1 && g.def.quips.lose) {
            g.commentary.push({ from: 'agent', text: pickGameQuip(g.def.quips.lose).replaceAll('主人', g.userTitle) })
          }
          pushGameOutcome()
          g.busy = false
          json(res, 200, { ...gameSnapshot(), aiMove: null })
          return
        }
        const mv = await g.ai.pickMove(g.engine)
        if (game !== g) { json(res, 409, { error: '对局已更换，请以最新局面为准' }); return }
        if (!mv) {
          g.busy = false
          json(res, 200, { ...gameSnapshot(), aiMove: null })
          return
        }
        const aiDone = g.def.aiMove(g.engine, mv)
        if (!aiDone.ok) {
          g.busy = false
          json(res, 200, { ...gameSnapshot(), aiMove: null })
          return
        }
        const over = g.def.isOver(g.engine)
        // 在线模式让 OpenCode Nori 解说；未连接/超时/报错时无缝回退本地台词池。
        const key = (g.def.pickQuipKey ?? defaultQuipKey)(mv, { win: over.over && over.winner === 2 })
        const pool = g.def.quips[key] ?? g.def.quips.normal
        const lines = over.over ? g.def.outcomeLines(g.engine) : null
        const outcome = over.over ? (over.winner === 2 ? lines.aiWin : lines.draw) : ''
        const said = await gameCommentary(placed, aiDone, outcome)
        if (game !== g) { json(res, 409, { error: '对局已更换，请以最新局面为准' }); return }
        g.commentary.push({
          from: 'agent',
          text: said || pickGameQuip(pool).replaceAll('主人', g.userTitle),
        })
        if (g.commentary.length > 60) g.commentary.splice(0, g.commentary.length - 60)
        if (over.over) pushGameOutcome()
        g.busy = false   // 必须在 json 前清：响应即回合终态，前端按 busy 渲染思考态
        json(res, 200, { ...gameSnapshot(), aiMove: mv })
      } catch (error) {
        if (g && game === g) g.busy = false
        json(res, error.message === 'body too large' ? 413 : 400, { error: error.message })
      }
      return
    }

    if (pathname === '/live2d/config' && method === 'GET') {
      json(res, 200, { model: modelPath, defaultModel: modelPath })
      return
    }

    if (pathname === '/live2d/models' && method === 'GET') {
      const models = await collectModels()
      json(res, 200, { current: modelPath, defaultModel: models[0]?.path || '', models })
      return
    }

    if (pathname === '/live2d/model' && method === 'POST') {
      try {
        const parsed = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || '{}')
        const models = await collectModels()
        const next = parsed.reset === true ? models[0]?.path : resolveModel(parsed.model)?.ref
        if (!next) {
          json(res, 404, { error: 'model not found' })
          return
        }
        modelPath = next
        await fsp.writeFile(selectionFile, JSON.stringify({ model: next, updatedAt: new Date().toISOString() }, null, 2) + '\n')
        broadcast({ model: modelPath })
        json(res, 200, { model: modelPath, defaultModel: models[0]?.path || '' })
      } catch (error) {
        json(res, 400, { error: error.message })
      }
      return
    }

    if (pathname === '/live2d/import' && method === 'POST') {
      const folder = url.searchParams.get('model') || ''
      const parts = splitSafePath(url.searchParams.get('path') || '')
      if (!safeSegment(folder, 128) || parts === null) {
        json(res, 400, { error: 'invalid model path' })
        return
      }
      try {
        const body = await readBody(req, MAX_IMPORT_BYTES)
        const target = path.resolve(modelDir, folder, ...parts)
        if (!isInside(modelDir, target)) throw new Error('invalid target')
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.writeFile(target, body)
        json(res, 200, { imported: { model: folder, path: parts.join('/'), bytes: body.length } })
      } catch (error) {
        json(res, error.message === 'body too large' ? 413 : 400, { error: error.message })
      }
      return
    }

    if (pathname === '/live2d/profile' && method === 'POST') {
      try {
        const parsed = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || '{}')
        if (!safeSegment(parsed.dir, 128)) throw new Error('invalid model directory')
        const target = path.join(modelDir, parsed.dir, 'profile.json')
        if (parsed.reset === true) {
          await fsp.rm(target, { force: true })
          json(res, 200, { reset: true })
          return
        }
        const profile = sanitizeProfile(parsed.profile)
        if (profile === null) throw new Error('invalid profile')
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.writeFile(target, JSON.stringify(profile, null, 2) + '\n')
        json(res, 200, { saved: `${parsed.dir}/profile.json` })
      } catch (error) {
        json(res, 400, { error: error.message })
      }
      return
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405)
      res.end('method not allowed')
      return
    }

    if (pathname.startsWith('/live2d/model/')) {
      const parts = splitSafePath(pathname.slice('/live2d/model/'.length))
      if (parts !== null) {
        for (const root of modelRoots) {
          if (await serveFile(res, root, parts)) return
        }
      }
      res.writeHead(404)
      res.end('not found')
      return
    }

    let relative = pathname.startsWith('/live2d/') ? pathname.slice('/live2d/'.length) : ''
    if (!relative) relative = 'pet.html'
    const parts = splitSafePath(relative)
    if (parts === null) {
      res.writeHead(400)
      res.end('invalid path')
      return
    }
    const headers = relative === 'pet.html' && url.searchParams.get('token') === token
      ? { 'set-cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/live2d` }
      : {}
    if (!await serveFile(res, publicDir, parts, headers)) {
      res.writeHead(404)
      res.end('not found')
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  await fsp.writeFile(adapterFile, JSON.stringify({
    version: 1,
    endpoint: `${origin}/live2d/adapter`,
    token: adapterToken,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }, null, 2) + '\n', { mode: 0o600 })
  return {
    origin,
    target: `${origin}/live2d/pet.html?token=${token}&standalone=1`,
    modelDir,
    hasModel: Boolean(modelPath),
    hasCore: fs.existsSync(path.join(publicDir, 'vendor', 'live2dcubismcore.min.js')),
    adapterFile,
    setState(next) {
      if (!ALLOWED_STATES.has(next)) return false
      state = next
      broadcast({ state })
      return true
    },
    close: () => new Promise(resolve => {
      clearInterval(sseHeartbeat)
      // SSE 长连接会吊住 server.close 的回调永不触发：先主动收尾再关
      for (const client of clients) { try { client.end() } catch { } }
      clients.clear()
      server.close(async () => {
      for (const timer of settleTimers.values()) clearTimeout(timer)
      for (const job of chatJobs.values()) {
        clearTimeout(job.timer)
        if (typeof job.resolve === 'function') job.resolve('')
        else if (!job.browserRes.writableEnded) json(job.browserRes, 503, { error: 'companion is closing' })
      }
      chatJobs.clear()
      chatQueue.length = 0
      try {
        const current = JSON.parse(await fsp.readFile(adapterFile, 'utf8'))
        if (current.token === adapterToken) await fsp.rm(adapterFile, { force: true })
      } catch { }
      resolve()
      })
    }),
  }
}

module.exports = { createStandaloneServer }
