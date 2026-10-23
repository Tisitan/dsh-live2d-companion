import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const boot = fs.readFileSync(new URL('./public/boot.js', import.meta.url), 'utf8')
const panelSource = fs.readFileSync(new URL('./public/src/panel.js', import.meta.url), 'utf8')
// Execute the production API assembly and the production list-fetch closure.
// DOM rendering and HTTP transport are the fixture boundaries, not the getters.
const apiSource = boot.slice(boot.indexOf('  const api = {'), boot.indexOf('  window.__l2d = api') + '  window.__l2d = api'.length)
const refreshSource = panelSource.slice(panelSource.indexOf('  async function refreshModels()'), panelSource.indexOf('  async function selectModel('))
const panelApiSource = panelSource.slice(panelSource.lastIndexOf('  return {'), panelSource.lastIndexOf('\n}'))

function fixture(preview = false) {
  let responseModels = []
  const scope = {
    models: [], serverDefaultModel: '', resetBtn: {}, BASE: '/live2d', window: {}, ctx: {}, quip() {},
    setStatus() {}, renderList() {}, openPanel() {}, closePanel() {}, openViewer() {}, importSelectedFiles() {},
    fetch: async () => ({ ok: true, json: async () => ({ models: responseModels, defaultModel: 'default/model.model3.json' }) }),
  }
  vm.runInNewContext(refreshSource + '\nglobalThis.panel = (() => {' + panelApiSource + '\n})()', scope)
  if (preview) scope.panel = null
  vm.runInNewContext(apiSource, scope)
  return { api: scope.window.__l2d, models: value => { responseModels = value } }
}

test('public modelList follows actual refreshes and gives callers a fresh array', async () => {
  const f = fixture()
  assert.equal(f.api.modelList.length, 0)
  f.models([{ path: 'first/first.model3.json' }])
  await f.api.refreshModels()
  assert.equal(f.api.modelList[0].path, 'first/first.model3.json')
  const snapshot = f.api.modelList
  snapshot.push({ path: 'caller-only/model.model3.json' })
  assert.equal(f.api.modelList.length, 1)
  f.models([{ path: 'second/second.model3.json' }])
  await f.api.refreshModels()
  assert.equal(f.api.modelList[0].path, 'second/second.model3.json')
  f.models([])
  await f.api.refreshModels()
  assert.equal(f.api.modelList.length, 0)
  assert.throws(() => { f.api.modelList = [] }, TypeError)
})

test('preview API tolerates its deliberately absent panel', () => {
  const f = fixture(true)
  assert.equal(f.api.modelList.length, 0)
  assert.equal(f.api.refreshModels, undefined)
})
