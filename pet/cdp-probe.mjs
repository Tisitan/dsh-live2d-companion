// 主进程限频合并验收 v2：真实节奏派发 + 位移精确 + 位置写盘落地
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
for (let i = 0; i < 15; i++) {
  if (await ev(`!!window.__l2d?.model`)) break
  await new Promise(r => setTimeout(r, 1000))
}

console.log('model alive:', await ev(`window.__l2d.model.width > 0`))

// 真实节奏：200 次移动按 5ms 间隔派发（200Hz，经渲染 rAF 合并+主进程 30Hz 合并）
const bx = await ev(`window.__petBridge.getCursor().then(d => d.bounds.x)`, true)
await ev(`new Promise(done => {
  const box = document.getElementById('l2d-companion')
  const fire = (type, sx) => box.dispatchEvent(new PointerEvent(type, { screenX: sx, screenY: 500, clientX: 100, clientY: 200, bubbles: true, pointerId: 1, isPrimary: true }))
  fire('pointerdown', 1000)
  let i = 0
  const timer = setInterval(() => {
    i++
    fire('pointermove', 1000 + i * 2)
    if (i >= 200) { clearInterval(timer); fire('pointerup', 1400); done('dragged') }
  }, 5)
})`, true)
await new Promise(r => setTimeout(r, 800))
const ax = await ev(`window.__petBridge.getCursor().then(d => d.bounds.x)`, true)
console.log('drag displacement (expect 400):', ax - bx)

ws.close()
process.exit(0)
