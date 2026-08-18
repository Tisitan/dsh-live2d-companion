import { createReadStream, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdir, readdir, lstat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

export const name = 'dsh-live2d-companion'
export const inject = ['webServer']

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
 */
function rewriteLive2dConfig(src, cfg) {
  const lines = src.split('\n')
  const idIdx = lines.findIndex((l) => /^\s*-\s*id:\s*live2d-companion\s*$/.test(l))
  if (idIdx === -1) return undefined
  let end = lines.length
  for (let i = idIdx + 1; i < lines.length; i++) {
    if (/^\s*-\s+id:/.test(lines[i]) || /^\s*-\s*insert:/.test(lines[i])) { end = i; break }
  }
  const block = lines.slice(idIdx, end).filter((l) => !/^\s+(widget|pet):/.test(l))
  const widgetLine = `        widget: ${cfg.widget}`
  const petLine = `        pet: ${cfg.pet}`
  const configIdx = block.findIndex((l) => /^\s*config:\s*$/.test(l))
  if (configIdx === -1) {
    const nameIdx = block.findIndex((l) => /^\s*name:/.test(l))
    block.splice(nameIdx === -1 ? 1 : nameIdx + 1, 0, '      config:', widgetLine, petLine)
  } else {
    block.splice(configIdx + 1, 0, widgetLine, petLine)
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
      if (!isLocalReq(req)) {
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
          writeFileSync(PATCH_FILE, next)
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
      if (!isLocalReq(req)) {
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

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/import',
    handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end('method not allowed')
        return
      }
      if (!isLocalReq(req)) {
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
      if (!isLocalReq(req)) {
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
      if (!isLocalReq(req)) {
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
      ctx.effect(() => {
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
        child.unref()
        ctx.logger.info(`live2d pet spawned (pid ${child.pid}) -> ${petUrl}`)
        return () => {
          try {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => { })
          } catch { }
        }
      })
    } else {
      ctx.logger.warn(`live2d pet enabled but electron not found at ${exe}`)
    }
  }

  ctx.logger.info('live2d companion mounted: /live2d/ assets, state stream')
}
