// Isolated integration test: actual index.js supervisor block + real Electron
// pet/main.js/preload. Only the executable/entry path is redirected to the
// installed test Electron and wrapper. Recovery uses real wall-clock timers.
// Run with Node, not Electron; a child exit code of 64 is the expected result.
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const vm = require('node:vm')
const { spawn, execFileSync } = require('node:child_process')
const { pathToFileURL, fileURLToPath } = require('node:url')
if (process.platform === 'win32' ? process.env.GITHUB_ACTIONS !== 'true' : process.env.L2D_SMOKE_ISOLATED_DISPLAY !== '1') {
  throw Error('Use a disposable Windows CI runner or explicitly opt in on an isolated Xvfb display')
}
const repo = path.resolve(__dirname, '..')
const electronExe = process.env.L2D_SMOKE_ELECTRON || path.join(repo, 'pet/node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
if (!fs.existsSync(electronExe)) throw Error('Missing test Electron executable')
const run = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-user-quit-'))
const pidFile = path.join(run, 'pet.pid.json')
const source = fs.readFileSync(path.join(repo, 'index.js'), 'utf8')
const start = source.indexOf('\n  if (config?.pet === true) {')
const end = source.indexOf("\n  ctx.logger.info('live2d companion mounted:", start)
if (start < 0 || end <= start) throw Error('Supervisor block anchor changed')
const block = source.slice(start, end).replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(repo, 'index.js')).href))
const checks = [], children = [], logs = [], timers = new Set()
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const check = (name, pass, details) => { checks.push({ name, pass: !!pass, details }); console.log(pass ? 'PASS' : 'FAIL', name) }
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while(Date.now() < end) { const v = fn(); if(v) return v; await wait(100) } throw Error('Timed out waiting for native pet') }
const childEnv = { ...process.env }
for (const key of ['ELECTRON_RUN_AS_NODE', 'L2D_AUTH_URL', 'L2D_DEBUG', 'L2D_URL', 'L2D_PIDFILE']) delete childEnv[key]
let dispose, server, electronVersion
async function main() {
  const { findLivePet, readPidRecord } = await import(pathToFileURL(path.join(repo, 'pet-lifecycle.mjs')))
  const { USER_QUIT_EXIT_CODE } = require(path.join(repo, 'pet/exit-reasons.cjs'))
  server = http.createServer((req, res) => {
    if (req.url === '/live2d/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html><title>Isolated native quit check</title><script>window.__L2D_PAGE_LIVE=true</script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const scope = {
    URL, fileURLToPath, USER_QUIT_EXIT_CODE, Date,
    config: { pet: true, petDir: path.join(repo, 'pet') }, PET_PID_FILE: pidFile,
    petChild: null, managedPetPid: null, petGen: 0, petKillTimer: null,
    petRespawnTimer: null, requestPetRespawn: null, petRespawnHistory: [], petSickRespawns: 0,
    lastPetSpawnAt: 0, petExitHookArmed: false,
    existsSync: () => true, ensurePetCredentialDir() {}, openPetLogFd: () => null,
    closeSync: fs.closeSync, join: path.join, readPidRecord, findLivePet,
    process: { platform: process.platform, env: { ...childEnv, L2D_SMOKE_RUN: run, L2D_SOFT: '1' }, on() {}, kill: process.kill.bind(process) },
    setTimeout: (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn() }, ms); timers.add(timer); return timer },
    clearTimeout: timer => { clearTimeout(timer); timers.delete(timer) },
    spawn(_exe, _args, options) {
      const childLog = fs.openSync(path.join(run, 'child.log'), 'a')
      const args = ['--no-sandbox', '--disable-dev-shm-usage']
      if (process.platform === 'linux') args.push('--ozone-platform=x11')
      args.push(path.join(__dirname, 'pet-user-quit-child.cjs'))
      const child = spawn(electronExe, args, { ...options, stdio: ['ignore', childLog, childLog] })
      fs.closeSync(childLog)
      children.push(child)
      fs.writeFileSync(path.join(run, 'pet-child-pids.json'), JSON.stringify(children.map(c => c.pid)))
      child.on('error', error => logs.push({ event: 'spawn-error', message: error.message }))
      child.on('exit', (code, signal) => logs.push({ event: 'native-child-exit', code, signal, at: Date.now() }))
      return child
    },
    ctx: {
      logger: { info: message => logs.push({ event: 'supervisor-info', message }), warn: message => logs.push({ event: 'supervisor-warn', message }) },
      webServer: { getOrigin: () => `http://127.0.0.1:${server.address().port}` },
      connection: { authenticatedUrl: () => '' },
      effect: fn => { dispose = fn() },
    },
  }
  vm.runInContext('(() => {' + block + '\n})()', vm.createContext(scope))
  await until(() => children.length === 1 && fs.existsSync(pidFile))
  check('actual pet main writes owned PID credential', JSON.parse(fs.readFileSync(pidFile)).pid === children[0].pid)
  await until(() => logs.find(e => e.event === 'native-child-exit'))
  const childEvents = fs.readFileSync(path.join(run, 'child-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const loaded = childEvents.find(e => e.event === 'native-window-loaded')
  electronVersion = loaded?.electron
  check('real native window loads real isolated preload', loaded?.bridge && loaded.nativeHandle)
  check('quit requested through actual renderer bridge', childEvents.some(e => e.event === 'quit-bridge-called'))
  check('real Electron process exits with explicit user code 64', children[0].exitCode === USER_QUIT_EXIT_CODE && children[0].signalCode === null, { code: children[0].exitCode, signal: children[0].signalCode })
  check('will-quit deletes owned PID credential', !fs.existsSync(pidFile))
  check('actual supervisor clears managed child and recovery request', scope.managedPetPid === null && scope.petChild === null && scope.requestPetRespawn === null && scope.petRespawnTimer === null)
  const waitStart = Date.now()
  await wait(31000)
  check('real 30 second recovery window passes without another spawn', children.length === 1 && timers.size === 0, { observedWaitMs: Date.now() - waitStart, spawns: children.length, pendingSupervisorTimers: timers.size })
  dispose()
  check('unmount after explicit quit schedules no stale kill', timers.size === 0)
}
async function finish(error) {
  if (error) check('harness completed', false, String(error.stack || error))
  try { dispose?.() } catch {}
  for (const timer of timers) clearTimeout(timer)
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        else process.kill(-child.pid, 'SIGKILL')
      } catch {}
      await Promise.race([new Promise(resolve => child.once('close', resolve)), wait(3000)])
    }
  }
  server?.close()
  const result = { kind: 'real-native-user-quit-supervisor', electron: electronVersion, platform: process.platform,
    passed: checks.filter(c => c.pass).length, failed: checks.filter(c => !c.pass).length, checks,
    limits: ['A disposable virtual desktop is used; this is not a physical desktop compatibility claim.',
      'Supervisor code executes from actual index.js in an isolated VM context; DSH host services are stand-ins. Real Electron child, preload, IPC, shutdown, PID file and wall-clock recovery interval are exercised.'] }
  if (result.failed) {
    result.logs = logs
    try { result.childLog = fs.readFileSync(path.join(run, 'child.log'), 'utf8') } catch {}
  }
  if (process.env.L2D_SMOKE_RESULT) {
    fs.mkdirSync(path.dirname(process.env.L2D_SMOKE_RESULT), { recursive: true })
    fs.writeFileSync(process.env.L2D_SMOKE_RESULT, JSON.stringify(result, null, 2))
  }
  console.log(JSON.stringify(result, null, 2))
  try { fs.rmSync(run, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  catch (error) { console.error('Temporary profile cleanup failed:', String(error)); process.exitCode = 1 }
  process.exitCode ||= result.failed ? 1 : 0
}
main().then(() => finish(), finish)
