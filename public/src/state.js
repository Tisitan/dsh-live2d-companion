/**
 * state.js —— 状态机。
 *
 * 8 态：offline / idle / thinking / working / waiting / error / done / sleeping。
 * enter() 是唯一切换入口：负责换灯、换表情、播放动作、启动台词轮播、
 * 动作重放与瞬态回落计时。状态只引用语义槽位，具体素材由 binding 层解析。
 */

import { cfg, quip } from './config.js'

/**
 * 状态行为定义。
 * expr/motion 为语义槽位；rotate=台词轮播；remotionMs=动作周期性重放；
 * transientMs/then=瞬态状态到时回落目标。
 */
const STATE_DEF = {
  offline: { expr: 'dark' },
  thinking: { expr: 'doubt', motion: 'think', pool: 'thinking', rotate: true },
  working: { expr: 'excited', motion: 'excited', pool: 'working', rotate: true, remotionMs: 22000 },
  waiting: { expr: 'doubt', motion: 'shake', pool: 'waiting', rotate: true, remotionMs: 16000 },
  error: { expr: 'troubled', motion: 'dizzy', pool: 'error', rotate: true, transientMs: 4500, then: 'thinking' },
  done: { expr: 'happy', motion: 'nod', pool: 'done', transientMs: 6000, then: 'idle' },
  sleeping: { expr: 'sleep', motion: 'sleep', pool: 'sleeping', rotate: true },
  idle: { expr: 'default' },
}

/** 忙碌判定集：这些状态下点击/双击被拦截（busy 池回应），摸头被静默无视。 */
const BUSY_STATES = ['thinking', 'working', 'waiting', 'error']

/**
 * 初始化状态机并挂到 ctx（enter / busy / stateExpr / getState / registerState）。
 * @param {Object} ctx 共享上下文
 */
export function initState(ctx) {
  /** 状态注册表：扩展可用 registerState 新增或覆盖条目（浅合并）。 */
  const registry = { ...STATE_DEF }

  let state = 'idle'
  let stateSince = Date.now()
  let idleSince = Date.now()
  let rotateTimer = 0
  let remotionTimer = 0
  let transientTimer = 0

  ctx.getState = () => state
  ctx.busy = () => BUSY_STATES.includes(state)
  ctx.stateExpr = () => registry[state]?.expr ?? 'default'
  ctx.registerState = (name, def) => { registry[name] = { ...registry[name], ...def } }

  /**
   * 切换到指定状态；同名调用为 no-op。
   * @param {string} next 目标状态（须在注册表中定义）
   */
  ctx.enter = (next) => {
    if (next === state) return
    const prev = state
    const woke = state === 'sleeping' && next !== 'sleeping'
    state = next
    stateSince = Date.now()
    ctx.setLamp(next)
    ctx.emit('enter', next, prev)
    clearInterval(rotateTimer)
    rotateTimer = 0
    clearInterval(remotionTimer)
    remotionTimer = 0
    clearTimeout(transientTimer)
    transientTimer = 0

    const def = registry[next]
    if (!def) return
    if (next === 'idle') {
      idleSince = Date.now()
      ctx.setExpr(def.expr)
      return
    }
    // 从睡梦中被唤醒：先惊喜脸，1.2 秒后落回新状态表情
    if (woke) {
      ctx.setExpr('surprised')
      setTimeout(() => ctx.setExpr(ctx.stateExpr()), 1200)
    } else {
      ctx.setExpr(def.expr)
    }
    if (def.motion) {
      // 报错态 40% 概率播放故障特效（槽位存在时）
      if (next === 'error' && Math.random() < 0.4 && ctx.binding.motion.glitch) ctx.playMotion('glitch')
      else ctx.playMotion(def.motion)
    }
    if (def.rotate) {
      ctx.showBubble(quip(def.pool), cfg.rotation.holdMs)
      rotateTimer = setInterval(() => {
        if (document.hidden) return
        // 加班升级：工作时间越长表情越凝重，超时后切焦虑台词池
        if (next === 'working') {
          const elapsed = Date.now() - stateSince
          if (elapsed > cfg.behavior.overtimeAfterMs) {
            ctx.setExpr('troubled')
            ctx.showBubble(quip('overtime'), cfg.rotation.holdMs)
            return
          }
          if (elapsed > cfg.behavior.seriousAfterMs) ctx.setExpr('serious')
        }
        ctx.showBubble(quip(def.pool), cfg.rotation.holdMs)
      }, cfg.rotation.intervalMs)
    }
    if (def.remotionMs) {
      remotionTimer = setInterval(() => {
        if (!document.hidden && def.motion) ctx.playMotion(def.motion)
      }, def.remotionMs)
    }
    if (def.transientMs && def.then) {
      transientTimer = setTimeout(() => ctx.enter(def.then), def.transientMs)
    }
  }

  // 闲置睡眠检查：30 秒一探，超时未活动进入 sleeping
  setInterval(() => {
    if (state === 'idle' && Date.now() - idleSince > cfg.behavior.sleepAfterMs) ctx.enter('sleeping')
  }, 30000)
}
