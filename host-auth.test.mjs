import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createAuthenticatedRegistrar } from './host-auth.mjs'
const require = createRequire(import.meta.url)
const { createHostAuth } = require('./pet/host-auth.cjs')
let assertions = 0
const check = (a, b) => { assert.deepEqual(a, b); assertions++ }

// Exercise registered handlers: admission happens before reads, writes, or SSE.
for (const path of ['/live2d/config', '/live2d/import', '/live2d/state-stream', '/live2d']) {
  for (const rejection of [401, 403, undefined]) {
    let registered, calls = 0, seen
    const ctx = {
      connection: { requestRejection(req) { seen = req; return rejection } },
      webServer: { register(route) { registered = route; return () => 'disposed' } },
    }
    const dispose = createAuthenticatedRegistrar(ctx)({ path, kind: 'exact', handler() { calls++; return 'handled' } })
    const req = { headers: { cookie: 'private' } }
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
    const result = registered.handler(req, res)
    check(seen, req)
    check(calls, rejection === undefined ? 1 : 0)
    check(result, rejection === undefined ? 'handled' : undefined)
    if (rejection) { check(res.status, rejection); check(res.headers['cache-control'], 'no-store') }
    check(dispose(), 'disposed')
  }
}
for (const connection of [undefined, {}, { requestRejection() { throw Error('secret') } }, { requestRejection() { return null } }]) {
  let registered
  const ctx = { connection, webServer: { register(route) { registered = route } } }
  createAuthenticatedRegistrar(ctx)({ handler() { assert.fail('must not enter route') } })
  const res = { writeHead(status) { this.status = status }, end(body) { this.body = body } }
  registered.handler({}, res)
  check(res.status, 503)
  check(res.body.includes('secret'), false)
}

// Model the cookie jar at the Electron session boundary: Node global fetch is
// deliberately absent, so health and login must use the same browser session.
function fakeSession({ authorized = false, loginSucceeds = true } = {}) {
  const calls = []
  let released = 0
  return {
    calls,
    get released() { return released },
    async fetch(url, init) {
      calls.push({ url, init })
      if (url.includes('?token=')) authorized = loginSucceeds
      const status = authorized ? 200 : 401
      return { status, ok: status === 200, body: { async cancel() { released++ } } }
    },
  }
}
const target = 'http://127.0.0.1:3081/live2d/pet.html'
const authUrl = 'http://127.0.0.1:3081/?token=private-test-token'
{
  const session = fakeSession()
  const auth = createHostAuth({ session, target, authUrl })
  await Promise.all([auth.ensureAuthenticated(), auth.ensureAuthenticated()])
  check(session.calls.length, 3)
  check(session.released, 3)
  check(session.calls.map((call) => call.init.credentials), ['include', 'include', 'include'])
  check(session.calls[1].url, authUrl)
  const health = await auth.fetchState()
  check(health.ok, true)
  check(session.calls[3].url, 'http://127.0.0.1:3081/live2d/state')
  await auth.ensureAuthenticated()
  check(session.calls.length, 5) // A valid durable cookie does not exchange an old token.
}
{
  const session = fakeSession({ authorized: true })
  await createHostAuth({ session, target }).ensureAuthenticated()
  check(session.calls.length, 1)
}
for (const options of [{}, { authUrl, loginSucceeds: false }]) {
  const session = fakeSession(options)
  await assert.rejects(createHostAuth({ session, target, authUrl: options.authUrl }).ensureAuthenticated(), (error) => {
    check(error.message.includes('private-test-token'), false)
    return /authentication/.test(error.message)
  })
}
for (const invalid of ['http://evil.example/?token=x', 'http://127.0.0.1:3081/live2d/?token=x',
  'http://127.0.0.1:3081/?token=x&token=y', 'http://user:pass@127.0.0.1:3081/?token=x']) {
  assert.throws(() => createHostAuth({ session: fakeSession(), target, authUrl: invalid }), /Invalid DSH/)
  assertions++
}
console.log(`host auth: ${assertions} assertions passed`)
