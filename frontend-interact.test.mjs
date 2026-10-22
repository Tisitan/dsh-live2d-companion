import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const source = fs.readFileSync(new URL('./public/src/interact.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/m, '').replace('export function initInteract', 'function initInteract')

function eventTarget() {
  const listeners = new Map()
  return {
    addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list) },
    dispatch(type, data = {}) { for (const fn of listeners.get(type) || []) fn({ type, ...data }) },
    setPointerCapture() {},
  }
}

for (const ending of ['pointerup', 'pointercancel', 'blur']) {
  test(`${ending} flushes the last drag step and saves the displayed model center`, () => {
    const box = eventTarget(), window = Object.assign(eventTarget(), { innerWidth: 1280, innerHeight: 900 })
    const frames = [], saved = [], reports = []
    const model = { x: 100, y: 100, getBounds() { return { x: this.x, y: this.y, width: 100, height: 200 } } }
    // The ticker has not measured a new frame yet. This is the real race that
    // occurred on a final XTest drag step followed immediately by pointerup.
    const ctx = { box, model, modelBounds: () => ({ x: 100, y: 100, width: 100, height: 200 }),
      app: { view: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } },
      getState: () => 'idle', stateExpr: () => 'neutral', setExpr() {}, showBubble() {} }
    const sandbox = { window, PET: true, BRIDGE: { pushRects: rects => reports.push(rects) },
      store: { getPinned: () => false, setPetPos: value => saved.push(value) },
      document: { querySelectorAll: () => [] }, quip: () => '', console, Date, Math,
      requestAnimationFrame: fn => frames.push(fn), setInterval() {}, setTimeout() {}, clearTimeout() {} }
    vm.runInNewContext(source + '\nglobalThis.init = initInteract', sandbox)
    sandbox.init(ctx)
    box.dispatch('pointerdown', { screenX: 100, screenY: 100, pointerId: 1 })
    box.dispatch('pointermove', { screenX: 130, screenY: 140, pointerId: 1 })
    assert.equal(frames.length, 1)
    ;(ending === 'blur' ? window : box).dispatch(ending)
    assert.equal(model.x, 130)
    assert.equal(model.y, 140)
    assert.deepEqual(JSON.parse(JSON.stringify(saved)), [{ cx: 180, cy: 240 }])
    assert.equal(reports.at(-1).dragging, false)
    // The previously queued animation frame must not apply the move twice.
    frames[0]()
    assert.equal(model.x, 130)
    assert.equal(model.y, 140)
  })
}
