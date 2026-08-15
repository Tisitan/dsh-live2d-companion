import { createReadStream, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-live2d-companion'
export const inject = ['webServer']

const PUBLIC_DIR = normalize(fileURLToPath(new URL('./public', import.meta.url)))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.moc3': 'application/octet-stream',
}

const INDEX_TAG = '<script src="/live2d/boot.js" defer></script>'
const DONE_HOLD_MS = 6000
const ERROR_HOLD_MS = 4500

export function apply(ctx, config) {
  const modelPath = config?.model ?? 'nori/ARGNori.model3.json'

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
      res.write(`data: ${JSON.stringify({ state: current })}\n\n`)
      sseClients.add(res)
      req.on('close', () => { sseClients.delete(res) })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/config',
    handler(req, res) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ model: modelPath }))
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/live2d/state',
    handler(req, res) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ state: current }))
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
