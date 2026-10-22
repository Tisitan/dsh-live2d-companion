// Run with Electron, not Node. Local runs require L2D_LAYOUT_SMOKE=1 and an
// isolated display (for example xvfb-run -a). CI may run on its disposable desktop.
// Only repository static files and an ephemeral loopback fixture server are used.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

if (!app) throw new Error('Run this test with the Electron executable')
if (process.env.GITHUB_ACTIONS !== 'true' && process.env.L2D_LAYOUT_SMOKE !== '1') {
  throw new Error('Use a disposable display and set L2D_LAYOUT_SMOKE=1 for local runs')
}

const publicDir = path.resolve(__dirname, '../public')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-card-layout-'))
const cases = []
const moves = []
const errors = []
let server
let win
app.setPath('userData', path.join(temp, 'profile'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('mute-audio')
app.on('window-all-closed', () => {})

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const evaluate = code => win.webContents.executeJavaScript(code)
async function until(fn, label) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    if (await fn()) return
    await pause(50)
  }
  throw new Error('Timed out: ' + label)
}

function state(game) {
  const common = { game, status: 'playing', busy: false, mode: 'offline', moves: [],
    commentary: [{ from: 'system', text: '本地布局测试：棋盘与解说应当均可访问。' }] }
  if (game === 'chess') {
    const board = Array.from({ length: 8 }, () => Array(8).fill(null))
    board[7][7] = 'R'
    return { ...common, board, turn: 'w', legal: [{ from: { x: 7, y: 7 }, to: { x: 7, y: 6 } }] }
  }
  return { ...common, size: 15, board: Array.from({ length: 15 }, () => Array(15).fill(0)) }
}

async function startFixture() {
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const json = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)) }
      if (url.pathname === '/live2d/game/list') {
        json({ games: [{ id: 'gomoku', name: '五子棋', available: true }, { id: 'chess', name: '国际象棋', available: true }] })
      } else if (url.pathname === '/live2d/game/presets') {
        json({ presets: [{ id: 'fixture', name: '本地测试人格' }] })
      } else if (url.pathname === '/live2d/game/models') {
        json({ models: [{ id: 'fixture', name: '本地测试模型' }] })
      } else if (url.pathname === '/live2d/game/state') {
        json(state(url.searchParams.get('game')))
      } else if (url.pathname === '/live2d/game/move' && req.method === 'POST') {
        let body = ''
        for await (const chunk of req) body += chunk
        const input = JSON.parse(body)
        moves.push(input)
        json(state(input.game))
      } else {
        const file = path.resolve(publicDir, url.pathname.replace(/^\/live2d\//, ''))
        if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403); res.end(); return }
        const contents = fs.readFileSync(file)
        res.setHeader('content-type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8')
        res.end(contents)
      }
    } catch (error) {
      errors.push(String(error))
      res.writeHead(500)
      res.end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function clickCanvas(x, y) {
  const point = await evaluate(`(() => {
    const canvas = document.querySelector('#l2d-game canvas')
    canvas.scrollIntoView({ block: 'end' })
    const rect = canvas.getBoundingClientRect()
    return { x: rect.x + ${x} * rect.width / canvas.width, y: rect.y + ${y} * rect.height / canvas.height }
  })()`)
  for (const type of ['mouseDown', 'mouseUp']) {
    win.webContents.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
  }
}

async function checkLayout(origin, game, width, height) {
  win = new BrowserWindow({ width, height, frame: false, show: true, hasShadow: false,
    ...(process.platform === 'win32' ? { thickFrame: false } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) errors.push(message)
  })
  await win.loadURL(`${origin}/live2d/game-card.html?game=${game}`)
  await until(() => evaluate(`document.querySelector('.l2d-game-status')?.textContent === ${JSON.stringify(`轮到你（${game === 'chess' ? '白' : '黑'}）`)}`), 'game renderer ready')
  const geometry = await evaluate(`(() => {
    const card = document.getElementById('l2d-game'), canvas = card.querySelector('canvas')
    const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
    return { viewport: [innerWidth, innerHeight], card: box(card), canvas: box(canvas), side: box(card.querySelector('.l2d-game-side')),
      direction: getComputedStyle(card.querySelector('.l2d-game-body')).flexDirection, overflow: getComputedStyle(card).overflow,
      client: [card.clientWidth, card.clientHeight], scroll: [card.scrollWidth, card.scrollHeight] }
  })()`)
  // Native frames can round by up to two DIP at fractional scale. The separate
  // native-window suite checks screen bounds; these checks use the real CSS viewport.
  assert.ok(Math.abs(geometry.viewport[0] - width) <= 2 && Math.abs(geometry.viewport[1] - height) <= 2,
    'fixture viewport stays within native rounding of its requested dimensions')
  assert.deepEqual(geometry.card, { x: 0, y: 0, width: geometry.viewport[0], height: geometry.viewport[1] }, 'card fills its window')
  assert.ok(geometry.scroll[0] <= geometry.client[0] + 1, 'no horizontal content clipping')
  const normal = geometry.viewport[0] >= 760 && geometry.viewport[1] >= 650
  if (normal) {
    assert.equal(geometry.direction, 'row')
    assert.equal(geometry.canvas.width, 500)
    assert.equal(geometry.canvas.height, 500)
    assert.ok(geometry.side.x >= geometry.canvas.x + geometry.canvas.width, 'commentary stays beside the full-size board')
    assert.ok(geometry.scroll[1] <= geometry.client[1] + 1, 'standard layout needs no scrollbar')
  } else {
    assert.equal(geometry.direction, 'column')
    assert.equal(geometry.overflow, 'auto')
    assert.ok(geometry.scroll[1] > geometry.client[1], 'small window has a scrollable board and commentary')
    assert.equal(geometry.canvas.width, geometry.canvas.height, 'responsive board keeps its aspect ratio')
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: 30, y: Math.min(height - 40, 300), deltaY: -600, canScroll: true })
    await until(() => evaluate("document.getElementById('l2d-game').scrollTop > 0"), 'real mouse wheel scrolls the card')
    let lastScroll = -1
    let stableSamples = 0
    await until(async () => {
      const scroll = await evaluate("document.getElementById('l2d-game').scrollTop")
      stableSamples = scroll === lastScroll ? stableSamples + 1 : 0
      lastScroll = scroll
      return stableSamples >= 3
    }, 'native wheel animation settles before checking controls')
  }
  // Programmatic reachability alone is insufficient: overflow:hidden can also
  // scrollIntoView. The native wheel assertion above verifies user scrolling.
  const controls = await evaluate(`(async () => {
    const result = []
    for (const element of document.querySelectorAll('#l2d-game button, #l2d-game input, #l2d-game select, .l2d-game-hint')) {
      if (element.getClientRects().length === 0) continue
      element.scrollIntoView({ block: 'center', inline: 'nearest' })
      await new Promise(resolve => requestAnimationFrame(resolve))
      const box = element.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2
      const hit = document.elementFromPoint(x, y)
      result.push({ name: element.className, reachable: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && (hit === element || element.contains(hit)) })
    }
    return result
  })()`)
  assert.ok(controls.length >= 8, 'settings, close, new game, and final hint are present')
  assert.deepEqual(controls.filter(control => !control.reachable), [], 'all controls and the final hint can be reached')
  let move
  if (width === 320) {
    const before = moves.length
    if (game === 'gomoku') await clickCanvas(474, 474)
    else { await clickCanvas(442.5, 442.5); await clickCanvas(442.5, 387.5) }
    await until(() => moves.length > before, 'scaled board click reaches the fixture backend')
    move = moves.at(-1)
    assert.deepEqual(move, game === 'gomoku' ? { game, x: 14, y: 14 } : { game, from: { x: 7, y: 7 }, to: { x: 7, y: 6 } })
  }
  cases.push({ game, requestedViewport: [width, height], viewport: geometry.viewport, direction: geometry.direction, canvas: geometry.canvas,
    scroll: geometry.scroll, reachableControls: controls.length, ...(move ? { move } : {}) })
  win.destroy()
  win = null
}

async function closeFixture() {
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
}

const watchdog = setTimeout(() => { console.error('Card layout smoke timed out'); app.exit(2) }, 45000)
app.whenReady().then(async () => {
  const origin = await startFixture()
  for (const game of ['gomoku', 'chess']) {
    for (const [width, height] of [[760, 650], [683, 480], [760, 480], [480, 480], [320, 400]]) {
      await checkLayout(origin, game, width, height)
    }
  }
  assert.deepEqual(errors, [], 'no renderer or fixture server errors')
  await closeFixture()
  clearTimeout(watchdog)
  console.log('CARD_LAYOUT_SMOKE_RESULT=' + JSON.stringify({ success: true, electron: process.versions.electron, cases }))
  app.quit()
}).catch(async error => {
  console.error(error.stack)
  console.error('CARD_LAYOUT_SMOKE_RESULT=' + JSON.stringify({ success: false, cases, errors }))
  await closeFixture()
  clearTimeout(watchdog)
  app.exit(1)
})
