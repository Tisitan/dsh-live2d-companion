/**
 * boot.js —— 入口装配器（ES Module）。
 *
 * 初始化顺序即依赖方向：
 *   config（纯数据）→ ui（DOM 骨架）→ stage（PIXI/模型/绑定层）
 *   → state（状态机）→ interact（交互）→ stream（SSE 状态流）
 * 模块间不互相 import，全部经由共享上下文 ctx 在运行期取用彼此的能力。
 */

import { BASE, PREVIEW, BRIDGE, quip, loadQuips } from './src/config.js'
import { emptyBinding } from './src/binding.js'
import { initUI } from './src/ui.js'
import { initStage } from './src/stage.js'
import { initState } from './src/state.js'
import { initInteract } from './src/interact.js'
import { initStream } from './src/stream.js'
import { initPanel } from './src/panel.js'
import { initChat } from './src/chat.js'

// 防重复注入（tapIndex 与手动加载可能并存）
if (!window.__l2dCompanion) {
  window.__l2dCompanion = true
  main().catch((err) => console.error('[l2d] boot failed:', err))
}

async function main() {
  /** 共享上下文：各 init 按序填充，运行期跨模块取用。 */
  const ctx = { binding: emptyBinding() }

  // ── 微事件总线：扩展钩子（enter / raw / ready），单监听器异常不影响其他 ──
  const listeners = new Map()
  ctx.on = (ev, fn) => {
    if (!listeners.has(ev)) listeners.set(ev, new Set())
    listeners.get(ev).add(fn)
    return () => listeners.get(ev)?.delete(fn)
  }
  ctx.emit = (ev, ...args) => {
    for (const fn of listeners.get(ev) ?? []) {
      try { fn(...args) } catch (e) { console.error(`[l2d] hook '${ev}' error:`, e) }
    }
  }

  await loadQuips()
  initUI(ctx)
  await initStage(ctx)
  initState(ctx)
  // 预览模式（面板 iframe ?preview=1）：只保留 渲染+状态机，
  // 不接 SSE、不装交互、不问候不碎碎念不加载扩展——由父页面按钮手动驱动状态。
  if (!PREVIEW) {
    initInteract(ctx)
    initChat(ctx)
    initStream(ctx)
  }
  const panel = initPanel(ctx)

  if (!PREVIEW) {
    // 时段问候：深夜（23-5）与早晨（5-11）有专属台词池
    const hour = new Date().getHours()
    const greetPool = hour >= 23 || hour < 5 ? 'greet_night' : hour >= 5 && hour < 11 ? 'greet_morning' : 'greet'
    ctx.showBubble(quip(greetPool), 4000)

    // 闲置碎碎念：空闲时每 2 分钟掷一次骰（60 秒气泡静默期内不出声）
    setInterval(() => {
      if (ctx.getState() === 'idle'
        && !document.hidden
        && performance.now() - ctx.getLastBubbleAt() > 60000
        && Math.random() < 0.5) {
        ctx.showBubble(quip('idle'), 3000)
      }
    }, 120000)

    // 台词库热重载：改 quips.json 存盘即生效（页面可见时）
    setInterval(() => { if (!document.hidden) loadQuips() }, 30000)
  }

  /**
   * 公共 API（window.__l2d）：控制台调试句柄 + 扩展的 apply(api) 入参。
   * getter 实时读值；ctx 直通标记为实验性（结构可能随版本调整）。
   */
  const api = {
    enter: (s) => ctx.enter(s),
    showBubble: (t, ms) => ctx.showBubble(t, ms),
    on: ctx.on,
    registerState: (n, d) => ctx.registerState(n, d),
    registerLamp: (n, s) => ctx.registerLamp(n, s),
    quip,
    setModel: (path) => ctx.switchModel(path),
    openChat: () => ctx.openChat?.(),
    // 原样试穿（绑定编辑器用）：按素材原名直接播放，不走槽位解析
    rawExpr: (name) => { try { void ctx.model.expression(name) } catch { } },
    rawMotion: (g, i) => { try { ctx.model.motion(g, i, 3).catch(() => { }) } catch { } },
    ...(panel === null ? {} : {
      refreshModels: panel.refreshModels,
      openModelPanel: panel.openPanel,
      closeModelPanel: panel.closePanel,
      openModelViewer: panel.openViewer,
      importModels: panel.importModels,
      get modelList() { return panel.modelList },
    }),
    get state() { return ctx.getState() },
    get binding() { return ctx.binding },
    get model() { return ctx.model },
    get modelPath() { return ctx.modelPath },
    get app() { return ctx.app },
    get scale() { return ctx.scale },
    get targetScale() { return ctx.targetScale },
    get bounds() { const b = ctx.model.getBounds(); return { x: b.x, y: b.y, w: b.width, h: b.height } },
    get gaze() { return ctx.lastGaze ?? null },
    ctx,
  }
  window.__l2d = api

  // 卫星窗声道：桌宠模式下游戏卡独立小窗的气泡台词经同源 BroadcastChannel 转发，
  // 仍由 Live2D 小人头上说出（对局话语与桌宠同一声道的承诺不因拆窗而变）
  if (BRIDGE && 'BroadcastChannel' in window) {
    const relay = new BroadcastChannel('l2d-companion')
    relay.onmessage = (e) => {
      const d = e.data
      if (d && d.type === 'bubble' && typeof d.text === 'string') ctx.showBubble?.(d.text, d.ms, d.priority)
    }
  }

  if (!PREVIEW) await loadExtensions(api)
  ctx.emit('ready', api)
  console.log('[l2d] companion ready' + (PREVIEW ? ' (preview)' : ''))
}

/**
 * 扩展加载：读 public/extensions/index.json 清单，逐个动态 import
 * 并调用其默认导出 apply(api)。无清单=无扩展；单扩展失败隔离。
 * @param {Object} api 公共 API（window.__l2d）
 */
async function loadExtensions(api) {
  try {
    const list = await (await fetch(BASE + '/extensions/index.json', { cache: 'no-store' })).json()
    if (!Array.isArray(list)) return
    for (const name of list) {
      // 清单条目必须是纯文件名：防 ../ 遍历加载同源任意脚本
      if (typeof name !== 'string' || !/^[\w.-]+\.js$/.test(name)) continue
      try {
        const mod = await import(`${BASE}/extensions/${name}`)
        const apply = mod.default ?? mod.apply
        if (typeof apply === 'function') await apply(api)
        console.log(`[l2d] extension loaded: ${name}`)
      } catch (e) {
        console.error(`[l2d] extension failed: ${name}`, e)
      }
    }
  } catch { }
}
