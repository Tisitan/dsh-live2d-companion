import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const readModule = (name, exported) => fs.readFileSync(new URL(`./public/src/${name}.js`, import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replace(`export function ${exported}`, `function ${exported}`)

function fixture({ preview = false, doneHoldMs = 1234 } = {}) {
  let now = 1_000_000, nextId = 0, stream
  const timers = new Map()
  const schedule = (fn, ms, interval = false) => {
    const id = ++nextId
    timers.set(id, { fn, at: now + ms, ms, interval })
    return id
  }
  const tick = ms => {
    const end = now + ms
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      const [id, timer] = next
      now = timer.at
      if (timer.interval) timer.at += Math.max(1, timer.ms)
      else timers.delete(id)
      timer.fn()
    }
    now = end
  }
  class Element {
    constructor() { this.style = {}; this.children = []; this.offsetWidth = 140; this.offsetHeight = 30; this.textContent = '' }
    appendChild(child) { this.children.push(child) }
    append(...children) { this.children.push(...children) }
    replaceChildren(...children) { this.children = children }
  }
  const document = { hidden: false, createElement: () => new Element(), head: new Element(), body: new Element() }
  const expressions = [], motions = [], events = [], bubbles = []
  const ctx = {
    model: { getBounds: () => ({ x: 50, y: 80, width: 100, height: 240 }) },
    binding: { motion: {} }, setExpr: value => expressions.push(value), playMotion: value => motions.push(value),
    emit: (...args) => events.push(args), setEyeBlinkEnabled() {}, stopMotions() {}, switchModel: async () => false,
  }
  const cfg = { rotation: { holdMs: 6000, intervalMs: 9000, doneHoldMs },
    behavior: { sleepAfterMs: 300000, seriousAfterMs: 45000, overtimeAfterMs: 120000 } }
  const sandbox = { ctx, cfg, PREVIEW: preview, PET: false, BASE: '/live2d', BASE_W: 300, BASE_H: 400,
    document, window: { innerWidth: 1280, innerHeight: 900 }, store: { getPos: () => null },
    Date: class extends Date { static now() { return now } }, Math: Object.assign(Object.create(Math), { random: () => .9 }),
    performance: { now: () => now }, quip: name => `quip:${name}`, console,
    setTimeout: (fn, ms) => schedule(fn, ms), setInterval: (fn, ms) => schedule(fn, ms, true),
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id), requestAnimationFrame() {},
    EventSource: class { constructor() { stream = this } },
  }
  vm.runInNewContext(readModule('ui', 'initUI') + '\ninitUI(ctx)', sandbox)
  const show = ctx.showBubble
  ctx.showBubble = (...args) => { const accepted = show(...args); bubbles.push({ args, accepted }); return accepted }
  vm.runInNewContext(readModule('state', 'initState') + '\ninitState(ctx)', sandbox)
  vm.runInNewContext(readModule('stream', 'initStream') + '\ninitStream(ctx)', sandbox)
  return { ctx, cfg, document, tick, expressions, motions, events, bubbles,
    bubble: ctx.box.children[0], lamp: ctx.box.children[1].children[1], taskLamps: ctx.box.children[2],
    message: data => stream.onmessage({ data: JSON.stringify(data) }), disconnect: () => stream.onerror(),
    completions: () => bubbles.filter(b => b.accepted && b.args[0].includes('quip:done')),
  }
}

const sessions = (...states) => states.map((state, index) => ({ n: index + 1, state }))

test('all eight states drive their real lamp, expression and motion handlers', () => {
  const f = fixture()
  for (const [state, label, expr, motion] of [
    ['thinking', '思考中', 'doubt', 'think'], ['working', '工作中', 'excited', 'excited'],
    ['waiting', '待确认!', 'doubt', 'shake'], ['error', '卡壳中…', 'troubled', 'dizzy'],
    ['done', '完成啦~', 'happy', 'nod'], ['sleeping', '打瞌睡…', 'sleep', 'sleep'],
    ['offline', '离线中', 'dark', null], ['idle', '闲置中', 'default', null],
  ]) {
    f.ctx.enter(state)
    f.tick(1200) // sleeping -> any state has a deliberate surprised-face transition
    assert.equal(f.ctx.getState(), state)
    assert.equal(f.lamp.textContent, label)
    assert.equal(f.expressions.at(-1), expr)
    if (motion) assert.equal(f.motions.at(-1), motion)
  }
})

test('done emits one priority-2 bubble using doneHoldMs and still returns to idle at six seconds', () => {
  const f = fixture({ doneHoldMs: 1700 })
  f.ctx.enter('done')
  f.ctx.enter('done')
  assert.equal(f.completions().length, 1)
  assert.deepEqual(f.completions()[0].args, ['quip:done', 1700, 2])
  f.tick(1699)
  assert.equal(f.bubble.style.opacity, '1')
  f.tick(1)
  assert.equal(f.bubble.style.opacity, '0')
  assert.equal(f.ctx.getState(), 'done')
  f.tick(4300)
  assert.equal(f.ctx.getState(), 'idle')
})

test('real bubble arbitration protects completion/error from game and rotation chatter', () => {
  const f = fixture()
  assert.equal(f.ctx.showBubble('game', 3000, 1), true)
  assert.equal(f.ctx.showBubble('rotation', 3000, 0), false)
  f.ctx.enter('done')
  assert.equal(f.bubble.textContent, 'quip:done')
  assert.equal(f.ctx.showBubble('game-again', 3000, 1), false)
  f.ctx.enter('error')
  assert.equal(f.bubble.textContent, 'quip:error')
  assert.equal(f.ctx.showBubble('rotation', 3000, 0), false)
  f.tick(6000)
  assert.equal(f.ctx.showBubble('rotation', 3000, 0), true)
})

test('sleep, wake, overtime and transient timers use current state and preview stays manual', () => {
  const f = fixture()
  f.tick(330000)
  assert.equal(f.ctx.getState(), 'sleeping')
  f.ctx.pokeActivity()
  assert.equal(f.ctx.getState(), 'idle')
  assert.equal(f.expressions.at(-1), 'surprised')
  f.ctx.enter('working')
  f.tick(54000)
  assert.equal(f.expressions.at(-1), 'serious')
  f.tick(72000)
  assert.equal(f.expressions.at(-1), 'troubled')
  assert.equal(f.bubble.textContent, 'quip:overtime')
  f.ctx.enter('error')
  f.tick(4500)
  assert.equal(f.ctx.getState(), 'thinking')
  const preview = fixture({ preview: true })
  preview.ctx.enter('done')
  preview.tick(330000)
  assert.equal(preview.ctx.getState(), 'done')
})

test('single-session raw, same-frame snapshot and reconnect announce a completion only once', () => {
  const f = fixture()
  f.message({ ev: 'turn/start', n: 1, state: 'thinking', sessions: sessions('thinking') })
  f.message({ ev: 'turn/end', n: 1, state: 'done', sessions: sessions('done') })
  assert.equal(f.ctx.getState(), 'done')
  assert.equal(f.completions().length, 1)
  f.message({ ev: 'turn/end', n: 1 })
  f.message({ state: 'done', sessions: sessions('done') })
  f.disconnect()
  assert.equal(f.ctx.getState(), 'offline')
  f.message({ state: 'done', sessions: sessions('done') })
  assert.equal(f.ctx.getState(), 'done')
  assert.equal(f.completions().length, 1)
  f.message({ ev: 'turn/start', n: 1, state: 'thinking', sessions: sessions('thinking') })
  f.message({ ev: 'turn/end', n: 1, state: 'done', sessions: sessions('done') })
  assert.equal(f.completions().length, 2)
})

test('one parallel task completes independently without changing the working main lamp', () => {
  const f = fixture()
  f.message({ state: 'working', sessions: sessions('working', 'working') })
  f.message({ ev: 'turn/end', n: 1, state: 'working', sessions: sessions('done', 'working') })
  assert.equal(f.ctx.getState(), 'working')
  assert.equal(f.lamp.textContent, '工作中')
  assert.equal(f.completions().length, 1)
  assert.match(f.bubble.textContent, /^任务1 · quip:done$/)
  assert.equal(f.taskLamps.children[0].children[1].textContent, '任务1·完成')
  assert.equal(f.taskLamps.children[1].children[1].textContent, '任务2·工作')
  f.message({ state: 'working', sessions: sessions('done', 'working') })
  f.disconnect()
  f.message({ state: 'working', sessions: sessions('done', 'working') })
  assert.equal(f.completions().length, 1)
  f.message({ ev: 'turn/end', n: 2, state: 'done', sessions: sessions('done', 'done') })
  assert.equal(f.ctx.getState(), 'done')
  assert.equal(f.completions().length, 2)
})

test('first combined multi-session frame never gives raw completion ownership of the main lamp', () => {
  const f = fixture()
  f.message({ ev: 'turn/end', n: 1, state: 'working', sessions: sessions('done', 'working') })
  assert.equal(f.ctx.getState(), 'working')
  assert.deepEqual(f.events.filter(e => e[0] === 'enter').map(e => e[1]), ['working'])
  assert.equal(f.completions().length, 1)
})

test('coarse-only hosts announce each task once and allow new turns and recycled task numbers', () => {
  const f = fixture()
  f.message({ state: 'working', sessions: sessions('working', 'working') })
  f.message({ state: 'working', sessions: sessions('done', 'working') })
  f.message({ state: 'working', sessions: sessions('done', 'working') })
  assert.equal(f.completions().length, 1)
  f.message({ state: 'working', sessions: sessions('working', 'working') })
  f.message({ state: 'working', sessions: sessions('done', 'working') })
  assert.equal(f.completions().length, 2)
  f.message({ state: 'idle', sessions: [] })
  f.message({ state: 'done', sessions: sessions('done') })
  assert.equal(f.completions().length, 3)
})

test('legacy aggregate-only frames deduplicate completion and keep low-priority bubbles out', () => {
  const f = fixture()
  f.message({ ev: 'turn/start', n: 1 })
  f.message({ ev: 'turn/end', n: 1 })
  f.message({ state: 'done' })
  f.disconnect()
  f.message({ state: 'done' })
  assert.equal(f.completions().length, 1)
  f.message({ state: 'working' })
  f.message({ state: 'done' })
  assert.equal(f.completions().length, 2)
})

test('hidden standalone sessions may announce aggregate completion without a visible task lamp', () => {
  const f = fixture()
  f.message({ state: 'working', sessions: [] })
  f.message({ state: 'done', sessions: [] })
  f.message({ state: 'done', sessions: [] })
  f.disconnect()
  f.message({ state: 'done', sessions: [] })
  assert.equal(f.completions().length, 1)
  assert.equal(f.ctx.getState(), 'done')
  assert.equal(f.taskLamps.children.length, 0)
})

test('task lamps fold after eight and disappear when only one remains', () => {
  const f = fixture()
  f.message({ state: 'working', sessions: sessions(...Array(10).fill('working')) })
  assert.equal(f.taskLamps.children.length, 9)
  assert.equal(f.taskLamps.children.at(-1).textContent, '+2 个任务')
  f.message({ state: 'working', sessions: sessions('working') })
  assert.equal(f.taskLamps.children.length, 0)
})


test('legacy aggregate completion arriving before its numbered raw event is only announced once', () => {
  const f = fixture()
  f.message({ state: 'done' })
  f.message({ ev: 'turn/end', n: 1 })
  f.message({ state: 'done', sessions: sessions('done') })
  f.disconnect()
  f.message({ state: 'done', sessions: sessions('done') })
  assert.equal(f.completions().length, 1)
  f.message({ ev: 'turn/start', n: 1 })
  f.message({ ev: 'turn/end', n: 1 })
  assert.equal(f.completions().length, 2)
})

test('coarse same-task idle-to-done starts another completion while idle alone does not replay raw', () => {
  const f = fixture()
  f.message({ state: 'working', sessions: sessions('working') })
  f.message({ state: 'done', sessions: sessions('done') })
  f.message({ state: 'idle', sessions: sessions('idle') })
  f.message({ ev: 'turn/end', n: 1 }) // late duplicate without a new coarse transition
  assert.equal(f.completions().length, 1)
  f.message({ state: 'done', sessions: sessions('done') })
  f.message({ state: 'done', sessions: sessions('done') })
  assert.equal(f.completions().length, 2)
  f.message({ state: 'idle', sessions: sessions('idle') })
  f.message({ ev: 'turn/end', n: 1, state: 'done', sessions: sessions('done') })
  assert.equal(f.completions().length, 3)
  f.message({ state: 'idle', sessions: sessions('idle') })
  f.message({ ev: 'turn/start', n: 1 })
  f.message({ ev: 'turn/end', n: 1, state: 'done', sessions: sessions('done') })
  assert.equal(f.completions().length, 4)
})

test('hidden aggregate-only idle-to-done cycle announces again and correlates later raw', () => {
  const f = fixture()
  f.message({ state: 'done', sessions: [] })
  f.message({ state: 'idle', sessions: [] })
  f.message({ state: 'done', sessions: [] })
  f.message({ ev: 'turn/end', n: 1 })
  assert.equal(f.completions().length, 2)
  f.message({ state: 'idle', sessions: [] })
  f.message({ ev: 'turn/start', n: 1 })
  f.message({ ev: 'turn/end', n: 1 })
  f.message({ state: 'done', sessions: [] })
  assert.equal(f.completions().length, 3)
})


test('widget bubbles avoid main/task lamps and reflow when the session list arrives after raw completion', () => {
  const f = fixture()
  const lamp = f.ctx.box.children[1]
  lamp.offsetWidth = 80; lamp.offsetHeight = 16
  f.bubble.offsetWidth = 284; f.bubble.offsetHeight = 150
  f.ctx.model.getBounds = () => ({ x: 70, y: 10, width: 130, height: 250 })
  f.ctx.notifyCompletion(1)
  for (const count of [2, 8, 9]) {
    f.taskLamps.offsetWidth = 88; f.taskLamps.offsetHeight = Math.min(count, 9) * 16
    f.ctx.setSessions(sessions(...Array(count).fill('working')))
    const bubbleTop = parseFloat(f.bubble.style.top) - f.bubble.offsetHeight
    assert.ok(bubbleTop >= 28 + f.taskLamps.offsetHeight + 8, `${count} tasks leave an eight-pixel gap`)
    assert.ok(parseFloat(f.bubble.style.top) <= 392, 'long bubble stays inside the widget')
    assert.equal(f.taskLamps.children.length, Math.min(count, 9))
  }
  f.ctx.setSessions(sessions('done'))
  assert.equal(parseFloat(f.bubble.style.top) - f.bubble.offsetHeight, 30, 'removed task lamps release their reserved area')
})
