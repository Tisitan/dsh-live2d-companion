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
  return r.exceptionDetails ? 'EXC: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text) : r.result?.value
}

console.log('=== idempotent layout guard ===')
const b0 = JSON.parse(await ev(`JSON.stringify(window.__l2d.bounds)`))
console.log('bounds before:', JSON.stringify(b0))

// 同尺寸连调三次 layout：不报错、模型位置稳定
await ev(`window.__l2d.ctx.layout(); window.__l2d.ctx.layout(); window.__l2d.ctx.layout(); 'ok'`)
await new Promise(r => setTimeout(r, 300))
const b1 = JSON.parse(await ev(`JSON.stringify(window.__l2d.bounds)`))
console.log('bounds after 3 same-size layout:', JSON.stringify(b1))
console.log('model position stable:', Math.abs(b0.x - b1.x) < 1 && Math.abs(b0.y - b1.y) < 1 && Math.abs(b0.w - b1.w) < 1)

// 真实窗口尺寸变化 → resize 照常生效
await ev(`window.__petBridge.resizeTo(500, 700)`)
await new Promise(r => setTimeout(r, 600))
console.log('after resizeTo 500x700 → innerW/H:', await ev(`window.innerWidth + 'x' + window.innerHeight`))
console.log('renderer screen matches:', await ev(`window.__l2d.app.renderer.screen.width + 'x' + window.__l2d.app.renderer.screen.height`))
const b2 = JSON.parse(await ev(`JSON.stringify(window.__l2d.bounds)`))
console.log('model fits new window:', b2.x >= 0 && b2.y >= 0 && b2.x + b2.w <= 500 && b2.y + b2.h <= 700)

// 还原
await ev(`window.__petBridge.resizeTo(339, 631)`)
await new Promise(r => setTimeout(r, 400))
console.log('restored:', await ev(`window.innerWidth + 'x' + window.innerHeight`))

ws.close()
process.exit(0)
