// 独立静态服：脱离 DSH 主机直接跑桌宠页面（跨机器硬件测试/拖动闪烁复现用）。
// 用法：node standalone-server.mjs [端口=8092]  → http://127.0.0.1:8092/live2d/pet.html
// SSE / API 端点在此模式下不存在：events 返回 204（EventSource 停止重连），
// 前端自然落入离线态，渲染/拖拽/交互全部照常。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.argv[2]) || 8092
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/live2d/events') { res.writeHead(204); res.end(); return }
  // 桌宠心跳打这里：standalone 没有 DSH 宿主，回最小快照否则 404 会累计失败触发看门狗自杀
  if (url.pathname === '/live2d/state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(JSON.stringify({ state: 'idle', online: true, standalone: true }))
    return
  }
  // SSE 长连存根：发一帧 idle 后挂起，防前端 EventSource 断线重连风暴
  if (url.pathname === '/live2d/state-stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write('data: {"state":"idle"}\n\n')
    return
  }
  if (!url.pathname.startsWith('/live2d/')) { res.writeHead(404); res.end('not found'); return }
  let rel
  try { rel = decodeURIComponent(url.pathname.slice('/live2d/'.length)) } catch { res.writeHead(400); res.end('bad request'); return }
  const safe = path.normalize(rel).replace(/^(\.\.([/\\]|$))+/, '')
  const file = path.join(PUBLIC, safe)
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
  fs.createReadStream(file).pipe(res)
}).listen(PORT, '127.0.0.1', () => console.log(`standalone pet server: http://127.0.0.1:${PORT}/live2d/pet.html`))
