/**
 * stream.js —— 状态流客户端。
 *
 * SSE 连接宿主的 /live2d/state-stream，帧格式三选一：
 *   { ev: '事件名' }    —— 白名单原始会话事件（优先，驱动状态机）
 *   { state: '状态名' } —— 宿主聚合状态（兜底：raw 通道静默 10 秒以上才采信）
 *   { model: '路径' }   —— 模型热切换广播（首帧快照同含；多窗口同步用）
 * 断线进入 offline 状态并清零 raw 时效，重连后的聚合快照可立即生效。
 */

import { BASE } from './config.js'

/** raw 事件新鲜度窗口：距上一个原始事件超过该毫秒数才允许 coarse 状态覆盖。 */
const RAW_FRESH_MS = 10000

/**
 * 建立 SSE 状态流（断线由 EventSource 自动重连）。
 * @param {Object} ctx 共享上下文（使用 enter / busy / getState）
 */
export function initStream(ctx) {
  let lastRawAt = 0

  /** 原始事件 → 状态机映射，并向扩展广播。 */
  function onRawEvent(ev) {
    lastRawAt = Date.now()
    ctx.emit('raw', ev)
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
        // 他窗口发起的模型热切换广播（首帧快照同含）；switchModel 对同路径/并发幂等。
        // 注意与 state 判定并列而非 else-if：首帧同时携带 model 与 state，两者都要处理。
        if (typeof data.model === 'string' && data.model !== ctx.modelPath) {
          void ctx.switchModel(data.model).catch(() => { })
        }
        if (typeof data.state === 'string' && Date.now() - lastRawAt > RAW_FRESH_MS && data.state !== ctx.getState()) {
          ctx.enter(data.state)
        }
      } catch { }
    }
  } catch { }
}
