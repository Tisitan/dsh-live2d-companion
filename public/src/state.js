/**
 * state.js —— 状态机。
 *
 * 8 态：offline / idle / thinking / working / waiting / error / done / sleeping。
 * enter() 是唯一切换入口：负责换灯、换表情、播放动作、启动台词轮播、
 * 动作重放与瞬态回落计时。状态只引用语义槽位，具体素材由 binding 层解析。
 */

import { cfg, quip, PREVIEW } from './config.js'

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
  let wakeTimer = 0

  ctx.getState = () => state
  ctx.busy = () => BUSY_STATES.includes(state)
  ctx.stateExpr = () => registry[state]?.expr ?? 'default'
  ctx.registerState = (name, def) => { registry[name] = { ...registry[name], ...def } }
  // 用户活动戳：互动重置睡眠计时；睡梦中被摸/点/拖会唤醒回 idle（enter 自带惊喜脸衔接）
  ctx.pokeActivity = () => {
    idleSince = Date.now()
    if (state === 'sleeping') ctx.enter('idle')
  }

  /**
   * 切换到指定状态；同名调用为 no-op。
   * @param {string} next 目标状态（须在注册表中定义）
   */
  ctx.enter = (next) => {
    if (next === state) return
    if (!registry[next]) return   // 未知状态名（如宿主下发了新 coarse 值）不入场，灯与行为不脱节
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
    clearTimeout(wakeTimer)
    wakeTimer = 0

    const def = registry[next]
    if (!def) return
    ctx.setEyeBlinkEnabled?.(next !== 'sleeping')
    // 唤醒时终止仍在循环的睡眠动作；随后模型会自然回到 Idle，保留睁眼过渡。
    if (woke) ctx.stopMotions?.()
    if (next === 'idle') idleSince = Date.now()
    // 从睡梦中被唤醒：先惊喜脸，1.2 秒后落回新状态表情（含直接回 idle 的路径；
    // wakeTimer 已纳入 enter 的清理队列，快速连切不会被旧定时器踩脸）
    if (woke) {
      ctx.setExpr('surprised')
      wakeTimer = setTimeout(() => {
        wakeTimer = 0
        ctx.setExpr(ctx.stateExpr())
      }, 1200)
    } else {
      ctx.setExpr(def.expr)
    }
    if (next === 'idle') return
    if (def.motion) {
      // 报错态 40% 概率播放故障特效（槽位存在时；预览模式求确定性，恒播主动作）
      if (!PREVIEW && next === 'error' && Math.random() < 0.4 && ctx.binding.motion.glitch) ctx.playMotion('glitch')
      else ctx.playMotion(def.motion)
    }
    if (def.rotate) {
      // 优先级：完成/报错必须穿透对局解说等低级气泡；其余轮播最低级
      const poolPriority = def.pool === 'done' || def.pool === 'error' ? 2 : 0
      ctx.showBubble(quip(def.pool), cfg.rotation.holdMs, poolPriority)
      // intervalMs 在 enter 时快照：quips 热重载改了节奏后，下次进入状态才生效（设计如此，勿改成每轮换读）
      rotateTimer = setInterval(() => {
        if (document.hidden) return
        // 加班升级：工作时间越长表情越凝重，超时后切焦虑台词池（预览模式不升级，保持所选状态的原始表现）
        if (!PREVIEW && next === 'working') {
          const elapsed = Date.now() - stateSince
          if (elapsed > cfg.behavior.overtimeAfterMs) {
            ctx.setExpr('troubled')
            ctx.showBubble(quip('overtime'), cfg.rotation.holdMs, 0)
            return
          }
          if (elapsed > cfg.behavior.seriousAfterMs) ctx.setExpr('serious')
        }
        ctx.showBubble(quip(def.pool), cfg.rotation.holdMs, poolPriority)
      }, cfg.rotation.intervalMs)
    }
    if (def.remotionMs) {
      remotionTimer = setInterval(() => {
        if (!document.hidden && def.motion) ctx.playMotion(def.motion)
      }, def.remotionMs)
    }
    // 瞬态自动回落（预览模式禁用：按钮选什么就定格什么）
    if (!PREVIEW && def.transientMs && def.then) {
      transientTimer = setTimeout(() => ctx.enter(def.then), def.transientMs)
    }
  }

  // 闲置睡眠检查：30 秒一探，超时未活动进入 sleeping（预览模式禁用，避免劫持手动演示）
  if (!PREVIEW) {
    setInterval(() => {
      if (state === 'idle' && Date.now() - idleSince > cfg.behavior.sleepAfterMs) ctx.enter('sleeping')
    }, 30000)
  }
}
