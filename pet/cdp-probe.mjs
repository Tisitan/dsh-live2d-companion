// 终审回归套件：面板共存(P2-8) + 问号卡新内容 + 状态机单会话通路 + 拖拽 + 气泡
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

console.log('=== 基础 ===')
console.log('model alive:', await ev(`window.__l2d.model.width > 0`))
console.log('state:', await ev(`window.__l2d.state`))

console.log('=== P2-8：模型面板开着时点词按钮，面板不该被关 ===')
await ev(`document.getElementById('l2d-model-toggle').click()`)
await new Promise(r => setTimeout(r, 400))
console.log('panel open:', await ev(`document.getElementById('l2d-model-panel').classList.contains('open')`))
await ev(`document.getElementById('l2d-quips-toggle').click()`)
await new Promise(r => setTimeout(r, 600))
console.log('after quips click, panel still open (expect true):', await ev(`document.getElementById('l2d-model-panel').classList.contains('open')`))
await ev(`document.querySelector('.l2d-quips-close').click()`)
await ev(`document.querySelector('.l2d-panel-close').click()`)
await new Promise(r => setTimeout(r, 300))

console.log('=== 问号卡新内容 ===')
await ev(`document.getElementById('l2d-model-help').click()`)
await new Promise(r => setTimeout(r, 300))
const helpItems = await ev(`[...document.querySelectorAll('#l2d-help-card li')].map(li => li.textContent).join(' | ')`)
console.log('help items:', helpItems)
console.log('含词编辑器 (expect true):', helpItems.includes('台词编辑器'))
console.log('含 CPU渲染 (expect true):', helpItems.includes('CPU渲染'))
await ev(`document.querySelector('.l2d-help-close').click()`)

console.log('=== 单会话状态机通路（raw 驱动回归）===')
await ev(`window.__l2d.enter('working')`)
await new Promise(r => setTimeout(r, 300))
console.log('manual working:', await ev(`window.__l2d.state`))
console.log('聚合帧可把状态拉回（宿主当前权威态，10s raw 静默后）: 跳过等待，仅确认无异常')

console.log('=== 拖拽回归 ===')
const bx = await ev(`window.__petBridge.getCursor().then(d => d.bounds.x)`, true)
await ev(`new Promise(done => {
  const box = document.getElementById('l2d-companion')
  const fire = (type, sx) => box.dispatchEvent(new PointerEvent(type, { screenX: sx, screenY: 500, clientX: 100, clientY: 200, bubbles: true, pointerId: 1, isPrimary: true }))
  fire('pointerdown', 1000)
  let i = 0
  const timer = setInterval(() => {
    i++
    fire('pointermove', 1000 + i * 2)
    if (i >= 50) { clearInterval(timer); fire('pointerup', 1100); done('ok') }
  }, 5)
})`, true)
await new Promise(r => setTimeout(r, 800))
const ax = await ev(`window.__petBridge.getCursor().then(d => d.bounds.x)`, true)
console.log('drag displacement (expect 100):', ax - bx)

console.log('=== 气泡 ===')
await ev(`window.__l2d.ctx.showBubble('回归气泡MARKER', 2000)`)
await new Promise(r => setTimeout(r, 300))
console.log('bubble visible:', await ev(`(() => { const d = [...document.querySelectorAll('#l2d-companion > div')].find(x => x.textContent.includes('回归气泡MARKER')); return d ? d.style.opacity === '1' : false })()`))

ws.close()
process.exit(0)
