const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')

async function main() {
  const base = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
  const discovery = JSON.parse(await fs.readFile(path.join(base, 'live2d-standalone-companion', 'adapter.json'), 'utf8'))
  const body = Buffer.from(JSON.stringify({
    source: 'test', sessionId: 'bubble-test', state: 'done', text: '气泡连接成功啦！Nori在这里哦。', holdMs: 8000,
  }))
  await new Promise((resolve, reject) => {
    const req = http.request(discovery.endpoint, {
      method: 'POST', headers: {
        authorization: `Bearer ${discovery.token}`,
        'content-type': 'application/json', 'content-length': body.length,
      },
    }, res => { res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('发送失败'))) })
    req.on('error', reject)
    req.end(body)
  })
  console.log('已发送：气泡连接成功啦！Nori在这里哦。')
}

main().catch(error => { console.error('测试失败：请先启动桌宠。\n' + error.message); process.exitCode = 1 })
