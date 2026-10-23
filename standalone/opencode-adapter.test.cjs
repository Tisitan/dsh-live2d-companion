const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const { test } = require('node:test')

const source = fs.readFileSync(path.join(__dirname, 'adapters', 'opencode-live2d.js'), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replace('export const Live2DCompanion', 'const Live2DCompanion')
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const answer = text => ({ data: { parts: [{ type: 'text', text }] } })
const job = (id, extra = {}) => ({
  id, channel: 'chat', profileId: 'profile-a', profileRevision: '1', persona: 'Persona A',
  message: id, memory: 'local fallback memory', memoryMode: 'local', memoryCandidates: [], ...extra,
})
const semanticJob = id => job(id, { memoryMode: 'opencode', memoryCandidates: [{ id: 'M1', text: 'semantic memory' }] })

// Execute the real adapter in an isolated VM. Only its filesystem, HTTP and
// clock boundaries are fixtures; SDK deadlines advance without waiting minutes.
async function fixture(jobs = [], overrides = {}, realClient = null) {
  const calls = [], replies = [], events = [], intervals = new Map(), timers = new Map()
  let now = 0, timerId = 0, nextRequests = 0, heartbeats = 0, nextSessionId = 0
  const session = {}
  const f = { calls, replies, events, jobs, session }
  for (const method of ['create', 'prompt', 'abort', 'delete']) {
    session[method] = options => {
      assert.ok(options.signal instanceof AbortSignal, `${method} must receive a signal`)
      assert.equal(options.throwOnError, true, `${method} must reject HTTP errors`)
      calls.push({ method, options })
      if (overrides[method]) return overrides[method](options, f)
      if (realClient) return realClient.session[method](options)
      if (method === 'create') return Promise.resolve({ data: { id: 'session-' + (++nextSessionId) } })
      return Promise.resolve(method === 'prompt' ? answer('reply') : { data: true })
    }
  }
  const factory = vm.runInNewContext(source + '\nLive2DCompanion', {
    path, URL, AbortSignal, AbortController,
    process: { env: { L2D_ADAPTER_FILE: 'in-memory-fixture' } },
    readFile: async name => {
      assert.equal(name, 'in-memory-fixture')
      return JSON.stringify({ endpoint: 'http://127.0.0.1:1/live2d/adapter', token: 'fixture-only' })
    },
    setInterval: (fn, ms) => { intervals.set(ms, fn); return { unref() {} } },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { due: now + ms, fn }); return id },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options = {}) => {
      const route = new URL(url).pathname
      if (route === '/live2d/chat/next') {
        nextRequests++
        return jobs.length ? new Response(JSON.stringify(jobs.shift())) : new Response(null, { status: 204 })
      }
      if (route === '/live2d/chat/heartbeat') heartbeats++
      else if (route === '/live2d/chat/reply') replies.push(JSON.parse(options.body))
      else if (route === '/live2d/adapter') events.push(JSON.parse(options.body))
      else throw new Error('Unexpected fixture route: ' + route)
      return new Response('{}')
    },
  })
  f.plugin = await factory({ client: { session } })
  f.poll = async () => { const pending = intervals.get(1000)(); await flush(); return { pending } }
  f.heartbeat = async () => { await intervals.get(5000)(); await flush() }
  f.advance = async ms => {
    const end = now + ms
    for (;;) {
      const entry = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0]
      if (!entry) break
      now = entry[1].due
      timers.delete(entry[0])
      entry[1].fn()
      await flush()
    }
    now = end
    await flush()
  }
  f.stats = () => ({ nextRequests, heartbeats, timers: timers.size })
  await flush()
  return f
}

test('reranking timeout falls back while abort and deletion are also stalled', async () => {
  const rerank = deferred(), abort = deferred(), deletion = deferred()
  const f = await fixture([semanticJob('first'), job('second')], {
    prompt: options => options.path.id === 'session-2' ? rerank.promise : Promise.resolve(answer('chat reply')),
    abort: () => abort.promise,
    delete: () => deletion.promise,
  })
  await f.heartbeat()
  assert.equal(f.stats().heartbeats, 2)
  await f.advance(8000)
  assert.equal(f.replies[0].text, 'chat reply')
  const prompts = f.calls.filter(call => call.method === 'prompt')
  assert.equal(prompts[0].options.signal.aborted, true)
  assert.match(prompts[1].options.body.parts[0].text, /local fallback memory/)
  await f.poll()
  assert.equal(f.replies[1].id, 'second')
  await f.advance(4000)
  for (const call of f.calls.filter(call => ['abort', 'delete'].includes(call.method))) assert.equal(call.options.signal.aborted, true)
  assert.equal(f.stats().timers, 0)
  rerank.resolve(answer('{"ids":["M1"]}'))
  abort.resolve({ data: true }); deletion.reject(new Error('late delete error'))
  await flush()
  assert.equal(f.replies.length, 2, 'late SDK completions cannot send another reply')
})

test('ordinary chat timeout frees the queue and late output cannot enter a new profile', async () => {
  const pending = deferred()
  const f = await fixture([job('old'), job('new', { profileId: 'profile-b', persona: 'Persona B' })], {
    prompt: options => options.path.id === 'session-1' ? pending.promise : Promise.resolve(answer('new reply')),
  })
  await f.advance(60000)
  assert.match(f.replies[0].error, /timed out/)
  assert.equal(f.calls.find(call => call.method === 'prompt').options.signal.aborted, true)
  await f.heartbeat()
  await f.poll()
  assert.equal(f.replies[1].text, 'new reply')
  const nextPrompt = f.calls.filter(call => call.method === 'prompt')[1]
  assert.equal(nextPrompt.options.path.id, 'session-2')
  assert.match(nextPrompt.options.body.parts[0].text, /Persona B/)
  assert.doesNotMatch(nextPrompt.options.body.parts[0].text, /Persona A/)
  pending.resolve(answer('late old profile answer'))
  await flush()
  assert.equal(f.replies.length, 2)
  const before = f.events.length
  await f.plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'session-1' } } })
  await f.plugin['tool.execute.before']({ sessionID: 'session-1', tool: 'bash' })
  await f.plugin['tool.execute.after']({ sessionID: 'session-1' })
  assert.equal(f.events.length, before, 'retired internal sessions cannot create task lamps')
  assert.equal(f.stats().heartbeats, 2)
  assert.equal(f.stats().timers, 0)
})

test('timed out session creation is cleaned up when it arrives after another profile', async () => {
  const pending = deferred()
  let creates = 0
  const f = await fixture([job('old'), job('new', { profileId: 'profile-b', persona: 'Persona B' })], {
    create: () => ++creates === 1 ? pending.promise : Promise.resolve({ data: { id: 'new-session' } }),
  })
  await f.advance(5000)
  assert.match(f.replies[0].error, /create timed out/)
  await f.poll()
  pending.resolve({ data: { id: 'late-session' } })
  await flush()
  assert.ok(f.calls.some(call => call.method === 'delete' && call.options.path.id === 'late-session'))
  f.jobs.push(job('third', { profileId: 'profile-b', persona: 'Persona B' }))
  await f.poll()
  assert.deepEqual(f.calls.filter(call => call.method === 'prompt').map(call => call.options.path.id), ['new-session', 'new-session'])
  assert.equal(f.replies.length, 3)
})

test('rerank session creation timeout also falls back and disposes a late session', async () => {
  const pending = deferred()
  let creates = 0
  const f = await fixture([semanticJob('first')], {
    create: () => ++creates === 2 ? pending.promise : Promise.resolve({ data: { id: 'chat-session' } }),
  })
  await f.advance(5000)
  assert.equal(f.replies[0].text, 'reply')
  assert.match(f.calls.find(call => call.method === 'prompt').options.body.parts[0].text, /local fallback memory/)
  pending.resolve({ data: { id: 'late-rerank-session' } })
  await flush()
  assert.ok(f.calls.some(call => call.method === 'abort' && call.options.path.id === 'late-rerank-session'))
})

for (const invalid of ['not JSON', '{"ids":["missing"]}', '{"ids":7}', '{"ids":[null]}']) {
  test('invalid rerank output falls back: ' + invalid, async () => {
    const f = await fixture([semanticJob('first')], {
      prompt: options => Promise.resolve(answer(options.path.id === 'session-2' ? invalid : 'chat reply')),
    })
    const prompt = f.calls.filter(call => call.method === 'prompt')[1]
    assert.match(prompt.options.body.parts[0].text, /local fallback memory/)
    assert.equal(f.replies[0].text, 'chat reply')
    assert.equal(f.stats().timers, 0)
  })
}

test('a successful rerank does not wait for stalled deletion', async () => {
  const f = await fixture([semanticJob('first'), job('second')], {
    prompt: options => Promise.resolve(answer(options.path.id === 'session-2' ? '{"ids":["M1"]}' : 'chat reply')),
    delete: () => new Promise(() => {}),
  })
  const prompt = f.calls.filter(call => call.method === 'prompt')[1]
  assert.match(prompt.options.body.parts[0].text, /semantic memory/)
  assert.doesNotMatch(prompt.options.body.parts[0].text, /local fallback memory/)
  await f.poll()
  assert.equal(f.replies.length, 2)
  await f.advance(2000)
  assert.equal(f.stats().timers, 0)
})

test('SDK errors fall back during reranking and retire failed chat sessions', async () => {
  let ordinaryPrompts = 0
  const f = await fixture([semanticJob('first'), job('second')], {
    prompt: options => {
      if (options.path.id === 'session-2') return Promise.reject(new Error('rerank offline'))
      if (++ordinaryPrompts === 1) return Promise.reject({ message: 'provider unavailable' })
      return Promise.resolve(answer('recovered'))
    },
  })
  assert.match(f.replies[0].error, /provider unavailable/)
  assert.match(f.calls.filter(call => call.method === 'prompt')[1].options.body.parts[0].text, /local fallback memory/)
  await f.poll()
  assert.equal(f.replies[1].text, 'recovered')
  assert.equal(f.calls.filter(call => call.method === 'prompt')[2].options.path.id, 'session-3')
})

for (const [channel, deadline] of [['diary', 30000], ['memory', 30000], ['game', 45000]]) {
  test(channel + ' timeout clears its state and permits the next queued job', async () => {
    const f = await fixture([job('slow', { channel }), job('next')], {
      prompt: options => options.path.id === 'session-1' ? new Promise(() => {}) : Promise.resolve(answer('next reply')),
    })
    await f.advance(deadline)
    assert.match(f.replies[0].error, /timed out/)
    await f.poll()
    assert.equal(f.replies[1].text, 'next reply')
    if (channel === 'game') assert.ok(f.events.some(event => event.sessionId === 'companion-game-turn' && event.remove))
  })
}

// Optional real SDK transport contract, with no OpenCode process or provider.
// Point this at an unpacked official @opencode-ai/sdk dist/client.js to rerun.
test('official OpenCode SDK forwards abort signals and its HTTP errors recover', {
  skip: process.env.L2D_OPENCODE_SDK_CLIENT ? false : 'Set L2D_OPENCODE_SDK_CLIENT to an official SDK dist/client.js',
}, async t => {
  const { createOpencodeClient } = await import(pathToFileURL(process.env.L2D_OPENCODE_SDK_CLIENT).href)
  const requests = [], sockets = new Set()
  let creates = 0, aborted = false
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/session') return res.end(JSON.stringify({ id: 'real-' + (++creates) }))
    if (req.url === '/session/real-1/message') { res.on('close', () => { aborted = true }); return }
    if (req.url === '/session/real-2/message') { res.statusCode = 503; return res.end(JSON.stringify({ message: 'fixture unavailable' })) }
    if (req.url.endsWith('/message')) return res.end(JSON.stringify({ parts: [{ type: 'text', text: 'real SDK recovered' }] }))
    res.end('true')
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) })
  const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` })
  const f = await fixture([job('first'), job('second'), job('third')], {}, client)
  const until = async predicate => {
    const end = Date.now() + 3000
    while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(predicate(), 'fixture transport did not finish within three seconds')
  }
  await until(() => requests.includes('POST /session/real-1/message'))
  await f.advance(60000)
  await until(() => aborted && f.replies.length === 1)
  await f.poll()
  await until(() => f.replies.length === 2)
  assert.ok(f.replies[1].error)
  await f.poll()
  await until(() => f.replies.length === 3)
  assert.equal(f.replies[2].text, 'real SDK recovered')
  await until(() => requests.includes('DELETE /session/real-1') && requests.includes('DELETE /session/real-2'))
  assert.ok(requests.includes('POST /session/real-1/abort'))
  assert.ok(requests.includes('POST /session/real-2/abort'))
})
