// 软渲染开关 E2E：勾选 → 自动重启 → SwiftShader 实锤 → 勾回 → GPU 回归
const GL_RENDERER = `(() => {
  const gl = document.createElement('canvas').getContext('webgl')
  if (!gl) return 'NO WEBGL'
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'no debug info'
})()`

async function connect() {
  for (let i = 0; i < 20; i++) {
    try {
      const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
      const page = targets.find(t => t.type === 'page' && t.url.includes('pet.html') && !t.url.includes('preview'))
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
        return ws
      }
    } catch { }
    await new Promise(r => setTimeout(r, 1500))
  }
  throw new Error('CDP connect failed')
}

let ws = await connect()
let seq = 0
const pending = new Map()
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? d.error); pending.delete(d.id) }
}
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise })
  return r.exceptionDetails ? 'EXC: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text) : r.result?.value
}
// 等页面就绪
for (let i = 0; i < 20; i++) {
  if (await ev(`!!window.__l2d`)) break
  await new Promise(r => setTimeout(r, 1500))
}

console.log('=== phase 1: GPU mode (default) ===')
console.log('soft row visible (expect false=shown):', await ev(`document.querySelector('.l2d-soft-row')?.hidden`))
console.log('getSoft (expect false):', await ev(`window.__petBridge.getSoft()`, true))
console.log('GL renderer (expect ANGLE/GPU):', await ev(GL_RENDERER))

console.log('=== phase 2: toggle soft ON → auto relaunch ===')
await ev(`(() => { const c = document.querySelector('.l2d-soft'); c.checked = true; c.dispatchEvent(new Event('change')); return 'toggled' })()`)
await new Promise(r => setTimeout(r, 2000))
try { ws.close() } catch { }
ws = await connect()  // 等重启后的新实例
seq = 0
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? d.error); pending.delete(d.id) }
}
for (let i = 0; i < 25; i++) {
  if (await ev(`!!window.__l2d`)) break
  await new Promise(r => setTimeout(r, 1500))
}
console.log('after relaunch getSoft (expect true):', await ev(`window.__petBridge.getSoft()`, true))
console.log('GL renderer (expect SwiftShader):', await ev(GL_RENDERER))
console.log('checkbox state persisted in UI (expect true):', await ev(`(() => { const c = document.querySelector('.l2d-soft'); return new Promise(res => setTimeout(() => res(c.checked), 500)) })()`, true))
console.log('model alive:', await ev(`window.__l2d.model.width > 0`))

console.log('=== phase 3: toggle OFF → back to GPU ===')
await ev(`(() => { const c = document.querySelector('.l2d-soft'); c.checked = false; c.dispatchEvent(new Event('change')); return 'toggled off' })()`)
await new Promise(r => setTimeout(r, 2000))
try { ws.close() } catch { }
ws = await connect()
seq = 0
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? d.error); pending.delete(d.id) }
}
for (let i = 0; i < 25; i++) {
  if (await ev(`!!window.__l2d`)) break
  await new Promise(r => setTimeout(r, 1500))
}
console.log('final getSoft (expect false):', await ev(`window.__petBridge.getSoft()`, true))
console.log('final GL renderer (expect ANGLE/GPU):', await ev(GL_RENDERER))

ws.close()
process.exit(0)
