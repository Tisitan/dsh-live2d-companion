const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find(t => t.type === 'page')
if (!page) { console.log('NO PAGE TARGET'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? msg.error)
    pending.delete(msg.id)
  }
}
await new Promise(r => { ws.onopen = r })

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r.exceptionDetails ? 'EXC: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text) : (r.result?.value ?? JSON.stringify(r))
}

console.log('setup:', await evalJs(`(() => {
  window.__err = []
  window.addEventListener('error', (e) => window.__err.push(String(e.message)))
  window.__m = 0
  window.__clicks = 0
  window.__downs = 0
  window.__ups = 0
  const box = document.getElementById('l2d-companion')
  box.addEventListener('click', () => window.__clicks++, true)
  box.addEventListener('pointerdown', () => window.__downs++, true)
  box.addEventListener('pointerup', () => window.__ups++, true)
  const mm = window.__l2d.model.motion.bind(window.__l2d.model)
  window.__l2d.model.motion = (...a) => { window.__m++; return mm(...a) }
  window.__l2d.enter('idle')
  return 'ok'
})()`))

console.log('synthetic js click:', await evalJs(`(() => {
  document.getElementById('l2d-companion').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  return JSON.stringify({ clicks: window.__clicks, motions: window.__m, state: window.__l2d.state, err: window.__err })
})()`))

const b = JSON.parse(await evalJs(`JSON.stringify(window.__l2d.bounds)`))
const cx = Math.round(b.x + b.w / 2)
const cy = Math.round(b.y + b.h / 2)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
await new Promise(r => setTimeout(r, 200))
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
await new Promise(r => setTimeout(r, 120))
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
await new Promise(r => setTimeout(r, 800))

console.log('after cdp click:', await evalJs(`JSON.stringify({ downs: window.__downs, ups: window.__ups, clicks: window.__clicks, motions: window.__m, state: window.__l2d.state, err: window.__err })`))

ws.close()
process.exit(0)
