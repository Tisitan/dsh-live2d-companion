// 三态锁钮 + 独立问号 + roomy 排版 验收（真实 OS 光标驱动 + 截图）
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const setCursor = (x, y) => execFileSync('powershell', ['-NoProfile', '-Command',
  `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`])

const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find(t => t.type === 'page' && t.url.includes('pet.html') && !t.url.includes('preview'))
if (!page) { console.log('NO PAGE'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? d.error); pending.delete(d.id) }
}
await new Promise(r => { ws.onopen = r })
const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise })
  return r.exceptionDetails ? 'EXC: ' + (r.exceptionDetails.exception?.description ?? '') : r.result?.value
}
for (let i = 0; i < 15; i++) {
  if (await ev(`!!window.__l2d?.model`)) break
  await new Promise(r => setTimeout(r, 1000))
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const shot = async (name, clip) => {
  const s = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 2 } })
  writeFileSync(`pet/${name}`, Buffer.from(s.data, 'base64'))
}
const pinState = () => ev(`(() => { const b = document.getElementById('l2d-pin-toggle'); return b.textContent + (b.classList.contains('on') ? '+蓝' : b.classList.contains('auto') ? '+绿' : '+白') })()`)
const saved = await ev(`window.__petBridge.getCursor().then(d => ({ x: d.x, y: d.y }))`, true)
const b = JSON.parse(await ev(`JSON.stringify(window.__l2d.bounds)`))
const mx = Math.round(b.x + b.w / 2), my = Math.round(b.y + b.h / 2)

console.log('===  roomy 模式 ===')
console.log('body.l2d-roomy:', await ev(`document.body.classList.contains('l2d-roomy')`))

console.log('=== 锁钮三态 ===')
setCursor(500, 500); await sleep(300)
setCursor(mx, my); await sleep(200)
console.log('接近模型（穿透中） expect 🔒+绿:', await pinState())
await sleep(800)
console.log('停留解锁后 expect 🔓+白:', await pinState())
setCursor(500, 500); await sleep(400)
console.log('离开后 expect 🔒+绿:', await pinState())
await ev(`document.getElementById('l2d-pin-toggle').click()`); await sleep(200)
console.log('手动锁定 expect 🔒+蓝:', await pinState())
await ev(`document.getElementById('l2d-pin-toggle').click()`); await sleep(200)
console.log('解除 expect 🔒+绿:', await pinState())

console.log('=== 三按钮簇截图 ===')
setCursor(mx, my); await sleep(300)
const gr = JSON.parse(await ev(`JSON.stringify(document.getElementById('l2d-model-toggle').getBoundingClientRect())`))
await shot('ui-cluster.png', { x: gr.x - 92, y: gr.y - 6, width: 140, height: 48 })
setCursor(500, 500); await sleep(300)

console.log('=== 独立问号 + 帮助卡 ===')
console.log('help toggle present:', await ev(`!!document.getElementById('l2d-help-toggle')`))
console.log('menu items (expect 无基本操作):', await ev(`[...document.querySelectorAll('#l2d-pet-menu button')].map(x => x.textContent).join('|')`))
await ev(`document.getElementById('l2d-help-toggle').click()`); await sleep(400)
console.log('help card open:', await ev(`document.getElementById('l2d-help-card').classList.contains('open')`))
const hc = JSON.parse(await ev(`JSON.stringify(document.getElementById('l2d-help-card').getBoundingClientRect())`))
await shot('ui-help.png', { x: hc.x - 4, y: hc.y - 4, width: hc.width + 8, height: hc.height + 8 })
await ev(`document.querySelector('.l2d-help-close').click()`); await sleep(200)

console.log('=== 模型面板 roomy 截图 ===')
await ev(`document.getElementById('l2d-model-toggle').click()`); await sleep(200)
await ev(`document.querySelector('[data-act="panel"]').click()`); await sleep(500)
const pc = JSON.parse(await ev(`JSON.stringify(document.getElementById('l2d-model-panel').getBoundingClientRect())`))
console.log('panel width (expect ~360):', Math.round(pc.width))
await shot('ui-panel.png', { x: pc.x - 4, y: pc.y - 4, width: pc.width + 8, height: Math.min(pc.height + 8, 620) })
await ev(`document.querySelector('.l2d-panel-close').click()`)

setCursor(saved.x, saved.y)
ws.close()
process.exit(0)
