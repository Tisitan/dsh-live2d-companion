const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const http = require('node:http')
const path = require('node:path')
const { test } = require('node:test')
const { createStandaloneServer } = require('./server.cjs')
const { createProfileStore } = require('./profile-store.cjs')

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'l2d-regression-'))
  const publicDir = path.join(root, 'public')
  const dataDir = path.join(root, 'data')
  await fs.mkdir(publicDir, { recursive: true })
  await fs.writeFile(path.join(publicDir, 'pet.html'), '<!doctype html>test')
  await fs.cp(path.join(__dirname, '..', 'games'), path.join(root, 'games'), { recursive: true })
  const server = await createStandaloneServer({ publicDir, dataDir })
  t.after(async () => { await server.close(); await fs.rm(root, { recursive: true, force: true }) })
  const page = await fetch(server.target)
  await page.text()
  const cookie = page.headers.get('set-cookie').split(';')[0]
  const adapter = JSON.parse(await fs.readFile(server.adapterFile, 'utf8'))
  const headers = { cookie, 'content-type': 'application/json' }
  const adapterHeaders = { authorization: `Bearer ${adapter.token}`, 'content-type': 'application/json' }
  const post = (route, value, extra = {}) => fetch(server.origin + '/live2d/' + route, {
    method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value),
  })
  const profiles = () => fetch(server.origin + '/live2d/companion-profiles', { headers }).then(r => r.json())
  const model = async name => {
    assert.equal((await post(`import?model=${name}&path=${name}.model3.json`, {})).status, 200)
    const response = await post('model', { model: `${name}/${name}.model3.json` })
    assert.equal(response.status, 200)
    return (await profiles()).active
  }
  return { root, dataDir, server, headers, adapterHeaders, post, profiles, model }
}

test('standalone rejects cross-port, opaque and forged-host requests with valid cookies', async t => {
  const f = await fixture(t)
  for (const origin of ['http://127.0.0.1:1', 'https://example.invalid', 'null']) {
    const result = await f.post('state', { state: 'working' }, { origin })
    assert.equal(result.status, 403, origin)
  }
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const req = http.request(f.server.origin + '/live2d/state', { method: 'POST', headers: { ...f.headers, host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end(JSON.stringify({ state: 'working' }))
  })
  assert.equal(forgedHostStatus, 403)
  assert.equal((await f.post('state', { state: 'working' }, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await f.post('state', { state: 'working' }, { origin: f.server.origin })).status, 200)
  assert.equal((await f.post('adapter', { source: 'test', sessionId: 'x', state: 'idle' }, f.adapterHeaders)).status, 200)
})

test('model routes cannot read, overwrite or delete outside a symlinked model directory', async t => {
  const f = await fixture(t)
  const outside = path.join(f.root, 'outside')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'private.json'), 'private data')
  await fs.writeFile(path.join(outside, 'test.model3.json'), '{}')
  await fs.writeFile(path.join(outside, 'profile.json'), 'keep profile')
  try {
    await fs.symlink(outside, path.join(f.server.modelDir, 'escape'), 'junction')
    await fs.symlink(path.join(outside, 'new.json'), path.join(f.server.modelDir, 'dangling.json'))
  } catch (error) {
    if (error.code === 'EPERM') { t.skip('symlink privileges unavailable'); return }
    throw error
  }
  assert.equal((await fetch(f.server.origin + '/live2d/model/escape/private.json')).status, 404)
  assert.equal((await f.post('model', { model: 'escape/test.model3.json' })).status, 404)
  assert.equal((await f.post('import?model=escape&path=private.json&overwrite=1', {})).status, 400)
  assert.equal((await f.post('profile', { dir: 'escape', reset: true })).status, 400)
  assert.equal((await f.post('model', { delete: 'escape' })).status, 400)
  assert.equal(await fs.readFile(path.join(outside, 'private.json'), 'utf8'), 'private data')
  assert.equal(await fs.readFile(path.join(outside, 'profile.json'), 'utf8'), 'keep profile')
  // A dangling symlink must not become an outside write after mkdir creates ancestors.
  await fs.mkdir(path.join(f.server.modelDir, 'safe'))
  await fs.symlink(path.join(outside, 'new.json'), path.join(f.server.modelDir, 'safe', 'new.json'))
  assert.equal((await f.post('import?model=safe&path=new.json&overwrite=1', {})).status, 400)
  await assert.rejects(fs.stat(path.join(outside, 'new.json')), { code: 'ENOENT' })
})

test('deleting active models switches the profile too, then clears an empty selection', async t => {
  const f = await fixture(t)
  const a = await f.model('a')
  const b = await f.model('b')
  assert.equal((await f.post('model', { delete: 'b' })).status, 200)
  const after = await f.profiles()
  assert.equal(after.currentModel, a.model)
  assert.equal(after.active.id, a.id)
  assert.equal((await f.post('companion-profiles', { action: 'activate', id: b.id })).status, 400)
  assert.equal((await f.post('model', { delete: 'a' })).status, 200)
  const empty = await f.profiles()
  assert.equal(empty.currentModel, '')
  assert.equal(empty.active, null)
})

test('diary requests keep the captured profile across asynchronous summaries', async t => {
  const f = await fixture(t)
  const a = await f.model('a')
  const b = await f.model('b')
  await f.post('companion-profiles', { action: 'activate', id: a.id })
  await fetch(f.server.origin + '/live2d/chat/heartbeat', { headers: f.adapterHeaders })
  assert.equal((await f.post('diary/save', { summary: 'unowned' })).status, 400)
  const pending = f.post('diary/summarize', { profileId: a.id, messages: [{ role: 'user', text: 'A private conversation' }] })
  let job
  for (let i = 0; i < 100 && !job; i++) {
    const response = await fetch(f.server.origin + '/live2d/chat/next', { headers: f.adapterHeaders })
    if (response.status === 200) job = await response.json()
    else await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(job?.profileId, a.id)
  await f.post('companion-profiles', { action: 'activate', id: b.id })
  await f.post('chat/reply', { id: job.id, text: 'A private diary' }, f.adapterHeaders)
  assert.equal((await pending).status, 400)
  assert.equal((await f.post('diary/save', { profileId: a.id, summary: 'A private diary' })).status, 400)
  assert.equal((await f.post('chat', { profileId: a.id, message: 'stale chat' })).status, 400)
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'profiles', b.id, 'diaries')), [])
  // A stale auto-save toggle cannot reactivate A or overwrite its persona.
  assert.equal((await f.post('companion-profiles', { id: a.id, expectedActiveId: a.id, autoDiary: true })).status, 400)
  assert.equal((await f.profiles()).active.id, b.id)
})

test('shutdown resolves an unanswered chat before waiting for HTTP connections', async t => {
  const f = await fixture(t)
  const profile = await f.model('a')
  await fetch(f.server.origin + '/live2d/chat/heartbeat', { headers: f.adapterHeaders })
  const pending = f.post('chat', { profileId: profile.id, message: 'pending' })
  let claimed = false
  for (let i = 0; i < 100 && !claimed; i++) {
    const response = await fetch(f.server.origin + '/live2d/chat/next', { headers: f.adapterHeaders })
    claimed = response.status === 200
    await response.text()
    if (!claimed) await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(claimed, true)
  const closed = f.server.close()
  assert.equal((await pending).status, 503)
  let timeout
  await Promise.race([closed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('close hung')), 1500) })])
    .finally(() => clearTimeout(timeout))
  await assert.rejects(fs.stat(f.server.adapterFile), { code: 'ENOENT' })
})

test('nested model folders support binding edits and delete only the selected sibling', async t => {
  const f = await fixture(t)
  for (const name of ['alpha', 'beta']) {
    assert.equal((await f.post(`import?model=bundle&path=${name}/${name}.model3.json`, {})).status, 200)
  }
  assert.equal((await f.post('model', { model: 'bundle/alpha/alpha.model3.json' })).status, 200)
  assert.equal((await f.post('profile', { dir: 'bundle/alpha', profile: { expressions: { happy: 'smile' } } })).status, 200)
  assert.equal((await f.post('profile', { dir: 'bundle/alpha', reset: true })).status, 200)
  assert.equal((await f.post('model', { delete: 'bundle' })).status, 400)
  // A folder with a model filename does not make its parent a deletable model.
  await fs.mkdir(path.join(f.server.modelDir, 'bundle', 'fake.model3.json'))
  assert.equal((await f.post('model', { delete: 'bundle' })).status, 400)
  assert.equal((await f.post('model', { delete: 'bundle/alpha' })).status, 200)
  assert.equal(await fs.readFile(path.join(f.server.modelDir, 'bundle', 'beta', 'beta.model3.json'), 'utf8'), '{}')
  assert.equal((await f.profiles()).active.model, 'bundle/beta/beta.model3.json')
})

test('imports reject executable assets and Windows aliases, and concurrent creates never overwrite', async t => {
  const f = await fixture(t)
  for (const filename of ['evil.html', 'evil.js', 'evil.svg', 'data.json.', 'bad?.json', 'bad .json ', 'NUL.json']) {
    assert.equal((await f.post(`import?model=safe&path=${encodeURIComponent(filename)}`, {})).status, 400, filename)
  }
  for (const folder of ['CON', 'trailing.', 'trailing ', 'bad*name']) {
    assert.equal((await f.post(`import?model=${encodeURIComponent(folder)}&path=data.json`, {})).status, 400, folder)
  }
  const attempts = await Promise.all([
    f.post('import?model=safe&path=new.json', { content: 'first' }),
    f.post('import?model=safe&path=new.json', { content: 'second' }),
  ])
  assert.deepEqual(attempts.map(item => item.status).sort(), [200, 409])
  const firstWrite = await fs.readFile(path.join(f.server.modelDir, 'safe', 'new.json'), 'utf8')
  assert.equal((await f.post('import?model=safe&path=new.json', { content: 'third' })).status, 409)
  assert.equal(await fs.readFile(path.join(f.server.modelDir, 'safe', 'new.json'), 'utf8'), firstWrite)
  assert.equal((await f.post('import?model=safe&path=new.json&overwrite=1', { content: 'explicit' })).status, 200)
})

test('serialized profile updates reject stale activation and retain concurrent imported memories', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'l2d-profile-regression-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const store = createProfileStore({ dataDir: root })
  const a = await store.save({ name: 'A', model: 'a/a.model3.json' })
  const b = await store.save({ name: 'B', model: 'b/b.model3.json' })
  await store.activate(a.id)
  const updates = await Promise.allSettled([
    store.activate(b.id),
    store.save({ id: a.id, expectedActiveId: a.id, autoDiary: true }),
  ])
  assert.equal(updates[0].status, 'fulfilled')
  assert.equal(updates[1].status, 'rejected')
  assert.equal((await store.get()).id, b.id)
  assert.equal(await store.get('../invalid'), null)
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.importText(b.id, 'memory', `entry-${i}`, `User likes hobby number ${i}`)))
  const index = JSON.parse(await fs.readFile(path.join(root, 'profiles', b.id, 'memories', 'index.json'), 'utf8'))
  assert.equal(index.length, 8)
  const firstDiary = await store.saveDiary('First run', b.id)
  const restartedStore = createProfileStore({ dataDir: root })
  const secondDiary = await restartedStore.saveDiary('Second run', b.id)
  assert.notEqual(firstDiary.file, secondDiary.file)
  assert.match(await fs.readFile(path.join(root, 'profiles', b.id, 'diaries', firstDiary.file), 'utf8'), /First run/)
})
