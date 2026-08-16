const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const pages = targets.filter(t => t.type === 'page')
console.log('page targets:', pages.map(p => p.url).join(' | '))
const page = pages.find(t => t.url.includes('pet.html')) ?? pages[0]
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
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r.exceptionDetails ? 'EXC: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text) : r.result?.value
}

console.log('emit exists:', await ev(`typeof window.__l2d.ctx.emit`))
console.log('enter fn has emit:', await ev(`window.__l2d.ctx.enter.toString().includes('emit')`))
await ev(`window.__hookLog = []; window.__l2d.on('enter', (n, p) => window.__hookLog.push(n + '<-' + p))`)
console.log('manual emit:', await ev(`window.__l2d.ctx.emit('enter', 'x', 'y'), JSON.stringify(window.__hookLog)`))
console.log('via enter:', await ev(`window.__l2d.enter('thinking'), JSON.stringify(window.__hookLog)`))
await ev(`window.__l2d.enter('idle')`)

ws.close()
process.exit(0)
