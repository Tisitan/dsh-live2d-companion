// Real Electron / native HWND checks on a disposable Windows runner only.
// No DSH instance or provider credentials are used. The actual pet/main.js and
// preloads run against a temporary copy served by the real standalone server.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { app, BrowserWindow, screen, session } = require('electron')
const { createStandaloneServer } = require('../standalone/server.cjs')

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('This test may only run on a disposable Windows GitHub runner')
}
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-native-window-'))
const publicDir = path.join(temp, 'public')
const pidFile = path.join(temp, 'pet.pid.json')
app.setPath('userData', path.join(temp, 'electron-profile'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('mute-audio')
const requestedScale = process.env.L2D_SMOKE_SCALE || '1'
assert.ok(['1', '1.5'].includes(requestedScale))
app.commandLine.appendSwitch('force-device-scale-factor', requestedScale)
delete process.env.L2D_AUTH_URL
delete process.env.L2D_DEBUG
delete process.env.L2D_SOFT
process.env.L2D_PIDFILE = pidFile
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const checks = []
const check = (name, value) => { assert.ok(value, name); checks.push(name) }
async function until(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await fn()) return; await pause(50) }
  throw new Error('Timed out: ' + label)
}
function hwnd(win) { return Number(win.getNativeWindowHandle().readBigUInt64LE()) }
async function native(win, operation = 'inspect', point = {}) {
  const { stdout } = await promisify(execFile)('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'windows-native-window.ps1'),
    '-WindowHandle', String(hwnd(win)), '-Operation', operation,
    '-X', String(point.x || 0), '-Y', String(point.y || 0),
  ], { timeout: 20000, windowsHide: true })
  return JSON.parse(stdout.trim())
}
let server
const cardGeometry = []
const watchdog = setTimeout(() => { console.error('Native window smoke timed out'); app.exit(1) }, 120000)

async function main() {
  fs.cpSync(path.join(root, 'public'), publicDir, { recursive: true,
    filter: source => path.basename(source) !== 'model' })
  fs.cpSync(path.join(root, 'games'), path.join(temp, 'games'), { recursive: true })
  server = await createStandaloneServer({ publicDir, dataDir: temp })
  await app.whenReady()
  const login = await session.defaultSession.fetch(server.target)
  check('temporary server cookie bootstrap', login.ok)
  process.env.L2D_URL = server.origin + '/live2d/pet.html'
  let pet
  app.once('browser-window-created', (_event, win) => { pet = win })
  require('../pet/main.js')
  await until(() => pet && !pet.webContents.isLoading() && pet.webContents.getURL().includes('/pet.html'), 'pet document')
  await until(() => pet.webContents.executeJavaScript('!!window.__petBridge'), 'real preload bridge')
  await until(() => pet.isVisible(), 'visible overlay')
  pet.webContents.setAudioMuted(true)
  const workArea = screen.getPrimaryDisplay().workArea
  const initialBounds = pet.getBounds()
  // Fractional scale converts integer physical pixels to rounded DIP bounds.
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(initialBounds[key] - workArea[key]) <= 1, 'work area ' + key)
  check('overlay covers primary work area within one DIP rounding', true)
  check('always-on-top and fixed size', pet.isAlwaysOnTop() && !pet.isResizable())
  const prefs = pet.webContents.getLastWebPreferences()
  check('sandbox and context isolation', prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration)
  let style = await native(pet)
  check('native topmost / NOACTIVATE / mouse-transparent flags', style.topmost && style.noActivate && style.transparent)
  check('initial overlay cannot take keyboard focus', !pet.isFocusable())

  // An OS-generated click must reach the real window underneath the overlay.
  const under = new BrowserWindow({ x: workArea.x + 30, y: workArea.y + 30,
    width: 300, height: 200, frame: false, show: false, webPreferences: { sandbox: true } })
  await under.loadURL('data:text/html,<body style="background:green">click target<script>window.clicks=0;document.addEventListener("click",()=>window.clicks++)</script>')
  under.show(); under.focus()
  await pause(400)
  const point = screen.dipToScreenPoint({ x: workArea.x + 100, y: workArea.y + 100 })
  style = await native(pet, 'click', point)
  await until(() => under.webContents.executeJavaScript('window.clicks > 0'), 'native click-through')
  check('native mouse click reaches underlying window', true)
  check('overlay click does not steal foreground focus', style.foreground === hwnd(under))

  const invoke = js => pet.webContents.executeJavaScript(js)
  await invoke('__petBridge.setOverlayFocusable("settings", true)')
  await until(() => pet.isFocusable(), 'settings keyboard focus')
  check('opening an input panel removes native NOACTIVATE', !(await native(pet)).noActivate)
  await invoke('__petBridge.setOverlayFocusable("chat", true); __petBridge.setOverlayFocusable("settings", false)')
  await pause(100)
  check('two focus owners do not disable each other', pet.isFocusable())
  await invoke('__petBridge.setOverlayFocusable("chat", false)')
  await until(() => !pet.isFocusable(), 'last input panel closed')
  check('closing last input panel restores native NOACTIVATE', (await native(pet)).noActivate)
  await invoke('__petBridge.setOverlayFocusable("settings", true)')
  await until(() => pet.isFocusable(), 'focus before reload')
  pet.reload()
  await until(() => !pet.webContents.isLoading() && !pet.isFocusable(), 'reload clears focus owners')
  check('reload clears stale focus ownership', true)
  pet.minimize()
  await until(() => !pet.isMinimized(), 'minimize recovery')
  check('minimize automatically restores overlay', true)
  under.close()

  await invoke('__petBridge.openGame("gomoku")')
  const cards = () => BrowserWindow.getAllWindows().filter(w => w !== pet)
  await until(() => cards().length === 1 && cards()[0].webContents.getURL().includes('/game-card.html') && !cards()[0].webContents.isLoading(), 'gomoku card')
  const card = cards()[0]
  await until(() => card.webContents.executeJavaScript('!!window.__cardBridge'), 'card preload')
  check('card is topmost, fixed-size and keyboard-focusable', card.isAlwaysOnTop() && !card.isResizable() && card.isFocusable())
  await invoke('__petBridge.openGame("gomoku")')
  await pause(150)
  check('same game reuses one card', cards().length === 1)
  await pause(300)
  const bounds = card.getBounds()
  const nativeCard = await native(card)
  check('fixed frameless card has no native thick frame', !nativeCard.thickFrame)
  check('initial card fits the work area', bounds.x >= workArea.x - 1 && bounds.y >= workArea.y - 1 &&
    bounds.x + bounds.width <= workArea.x + workArea.width + 1 && bounds.y + bounds.height <= workArea.y + workArea.height + 1)
  cardGeometry.push({ phase: 'baseline', dip: bounds, native: nativeCard })
  const stableSize = () => Math.abs(card.getSize()[0] - bounds.width) <= 1 && Math.abs(card.getSize()[1] - bounds.height) <= 1
  const assertPhysicalSize = measurement => {
    assert.equal(measurement.physicalBounds.width, nativeCard.physicalBounds.width, 'native pixel width must not drift')
    assert.equal(measurement.physicalBounds.height, nativeCard.physicalBounds.height, 'native pixel height must not drift')
  }
  for (let i = 0; i < 10; i++) {
    const before = card.getBounds(), dx = i % 2 ? 31 : -31, dy = i % 2 ? -19 : 19
    await card.webContents.executeJavaScript(`__cardBridge.moveBy(${dx}, ${dy})`)
    await until(() => Math.abs(card.getBounds().x - (before.x + dx)) <= 1, 'card move')
    // DIP bounds enclose the integer pixel rectangle. At 150%, moving the
    // origin can change the reported width by one DIP with identical physical
    // width. Test physical dimensions strictly, separately from that rounding.
    await until(stableSize, 'post-drag card size settles')
    await pause(300)
    const measurement = await native(card)
    cardGeometry.push({ phase: 'move-' + i, dip: card.getBounds(), native: measurement })
    assertPhysicalSize(measurement)
    const moved = card.getBounds()
    assert.ok(stableSize())
    assert.ok(Math.abs(moved.x - (before.x + dx)) <= 1 && Math.abs(moved.y - (before.y + dy)) <= 1)
  }
  await pause(1000)
  assertPhysicalSize(await native(card))
  check('ten card drag cycles preserve exact native pixel dimensions', stableSize())
  card.setSize(bounds.width + 20, bounds.height + 20)
  await until(stableSize, 'card size guard')
  await pause(300)
  assertPhysicalSize(await native(card))
  check('card size guard restores dimensions', true)
  await invoke('__petBridge.openGame("chess")')
  await until(() => cards().length === 2, 'second game card')
  const areas = await invoke('__petBridge.getCardArea()')
  check('two game cards report independent dead zones', Array.isArray(areas) && areas.length === 2)
  await card.webContents.executeJavaScript('__cardBridge.close()')
  await until(() => card.isDestroyed() && cards().length === 1, 'card-specific close')
  check('card preload closes only its own window', true)
  for (const remaining of cards()) remaining.close()
  check('PID record belongs to tested process', JSON.parse(fs.readFileSync(pidFile)).pid === process.pid)
  await server.close()
  clearTimeout(watchdog)
  app.once('will-quit', () => {
    check('normal quit removes owned PID record', !fs.existsSync(pidFile))
    console.log('WINDOW_SMOKE_RESULT=' + JSON.stringify({ platform: process.platform,
      electron: process.versions.electron, dpi: style.dpi, requestedScale, initialBounds, workArea, cardGeometry, checks,
      realModelRendered: false, limitations: ['CI virtual desktop, no physical GPU/monitor validation'], success: true }))
  })
  app.quit()
}
main().catch(async error => {
  console.error(error.stack)
  console.error('WINDOW_SMOKE_RESULT=' + JSON.stringify({ checks, cardGeometry, success: false }))
  clearTimeout(watchdog)
  try { await server?.close() } catch {}
  app.exit(1)
})
