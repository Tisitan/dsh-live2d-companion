/**
 * binding.js —— 语义槽位绑定层。
 *
 * 状态机只引用语义槽位（如 excited / shy / nod），本层负责把槽位
 * 解析为具体模型的表情名与动作 [组, 序号]。解析优先级：
 *   1. 模型目录下的 profile.json（精确覆盖，随模型分发）
 *   2. .model3.json FileReferences 自动嗅探（关键词模糊匹配）
 *   3. 缺槽静默跳过（调用方对空绑定 no-op，绝不抛错）
 */

import { BASE } from './config.js'

/** 表情槽位 → 嗅探关键词（小写包含匹配，支持中英文命名习惯）。 */
const SNIFF_EXPR = {
  default: ['default', 'normal', '通常'],
  happy: ['happy', 'smile', 'joy', '开心', '喜悦', '笑'],
  excited: ['kirakira', 'excited', 'star'],
  shy: ['shy', 'blush', '害羞'],
  doubt: ['doubt', 'think', 'confuse', '疑'],
  troubled: ['troubled', 'annoy', 'worry', '困扰', '为难'],
  serious: ['serious', '严肃'],
  surprised: ['surprise', '惊'],
  dark: ['dark', 'gloom', '阴沉'],
  sleep: ['sleep', '眠'],
}

/** 动作槽位 → 嗅探关键词（匹配动作文件名）。 */
const SNIFF_MOTION = {
  think: ['think'],
  excited: ['wakuwaku', 'excited', 'joy'],
  shake: ['shake'],
  dizzy: ['dizzy'],
  nod: ['nod'],
  sleep: ['sleep'],
  glitch: ['glitch', 'effect'],
}

/** @returns {{expr:Object, motion:Object, clickPool:Array}} 空绑定（全槽位缺失的安全态） */
export function emptyBinding() {
  return { expr: {}, motion: {}, clickPool: [] }
}

/**
 * 提取模型素材全量清单（绑定编辑器用）：全部表情名与全部动作 [组, 序号, 文件名]。
 * @param {?Object} modelJson .model3.json 解析结果（可为 null）
 */
export function extractInventory(modelJson) {
  const refs = modelJson?.FileReferences ?? {}
  const expressions = (refs.Expressions ?? []).map((e) => e.Name).filter(Boolean)
  const motions = []
  for (const [group, arr] of Object.entries(refs.Motions ?? {})) {
    if (!Array.isArray(arr)) continue
    for (let index = 0; index < arr.length; index++) {
      motions.push({ group, index, file: String(arr[index].File ?? '') })
    }
  }
  return { expressions, motions }
}

/**
 * 由模型清单与用户档案合成槽位映射。
 * @param {?Object} modelJson .model3.json 解析结果（可为 null）
 * @param {?Object} profile 模型目录 profile.json（可为 null）
 * @returns 绑定表 { expr: {slot: 表情名}, motion: {slot: [组, 序号]}, clickPool: [[组, 序号]] }
 */
export function resolveBinding(modelJson, profile) {
  const refs = modelJson?.FileReferences ?? {}
  const exprAvail = (refs.Expressions ?? []).map((e) => e.Name).filter(Boolean)
  const motionGroups = refs.Motions ?? {}
  const out = emptyBinding()

  // 表情：profile 命中（须真实存在）→ 关键词嗅探
  for (const [slot, keys] of Object.entries(SNIFF_EXPR)) {
    const fromProfile = profile?.expressions?.[slot]
    if (typeof fromProfile === 'string' && exprAvail.includes(fromProfile)) {
      out.expr[slot] = fromProfile
      continue
    }
    const hit = exprAvail.find((n) => keys.some((k) => n.toLowerCase().includes(k)))
    if (hit) out.expr[slot] = hit
  }
  if (!out.expr.default && exprAvail.length > 0) out.expr.default = exprAvail[0]

  // 动作引用合法性校验
  const motionAt = (g, i) => Array.isArray(motionGroups[g]) && motionGroups[g][i] ? true : false

  // 动作：profile 命中 → 按文件名关键词嗅探（组间先序、组内按序）
  for (const [slot, keys] of Object.entries(SNIFF_MOTION)) {
    const fromProfile = profile?.motions?.[slot]
    if (Array.isArray(fromProfile) && motionAt(fromProfile[0], fromProfile[1])) {
      out.motion[slot] = [fromProfile[0], fromProfile[1]]
      continue
    }
    outer:
    for (const [g, arr] of Object.entries(motionGroups)) {
      for (let i = 0; i < arr.length; i++) {
        const f = String(arr[i].File ?? '').toLowerCase()
        if (keys.some((k) => f.includes(k))) {
          out.motion[slot] = [g, i]
          break outer
        }
      }
    }
  }

  // think 槽位兜底：没有关键词命中时取名字带 pose 的组的第一个动作
  if (!out.motion.think) {
    const pg = Object.keys(motionGroups).find((g) => g.toLowerCase().includes('pose'))
    if (pg) out.motion.think = [pg, 0]
  }

  // 点击反应池：profile 覆盖 → 取官方示例惯例组（Tap/Reaction/Touch）并剔除生气动作
  const poolFromProfile = profile?.motions?.clickPool
  if (Array.isArray(poolFromProfile) && poolFromProfile.length > 0) {
    out.clickPool = poolFromProfile.filter((p) => Array.isArray(p) && motionAt(p[0], p[1])).map((p) => [p[0], p[1]])
  } else {
    const rg = Object.keys(motionGroups).find((g) => /reaction|tap|touch/i.test(g))
    if (rg) {
      out.clickPool = motionGroups[rg]
        .map((entry, i) => [rg, i, String(entry.File ?? '')])
        .filter(([, , f]) => !/angry/i.test(f))
        .map(([g, i]) => [g, i])
    }
  }
  return out
}

/**
 * 加载模型清单与同目录 profile.json，合成最终绑定。
 * 两个源都允许失败（404/网络异常），最终退化为空绑定。
 * @param {string} modelPath 相对 model/ 的路径，如 'nori/ARGNori.model3.json'
 */
export async function loadBinding(modelPath) {
  const dir = modelPath.split('/').slice(0, -1).join('/')
  let modelJson = null
  let profile = null
  try { modelJson = await (await fetch(`${BASE}/model/${modelPath}`, { cache: 'no-store' })).json() } catch { }
  try { profile = await (await fetch(`${BASE}/model/${dir}/profile.json`, { cache: 'no-store' })).json() } catch { }
  return resolveBinding(modelJson, profile)
}
