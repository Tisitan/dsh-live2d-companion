/**
 * stream.js —— 状态流客户端。
 *
 * SSE 连接宿主的 /live2d/state-stream，帧格式三选一：
 *   { ev: '事件名', n: 任务号 } —— 白名单原始会话事件（单会话时优先驱动状态机）
 *   { state: '状态名', sessions: [...] } —— 宿主聚合状态（多会话时的唯一权威）
 *   { model: '路径' }   —— 模型热切换广播（首帧快照同含；多窗口同步用）
 * 多会话并行时 raw 事件只喂灯与扩展，主状态机改由宿主 rank 聚合驱动——
 * 否则会话 A 的 turn/end 会把仍在工作的会话 B 的显示态刷成 done（最长错 10 秒）。
 * 断线进入 offline 状态并清零 raw 时效，重连后的聚合快照可立即生效。
 */

import { BASE } from './config.js'

/** raw 事件新鲜度窗口：距上一个原始事件超过该毫秒数才允许 coarse 状态覆盖（单会话时）。 */
const RAW_FRESH_MS = 10000

/**
 * 建立 SSE 状态流（断线由 EventSource 自动重连）。
 * @param {Object} ctx 共享上下文（使用 enter / busy / getState）
 */
export function initStream(ctx) {
  let lastRawAt = 0
  let multiSession = false

  /** 原始事件 → 状态机映射（单会话时），并向扩展广播。 */
  function onRawEvent(ev) {
    lastRawAt = Date.now()
    ctx.emit('raw', ev)
    if (multiSession) return   // 多会话：主状态机交给聚合帧，raw 不驱动
    switch (ev) {
      case 'turn/start': ctx.enter('thinking'); break
      case 'assistant/chunk': if (!ctx.busy()) ctx.enter('thinking'); break
      case 'tool/call':
      case 'tool-workflow/run-start':
      case 'subagent/descriptor': ctx.enter('working'); break
      case 'approval/asked': ctx.enter('waiting'); break
      case 'approval/decided': ctx.enter('working'); break
      case 'llm/retry-started': ctx.enter('error'); break
      case 'turn/end': ctx.enter('done'); break
    }
  }

  try {
    const es = new EventSource(BASE + '/state-stream')
    es.onerror = () => { lastRawAt = 0; ctx.enter('offline') }
    es.onmessage = (m) => {
      try {
        const data = JSON.parse(m.data)
        if (typeof data.ev === 'string') onRawEvent(data.ev)
        // 每会话状态快照（多任务指示灯）；与 state 判定并列：同帧可能同时携带
        if (Array.isArray(data.sessions)) {
          multiSession = data.sessions.length > 1
          ctx.setSessions?.(data.sessions)
        }
        // 他窗口发起的模型热切换广播（首帧快照同含）；switchModel 对同路径/并发幂等。
        // 注意与 state 判定并列而非 else-if：首帧同时携带 model 与 state，两者都要处理。
        if (typeof data.model === 'string' && data.model !== ctx.modelPath) {
          void ctx.switchModel(data.model).catch(() => { })
        }
        // 聚合覆盖条件：多会话时聚合即权威；单会话时须等 raw 通道静默超时
        if (typeof data.state === 'string' && (multiSession || Date.now() - lastRawAt > RAW_FRESH_MS) && data.state !== ctx.getState()) {
          ctx.enter(data.state)
        }
      } catch { }
    }
  } catch { }
}
