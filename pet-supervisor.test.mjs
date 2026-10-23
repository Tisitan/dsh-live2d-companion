import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { USER_QUIT_EXIT_CODE } from './pet/exit-reasons.cjs'

const index = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
const main = fs.readFileSync(new URL('./pet/main.js', import.meta.url), 'utf8')
const start = index.indexOf('\n  if (config?.pet === true) {')
const end = index.indexOf("\n  ctx.logger.info('live2d companion mounted:", start)
assert.ok(start > 0 && end > start)
// Run the actual supervisor block with a fake process and clock. The only
// syntactic substitution is import.meta.url, which a vm.Script cannot parse.
const supervisor = index.slice(start, end).replaceAll('import.meta.url', JSON.stringify(new URL('./index.js', import.meta.url).href))
const quitHandler = main.match(/  ipcMain\.on\('l2d-quit', \(event\) => \{[\s\S]*?\n  \}\)/)?.[0]
assert.ok(quitHandler)
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve() }

function fixture() {
  let now = 100000, timerId = 0, record = null, find = async () => ({ status: 'free' })
  const timers = new Map(), children = [], disposers = [], logs = []
  const scope = {
    URL, fileURLToPath, USER_QUIT_EXIT_CODE,
    config: { pet: true, petDir: '/fixture/pet' }, PET_PID_FILE: '/fixture/pet.pid',
    petChild: null, managedPetPid: null, petGen: 0, petKillTimer: null,
    petRespawnTimer: null, requestPetRespawn: null, petRespawnHistory: [], petSickRespawns: 0,
    lastPetSpawnAt: 0, petExitHookArmed: false,
    existsSync: () => true, ensurePetCredentialDir() {}, openPetLogFd: () => null,
    closeSync() {}, join: path.join, readPidRecord: () => record,
    process: { platform: 'linux', env: {}, on() {}, kill() {} },
    findLivePet: (...args) => find(...args), Date: { now: () => now },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id },
    clearTimeout: id => timers.delete(id),
    spawn(exe, args, options) {
      const child = Object.assign(new EventEmitter(), { pid: 7000 + children.length, exitCode: null, killed: false, unref() {} })
      children.push({ child, options })
      record = { pid: child.pid, bornAt: now, passthroughProvenAt: now }
      return child
    },
  }
  const context = vm.createContext(scope)
  const mount = async (origin = 'http://127.0.0.1:1') => {
    scope.ctx = {
      logger: { info: text => logs.push(text), warn: text => logs.push(text) },
      webServer: { getOrigin: () => origin }, connection: { authenticatedUrl: value => value },
      effect: fn => disposers.push(fn()),
    }
    vm.runInContext('(() => {' + supervisor + '\n})()', context)
    await flush()
    return disposers.at(-1)
  }
  const exit = (code, child = children.at(-1).child) => {
    child.exitCode = code
    child.emit('exit', code)
  }
  const advance = async ms => {
    now += ms
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() }
    await flush()
  }
  function shell() {
    const ipc = new EventEmitter(), owner = {}, child = children.at(-1).child
    let exitCode = null, quitCalls = 0
    const app = Object.assign(new EventEmitter(), {
      commandLine: { appendSwitch() {} }, getPath: () => '/fixture',
      requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }),
      exit(code) { exitCode = code },
      quit() {
        quitCalls++
        app.emit('will-quit')
        exitCode ??= 0
        exit(exitCode, child)
      },
    })
    const fakeFs = {
      readFileSync(file) { if (file === scope.PET_PID_FILE && record) return JSON.stringify(record); throw Error('missing') },
      writeFileSync(file, text) { if (file === scope.PET_PID_FILE) record = JSON.parse(text) },
      mkdirSync() {}, rmSync(file) { if (file === scope.PET_PID_FILE) record = null },
    }
    const runtime = vm.createContext({
      require(name) {
        if (name === 'electron') return { app, ipcMain: ipc }
        if (name === 'node:fs') return fakeFs
        if (name === 'node:path') return path
        if (name === './exit-reasons.cjs') return { USER_QUIT_EXIT_CODE }
        return {}
      },
      process: { pid: child.pid, execPath: '/fixture/electron', env: { L2D_PIDFILE: scope.PET_PID_FILE } },
      console, URL,
    })
    vm.runInContext(main, runtime)
    runtime.owner = owner
    vm.runInContext('win = { isDestroyed: () => false, webContents: owner };' + quitHandler, runtime)
    return { app, quit: (sender = owner) => ipc.emit('l2d-quit', { sender }),
      get code() { return exitCode }, get calls() { return quitCalls } }
  }
  return { scope, children, timers, logs, mount, exit, advance, shell,
    set find(fn) { find = fn }, get record() { return record }, set record(value) { record = value } }
}

test('user quit closes the owned pet and removes its PID without restarting it', async () => {
  const f = fixture(); await f.mount()
  const shell = f.shell()
  shell.quit()
  assert.equal(shell.code, USER_QUIT_EXIT_CODE)
  assert.equal(f.record, null)
  await f.advance(60000)
  assert.equal(f.children.length, 1)
  assert.equal(f.scope.managedPetPid, null)
  assert.equal(f.timers.size, 0)
})

test('watchdog quit still recovers after backoff and foreign quit IPC is ignored', async () => {
  const f = fixture(); await f.mount()
  const shell = f.shell()
  shell.quit({})
  assert.equal(shell.calls, 0)
  assert.equal(f.record.pid, f.children[0].child.pid)
  shell.app.quit()
  assert.equal(shell.code, 0)
  await f.advance(29999)
  assert.equal(f.children.length, 1)
  await f.advance(1)
  assert.equal(f.children.length, 2)
})

test('user quit preserves a PID record already owned by a replacement process', async () => {
  const f = fixture(); await f.mount()
  const shell = f.shell()
  f.record = { pid: 9000 }
  shell.quit()
  assert.deepEqual(f.record, { pid: 9000 })
  await f.advance(60000)
  assert.equal(f.children.length, 1)
})

test('an existing relaunched pet is adopted rather than duplicated', async () => {
  const f = fixture(); await f.mount()
  f.exit(0)
  f.find = async () => ({ status: 'alive', pid: 9000 })
  await f.advance(30000)
  assert.equal(f.children.length, 1)
  assert.equal(f.scope.managedPetPid, 9000)
})

test('disposal during an asynchronous recovery check prevents a late respawn', async () => {
  const f = fixture(); const dispose = await f.mount()
  f.exit(1)
  let finish
  f.find = () => new Promise(resolve => { finish = resolve })
  await f.advance(30000)
  dispose()
  finish({ status: 'free' })
  await flush()
  assert.equal(f.children.length, 1)
  assert.equal(f.scope.requestPetRespawn, null)
})

test('a remount adopts the child and routes its future recovery through the current host', async () => {
  const f = fixture(); const oldDispose = await f.mount()
  oldDispose()
  const dispose = await f.mount('http://127.0.0.1:2')
  assert.equal(f.children.length, 1)
  f.exit(1)
  await f.advance(30000)
  assert.equal(f.children.length, 2)
  assert.equal(f.children[1].options.env.L2D_URL, 'http://127.0.0.1:2/live2d/pet.html')
  dispose()
  f.exit(1)
  await f.advance(60000)
  assert.equal(f.children.length, 2)
})

test('user quit invalidates recovery already waiting for an asynchronous PID check', async () => {
  const f = fixture(); await f.mount()
  // A recovery check from an earlier exit is still pending while an already
  // launched replacement becomes owned. Quitting it must invalidate that check.
  f.scope.requestPetRespawn()
  let finish
  f.find = () => new Promise(resolve => { finish = resolve })
  await f.advance(30000)
  const shell = f.shell()
  shell.quit()
  finish({ status: 'free' })
  await flush()
  assert.equal(f.children.length, 1)
  assert.equal(f.scope.requestPetRespawn, null)
})
