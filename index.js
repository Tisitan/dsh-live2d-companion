import { createReadStream, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdir, readdir, lstat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { registerGame, getGame, listGames, defaultQuipKey } from './games/registry.mjs'
import gomokuGame from './games/gomoku/index.mjs'
import chessGame from './games/chess/index.mjs'

registerGame(gomokuGame)
registerGame(chessGame)

export const name = 'dsh-live2d-companion'
export const inject = ['webServer', 'agentPresets', 'agentLoop', 'agentDefaultModel', 'settings', 'llm']

const PUBLIC_DIR = normalize(fileURLToPath(new URL('./public', import.meta.url)))
const MODEL_DIR = join(PUBLIC_DIR, 'model')
const QUIPS_PRESETS_DIR = join(PUBLIC_DIR, 'quips-presets')
const QUIPS_ACTIVE_FILE = join(PUBLIC_DIR, 'quips.local.json')
const SELECTION_FILE = fileURLToPath(new URL('./model-selection.json', import.meta.url))
const DEFAULT_MODEL = 'nori/ARGNori.model3.json'
const MAX_SELECTION_BYTES = 64 * 1024
const MAX_IMPORT_FILE_BYTES = 128 * 1024 * 1024
// 显示模式切换的写入目标：本 profile 的用户补丁层（热重载，改文件即重挂载本插件）
const PATCH_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'web', 'cordis.patch.yml')

/** 桌宠 spawn 节流：效果重挂载（如端口冲突重试）时 30 秒内不重复拉起，防 electron 生死循环。 */
let lastPetSpawnAt = 0
/** 桌宠进程句柄：跨重挂载存活，新实例收养而非杀旧生新（杀+生竞态=单实例锁弹回新进程）。 */
let petChild = null
/** 延迟处死定时器：卸载后 8 秒内无新实例收养才杀（真卸载/关宿主兜底）。 */
let petKillTimer = null
/** 宿主进程退出钩子只挂一次（模块级状态跨挂载存活，反复注册会叠加）。 */
let petExitHookArmed = false

/** 显示模式 → config 布尔对。 */
const DISPLAY_MODES = {
  pet: { widget: false, pet: true },
  widget: { widget: true, pet: false },
  both: { widget: true, pet: true },
}

/**
 * 文本手术改写 cordis.patch.yml 中 live2d-companion 条目的 config。
 * 行级定位 `- id: live2d-companion` 块（止于下一个同级条目/insert 段/文件尾），
 * 块内重写 widget/pet 两行；无 config 块则补建。找不到条目返回 undefined。
 * 缩进不写死：全部从上下文行派生，用户手改过的 patch.yml（缩进风格不同）不会被写坏。
 */
function rewriteLive2dConfig(src, cfg) {
  const indentOf = (l) => l.match(/^\s*/)[0]
  const lines = src.split('\n')
  const idIdx = lines.findIndex((l) => /^\s*-\s*id:\s*live2d-companion\s*$/.test(l))
  if (idIdx === -1) return undefined
  let end = lines.length
  for (let i = idIdx + 1; i < lines.length; i++) {
    if (/^\s*-\s+id:/.test(lines[i]) || /^\s*-\s*insert:/.test(lines[i])) { end = i; break }
  }
  const block = lines.slice(idIdx, end).filter((l) => !/^\s+(widget|pet):/.test(l))
  const configIdx = block.findIndex((l) => /^\s*config:\s*$/.test(l))
  if (configIdx === -1) {
    const nameIdx = block.findIndex((l) => /^\s*name:/.test(l))
    // 以 name 行缩进为基准补建 config 块
    const base = indentOf(block[nameIdx === -1 ? 0 : nameIdx])
    block.splice(nameIdx === -1 ? 1 : nameIdx + 1, 0, `${base}config:`, `${base}  widget: ${cfg.widget}`, `${base}  pet: ${cfg.pet}`)
  } else {
    // 键缩进沿用 config 下既有子键；没有则 config 行缩进 +2
    const cIndent = indentOf(block[configIdx])
    const child = block.slice(configIdx + 1).find((l) => l.trim() !== '' && indentOf(l).length > cIndent.length)
    const kIndent = child ? indentOf(child) : cIndent + '  '
    block.splice(configIdx + 1, 0, `${kIndent}widget: ${cfg.widget}`, `${kIndent}pet: ${cfg.pet}`)
  }
  lines.splice(idIdx, end - idIdx, ...block)
  return lines.join('\n')
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.moc3': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
}

const INDEX_TAG = '<script src="/live2d/boot.js" type="module"></script>'
const DONE_HOLD_MS = 6000
const ERROR_HOLD_MS = 4500

/**
 * Normalize a user-supplied model reference: a POSIX-relative path under
 * `public/model/` ending in `.model3.json`. Returns `undefined` for anything
 * that could escape the model directory.
 * @param model - the raw model reference from config, query, or request body.
 * @returns the normalized slash-separated path, or `undefined` when invalid.
 */
function normalizeModelRef(model) {
  if (typeof model !== 'string' || model.includes('\0')) return undefined
  const rel = model.replaceAll('\\', '/').replace(/^\/+/, '')
  if (rel === '' || rel.length > 512 || !rel.toLowerCase().endsWith('.model3.json')) return undefined
  const parts = rel.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.includes(':'))) return undefined
  return rel
}

/** Resolve a normalized model reference to its absolute file path. */
function modelFile(ref) {
  const rel = normalizeModelRef(ref)
  return rel === undefined ? undefined : join(MODEL_DIR, ...rel.split('/'))
}

/** Reject path segments that could escape the model directory or the import target. */
function safePathSegment(segment, maxLength) {
  if (typeof segment !== 'string' || segment === '' || segment === '.' || segment === '..') return false
  if (segment.length > maxLength || segment.includes('\0')) return false
  if (segment.includes('/') || segment.includes('\\') || segment.includes(':')) return false
  // Windows 保留名（含带后缀形式）：writeFile 必失败且会触发未捕获异常路径
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment)) return false
  return !segment.startsWith('.')
}

/** Split a browser-upload relative path into safe slash-separated parts. */
function splitSafeRelPath(path) {
  if (typeof path !== 'string' || path.includes('\0')) return undefined
  const rel = path.replaceAll('\\', '/').replace(/^\/+/, '')
  if (rel === '' || rel.length > 512) return undefined
  const parts = rel.split('/')
  if (parts.some(part => !safePathSegment(part, 255))) return undefined
  return parts
}

/**
 * 白名单清洗绑定档案：只保留合法形状，拒绝注入任意键值。
 * 槽位键须为标识符；表情名为短字符串；动作引用为 [安全组名, 0-99 序号]。
 * @returns 清洗后的档案对象，形状非法时返回 undefined。
 */
function sanitizeProfile(profile) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return undefined
  const SLOT_KEY = /^[a-zA-Z][\w-]{0,31}$/
  const motionRef = (v) => Array.isArray(v) && v.length === 2
    && typeof v[0] === 'string' && safePathSegment(v[0], 64)
    && Number.isInteger(v[1]) && v[1] >= 0 && v[1] <= 99 ? [v[0], v[1]] : undefined
  const clean = {}
  if (profile.expressions !== undefined) {
    if (profile.expressions === null || typeof profile.expressions !== 'object' || Array.isArray(profile.expressions)) return undefined
    clean.expressions = {}
    for (const [slot, name] of Object.entries(profile.expressions)) {
      if (!SLOT_KEY.test(slot) || typeof name !== 'string' || name.length === 0 || name.length > 128 || /[/\\:\0]/.test(name)) return undefined
      clean.expressions[slot] = name
    }
  }
  if (profile.motions !== undefined) {
    if (profile.motions === null || typeof profile.motions !== 'object' || Array.isArray(profile.motions)) return undefined
    clean.motions = {}
    for (const [slot, ref] of Object.entries(profile.motions)) {
      if (!SLOT_KEY.test(slot)) return undefined
      if (slot === 'clickPool') {
        if (!Array.isArray(ref) || ref.length > 32) return undefined
        const pool = ref.map(motionRef)
        if (pool.some(p => p === undefined)) return undefined
        clean.motions.clickPool = pool
      } else {
        const m = motionRef(ref)
        if (m === undefined) return undefined
        clean.motions[slot] = m
      }
    }
  }
  if (clean.expressions === undefined && clean.motions === undefined) return undefined
  return clean
}

// 台词库白名单校验：pools 为 {池名: [台词…]}，池名限小写字母/下划线（≤32），
// 每池 1-200 条、每条 1-300 字符；rotation/behavior 若提供须为 0-3600000 的纯数字表。
function sanitizeQuips(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  if (body.pools === null || typeof body.pools !== 'object' || Array.isArray(body.pools)) return undefined
  const keys = Object.keys(body.pools)
  if (keys.length > 50) return undefined
  const pools = {}
  for (const [key, value] of keys.map((k) => [k, body.pools[k]])) {
    if (!/^[a-z_]{1,32}$/.test(key)) return undefined
    if (!Array.isArray(value) || value.length === 0 || value.length > 200) return undefined
    if (!value.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 300)) return undefined
    pools[key] = value
  }
  const clean = { pools }
  for (const section of ['rotation', 'behavior']) {
    if (body[section] !== undefined) {
      const v = body[section]
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
      if (!Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 3600000)) return undefined
      clean[section] = v
    }
  }
  return clean
}

export function apply(ctx, config) {
  const configModel = normalizeModelRef(config?.model) ?? DEFAULT_MODEL
  let modelPath = configModel
  if (existsSync(SELECTION_FILE)) {
    try {
      const persisted = JSON.parse(readFileSync(SELECTION_FILE, 'utf8'))
      const persistedRef = normalizeModelRef(persisted?.model)
      const persistedFile = persistedRef === undefined ? undefined : modelFile(persistedRef)
      if (persistedFile !== undefined && existsSync(persistedFile)) {
        modelPath = persistedRef
      } else {
        ctx.logger.warn('live2d companion: ignoring invalid or missing persisted model selection')
      }
    } catch (error) {
      ctx.logger.warn(`live2d companion: failed to read persisted model selection: ${String(error)}`)
    }
  }

  const perSession = new Map()
  const sessionLabels = new Map()   // 会话 id → 任务编号（任务一/任务二…指示灯用）
  const sseClients = new Set()
  let current = 'idle'
  let lastPayload = ''

  /** 分配任务编号：取最小空闲数字，会话销毁后编号回收复用。 */
  function labelFor(id) {
    let n = sessionLabels.get(id)
    if (n === undefined) {
      const used = new Set(sessionLabels.values())
      n = 1
      while (used.has(n)) n++
      sessionLabels.set(id, n)
    }
    return n
  }

  /** 每会话状态快照（编号升序），多任务指示灯的数据源。 */
  function sessionsSnapshot() {
    const list = []
    for (const [id, entry] of perSession) list.push({ n: labelFor(id), state: entry.state })
    list.sort((a, b) => a.n - b.n)
    return list
  }

  const rank = { working: 5, waiting: 4, thinking: 3, error: 2, done: 1, idle: 0 }

  const RAW_EVENTS = new Set([
    'turn/start', 'turn/end', 'assistant/chunk',
    'tool/call', 'tool-workflow/run-start', 'subagent/descriptor',
    'approval/asked', 'approval/decided', 'llm/retry-started',
  ])

  /** SSE 写帧：断连竞态下 write 可能抛 ERR_STREAM_DESTROYED，吞掉并剔除死客户端，绝不上抛宿主。 */
  function sseWrite(res, frame) {
    try { res.write(frame) } catch { sseClients.delete(res) }
  }

  function broadcastRaw(type, id) {
    const frame = `data: ${JSON.stringify({ ev: type, n: labelFor(id) })}\n\n`
    for (const res of sseClients) sseWrite(res, frame)
  }

  function aggregate() {
    let best = 'idle'
    for (const entry of perSession.values()) {
      if (rank[entry.state] > rank[best]) best = entry.state
    }
    return best
  }

  function publish() {
    const next = aggregate()
    // 帧内容判重而非仅聚合态判重：会话数/分工变化（聚合态不变）也要推给指示灯
    const payload = JSON.stringify({ state: next, sessions: sessionsSnapshot() })
    if (payload === lastPayload) return
    lastPayload = payload
    current = next
    const frame = `data: ${payload}\n\n`
    for (const res of sseClients) sseWrite(res, frame)
  }

  function broadcastModel() {
    const frame = `data: ${JSON.stringify({ model: modelPath })}\n\n`
    for (const res of sseClients) sseWrite(res, frame)
  }

  function sendJson(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  /** 变更类路由仅允许本机来源：DSH web 若被绑到 0.0.0.0/暴露到局域网，挡住远端写模型目录。 */
  function isLocalReq(req) {
    const addr = req.socket.remoteAddress
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  }

  /**
   * 写路由再加同源闸：本机地址校验挡不住「用户浏览恶意网页 → 浏览器向 127.0.0.1 发简单请求」
   * 的 CSRF/DNS-rebind。浏览器跨站请求必带 Origin，校验其为本机回环；curl/electron 无 Origin 放行。
   */
  function isLocalWriteReq(req) {
    if (!isLocalReq(req)) return false
    const origin = req.headers.origin
    if (!origin || origin === 'null') return true
    try {
      const host = new URL(origin).hostname
      return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
    } catch { return false }
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = ''
      let oversized = false
      req.setEncoding('utf8')
      req.on('data', chunk => {
        if (oversized) return // 超限即停读入内存，等 end 统一拒绝
        body += chunk
        if (body.length > MAX_SELECTION_BYTES) { oversized = true; body = '' }
      })
      req.on('end', () => {
        if (oversized) {
          reject(new Error('request body too large'))
          return
        }
        try {
          resolve(JSON.parse(body || '{}'))
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })
  }

  function readRawBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let oversized = false
      req.on('data', chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > maxBytes) oversized = true
        else chunks.push(buffer)
      })
      req.on('end', () => {
        if (oversized) reject(new Error('file too large'))
        else resolve(Buffer.concat(chunks))
      })
      req.on('error', reject)
    })
  }

  async function collectModels() {
    const models = []
    async function walk(dir, rel) {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return // no model directory yet: the panel shows an empty list
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const abs = join(dir, entry.name)
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) {
          await walk(abs, childRel)
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.model3.json')) {
          models.push({ path: childRel, dir: rel, file: entry.name })
        }
      }
    }
    await walk(MODEL_DIR, '')
    return models
  }

  /**
   * 闲置收割：会话转入 idle 后 5 分钟无活动即从看板除名（任务灯消失、编号回收）。
   * 会话再来事件会重新注册领牌——这是除 session/disposed 外的第二条回收路径，
   * 防「已完成任务灯变墓碑」与 perSession 无界增长。
   */
  const IDLE_REAP_MS = 5 * 60 * 1000
  function armReap(id, entry) {
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (entry.state === 'idle') {
        perSession.delete(id)
        sessionLabels.delete(id)
        publish()
      }
    }, IDLE_REAP_MS)
  }

  function setState(id, state) {
    const entry = perSession.get(id) ?? { state: 'idle', timer: undefined }
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    entry.state = state
    if (state === 'done') {
      entry.timer = setTimeout(() => {
        entry.timer = undefined
        if (entry.state === 'done') {
          entry.state = 'idle'
          publish()
          armReap(id, entry)  // 完成→闲置后进入收割倒计时
        }
      }, DONE_HOLD_MS)
    } else if (state === 'error') {
      entry.timer = setTimeout(() => {
        entry.timer = undefined
        if (entry.state === 'error') {
          entry.state = 'thinking'
          publish()
        }
      }, ERROR_HOLD_MS)
    }
    perSession.set(id, entry)
    publish()
  }

  ctx.on('session/event', (session, event) => {
    if (RAW_EVENTS.has(event.type)) broadcastRaw(event.type, session.id)
    switch (event.type) {
      case 'turn/start':
        setState(session.id, 'thinking')
        break
      case 'assistant/chunk':
        if (!['working', 'waiting'].includes(perSession.get(session.id)?.state ?? 'idle')) setState(session.id, 'thinking')
        break
      case 'tool/call':
      case 'tool-workflow/run-start':
      case 'subagent/descriptor':
        setState(session.id, 'working')
        break
      case 'approval/asked':
        setState(session.id, 'waiting')
        break
      case 'approval/decided':
        setState(session.id, 'working')
        break
      case 'llm/retry-started':
        setState(session.id, 'error')
        break
      case 'turn/end':
        setState(session.id, 'done')
        break
    }
  }, { global: true })

  ctx.on('session/disposed', (session) => {
    const entry = perSession.get(session.id)
    if (entry?.timer !== undefined) clearTimeout(entry.timer)
    perSession.delete(session.id)
    sessionLabels.delete(session.id)  // 编号回收，下个新会话复用
    publish()
  }, { global: true })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/state-stream',
    handler(req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      sseClients.add(res)
      sseWrite(res, `data: ${JSON.stringify({ state: current, model: modelPath, sessions: sessionsSnapshot() })}\n\n`)
      req.on('close', () => { sseClients.delete(res) })
    },
  }))

  // SSE 心跳：25 秒注释帧。客户端被杀死而 TCP 未 RST 的半开连接会在
  // 写失败时被 sseWrite 自动剔除，防止 sseClients 只增不减、广播成本线性膨胀。
  ctx.effect(() => {
    const hb = setInterval(() => {
      for (const res of sseClients) sseWrite(res, ': ka\n\n')
    }, 25000)
    return () => clearInterval(hb)
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/config',
    handler(req, res) {
      sendJson(res, 200, {
        model: modelPath,
        defaultModel: configModel,
        pet: config?.pet === true,
        widget: config?.widget !== false,
      })
    },
  }))

  // 显示模式切换：改写 cordis.patch.yml 本插件 config，补丁层热重载即时重挂载。
  // pet→ 桌宠 spawn/回收随重挂载自动发生；widget→ 挂件注入随下次 index 请求生效（前端提示刷新页面）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/mode',
    handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end('method not allowed')
        return
      }
      if (!isLocalWriteReq(req)) {
        sendJson(res, 403, { error: 'this route is local-only' })
        return
      }
      readJsonBody(req).then(parsed => {
        try {
          const cfg = DISPLAY_MODES[parsed.mode]
          if (cfg === undefined) {
            sendJson(res, 400, { error: 'mode must be one of pet/widget/both' })
            return
          }
          if (!existsSync(PATCH_FILE)) {
            sendJson(res, 500, { error: `patch file not found: ${PATCH_FILE}` })
            return
          }
          const next = rewriteLive2dConfig(readFileSync(PATCH_FILE, 'utf8'), cfg)
          if (next === undefined) {
            sendJson(res, 500, { error: 'live2d-companion entry not found in cordis.patch.yml' })
            return
          }
          // 手动切到含桌宠的模式：解除 spawn 节流，确保热重挂载时桌宠立刻回来
          if (cfg.pet) lastPetSpawnAt = 0
          // 原子写：tmp+rename，崩溃中途不会把用户 patch 文件截成半截
          const tmp = PATCH_FILE + '.tmp'
          writeFileSync(tmp, next)
          renameSync(tmp, PATCH_FILE)
          sendJson(res, 200, { mode: parsed.mode, ...cfg, hotReload: true })
        } catch (error) {
          sendJson(res, 500, { error: `failed to switch mode: ${String(error)}` })
        }
      }, error => {
        sendJson(res, 400, { error: `invalid request body: ${String(error)}` })
      })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/state',
    handler(req, res) {
      sendJson(res, 200, { state: current })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/models',
    async handler(req, res) {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end('method not allowed')
        return
      }
      try {
        sendJson(res, 200, { current: modelPath, defaultModel: configModel, models: await collectModels() })
      } catch (error) {
        sendJson(res, 500, { error: `failed to scan models: ${String(error)}` })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/model',
    handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end('method not allowed')
        return
      }
      if (!isLocalWriteReq(req)) {
        sendJson(res, 403, { error: 'this route is local-only' })
        return
      }
      readJsonBody(req).then(parsed => {
        try {
          if (parsed.reset === true) {
            rmSync(SELECTION_FILE, { force: true })
            modelPath = configModel
            broadcastModel()
            sendJson(res, 200, { model: modelPath, defaultModel: configModel, reset: true })
            return
          }
          // 删除模型目录：只删真模型目录（内含 .model3.json），当前在用则回落默认
          if (typeof parsed.delete === 'string') {
            const dir = parsed.delete
            if (!safePathSegment(dir, 128)) {
              sendJson(res, 400, { error: 'dir is invalid' })
              return
            }
            const target = join(MODEL_DIR, dir)
            if (!existsSync(target)) {
              sendJson(res, 404, { error: `model dir not found: ${dir}` })
              return
            }
            if (!readdirSync(target).some((f) => f.endsWith('.model3.json'))) {
              sendJson(res, 400, { error: `${dir} does not look like a model dir` })
              return
            }
            rmSync(target, { recursive: true, force: true })
            let reset = false
            if (modelPath.startsWith(dir + '/')) {
              rmSync(SELECTION_FILE, { force: true })
              modelPath = configModel
              broadcastModel()
              reset = true
            }
            sendJson(res, 200, { deleted: dir, reset })
            return
          }
          const ref = normalizeModelRef(parsed.model)
          const file = ref === undefined ? undefined : modelFile(ref)
          if (file === undefined) {
            sendJson(res, 400, { error: 'model must be a relative path ending in .model3.json' })
            return
          }
          if (!existsSync(file)) {
            sendJson(res, 404, { error: `model not found: ${ref}` })
            return
          }
          writeFileSync(SELECTION_FILE, JSON.stringify({ model: ref, updatedAt: new Date().toISOString() }, null, 2) + '\n')
          modelPath = ref
          broadcastModel()
          sendJson(res, 200, { model: modelPath, defaultModel: configModel })
        } catch (error) {
          // 文件被锁/EACCES 等写盘异常绝不能逃逸成 unhandled rejection 崩掉宿主
          sendJson(res, 500, { error: `failed to persist selection: ${String(error)}` })
        }
      }, error => {
        sendJson(res, 400, { error: `invalid request body: ${String(error)}` })
      })
    },
  }))

  // ══ 游戏中心：本地引擎裁决 + 本地 AI 执子 + LLM 解说（在线）/本地台词（离线）══
  // 架构要点：
  // - 注册表：游戏描述符在 games/<id>/ 登记（引擎/AI/解说提示词/台词池），路由全游戏无关；
  //   新游戏 = 一个目录 + 顶部一次 registerGame，hub chips/路由/快照自动接入
  // - 执子：本地 AI 按难度分档（LLM 听不懂难度指令，且逐手工具调用的延迟不可接受）；
  //   在线模式的 LLM 只做「解说员」——不碰引擎、无工具、单轮问答
  // - 同步：AI 落子在引擎内即时完成，但响应扣到解说就位再返回——前端收到响应时
  //   落子动画与解说语句同帧出现；解说 25s 超时/失败静默落回本地台词池，对局永不卡死
  /** 当前对局（单局制）。 */
  const gameRef = { current: null }
  // game = { game: 描述符, engine, ai, handle, agent, mode, difficulty, userTitle, presetId, busy, commentary, createdAt }

  function gameStateJson() {
    const g = gameRef.current
    if (!g) return { status: 'idle' }
    const over = g.game.isOver(g.engine)
    return {
      status: over.over ? 'over' : 'playing',
      game: g.game.id,
      ...g.game.snapshot(g.engine),
      winner: over.winner,   // 1=玩家胜 2=AI胜 -1=平局
      busy: g.busy,
      mode: g.mode,
      difficulty: g.difficulty,
      presetId: g.presetId,
      commentary: g.commentary.slice(-20),
      createdAt: g.createdAt,
    }
  }

  async function disposeGame() {
    const g = gameRef.current
    gameRef.current = null
    if (g) { try { await g.handle?.dispose() } catch { } }
  }
  // 插件重挂载/卸载时拆除对局 agent，防孤儿会话
  ctx.effect(() => () => { void disposeGame() })

  /** 称呼消毒：1~12 个文字/数字/常见符号，拒绝控制字符与提示词注入面。 */
  const sanitizeTitle = (raw) => (typeof raw === 'string' && /^[\p{L}\p{N} _\-~·]{1,12}$/u.test(raw.trim())) ? raw.trim() : '主人'

  const DIFF_NAME = { easy: '简单', normal: '普通', hard: '困难', alphago: '阿尔法狗' }
  const pickQuip = (arr) => arr[Math.floor(Math.random() * arr.length)]

  /** 终局系统播报（玩家胜/AI胜/平局统一出口）。 */
  function pushOutcome(g) {
    const over = g.game.isOver(g.engine)
    if (!over.over) return
    const lines = g.game.outcomeLines(g.engine)
    pushLine(g, { from: 'system', text: over.winner === 1 ? lines.playerWin : over.winner === 2 ? lines.aiWin : lines.draw })
  }

  /** 解说流水追加+截断：单局长局（五子棋满盘 225 手）不无界增长。 */
  function pushLine(g, item) {
    g.commentary.push(item)
    if (g.commentary.length > 60) g.commentary.splice(0, g.commentary.length - 60)
  }

  /** 本地台词兜底（离线模式与解说超时共用）：按情境选池，称呼替换。playerWin=true 时用服输池。 */
  function fallbackQuip(g, mv, aiWin, playerWin = false) {
    if (playerWin && g.game.quips.lose) {
      return pickQuip(g.game.quips.lose).replaceAll('主人', g.userTitle ?? '主人')
    }
    const key = (g.game.pickQuipKey ?? defaultQuipKey)(mv, { win: aiWin })
    const pool = g.game.quips[key] ?? g.game.quips.normal
    return pickQuip(pool).replaceAll('主人', g.userTitle ?? '主人')
  }

  /**
   * 对局 agent 单轮问答公共件：followup + 25s 超时 + 超时 cancel（防尸体占队列串台）
   * + 代际校验 + 按回合 id 切片提取文本。返回回复文本；超时/出错/换局返回 null。
   * 解说管道与阿尔法狗对局管道共用。
   */
  let commentSeq = 0
  async function askAgent(g, promptText, timeoutMs = 25000) {
    const seqBefore = g.agent.session.seq
    const myId = `game-${Date.now()}-${++commentSeq}`   // 唯一回合键：事件切片对齐用
    g.agent.followup(/** @type {any} */ ({
      id: myId,
      role: 'user',
      content: [{ type: 'text', text: promptText }],
      source: { kind: 'plugin', plugin: 'dsh-live2d-companion' },
    }))
    let timeoutHandle
    try {
      await Promise.race([
        g.agent.whenIdle(),
        new Promise((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error('对局回复超时')), timeoutMs) }),
      ])
    } catch {
      try { g.agent.cancel(/** @type {any} */ ({ kind: 'hook', reason: 'game agent turn timeout' })) } catch { }
      return null
    } finally {
      clearTimeout(timeoutHandle)
    }
    // 代际校验：等待期间主人开了新局（disposeGame），本回复属于旧局——丢弃不回写
    if (gameRef.current !== g) return null
    // 切片对齐本轮 followup：旧 turn 迟到的文本落在 seqBefore 之后也不认账（防串台双保险）
    const events = g.agent.session.events
    let startIdx = seqBefore
    for (let i = events.length - 1; i >= seqBefore; i--) {
      const d = events[i]?.data
      if (d && (d.message?.id === myId || d.id === myId)) { startIdx = i; break }
    }
    const turnEvents = events.slice(startIdx)
    const text = turnEvents
      .filter((e) => e.type === 'assistant/message')
      .map((e) => (e.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''))
      .join('').trim()
    return text || null
  }

  /** 解说管道：人格化 agent 以「对局者本人」角色逐手碎语（无工具、单轮问答）。 */
  async function commentate(g, playerDesc, aiDesc) {
    const over = g.game.isOver(g.engine)
    const firstBrief = g.engine.moveCount <= 2 ? g.game.commentatorBrief(g.userTitle ?? '主人') + '\n' : ''
    const overLine = over.over ? '\n这手之后对局结束：赢了小得意，输了大方服输夸对方，情绪拉满。' : ''
    const titleLine = `\n对方是「${g.userTitle ?? '主人'}」，用这个名字称呼对方，绝不叫「他/她/对手」。`
    return askAgent(g,
      `${firstBrief}对方刚走了：${playerDesc}${aiDesc ? `。你回应了：${aiDesc}` : '——这一手直接终结了比赛'}。`
      + `\n当前局面：\n${g.game.boardText(g.engine)}${overLine}${titleLine}`
      + '\n说出你此刻边下边说的话：先对对方这手给个真实反应（惊讶/得意/不服/警惕都行），'
      + '再带出你这手的打算或心情。一句口语，40 字内，别用解说腔，别复述坐标，别每句都以称呼开头。')
  }

  /**
   * 阿尔法狗对局管道：LLM 亲自执子。闭合标签协议——走法写在 <move>…</move> 里，
   * 标签之外全是台词，一次调用走子+狠话同产；
   * 无闭合标签/走法非法重试一次（带失败诊断），再失败/超时返回 null（本地 hard AI + 本地台词兜底）。
   */
  async function llmDuel(g, playerDesc) {
    const spec = g.game.llmMoveSpec?.(g.engine, playerDesc ?? '')
    if (!spec) return null
    const titleLine = `\n对方是「${g.userTitle ?? '主人'}」，用这个名字称呼对方，绝不叫「他/她/对手」。`
    const firstBrief = g.engine.moveCount <= 2 ? g.game.commentatorBrief(g.userTitle ?? '主人') + '\n' : ''
    const banterOf = (reply) => String(reply ?? '')
      .replace(/<move>\s*[\s\S]*?\s*<\/move>/i, ' ')
      .split('\n').map((s) => s.trim()).filter(Boolean).join(' ').slice(0, 120)
    let reply = await askAgent(g, firstBrief + spec.prompt + titleLine)
    let move = reply ? spec.parse(reply) : null
    const firstBanter = banterOf(reply)
    if (!move && reply !== null) {
      // 没解析出合法走法：带失败诊断重答一次（压缩到 15s——两连超时不该拖 50s）
      reply = await askAgent(g, spec.prompt
        + '\n注意：你上一条回复的走法被裁判打回了——原因只会是这三种：没有闭合的 <move>…</move> 标签、'
        + '选的位置已经有棋子/越界、或不在合法走法清单里。看清棋盘上的 · 空位（或清单条目）重来。' + titleLine, 15000)
      move = reply ? spec.parse(reply) : null
    }
    if (!move) return null
    // 台词=抠掉走法标签块后的剩余文本；重试成功的回复没台词时打捞首答的（没有则 null 落本地台词池）
    const banter = banterOf(reply) || firstBanter
    return { move, text: banter || null }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/game/list',
    handler(req, res) {
      // 游戏目录：游戏中心卡片的统一入口数据源。新游戏在 games/ 注册即出现。
      sendJson(res, 200, { games: listGames() })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/game/models',
    async handler(req, res) {
      const sel = ctx.agentDefaultModel.currentSelection()
      const list = []
      // 首选：适配器实时发现的网关模型目录（GUI 模型选择器的数据源）
      try {
        for (const m of await ctx.llm.listModels(sel.provider)) {
          if (m && typeof m.id === 'string') list.push({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id })
        }
      } catch { }
      // 兜底：settings 的 models 命名空间（部分部署不注册该命名空间）
      if (list.length === 0) {
        try {
          const raw = ctx.settings?.get?.(/** @type {any} */ ('models'))
          if (Array.isArray(raw)) {
            for (const m of raw) {
              if (m && typeof m.id === 'string') list.push({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id })
            }
          }
        } catch { }
      }
      if (!list.some((m) => m.id === sel.model)) list.unshift({ id: sel.model, name: sel.model })
      sendJson(res, 200, { defaultModel: sel.model, provider: sel.provider, models: list })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/game/presets',
    async handler(req, res) {
      try {
        const presets = await ctx.agentPresets.list()
        sendJson(res, 200, {
          presets: presets.map((p) => ({ id: p.id, name: p.metadata?.name ?? p.id })),
          defaultId: ctx.agentPresets.defaultId,
        })
      } catch (error) {
        sendJson(res, 500, { error: String(error) })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/game/state',
    handler(req, res) {
      if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end('method not allowed'); return }
      sendJson(res, 200, gameStateJson())
    },
  }))

  /** 开局串行闸：createAgent 是异步让出点，并发 new 会泄漏孤儿 agent 句柄（无人 dispose）。 */
  let newGameInFlight = false

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/game/new',
    handler(req, res) {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end('method not allowed'); return }
      if (!isLocalWriteReq(req)) { sendJson(res, 403, { error: 'this route is local-only' }); return }
      readJsonBody(req).then(async (parsed) => {
        if (newGameInFlight) { sendJson(res, 409, { error: '正在开局，请稍候' }); return }
        newGameInFlight = true
        try {
          const gameId = typeof parsed.game === 'string' ? parsed.game : 'gomoku'
          const def = getGame(gameId)
          if (!def) { sendJson(res, 400, { error: `unknown game: ${String(gameId).slice(0, 40)}` }); return }
          const mode = parsed.mode === 'offline' ? 'offline' : 'online'
          const difficulty = ['easy', 'normal', 'hard', 'alphago'].includes(parsed.difficulty) ? parsed.difficulty : 'normal'
          // 阿尔法狗=LLM 亲自执子，必须有在线 agent；离线选了它直接拒（前端也有同款拦截）
          if (difficulty === 'alphago' && mode === 'offline') {
            sendJson(res, 400, { error: '阿尔法狗难度需要在线模式——它由你的模型亲自执子' })
            return
          }
          if (difficulty === 'alphago' && !def.llmMoveSpec) {
            sendJson(res, 400, { error: `${def.name} 还不支持阿尔法狗难度` })
            return
          }
          const userTitle = sanitizeTitle(parsed.userTitle)
          await disposeGame()
          const engine = def.createEngine()
          // 执子者：本地 AI（难度分档在本地生效）；阿尔法狗局也建 hard 档本地 AI——LLM 超时/乱答时的兜底
          const ai = def.createAI(difficulty === 'alphago' ? 'hard' : difficulty)
          const startText = def.startLine?.(difficulty, mode)
            ?? `对局开始（${mode === 'offline' ? '本地对弈' : '在线解说'}·${DIFF_NAME[difficulty]}）。`
          // 离线模式：本地台词解说，不建 agent，秒回不耗 token
          if (mode === 'offline') {
            gameRef.current = {
              game: def, engine, ai, handle: null, agent: null,
              mode, difficulty, userTitle, presetId: null, busy: false,
              commentary: [{ from: 'system', text: startText }],
              createdAt: new Date().toISOString(),
            }
            sendJson(res, 200, gameStateJson())
            return
          }
          const sel = ctx.agentDefaultModel.currentSelection()
          // 模型自选：前端从 /game/models 清单选择；缺省跟随 GUI 默认。宽松校验防注入。
          const chosenModel = typeof parsed.model === 'string' && /^[\w.:-]{1,80}$/.test(parsed.model) ? parsed.model : sel.model
          const presetId = typeof parsed.preset === 'string' && parsed.preset !== '' ? parsed.preset : undefined
          const sessionId = /** @type {any} */ (`l2d-game-${gameId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
          const handle = await ctx.agentLoop.createAgent(ctx, {
            sessionId,
            meta: { cwd: homedir() },   // 不写死桌面路径：发布包在别人机器上该目录不存在
            agentOptions: /** @type {any} */ ({ provider: sel.provider, model: chosenModel }),
            setup: async (agentCtx) => {
              // 预设=解说人格：挂载失败裸跑兜底（解说变通用语气，游戏不受影响）
              try {
                await ctx.agentPresets.mount(agentCtx, presetId)
              } catch (e) {
                ctx.logger.warn(`live2d game: preset mount failed, bare agent fallback: ${String(e).slice(0, 200)}`)
              }
              // 对局 agent 零工具：deny 全局工具花名册（裁剪 prompt 体积+防乱用）。
              // 两道雷必须避：①run_code 是保留的 Code Mode 传输名，deny 它会整体 throw；
              // ②deny 未知/作用域名也会 throw——任何一道中招 restrict 全废，所以失败必须告警不许静默
              try {
                const roster = agentCtx.tools.schemas().map((s) => s.name).filter((n) => n !== 'run_code')
                if (roster.length > 0) agentCtx.tools.restrict({ deny: roster })
              } catch (e) {
                ctx.logger.warn(`live2d game: tool restrict failed (agent runs WITH tools!): ${String(e).slice(0, 200)}`)
              }
            },
          })
          gameRef.current = {
            game: def, engine, ai, handle, agent: handle.agent,
            mode, difficulty, userTitle,
            presetId: presetId ?? ctx.agentPresets.defaultId,
            busy: false,
            commentary: [{ from: 'system', text: startText }],
            createdAt: new Date().toISOString(),
          }
          sendJson(res, 200, gameStateJson())
        } catch (error) {
          sendJson(res, 500, { error: `开局失败：${String(error)}` })
        } finally {
          newGameInFlight = false
        }
      }, error => {
        sendJson(res, 400, { error: `invalid request body: ${String(error)}` })
      })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/game/move',
    handler(req, res) {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end('method not allowed'); return }
      if (!isLocalWriteReq(req)) { sendJson(res, 403, { error: 'this route is local-only' }); return }
      readJsonBody(req).then(async (parsed) => {
        const g = gameRef.current
        try {
          if (!g) { sendJson(res, 409, { error: '尚未开局' }); return }
          if (g.busy) { sendJson(res, 409, { error: '思考中，请稍候' }); return }
          g.busy = true
          // 玩家走子：描述符裁判（非法原样拒回，前端回滚乐观帧）
          const placed = g.game.playerMove(g.engine, parsed)
          if (!placed.ok) { g.busy = false; sendJson(res, 400, { error: placed.reason }); return }
          if (g.game.isOver(g.engine).over) {
            // 玩家制胜手终局：也要过解说管道——服输/夸奖的收场白是体验灵魂，不许静默收场
            const overNow = g.game.isOver(g.engine)
            let text = null
            if (g.mode === 'online' && g.agent) {
              text = await commentate(g, placed.desc, null)
            }
            // 代际校验：解说等待期间开了新局——不回写旧局
            if (gameRef.current !== g) { sendJson(res, 409, { error: '对局已更换，请以最新局面为准' }); return }
            if (!text) text = fallbackQuip(g, null, false, overNow.winner === 1)
            pushLine(g, { from: 'agent', text })
            pushOutcome(g)
            g.busy = false
            sendJson(res, 200, { ...gameStateJson(), aiMove: null })
            return
          }
          // AI 回合：阿尔法狗=LLM 亲自执子（走子+台词一次产出，失败兜底本地 hard AI）；
          // 其余难度=本地 AI 秒选。响应统一扣到解说/台词就位——动画与语句同帧出
          let mv = null
          let duelText = null
          if (g.difficulty === 'alphago' && g.mode === 'online' && g.agent) {
            const r = await llmDuel(g, placed.desc)
            if (gameRef.current !== g) { sendJson(res, 409, { error: '对局已更换，请以最新局面为准' }); return }
            if (r) { mv = r.move; duelText = r.text }
          }
          if (!mv) mv = await g.ai.pickMove(g.engine)
          if (!mv) {
            // 无合法手但引擎未判终局（防御性分支，正常不会发生）：按现状收局返回
            g.busy = false
            sendJson(res, 200, { ...gameStateJson(), aiMove: null })
            return
          }
          let aiDone = g.game.aiMove(g.engine, mv)
          if (!aiDone.ok && duelText !== null) {
            // 阿尔法狗走法被引擎二检拒（解析与裁判同源，理论不可达，兜底链最后一环）：
            // 丢弃 LLM 走法与台词，本地 hard AI 接管本手——回合不许无疾而终
            duelText = null
            mv = await g.ai.pickMove(g.engine)
            aiDone = mv ? g.game.aiMove(g.engine, mv) : { ok: false }
          }
          if (!aiDone.ok) {
            // 本地 AI 的手也被拒（当前两游戏不会触发，防御缺口先堵）
            g.busy = false
            sendJson(res, 200, { ...gameStateJson(), aiMove: null })
            return
          }
          const over = g.game.isOver(g.engine)
          // 解说：阿尔法狗的台词随走子同产（duelText）；其余在线=LLM 逐手碎语；离线/超时=本地台词池
          let text = duelText
          if (!text && g.mode === 'online' && g.agent) {
            text = await commentate(g, placed.desc, aiDone.desc)
          }
          // 代际校验：解说等待期间主人开了新局，本 handler 作用的是旧局——不回写状态
          if (gameRef.current !== g) { sendJson(res, 409, { error: '对局已更换，请以最新局面为准' }); return }
          if (!text) text = fallbackQuip(g, mv, over.over && over.winner === 2)
          pushLine(g, { from: 'agent', text })
          if (over.over) pushOutcome(g)
          g.busy = false   // 必须在 sendJson 前清：响应即回合终态，前端按 busy 渲染思考态
          sendJson(res, 200, { ...gameStateJson(), aiMove: mv })
        } catch (error) {
          if (g) g.busy = false
          sendJson(res, 500, { error: `回合失败：${String(error)}` })
        }
      }, error => {
        sendJson(res, 400, { error: `invalid request body: ${String(error)}` })
      })
    },
  }))



  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/import',
    handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end('method not allowed')
        return
      }
      if (!isLocalWriteReq(req)) {
        sendJson(res, 403, { error: 'this route is local-only' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://x')
      const modelName = url.searchParams.get('model') ?? ''
      const filePath = url.searchParams.get('path') ?? ''
      if (!safePathSegment(modelName, 128)) {
        sendJson(res, 400, { error: 'model folder name is invalid' })
        return
      }
      const parts = splitSafeRelPath(filePath)
      if (parts === undefined) {
        sendJson(res, 400, { error: 'file path is invalid' })
        return
      }
      readRawBody(req, MAX_IMPORT_FILE_BYTES).then(async buffer => {
        try {
          const target = join(MODEL_DIR, modelName, ...parts)
          // 静默覆盖防御：重名导入须显式 ?overwrite=1，防误传毁模型
          if (url.searchParams.get('overwrite') !== '1' && existsSync(target)) {
            sendJson(res, 409, { error: `文件已存在：${modelName}/${parts.join('/')}（确认覆盖请加 overwrite=1）` })
            return
          }
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, buffer)
          sendJson(res, 200, { imported: { model: modelName, path: parts.join('/'), bytes: buffer.length } })
        } catch (error) {
          // 写盘异常（锁/权限/磁盘满）兜底为 500，不许逃逸成 unhandled rejection
          sendJson(res, 500, { error: `failed to write import: ${String(error)}` })
        }
      }, error => {
        sendJson(res, error.message === 'file too large' ? 413 : 400, { error: error.message })
      })
    },
  }))

  // 绑定档案读写：可视化编辑器保存 profile.json / 恢复自动嗅探（删除档案）。
  // profile 只收白名单形状：expressions {槽位: 表情名}、motions {槽位: [组, 序号]}、clickPool [[组, 序号]]。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/profile',
    handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end('method not allowed')
        return
      }
      if (!isLocalWriteReq(req)) {
        sendJson(res, 403, { error: 'this route is local-only' })
        return
      }
      readJsonBody(req).then(async parsed => {
        try {
          const dir = typeof parsed.dir === 'string' && safePathSegment(parsed.dir, 128) ? parsed.dir : undefined
          if (dir === undefined) {
            sendJson(res, 400, { error: 'dir is invalid' })
            return
          }
          const file = join(MODEL_DIR, dir, 'profile.json')
          if (parsed.reset === true) {
            rmSync(file, { force: true })
            sendJson(res, 200, { reset: true })
            return
          }
          const clean = sanitizeProfile(parsed.profile)
          if (clean === undefined) {
            sendJson(res, 400, { error: 'profile shape is invalid' })
            return
          }
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, JSON.stringify(clean, null, 2) + '\n')
          sendJson(res, 200, { saved: `${dir}/profile.json` })
        } catch (error) {
          sendJson(res, 500, { error: `failed to write profile: ${String(error)}` })
        }
      }, error => {
        sendJson(res, 400, { error: `invalid request body: ${String(error)}` })
      })
    },
  }))

  // 台词预设列表：{active: 当前生效的预设名|null, presets: [预设名…]}。
  // 预设文件本体走静态路由直接读（quips-presets/<名>.json）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/quips-config',
    async handler(req, res) {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end('method not allowed')
        return
      }
      let active = null
      try {
        const p = JSON.parse(readFileSync(QUIPS_ACTIVE_FILE, 'utf8'))
        if (typeof p?.active === 'string' && safePathSegment(p.active, 64)) active = p.active
      } catch { }
      let presets = []
      try {
        presets = (await readdir(QUIPS_PRESETS_DIR))
          .filter((f) => f.endsWith('.json') && safePathSegment(f.slice(0, -5), 64))
          .map((f) => f.slice(0, -5))
          .sort()
      } catch { }
      if (active !== null && !presets.includes(active)) active = null
      sendJson(res, 200, { active, presets })
    },
  }))

  // 台词预设写盘：三个动作共用一路由（均为本机限定）。
  //   {save: 预设名, data: {pools…}}  新建/覆盖预设并设为生效
  //   {activate: 预设名|null}         仅切换生效预设（null=回官方默认）
  //   {delete: 预设名}                删除预设（若为生效预设则指针回 null）
  // 覆盖层与官方 quips.json 池级合并，用户自定义永不与上游更新冲突。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/quips',
    handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end('method not allowed')
        return
      }
      if (!isLocalWriteReq(req)) {
        sendJson(res, 403, { error: 'this route is local-only' })
        return
      }
      const writeActive = async (name) => {
        await writeFile(QUIPS_ACTIVE_FILE, JSON.stringify({ active: name }, null, 2) + '\n')
      }
      readJsonBody(req).then(async parsed => {
        try {
          if (typeof parsed.activate !== 'undefined') {
            if (parsed.activate !== null && (typeof parsed.activate !== 'string' || !safePathSegment(parsed.activate, 64))) {
              sendJson(res, 400, { error: 'activate is invalid' })
              return
            }
            await writeActive(parsed.activate)
            sendJson(res, 200, { active: parsed.activate })
            return
          }
          if (typeof parsed.delete === 'string') {
            if (!safePathSegment(parsed.delete, 64)) {
              sendJson(res, 400, { error: 'delete is invalid' })
              return
            }
            rmSync(join(QUIPS_PRESETS_DIR, parsed.delete + '.json'), { force: true })
            let active = null
            try { active = JSON.parse(readFileSync(QUIPS_ACTIVE_FILE, 'utf8'))?.active } catch { }
            if (active === parsed.delete) await writeActive(null)
            sendJson(res, 200, { deleted: parsed.delete })
            return
          }
          if (typeof parsed.save === 'string') {
            if (!safePathSegment(parsed.save, 64)) {
              sendJson(res, 400, { error: 'preset name is invalid' })
              return
            }
            const clean = sanitizeQuips(parsed.data)
            if (clean === undefined) {
              sendJson(res, 400, { error: 'quips shape is invalid' })
              return
            }
            await mkdir(QUIPS_PRESETS_DIR, { recursive: true })
            await writeFile(join(QUIPS_PRESETS_DIR, parsed.save + '.json'), JSON.stringify(clean, null, 2) + '\n')
            await writeActive(parsed.save)
            sendJson(res, 200, { saved: parsed.save })
            return
          }
          sendJson(res, 400, { error: 'need one of: save / activate / delete' })
        } catch (error) {
          sendJson(res, 500, { error: `failed to write preset: ${String(error)}` })
        }
      }, error => {
        sendJson(res, 400, { error: `invalid request body: ${String(error)}` })
      })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/live2d',
    async handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end('method not allowed')
        return
      }
      let pathname
      try {
        pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      } catch {
        res.writeHead(400)
        res.end('bad request')
        return
      }
      let rel = pathname.slice('/live2d'.length)
      if (rel === '' || rel === '/') rel = '/pet.html'
      const file = normalize(join(PUBLIC_DIR, rel))
      if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) {
        res.writeHead(403)
        res.end()
        return
      }
      let info
      try {
        info = await lstat(file)
      } catch {
        res.writeHead(404)
        res.end('not found')
        return
      }
      // 深度防御：public/ 内部的符号链接可逃逸前缀校验，一律拒读
      if (info.isSymbolicLink()) {
        res.writeHead(403)
        res.end()
        return
      }
      if (!info.isFile()) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': 'no-cache',
      })
      createReadStream(file).pipe(res)
    },
  }))

  if (config?.widget !== false) {
    ctx.effect(() => ctx.webServer.tapIndex(html =>
      html.includes(INDEX_TAG) ? html : html.replace('</body>', `${INDEX_TAG}</body>`)))
  }

  if (config?.pet === true) {
    const petDir = config?.petDir ?? fileURLToPath(new URL('./pet', import.meta.url))
    const exe = join(petDir, 'node_modules', 'electron', 'dist', 'electron.exe')
    if (existsSync(exe)) {
      /** 卸载不即杀：进入 8 秒收养窗口，超时无新实例才 taskkill（重挂载热更秒收养）。 */
      const schedulePetKill = (child) => {
        if (petKillTimer !== null) clearTimeout(petKillTimer)
        petKillTimer = setTimeout(() => {
          petKillTimer = null
          if (petChild !== child) return   // 已被收养/更替
          petChild = null
          try {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => { })
          } catch { }
        }, 8000)
      }
      // 宿主真退出时定时器随进程消失——exit 钩子同步兜底杀，防孤儿桌宠
      if (!petExitHookArmed) {
        petExitHookArmed = true
        process.on('exit', () => {
          if (petChild === null) return
          try {
            spawn('taskkill', ['/pid', String(petChild.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => { })
          } catch { }
        })
      }
      ctx.effect(() => {
        // 收养优先：重挂载（配置热更/端口重试）时旧桌宠还活着就直接续用——
        // 杀旧生新的窗口里新进程会被单实例锁弹回秒退，桌宠永远回不来（实测血案）
        if (petKillTimer !== null) { clearTimeout(petKillTimer); petKillTimer = null }
        if (petChild !== null && petChild.exitCode === null && !petChild.killed) {
          const adopted = petChild   // 闭包固化：处置器触发时模块变量可能已空（桌宠中途自退）
          ctx.logger.info(`live2d pet adopted (pid ${adopted.pid})`)
          return () => schedulePetKill(adopted)
        }
        // spawn 节流：cordis 效果若因宿主故障反复重挂载，30 秒内只拉一次桌宠。
        // 桌宠自身有单实例锁兜底，但反复 spawn 进程本身就是 CPU 灾难。
        const now = Date.now()
        if (now - lastPetSpawnAt < 30000) {
          ctx.logger.info('live2d pet spawn throttled (effect remounted within 30s)')
          return undefined
        }
        lastPetSpawnAt = now
        const petUrl = `http://127.0.0.1:${ctx.webServer.port}/live2d/pet.html`
        const child = spawn(exe, ['.'], {
          cwd: petDir,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, L2D_URL: petUrl },
        })
        // spawn 的 ENOENT 走异步 error 事件，try/catch 接不住——不监听会 uncaughtException 崩宿主
        child.on('error', (error) => ctx.logger.warn(`live2d pet spawn failed: ${String(error)}`))
        child.on('exit', () => { if (petChild === child) petChild = null })
        petChild = child
        child.unref()
        ctx.logger.info(`live2d pet spawned (pid ${child.pid}) -> ${petUrl}`)
        return () => schedulePetKill(child)
      })
    } else {
      ctx.logger.warn(`live2d pet enabled but electron not found at ${exe}`)
    }
  }

  ctx.logger.info('live2d companion mounted: /live2d/ assets, state stream')
}
