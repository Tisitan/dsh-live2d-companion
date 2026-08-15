const { app, BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const TARGET = process.env.L2D_URL
  || ('http://127.0.0.1:3080/live2d/pet.html'
    + (process.env.L2D_MODEL ? '?model=' + encodeURIComponent(process.env.L2D_MODEL) : ''))
const WIN_W = 340
const WIN_H = 460

if (process.env.L2D_DEBUG === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

let win = null
const stateFile = () => path.join(app.getPath('userData'), 'window-pos.json')

function loadPos() {
  try {
    const p = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) return p
  } catch { }
  return null
}

function savePos() {
  if (win === null || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  try { fs.writeFileSync(stateFile(), JSON.stringify({ x, y })) } catch { }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
app.on('second-instance', () => {
  if (win !== null && !win.isDestroyed()) win.show()
})

app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().workAreaSize
  const saved = loadPos()
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: saved?.x ?? area.width - WIN_W - 24,
    y: saved?.y ?? area.height - WIN_H - 24,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadURL(TARGET)

  ipcMain.on('l2d-ignore', (_e, ignore) => {
    if (win !== null && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore, { forward: true })
  })
  ipcMain.on('l2d-move', (_e, dx, dy) => {
    if (win === null || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    win.setPosition(Math.round(x + dx), Math.round(y + dy))
  })
  ipcMain.on('l2d-resize', (_e, w, h) => {
    if (win === null || win.isDestroyed()) return
    const width = Math.min(Math.max(Math.round(w), 160), 1200)
    const height = Math.min(Math.max(Math.round(h), 220), 1600)
    const b = win.getBounds()
    if (width !== b.width || height !== b.height) {
      win.setBounds({
        x: Math.round(b.x - (width - b.width) / 2),
        y: Math.round(b.y + b.height - height),
        width,
        height,
      })
    }
  })
  win.on('moved', savePos)
  win.on('closed', () => { win = null })

  const origin = new URL(TARGET).origin
  let failures = 0
  setInterval(async () => {
    try {
      const r = await fetch(origin + '/live2d/state', { cache: 'no-store' })
      failures = r.ok ? 0 : failures + 1
    } catch {
      failures += 1
    }
    if (failures >= 5) app.quit()
  }, 8000)
})

app.on('window-all-closed', () => app.quit())
}
