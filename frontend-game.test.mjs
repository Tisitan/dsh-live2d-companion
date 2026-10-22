import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const source = fs.readFileSync(new URL('./public/src/game.js', import.meta.url), 'utf8')
  .replace(/^import .*\n/m, '').replace('export function attachGame', 'function attachGame')
  .replace('import(`./games/${id}.js`)', 'loadRenderer(id)')
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

function fixture() {
  const elements = new Map()
  class Element {
    constructor() {
      this.children = []
      this.listeners = new Map()
      this.style = { setProperty() {} }
      this.classList = { add() {}, remove() {}, toggle() {} }
      this.value = ''
      this.width = this.height = 500
    }
    set innerHTML(value) {
      for (const match of value.matchAll(/class="([^"]+)"/g)) elements.set('.' + match[1].split(' ')[0], new Element())
      elements.set('canvas', new Element())
    }
    querySelector(selector) { return elements.get(selector) }
    querySelectorAll() { return this.children }
    appendChild(child) { this.children.push(child) }
    replaceChildren(...children) { this.children = children }
    addEventListener(event, handler) {
      if (!this.listeners.has(event)) this.listeners.set(event, [])
      this.listeners.get(event).push(handler)
    }
    async dispatch(event, data = {}) {
      for (const fn of this.listeners.get(event) || []) await fn({ clientX: 5, clientY: 5, preventDefault() {}, target: { closest() {} }, ...data })
    }
    getContext() { return {} }
    getBoundingClientRect() { return { width: 500, height: 500, left: 0, top: 0 } }
  }
  const timers = new Map()
  const intervals = new Map()
  const calls = []
  const renders = []
  let nextTimer = 0
  const snapshots = new Map(['gomoku', 'chess'].map(game => [game, {
    game, status: 'playing', mode: 'online', difficulty: 'normal', busy: false, commentary: [],
  }]))
  const overrides = new Map()
  const response = data => ({ ok: true, status: 200, json: async () => data })
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ url, body })
    if (overrides.has(url)) return overrides.get(url)(body, options)
    if (url.includes('/game/state')) return response(structuredClone(snapshots.get(new URL(url, 'http://test').searchParams.get('game'))))
    if (url.endsWith('/game/list')) return response({ games: ['gomoku', 'chess'].map(id => ({ id, name: id, available: true })) })
    if (url.endsWith('/game/models')) return response({ models: [] })
    if (url.endsWith('/game/presets')) return response({ presets: [] })
    if (url.endsWith('/game/new') || url.endsWith('/game/move')) return response(structuredClone(snapshots.get(body.game)))
    throw Error('Unexpected route ' + url)
  }
  const renderer = id => ({ default: { create: () => ({
    canvasSize: 500, sideLabel: id, reset() {},
    draw(_g, _c, state) { renders.push({ renderer: id, game: state.game, busy: state.busy }); return false },
    clickToMove() { return { move: { x: 1, y: 1 } } },
    applyOptimistic() {}, rollbackOptimistic() {},
  }) } })
  const sandbox = {
    BASE: '/live2d', STANDALONE: false, console, fetch, AbortController,
    document: { createElement: () => new Element(), head: new Element(), body: new Element() },
    window: { addEventListener() {}, removeEventListener() {}, innerWidth: 1000, innerHeight: 800 },
    localStorage: { getItem: () => JSON.stringify({ mode: 'online', difficulty: 'normal' }), setItem() {} },
    loadRenderer: async id => renderer(id), performance: { now: () => 1 },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    setInterval(fn, delay) { const id = ++nextTimer; intervals.set(id, { fn, delay }); return id },
    clearInterval(id) { intervals.delete(id) }, requestAnimationFrame() {}, cancelAnimationFrame() {},
  }
  vm.runInNewContext(source + '\nglobalThis.attach = attachGame', sandbox)
  const ctx = { showBubble() {}, evalIgnore() {} }
  sandbox.attach(ctx)
  return {
    snapshots, overrides, calls, renders, response, timers,
    element: name => elements.get(name === 'canvas' ? name : '.l2d-game-' + name),
    async open() { ctx.openGame(); await flush() },
    async tick() { for (const timer of intervals.values()) timer.fn(); await flush() },
    async select(game) { await elements.get('.l2d-game-chips').children.find(item => item.textContent === game).dispatch('click'); await flush() },
  }
}

test('remote busy snapshots keep polling until the other client finishes its move', async () => {
  const f = fixture()
  f.snapshots.get('gomoku').busy = true
  await f.open()
  assert.equal(f.element('status').textContent, '思考中…')
  f.snapshots.get('gomoku').busy = false
  await f.tick()
  assert.match(f.element('status').textContent, /轮到你/)
})

test('client timeouts respect server budgets and recover even if the next snapshot is still busy', async () => {
  for (const [difficulty, expectedTimeout] of [['normal', 95000], ['alphago', 230000]]) {
    const f = fixture()
    f.snapshots.get('gomoku').difficulty = difficulty
    await f.open()
    f.overrides.set('/live2d/game/move', (_body, options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(Error('timeout'), { name: 'AbortError' })))
    }))
    const move = f.element('canvas').dispatch('click')
    await flush()
    const timeout = [...f.timers.values()][0]
    assert.equal(timeout.delay, expectedTimeout)
    timeout.fn()
    await move
    f.snapshots.get('gomoku').busy = true
    await f.tick()
    assert.equal(f.element('status').textContent, '思考中…')
    f.snapshots.get('gomoku').busy = false
    await f.tick()
    assert.match(f.element('status').textContent, /轮到你/)
  }
})

test('an old move response cannot clear the new game request guard or replace its board', async () => {
  const f = fixture()
  await f.open()
  const oldMove = deferred()
  const nextMove = deferred()
  f.overrides.set('/live2d/game/move', body => body.game === 'gomoku' ? oldMove.promise : nextMove.promise)
  const first = f.element('canvas').dispatch('click')
  await flush()
  await f.select('chess')
  const second = f.element('canvas').dispatch('click')
  await flush()
  const before = f.calls.filter(call => call.url.includes('/game/state')).length
  oldMove.resolve(f.response(structuredClone(f.snapshots.get('gomoku'))))
  await first
  await f.tick()
  assert.equal(f.calls.filter(call => call.url.includes('/game/state')).length, before)
  assert.equal(f.element('status').textContent, '思考中…')
  nextMove.resolve(f.response(structuredClone(f.snapshots.get('chess'))))
  await second
  assert.equal(f.renders.at(-1).game, 'chess')
  assert.match(f.element('status').textContent, /轮到你/)
})

test('late new-game responses and slotless idle snapshots cannot replace the selected game', async () => {
  const f = fixture()
  await f.open()
  const oldNew = deferred()
  f.overrides.set('/live2d/game/new', () => oldNew.promise)
  const creating = f.element('new').dispatch('click')
  await flush()
  await f.select('chess')
  oldNew.resolve(f.response(structuredClone(f.snapshots.get('gomoku'))))
  await creating
  assert.equal(f.renders.at(-1).game, 'chess')

  const oldSnapshot = deferred()
  f.overrides.set('/live2d/game/state?game=chess', () => oldSnapshot.promise)
  const polling = f.tick()
  await flush()
  await f.select('gomoku')
  oldSnapshot.resolve(f.response({ status: 'idle' }))
  await polling
  assert.equal(f.renders.at(-1).game, 'gomoku')
  assert.match(f.element('status').textContent, /轮到你/)
})
