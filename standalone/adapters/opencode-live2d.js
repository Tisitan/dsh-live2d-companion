import { readFile } from 'node:fs/promises'
import path from 'node:path'

function discoveryPath() {
  if (process.env.L2D_ADAPTER_FILE) return process.env.L2D_ADAPTER_FILE
  const base = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
  return path.join(base, 'live2d-standalone-companion', 'adapter.json')
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

function sessionId(value) {
  const p = value?.properties ?? value ?? {}
  return String(p.sessionID || p.sessionId || p.session?.id || p.info?.id || 'opencode')
}

async function send(payload) {
  try {
    const discovery = JSON.parse(await readFile(discoveryPath(), 'utf8'))
    const target = new URL(discovery.endpoint)
    if (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost') return
    await fetch(target, {
      method: 'POST', signal: AbortSignal.timeout(1500),
      headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'opencode', ...payload }),
    })
  } catch { }
}

async function discovery() {
  const value = JSON.parse(await readFile(discoveryPath(), 'utf8'))
  const endpoint = new URL(value.endpoint)
  if (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost') throw new Error('invalid companion endpoint')
  return { endpoint, token: value.token }
}

async function chatRequest(route, options = {}) {
  const info = await discovery()
  const target = new URL(route, info.endpoint)
  return fetch(target, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(1800),
    headers: { authorization: `Bearer ${info.token}`, ...(options.headers ?? {}) },
  })
}

function responseData(value) {
  return value?.data ?? value
}

function replyText(result) {
  const parts = responseData(result)?.parts
  if (!Array.isArray(parts)) return ''
  return parts.filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text.trim()).filter(Boolean).join('\n').trim().slice(0, 1000)
}

function toolText(name) {
  const value = String(name || '').toLowerCase()
  if (value === 'bash' || value.includes('shell')) return 'Nori正在运行命令哦。'
  if (value.includes('edit') || value.includes('write') || value.includes('patch')) return 'Nori正在修改文件。'
  if (value.includes('web')) return 'Nori正在数据库里找资料......'
  return '交给Nori吧，正在处理。'
}

export const Live2DCompanion = async ({ client } = {}) => {
  const lastText = new Map()
  let noriSessionId = ''
  let polling = false

  async function sendChatReply(id, payload) {
    await chatRequest('/live2d/chat/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...payload }),
    })
  }

  async function answerChat(job) {
    try {
      if (!client?.session) throw new Error('OpenCode client is unavailable')
      if (!noriSessionId) {
        const created = await client.session.create({ body: { title: 'Nori 桌宠聊天' } })
        noriSessionId = String(responseData(created)?.id || '')
        if (!noriSessionId) throw new Error('could not create Nori session')
      }
      const result = await client.session.prompt({
        path: { id: noriSessionId },
        body: { agent: 'nori', parts: [{ type: 'text', text: job.message }] },
      })
      const text = replyText(result)
      await sendChatReply(job.id, text ? { text } : { error: 'Nori没有生成文字回复。' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/session|not found|404/i.test(message)) noriSessionId = ''
      try { await sendChatReply(job.id, { error: compactText(message, 'OpenCode回答失败了。') }) } catch { }
    }
  }

  async function pollChat() {
    if (polling) return
    polling = true
    try {
      const response = await chatRequest('/live2d/chat/next')
      if (response.status === 200) await answerChat(await response.json())
    } catch { }
    finally { polling = false }
  }

  async function heartbeat() {
    try { await chatRequest('/live2d/chat/heartbeat') } catch { }
  }

  const pollTimer = setInterval(pollChat, 1000)
  pollTimer.unref?.()
  const heartbeatTimer = setInterval(heartbeat, 5000)
  heartbeatTimer.unref?.()
  void heartbeat()
  void pollChat()

  return {
    'tool.execute.before': async (input) => {
      await send({ sessionId: sessionId(input), state: 'working', text: toolText(input?.tool), holdMs: 3500 })
    },
    'tool.execute.after': async (input) => {
      await send({ sessionId: sessionId(input), state: 'working' })
    },
    event: async ({ event }) => {
      const id = sessionId(event)
      if (id === noriSessionId) return
      const p = event?.properties ?? {}
      if (event?.type === 'message.part.updated') {
        const part = p.part ?? p
        if (part?.type === 'text' && typeof part.text === 'string') lastText.set(id, part.text)
        return
      }
      switch (event?.type) {
        case 'session.created':
          await send({ sessionId: id, state: 'thinking', text: 'Nori接上OpenCode啦！一直在这里等你哦。', holdMs: 4000 })
          break
        case 'session.status': {
          const status = String(p.status?.type || p.status || '').toLowerCase()
          if (status.includes('retry')) await send({ sessionId: id, state: 'error', text: '连接波动，正在重试…' })
          else if (status.includes('busy')) await send({ sessionId: id, state: 'thinking', text: '唔......Nori想一下。' })
          break
        }
        case 'permission.asked':
          await send({ sessionId: id, state: 'waiting', text: '这一步需要你确认一下......Nori会等你的。', holdMs: 10000 })
          break
        case 'permission.replied':
          await send({ sessionId: id, state: 'working', text: '收到啦，Nori继续处理哦。', holdMs: 3000 })
          break
        case 'session.error':
          await send({ sessionId: id, state: 'error', text: compactText(p.error?.message || p.error, '唔......数据好像坏掉了。Nori再想想办法。'), holdMs: 8000 })
          break
        case 'session.idle':
          await send({ sessionId: id, state: 'done', text: '完成啦！' + compactText(lastText.get(id), '数据都整理好了。'), holdMs: 8000 })
          break
        case 'session.deleted':
          lastText.delete(id)
          await send({ sessionId: id, remove: true })
          break
      }
    },
  }
}
