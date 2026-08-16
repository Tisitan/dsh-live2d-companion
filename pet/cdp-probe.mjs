const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find(t => t.type === 'page' && t.url.includes('pet.html'))
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

console.log('maxFPS now:', await ev(`window.__l2d.app.ticker.maxFPS`))
console.log('ticker started:', await ev(`window.__l2d.app.ticker.started`))
// 真·渲染率：数 PIXI ticker 发射次数（maxFPS 的跳过就发生在这里）
console.log('ticker emissions/s (2s):', await ev(`new Promise(res => { let n = 0; const f = () => n++; window.__l2d.app.ticker.add(f); setTimeout(() => { window.__l2d.app.ticker.remove(f); res((n / 2).toFixed(1)) }, 2000) })`, true))
console.log('enter sleeping:', await ev(`window.__l2d.enter('sleeping'), window.__l2d.app.ticker.maxFPS`))
console.log('ticker emissions/s sleeping (2s):', await ev(`new Promise(res => { let n = 0; const f = () => n++; window.__l2d.app.ticker.add(f); setTimeout(() => { window.__l2d.app.ticker.remove(f); res((n / 2).toFixed(1)) }, 2000) })`, true))
console.log('back to idle:', await ev(`window.__l2d.enter('idle'), window.__l2d.app.ticker.maxFPS`))

ws.close()
process.exit(0)
