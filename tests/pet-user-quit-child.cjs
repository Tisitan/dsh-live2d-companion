// Test driver only: the window, preload, IPC and shutdown below are the real pet.
const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const run = process.env.L2D_SMOKE_RUN
if (!run) throw Error('This child must be launched by pet-user-quit-smoke.cjs')
app.setPath('userData', path.join(run, 'child-profile'))
app.commandLine.appendSwitch('no-sandbox')
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11')
app.commandLine.appendSwitch('disable-dev-shm-usage')
app.commandLine.appendSwitch('mute-audio')
app.commandLine.appendSwitch('no-proxy-server')
const evidence = path.join(run, 'child-events.jsonl')
const record = value => fs.appendFileSync(evidence, JSON.stringify({ ...value, at: Date.now() }) + '\n')
app.on('browser-window-created', (_event, window) => {
  window.webContents.setAudioMuted(true)
  window.webContents.once('did-finish-load', async () => {
    try {
      const bridge = await window.webContents.executeJavaScript('typeof window.__petBridge?.quit === "function" && typeof require === "undefined"')
      record({ event: 'native-window-loaded', bridge,
        nativeHandle: window.getNativeWindowHandle().some(byte => byte !== 0), electron: process.versions.electron })
      // Allow normal window initialization and passthrough proof before invoking
      // the same context-isolated bridge used by the real Quit button.
      setTimeout(() => {
        record({ event: 'quit-bridge-called' })
        window.webContents.executeJavaScript('window.__petBridge.quit()').catch(() => {})
      }, 1800)
    } catch (error) { record({ event: 'driver-error', message: String(error) }); app.exit(1) }
  })
})
require('../pet/main.js')
