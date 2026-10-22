import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const stageSource = fs.readFileSync(new URL('./public/src/stage.js', import.meta.url), 'utf8')
// Exercise the actual closure installed by initStage without loading WebGL or model assets.
const switchSource = stageSource.slice(stageSource.indexOf('  ctx.switchModel = async'), stageSource.lastIndexOf('\n}'))
const streamSource = fs.readFileSync(new URL('./public/src/stream.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/m, '').replace('export function initStream', 'function initStream')

function fixture() {
  const pending = new Map()
  const oldModel = { destroyed: false, destroy() { this.destroyed = true } }
  const ctx = {
    model: oldModel, layout() {}, setExpr() {}, setEyeBlinkEnabled() {},
    emit() {}, enter() {}, getState: () => 'idle', busy: () => false,
  }
  const scope = {
    ctx, BASE: '/live2d', modelPath: 'a/a.model3.json', switchToken: 0, model: oldModel,
    naturalW: 100, naturalH: 100, PET_OVERLAY: false, guardIdlePool() {},
    app: { stage: { removeChild() {}, addChild() {} } },
    loadBinding: async () => ({ expr: {}, motion: {} }),
    PIXI: { live2d: { Live2DModel: { from: url => new Promise(resolve => pending.set(url, resolve)) } } },
  }
  Object.defineProperty(ctx, 'modelPath', { get: () => scope.modelPath })
  vm.runInNewContext(switchSource, scope)
  let stream
  vm.runInNewContext(streamSource + '\nglobalThis.init = initStream', {
    BASE: '/live2d', EventSource: class { constructor() { stream = this } },
    globalThis: scope,
  })
  scope.init(ctx)
  return {
    ctx, oldModel, pending,
    broadcast: model => stream.onmessage({ data: JSON.stringify({ model }) }),
    finish(modelPath) {
      const model = { destroyed: false, destroy() { this.destroyed = true }, internalModel: { originalWidth: 100, originalHeight: 100 } }
      pending.get('/live2d/model/' + modelPath)(model)
      return model
    },
  }
}

test('selecting the displayed model cancels a slower pending model switch', async () => {
  const f = fixture()
  const loading = f.ctx.switchModel('b/b.model3.json')
  assert.equal(await f.ctx.switchModel('a/a.model3.json'), false)
  const stale = f.finish('b/b.model3.json')
  assert.equal(await loading, false)
  assert.equal(f.ctx.model, f.oldModel)
  assert.equal(f.ctx.modelPath, 'a/a.model3.json')
  assert.equal(stale.destroyed, true)
  assert.equal(f.oldModel.destroyed, false)
})

test('same-path SSE broadcasts invalidate pending loads without reloading the displayed model', async () => {
  const f = fixture()
  const loading = f.ctx.switchModel('b/b.model3.json')
  f.broadcast('a/a.model3.json')
  const stale = f.finish('b/b.model3.json')
  assert.equal(await loading, false)
  assert.equal(f.ctx.modelPath, 'a/a.model3.json')
  assert.equal(stale.destroyed, true)
  assert.equal(f.pending.has('/live2d/model/a/a.model3.json'), false)
})

test('the latest different model still wins and a forced same-model reload still works', async () => {
  const f = fixture()
  const first = f.ctx.switchModel('b/b.model3.json')
  const latest = f.ctx.switchModel('c/c.model3.json')
  f.finish('b/b.model3.json')
  const current = f.finish('c/c.model3.json')
  assert.equal(await first, false)
  assert.equal(await latest, true)
  assert.equal(f.ctx.model, current)
  const forced = f.ctx.switchModel('c/c.model3.json', true)
  const refreshed = f.finish('c/c.model3.json')
  assert.equal(await forced, true)
  assert.equal(current.destroyed, true)
  assert.equal(f.ctx.model, refreshed)
})
