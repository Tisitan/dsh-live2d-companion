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

console.log('=== quit button flow ===')
console.log('quit row visible (expect false=shown):', await ev(`document.querySelector('.l2d-quit-row')?.hidden`))
console.log('initial text:', await ev(`document.querySelector('.l2d-quit')?.textContent`))

// 第一次点击：进入确认态（不退出）
await ev(`document.querySelector('.l2d-quit').click()`)
await new Promise(r => setTimeout(r, 300))
console.log('after 1st click text (expect 确认):', await ev(`document.querySelector('.l2d-quit')?.textContent`))
console.log('armed class:', await ev(`document.querySelector('.l2d-quit')?.classList.contains('arm')`))

// 等 3 秒确认态过期 → 文字应还原（验证防误触回退）
await new Promise(r => setTimeout(r, 3200))
console.log('after 3.2s text (expect 还原):', await ev(`document.querySelector('.l2d-quit')?.textContent`))

// 双击确认退出：点两次
await ev(`document.querySelector('.l2d-quit').click()`)
await new Promise(r => setTimeout(r, 200))
await ev(`document.querySelector('.l2d-quit').click()`)
console.log('double-clicked quit, waiting for app exit...')
await new Promise(r => setTimeout(r, 3000))
ws.close()
process.exit(0)
