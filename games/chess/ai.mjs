// 国际象棋本地 AI：negamax + alpha-beta 剪枝，难度=搜索深度+随性概率。
// 评估=子力+棋子位置表（经典简易版）。无 IO 无依赖。
import { PIECE_CHARS } from './engine.mjs'

const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 }

// 棋子位置表（白方视角，y=0 为第 8 排；黑方镜像取反）——鼓励中心控制与发展
const PST = {
  p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
}

/** 静态评估：正值=白优。 */
function evaluate(engine) {
  let score = 0
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const p = engine.at(x, y)
    if (!p) continue
    const idx = p.c === 'w' ? y * 8 + x : (7 - y) * 8 + x   // 黑方镜像
    const v = VAL[p.t] + (PST[p.t]?.[idx] ?? 0)
    score += p.c === 'w' ? v : -v
  }
  return score
}

const AI_PROFILES = {
  easy: { depth: 1, slack: 0.35 },    // 浅搜+三成概率随性走（放水给新手体验）
  normal: { depth: 2, slack: 0 },
  hard: { depth: 3, slack: 0 },
}

/** 搜索超时哨兵：预算闸耗尽即抛，根层接住按当前最优收。 */
const SEARCH_TIMEOUT = Symbol('search-timeout')

/**
 * 创建国际象棋本地 AI（执黑）。
 * @param {'easy'|'normal'|'hard'} difficulty
 * @param {number} budgetMs 单手搜索预算毫秒（缺省 2500；测试可压缩以验证超时路径）
 */
export function createChessAI(difficulty = 'normal', budgetMs = 2500) {
  const profile = AI_PROFILES[difficulty] ?? AI_PROFILES.normal
  let nodes = 0

  /** negamax + alpha-beta。返回相对当前手方的分数。deadline 预算闸防深搜冻结。 */
  function search(engine, depth, alpha, beta, deadline) {
    if ((++nodes & 1023) === 0 && Date.now() > deadline) throw SEARCH_TIMEOUT
    if (depth === 0) {
      // 被将军时延伸一层（check extension）：叶子不能对将杀/逼和失明——
      // 否则简单难度会把送到嘴边的将杀下成和棋；inCheck 只是一次攻击扫描，代价可控
      if (engine.inCheck(engine.turn)) depth = 1
      else {
        const raw = evaluate(engine)
        return engine.turn === 'w' ? raw : -raw
      }
    }
    const moves = engine.legalMoves()
    if (moves.length === 0) {
      // 无合法手：被将杀=大败（按深度衰减鼓励速杀），否则逼和=0
      return engine.inCheck(engine.turn) ? -100000 - depth : 0
    }
    // 走子排序：吃子优先（MVV-LVA），升变其次——剪枝效率的命脉
    const scored = moves.map((m) => {
      let s = 0
      const victim = engine.at(m.to.x, m.to.y)
      if (victim) s = 10 * VAL[victim.t] - VAL[engine.at(m.from.x, m.from.y).t]
      if (m.promotion) s += VAL[m.promotion]
      return [s, m]
    }).sort((a, b) => b[0] - a[0])
    let best = -Infinity
    for (const [, m] of scored) {
      const undo = engine.doMove(m)
      let v
      try {
        v = -search(engine, depth - 1, -beta, -alpha, deadline)
      } finally {
        // 铁律：undo 必须在 finally——SEARCH_TIMEOUT 哨兵从深层抛出时，
        // 路径上每一层都必须撤销，否则引擎停留在搜索支线（棋盘腐坏出"幽灵棋子"）
        engine.undoMove(m, undo)
      }
      if (v > best) best = v
      if (best > alpha) alpha = best
      if (alpha >= beta) break
    }
    return best
  }

  /**
   * 选一手（async：根节点间让出事件循环——困难深搜是 CPU 密集，同步执行会冻结
   * 宿主/独立版的全部路由）。返回引擎可执行的 {from,to,promotion?} + meta；
   * 无合法手返回 null（终局）。
   */
  async function pickMove(engine) {
    const moves = engine.legalMoves()
    if (moves.length === 0) return null
    // 放水：概率性从全部合法手里随性挑（仍合法，只是不优）
    if (Math.random() < profile.slack) {
      return { ...moves[Math.floor(Math.random() * moves.length)], blocked: false }
    }
    const deadline = Date.now() + budgetMs   // 单手预算：耗尽按当前最优收
    let best = null, bestScore = -Infinity
    try {
      for (const m of moves) {
        if (best !== null && Date.now() > deadline) break
        const undo = engine.doMove(m)
        let v
        try {
          v = -search(engine, profile.depth - 1, -Infinity, Infinity, deadline)
        } finally {
          engine.undoMove(m, undo)   // 根层同理：哨兵上抛时根走子必须撤销
        }
        if (v > bestScore) { bestScore = v; best = m }
        await new Promise((r) => setImmediate(r))   // 根节点间让出（引擎在让出点已还原）
      }
    } catch (e) {
      if (e !== SEARCH_TIMEOUT) throw e
    }
    if (best === null) best = moves[0]   // 极端：第一手都没搜完，保底合法手
    const victim = engine.at(best.to.x, best.to.y)
    // blocked 语义=吃子（台词情境用）；过路兵被吃者在邻列不在目标格，要并上 ep 判定
    return { ...best, blocked: !!victim || !!best.ep }
  }

  return { pickMove, difficulty }
}
