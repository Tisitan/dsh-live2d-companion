/**
 * config.js —— 共享配置与持久化。
 *
 * 职责：环境常量探测（挂件/桌宠形态）、localStorage 读写、
 * quips.json 台词库加载（30 秒热重载由入口调度）。
 * 本模块无副作用、无 DOM 依赖，被所有其他模块引用。
 */

/** 插件静态路由前缀（与宿主 index.js 的注册路径一致）。 */
export const BASE = '/live2d'

/** 桌宠形态：pet.html 在加载本模块前内联注入 __L2D_PET__。 */
export const PET = window.__L2D_PET__ === true

/** Electron preload 暴露的桌面桥；网页挂件环境下为 null。 */
export const BRIDGE = window.__petBridge ?? null

const URL_PARAMS = new URLSearchParams(location.search)

/** URL ?model= 临时指定模型（优先级高于宿主 config 与默认）。 */
export const MODEL_QUERY = URL_PARAMS.get('model')

/** URL ?preview=1：模型面板的预览 iframe 形态（隐藏面板入口本身）。 */
export const PREVIEW = URL_PARAMS.get('preview') === '1'

/** 独立桌宠本地服务形态；DSH 挂件/桌宠不启用独立聊天入口。 */
export const STANDALONE = URL_PARAMS.get('standalone') === '1'

/** 网页挂件的固定画布尺寸（桌宠形态用窗口尺寸）。 */
export const BASE_W = 300
export const BASE_H = 400

/**
 * localStorage 持久化。挂件与桌宠的缩放分别记账（l2d-scale / l2d-pet-scale），
 * 全部操作吞异常——无痕模式或存储被禁时静默降级为默认值。
 */
export const store = {
  /** @returns {{x:number,y:number}|null} 挂件上次拖动位置 */
  getPos() { try { return JSON.parse(localStorage.getItem('l2d-pos')) } catch { return null } },
  setPos(v) { try { localStorage.setItem('l2d-pos', JSON.stringify(v)) } catch { } },
  /** @returns {number} 缩放倍率，默认 1 */
  getScale() { const v = parseFloat(localStorage.getItem(PET ? 'l2d-pet-scale' : 'l2d-scale')); return Number.isFinite(v) ? v : 1 },
  setScale(v) { try { localStorage.setItem(PET ? 'l2d-pet-scale' : 'l2d-scale', String(v)) } catch { } },
  /** @returns {string} 帧率预设 full/balanced/saver，默认 balanced（双形态共享一档） */
  getFpsMode() { try { return localStorage.getItem('l2d-fps-mode') ?? 'balanced' } catch { return 'balanced' } },
  setFpsMode(v) { try { localStorage.setItem('l2d-fps-mode', v) } catch { } },
  /** @returns {{cx:number,cy:number}|null} 桌宠模型中心的画布坐标（overlay 架构的"位置记忆"） */
  getPetPos() { try { return JSON.parse(localStorage.getItem('l2d-pet-pos')) } catch { return null } },
  setPetPos(v) { try { localStorage.setItem('l2d-pet-pos', JSON.stringify(v)) } catch { } },
  /** @returns {boolean} 手动穿透：桌宠模型区域恒穿透（UI 控件保留可点），默认 false */
  getPinned() { try { return localStorage.getItem('l2d-pet-pinned') === '1' } catch { return false } },
  setPinned(v) { try { localStorage.setItem('l2d-pet-pinned', v ? '1' : '0') } catch { } },
}

/** quips.json 拉取失败时的保底台词（每池一句）。 */
const DEFAULT_QUIPS = {
  thinking: ['思考中…'],
  working: ['工作中…!'],
  done: ['完成啦~'],
  waiting: ['主人，需要确认一下…'],
  error: ['唔…好像卡住了…'],
  overtime: ['还在努力…'],
  sleeping: ['(Zzz…)'],
  click: ['呀!'],
  pat: ['呜…'],
  drag: ['哇啊啊…'],
  greet: ['主人好呀~'],
  greet_morning: ['主人早上好~'],
  greet_night: ['还在忙呀…'],
  idle: ['好无聊呀…'],
  busy: ['咱正忙着呢…'],
}

/**
 * 可变配置容器：loadQuips 原地更新，各模块随时读到最新值。
 * @property {Object<string,string[]>} quips 台词池
 * @property {{holdMs:number,intervalMs:number,doneHoldMs:number}} rotation 气泡节奏
 * @property {{sleepAfterMs:number,seriousAfterMs:number,overtimeAfterMs:number}} behavior 行为阈值
 */
export const cfg = {
  quips: DEFAULT_QUIPS,
  rotation: { holdMs: 6000, intervalMs: 9000, doneHoldMs: 6500 },
  behavior: { sleepAfterMs: 300000, seriousAfterMs: 45000, overtimeAfterMs: 120000 },
}

/**
 * 拉取并合并台词库：官方默认 quips.json + 用户预设（quips.local.json 指针 →
 * quips-presets/<名>.json，均可多份另存）池级合并——预设逐池胜出，
 * 未覆盖的池继续跟随上游更新。失败保留现状。可安全反复调用（热重载）。
 */
export async function loadQuips() {
  const validPools = (raw) => {
    const pools = {}
    if (raw?.pools && typeof raw.pools === 'object') {
      for (const [key, value] of Object.entries(raw.pools)) {
        if (Array.isArray(value) && value.length > 0 && value.every((s) => typeof s === 'string')) pools[key] = value
      }
    }
    return pools
  }
  const validSection = (raw, name) => {
    const v = raw?.[name]
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    // 只采信有限数值键，脏数据（字符串/负数/NaN）不得混入节奏与阈值
    const out = {}
    for (const [k, n] of Object.entries(v)) {
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 3600000) out[k] = n
    }
    return out
  }
  const tryFetch = async (url) => {
    try {
      const r = await fetch(url, { cache: 'no-store' })
      return r.ok ? await r.json() : null
    } catch { return null }
  }
  try {
    // 主拉取也走 tryFetch：官方 quips.json 404/损坏时保留现状并继续尝试用户预设，不拖垮整个热重载
    const raw = await tryFetch(BASE + '/quips.json')
    // 活跃指针：{active: 预设名}；预设文件读取失败则仅回落官方默认
    const pointer = await tryFetch(BASE + '/quips.local.json')
    const presetName = typeof pointer?.active === 'string' ? pointer.active : null
    const preset = presetName === null ? null
      : await tryFetch(BASE + '/quips-presets/' + encodeURIComponent(presetName) + '.json')
    cfg.quips = { ...DEFAULT_QUIPS, ...validPools(raw), ...validPools(preset) }
    cfg.rotation = { ...cfg.rotation, ...validSection(raw, 'rotation'), ...validSection(preset, 'rotation') }
    cfg.behavior = { ...cfg.behavior, ...validSection(raw, 'behavior'), ...validSection(preset, 'behavior') }
  } catch { }
}

/**
 * 从指定台词池随机抽一句；池不存在或为空时返回空串（调用方自行跳过）。
 * @param {string} kind 池名（thinking/working/click/pat/…）
 */
export function quip(kind) {
  const pool = cfg.quips[kind]
  return pool && pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : ''
}

/**
 * 顺序加载经典脚本（vendor 库通过全局变量导出，如 PIXI / PIXI.live2d）。
 * @param {string} src 脚本 URL
 */
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = resolve
    s.onerror = () => reject(new Error('failed to load ' + src))
    document.head.appendChild(s)
  })
}
