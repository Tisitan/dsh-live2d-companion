import { createReadStream, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-live2d-companion'
export const inject = ['webServer']

const PUBLIC_DIR = normalize(fileURLToPath(new URL('./public', import.meta.url)))
const MODEL_DIR = join(PUBLIC_DIR, 'model')
const SELECTION_FILE = fileURLToPath(new URL('./model-selection.json', import.meta.url))
const DEFAULT_MODEL = 'nori/ARGNori.model3.json'
const MAX_SELECTION_BYTES = 64 * 1024
const MAX_IMPORT_FILE_BYTES = 128 * 1024 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.moc3': 'application/octet-stream',
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
  const sseClients = new Set()
  let current = 'idle'

  const rank = { working: 5, waiting: 4, thinking: 3, error: 2, done: 1, idle: 0 }

  const RAW_EVENTS = new Set([
    'turn/start', 'turn/end', 'assistant/chunk',
    'tool/call', 'tool-workflow/run-start', 'subagent/descriptor',
    'approval/asked', 'approval/decided', 'llm/retry-started',
  ])

  function broadcastRaw(type) {
    const frame = `data: ${JSON.stringify({ ev: type })}\n\n`
    for (const res of sseClients) res.write(frame)
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
    if (next === current) return
    current = next
    const frame = `data: ${JSON.stringify({ state: current })}\n\n`
    for (const res of sseClients) res.write(frame)
  }

  function broadcastModel() {
    const frame = `data: ${JSON.stringify({ model: modelPath })}\n\n`
    for (const res of sseClients) res.write(frame)
  }

  function sendJson(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = ''
      let oversized = false
      req.setEncoding('utf8')
      req.on('data', chunk => {
        body += chunk
        if (body.length > MAX_SELECTION_BYTES) oversized = true
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
    if (RAW_EVENTS.has(event.type)) broadcastRaw(event.type)
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
      res.write(`data: ${JSON.stringify({ state: current, model: modelPath })}\n\n`)
      sseClients.add(res)
      req.on('close', () => { sseClients.delete(res) })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/config',
    handler(req, res) {
      sendJson(res, 200, { model: modelPath, defaultModel: configModel })
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
      readJsonBody(req).then(parsed => {
        if (parsed.reset === true) {
          rmSync(SELECTION_FILE, { force: true })
          modelPath = configModel
          broadcastModel()
          sendJson(res, 200, { model: modelPath, defaultModel: configModel, reset: true })
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
        const target = join(MODEL_DIR, modelName, ...parts)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, buffer)
        sendJson(res, 200, { imported: { model: modelName, path: parts.join('/'), bytes: buffer.length } })
      }, error => {
        sendJson(res, error.message === 'file too large' ? 413 : 400, { error: error.message })
      })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/live2d',
    async handler(req, res) {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
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
        info = await stat(file)
      } catch {
        res.writeHead(404)
        res.end('not found')
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
        const petUrl = `http://127.0.0.1:${ctx.webServer.port}/live2d/pet.html`
        const child = spawn(exe, ['.'], {
          cwd: petDir,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, L2D_URL: petUrl },
        })
        child.unref()
        ctx.logger.info(`live2d pet spawned (pid ${child.pid}) -> ${petUrl}`)
        return () => {
          try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { }
        }
      })
    } else {
      ctx.logger.warn(`live2d pet enabled but electron not found at ${exe}`)
    }
  }

  ctx.logger.info('live2d companion mounted: /live2d/ assets, state stream')
}
