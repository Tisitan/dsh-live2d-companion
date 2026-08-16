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

console.log('parent binding excited before:', await ev(`JSON.stringify(window.__l2d.ctx.binding.motion.excited)`))
console.log('open viewer:', await ev(`window.__l2d.openModelViewer(window.__l2d.modelPath), 'ok'`))
for (let i = 0; i < 15; i++) {
  await new Promise(r => setTimeout(r, 2000))
  if (await ev(`!!document.querySelector('#l2d-viewer iframe').contentWindow.__l2d`)) break
}
await ev(`document.querySelector('.l2d-binder-toggle').click()`)
await new Promise(r => setTimeout(r, 1200))

// 给「工作」换成 Angry（Reactions:3）
await ev(`[...document.querySelectorAll('.l2d-state-btn')].find(b => b.dataset.state === 'working').click()`)
await new Promise(r => setTimeout(r, 400))
await ev(`[...document.querySelectorAll('.l2d-binder-moves .l2d-mat')].find(x => x.textContent.includes('Angry')).click()`)
await new Promise(r => setTimeout(r, 400))

// 保存
await ev(`document.querySelector('.l2d-binder-save').click()`)
await new Promise(r => setTimeout(r, 6000))  // 保存 + 主窗强制热重载（模型重新加载要几秒）
console.log('save status:', await ev(`document.querySelector('.l2d-binder-status').textContent`))
console.log('parent binding excited after save (expect ["Reactions",3]):', await ev(`JSON.stringify(window.__l2d.ctx.binding.motion.excited)`))
console.log('parent modelPath still nori:', await ev(`window.__l2d.ctx.getModelPath()`))

// 回滚：换回 WakuWaku（Reactions:2）再保存，恢复原状
await ev(`[...document.querySelectorAll('.l2d-binder-moves .l2d-mat')].find(x => x.textContent.includes('WakuWaku')).click()`)
await new Promise(r => setTimeout(r, 400))
await ev(`document.querySelector('.l2d-binder-save').click()`)
await new Promise(r => setTimeout(r, 6000))
console.log('restore status:', await ev(`document.querySelector('.l2d-binder-status').textContent`))
console.log('parent binding excited restored (expect ["Reactions",2]):', await ev(`JSON.stringify(window.__l2d.ctx.binding.motion.excited)`))

await ev(`document.getElementById('l2d-viewer').classList.remove('open')`)
ws.close()
process.exit(0)
