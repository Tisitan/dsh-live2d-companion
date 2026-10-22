import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, cp, mkdir, writeFile, readFile, symlink, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mountPlugin } from './tests/plugin-harness.mjs'

async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'l2d-plugin-api-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'plugin')
  await mkdir(join(root, 'public', 'model'), { recursive: true })
  for (const file of ['package.json', 'index.js', 'host-auth.mjs', 'pet-lifecycle.mjs', 'games', 'public/quips.json', 'public/boot.js']) {
    await cp(new URL(file, import.meta.url), join(root, file), { recursive: true })
  }
  const plugin = await import(pathToFileURL(join(root, 'index.js')))
  const mounted = mountPlugin(t, { widget: true }, overrides, plugin.apply)
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const route = mounted.routes.find(r => r.kind === 'exact' && r.path === path)
      || mounted.routes.find(r => r.kind === 'prefix' && path.startsWith(r.path + '/'))
    if (!route) { res.writeHead(404); res.end(); return }
    try { await route.handler(req, res) } catch { res.writeHead(500); res.end('handler failed') }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const request = (path, body, headers = {}) => fetch(origin + '/live2d/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  })
  return { dir, root, ...mounted, origin, request }
}

test('plugin rejects malformed JSON, opaque and other-port browser origins', async t => {
  const { request } = await setup(t)
  for (const path of ['game/new', 'game/move', 'mode', 'model', 'profile', 'quips']) {
    for (const body of ['null', '[]', '"text"', '{']) assert.equal((await request(path, body)).status, 400, path + ':' + body)
  }
  for (const origin of ['null', 'https://evil.example', 'http://127.0.0.1:1']) {
    assert.equal((await request('model', { reset: true }, { origin })).status, 403)
  }
  assert.equal((await request('mode', { mode: '__proto__' })).status, 400)
  assert.equal((await request('mode', { mode: 'constructor' })).status, 400)
  assert.equal((await request('game/new', { userTitle: '字'.repeat(30000) })).status, 400)
  assert.equal((await request('config')).status, 200)
})

test('nested model operations preserve siblings and reject symlink escapes', async t => {
  const { root, dir, request } = await setup(t)
  const model = JSON.stringify({ FileReferences: {} })
  assert.equal((await request('import?model=pack&path=one/test.model3.json', model)).status, 200)
  assert.equal((await request('import?model=pack&path=two/test.model3.json', model)).status, 200)
  const simultaneous = await Promise.all([1, 2].map(() => request('import?model=race&path=test.model3.json', model)))
  assert.deepEqual(simultaneous.map(r => r.status).sort(), [200, 409])
  assert.equal((await request('model', { model: 'pack/one/test.model3.json' })).status, 200)
  assert.equal((await request('profile', { dir: 'pack/one', profile: { expressions: { happy: 'Smile' } } })).status, 200)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'public/model/pack/one/profile.json'))), { expressions: { happy: 'Smile' } })
  assert.equal((await request('model', { delete: 'pack/one' })).status, 200)
  assert.equal((await (await request('config')).json()).model, 'pack/two/test.model3.json')
  await access(join(root, 'public/model/pack/two/test.model3.json'))
  await assert.rejects(access(join(root, 'public/model/pack/one')))
  assert.equal((await request('model', { delete: '../outside' })).status, 400)
  assert.equal((await request('profile', { dir: '../outside', profile: {} })).status, 400)
  const outside = join(dir, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.json'), 'private-fixture')
  await writeFile(join(outside, 'outside.model3.json'), model)
  await symlink(outside, join(root, 'public/model/escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await request('model/escape/secret.json')).status, 403)
  assert.equal((await request('import?model=escape&path=new.json', '{}')).status, 403)
  assert.equal((await request('profile', { dir: 'escape', profile: { expressions: {} } })).status, 400)
  assert.equal((await request('model', { model: 'escape/outside.model3.json' })).status, 400)
  assert.equal((await request('model', { delete: 'escape' })).status, 400)
  assert.equal(await readFile(join(outside, 'secret.json'), 'utf8'), 'private-fixture')
  await assert.rejects(access(join(outside, 'new.json')))
  await symlink(outside, join(root, 'public/quips-presets'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await request('quips', { save: 'secret', data: { pools: { idle: ['hello'] } } })).status, 403)
  assert.equal((await request('quips', { delete: 'secret' })).status, 403)
})

test('offline game and state events work; malformed requests do not affect subsequent calls', async t => {
  const { request, ctx } = await setup(t)
  const game = await request('game/new', { game: 'gomoku', mode: 'offline' })
  assert.equal(game.status, 200)
  assert.equal((await game.json()).status, 'playing')
  const move = await request('game/move', { game: 'gomoku', x: 7, y: 7 })
  assert.equal(move.status, 200)
  assert.ok((await move.json()).aiMove)
  for (const [type, expected] of [['turn/start', 'thinking'], ['tool/call', 'working'], ['approval/asked', 'waiting'], ['turn/end', 'done']]) {
    ctx.emit('session/event', { id: 'synthetic-test' }, { type })
    assert.equal((await (await request('state')).json()).state, expected)
  }
  ctx.emit('session/disposed', { id: 'synthetic-test' })
  assert.equal((await (await request('state')).json()).state, 'idle')
})

test('commentator has an empty allow-list and fails closed when tools cannot be restricted', async t => {
  let fail = false, restrictions = [], guard
  const { request } = await setup(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    llm: { resolveModelInfo: async () => ({}) },
    agentPresets: { mount: async () => {} },
    agentLoop: { async createAgent(ctx, options) {
      await options.setup({ tools: {
        restrict(rule) { if (fail) throw Error('restriction failed'); restrictions.push(rule) },
        guard(check) { guard = check },
      } })
      return { agent: {}, dispose: async () => {} }
    } },
  })
  assert.equal((await request('game/new', { mode: 'online' })).status, 200)
  assert.deepEqual(restrictions, [{ allow: [] }])
  assert.match(guard({ name: 'preset-owned-tool' }), /cannot execute tools/)
  fail = true
  assert.equal((await request('game/new', { mode: 'online' })).status, 500)
  assert.equal((await (await request('game/state')).json()).status, 'idle')
})

test('agent creation finishing after plugin unload disposes the new handle', async t => {
  let release, entered, disposedHandles = 0
  const started = new Promise(resolve => { entered = resolve })
  const pending = new Promise(resolve => { release = resolve })
  const { request, dispose } = await setup(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    llm: { resolveModelInfo: async () => ({}) },
    agentLoop: { async createAgent() {
      entered(); await pending
      return { agent: {}, dispose: async () => { disposedHandles++ } }
    } },
  })
  const result = request('game/new', { mode: 'online' })
  await started
  await dispose()
  release()
  assert.equal((await result).status, 503)
  assert.equal(disposedHandles, 1)
})
