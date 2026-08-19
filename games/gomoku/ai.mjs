// 五子棋本地启发式 AI：攻守双线评分，难度=防守权重+噪音+防水概率。无 IO 无依赖。
import { EMPTY, BLACK, WHITE } from './engine.mjs'

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]]

/** 连子数+开放端 → 线分。活四>冲四>活三>眠三>活二。 */
function lineScore(count, openEnds) {
  if (count >= 5) return 10000000
  if (count === 4) return openEnds === 2 ? 1000000 : 100000
  if (count === 3) return openEnds === 2 ? 10000 : 1000
  if (count === 2) return openEnds === 2 ? 100 : 20
  return openEnds * 4 + 2
}

/** 假设 side 落在 (x,y) 的四方向总势能。 */
function cellScore(engine, x, y, side) {
  let total = 0
  for (const [dx, dy] of DIRS) {
    let count = 1, open = 0
    for (const s of [1, -1]) {
      let cx = x + dx * s, cy = y + dy * s
      while (engine.at(cx, cy) === side) { count++; cx += dx * s; cy += dy * s }
      if (engine.at(cx, cy) === EMPTY && cx >= 0 && cx < engine.size && cy >= 0 && cy < engine.size) open++
    }
    total += lineScore(count, open)
  }
  return total
}

const AI_PROFILES = {
  easy: { defWeight: 0.5, noise: 0.4, slack: 0.3 },    // 温柔：半心防守+大噪音+三成概率随性下
  normal: { defWeight: 1.0, noise: 0.1, slack: 0 },    // 均衡 1-ply
  hard: { defWeight: 1.1, noise: 0, slack: 0 },        // 全力：防守略优先，零噪音
}

/**
 * 创建本地对手。
 * @param {'easy'|'normal'|'hard'} difficulty
 */
export function createLocalAI(difficulty = 'normal') {
  const profile = AI_PROFILES[difficulty] ?? AI_PROFILES.normal

  /** 选一手。返回 {x, y, blocked:boolean}（blocked=这手主要是堵对手攻势）。 */
  function pickMove(engine) {
    const size = engine.size
    // 空盘：天元附近随机
    if (engine.moveCount === 0) {
      const c = Math.floor(size / 2)
      return { x: c + Math.floor(Math.random() * 3) - 1, y: c + Math.floor(Math.random() * 3) - 1, blocked: false }
    }
    const empties = []
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (engine.at(x, y) === EMPTY) empties.push([x, y])
    }
    if (empties.length === 0) return null   // 满盘防御（正常流程在平局前不会走到这）
    // 必胜优先：任何立刻成五的手直接取——防守权重再高也不许压过赢棋；
    // 且先于放水判定（简单难度可以漏防守，但不能送到嘴边的赢棋不下）
    for (const [x, y] of empties) {
      if (cellScore(engine, x, y, WHITE) >= 10000000) return { x, y, blocked: false }
    }
    // 放水：概率性在棋子附近随性和棋（不下必堵位）
    if (Math.random() < profile.slack) {
      const near = empties.filter(([x, y]) =>
        engine.moves.some((m) => Math.abs(m.x - x) <= 2 && Math.abs(m.y - y) <= 2))
      const pool = near.length > 0 ? near : empties
      const [x, y] = pool[Math.floor(Math.random() * pool.length)]
      return { x, y, blocked: false }
    }
    let best = null, bestScore = -Infinity, bestBlocked = false
    for (const [x, y] of empties) {
      const atk = cellScore(engine, x, y, WHITE)
      const def = cellScore(engine, x, y, BLACK)
      let score = atk + profile.defWeight * def
      score *= 1 + (Math.random() * 2 - 1) * profile.noise
      score += (size / 2 - Math.hypot(x - size / 2, y - size / 2)) * 0.5   // 微中心偏好破同分
      if (score > bestScore) { bestScore = score; best = [x, y]; bestBlocked = def > atk }
    }
    return { x: best[0], y: best[1], blocked: bestBlocked }
  }

  return { pickMove, difficulty }
}
