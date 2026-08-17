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

// ① 主窗健康 + 包围盒缓存生效（缓存值与实测值同帧一致）
console.log('=== main pet healthy ===')
console.log('state:', await ev(`window.__l2d.state`), '| modelPath:', await ev(`window.__l2d.modelPath`))
console.log('modelBounds cached:', await ev(`JSON.stringify(window.__l2d.ctx.modelBounds())`))
console.log('fresh getBounds:', await ev(`JSON.stringify(window.__l2d.model.getBounds())`))

// ② 模型加载回退链：坏模型路径 → 应回退默认 nori 而非裸死
console.log('=== fallback chain test ===')
await ev(`(() => { const f = document.createElement('iframe'); f.id = 'l2d-fallback-test'; f.src = '/live2d/pet.html?model=bogus/notexist.model3.json&preview=1'; f.style.cssText = 'position:fixed;width:10px;height:10px;left:-9999px'; document.body.appendChild(f); return 'iframe planted' })()`)
let fb = null
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 2000))
  fb = await ev(`(() => { const w = document.getElementById('l2d-fallback-test').contentWindow; return w.__l2d ? w.__l2d.modelPath : null })()`)
  if (fb) break
  console.log(`t=${(i + 1) * 2}s waiting...`)
}
console.log('fallback iframe modelPath (expect nori/ARGNori.model3.json):', fb)
console.log('fallback iframe model alive:', await ev(`(() => { const w = document.getElementById('l2d-fallback-test').contentWindow; return !!(w.__l2d && w.__l2d.model && w.__l2d.model.width > 0) })()`))
await ev(`document.getElementById('l2d-fallback-test').remove()`)

// ③ 唤醒竞态：sleeping→done→立刻 thinking，1.4 秒后脸上表情必须跟随 thinking（不被旧定时器踩）
console.log('=== wake timer race test ===')
await ev(`window.__l2d.enter('sleeping')`)
await new Promise(r => setTimeout(r, 300))
await ev(`window.__l2d.enter('done')`)
await new Promise(r => setTimeout(r, 200))
await ev(`window.__l2d.enter('thinking')`)
await new Promise(r => setTimeout(r, 1400))
console.log('state now (expect thinking):', await ev(`window.__l2d.state`))
console.log('current expr slot (expect doubt):', await ev(`window.__l2d.ctx.stateExpr()`))
console.log('active expression name:', await ev(`(() => { const em = window.__l2d.model.internalModel.expressionManager; return em && em.definitions ? 'expr mgr alive' : 'n/a' })()`))
await ev(`window.__l2d.enter('idle')`)

ws.close()
process.exit(0)
