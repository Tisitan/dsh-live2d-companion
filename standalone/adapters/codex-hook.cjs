const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')

function discoveryPath() {
  if (process.env.L2D_ADAPTER_FILE) return process.env.L2D_ADAPTER_FILE
  const base = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
  return path.join(base, 'live2d-standalone-companion', 'adapter.json')
}

function readStdin() {
  return new Promise(resolve => {
    const chunks = []
    process.stdin.on('data', chunk => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => resolve(''))
  })
}

function compactText(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  const text = value
    .replace(/```[\s\S]*?```/g, '（代码已完成）')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#~-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return fallback
  return text.length > 110 ? text.slice(0, 109) + '…' : text
}

function toolText(name) {
  const value = String(name || '').toLowerCase()
  if (value === 'bash' || value.includes('exec')) return '正在运行命令。'
  if (value === 'apply_patch' || value.includes('edit') || value.includes('write')) return '正在修改文件。'
  if (value.includes('web') || value.includes('browser')) return '正在查找资料……'
  if (value.includes('image')) return '正在处理图片。'
  return '正在处理。'
}

function mapHook(input) {
  const event = input.hook_event_name
  const sessionId = String(input.session_id || input.turn_id || 'codex')
  const base = { source: 'codex', sessionId, holdMs: 6000 }
  switch (event) {
    case 'SessionStart': return { ...base, state: 'idle', text: '桌宠已连接 Codex。', holdMs: 4000 }
    case 'UserPromptSubmit': return { ...base, state: 'thinking', text: '正在思考……' }
    case 'PreToolUse': return { ...base, state: 'working', text: toolText(input.tool_name), holdMs: 3500 }
    case 'PostToolUse': return { ...base, state: 'working' }
    case 'PermissionRequest': return {
      ...base, state: 'waiting',
      text: compactText(input.tool_input?.description, '这一步需要你确认。'), holdMs: 10000,
    }
    case 'SubagentStart': return { ...base, state: 'working', text: '已启动协作任务。', holdMs: 3500 }
    case 'SubagentStop': return { ...base, state: 'working', text: '协作任务已完成，继续处理。', holdMs: 3500 }
    case 'Stop': return {
      ...base, state: 'done', text: '完成啦！' + compactText(input.last_assistant_message, '数据都整理好了。'), holdMs: 8000,
    }
    case 'SessionEnd': return { ...base, remove: true }
    default: return null
  }
}

async function postEvent(payload) {
  const discovery = JSON.parse(await fs.readFile(discoveryPath(), 'utf8'))
  const target = new URL(discovery.endpoint)
  if (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost') return
  const body = Buffer.from(JSON.stringify(payload))
  await new Promise((resolve, reject) => {
    const req = http.request(target, {
      method: 'POST', timeout: 1500,
      headers: {
        authorization: `Bearer ${discovery.token}`,
        'content-type': 'application/json',
        'content-length': body.length,
      },
    }, res => {
      res.resume()
      res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error('request failed')))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(body)
  })
}

async function main() {
  try {
    const input = JSON.parse(await readStdin() || '{}')
    const payload = mapHook(input)
    if (payload) await postEvent(payload)
  } catch { }
  process.stdout.write('{}')
}

main()
