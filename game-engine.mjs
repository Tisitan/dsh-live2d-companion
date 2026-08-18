// 五子棋引擎：纯逻辑确定性裁判，无 IO 无依赖。宿主与工具处理器共用。
// 约定：0=空 1=黑(玩家先手) 2=白(agent)。坐标 0 起，x=列 y=行。

export const EMPTY = 0
export const BLACK = 1
export const WHITE = 2

export function createGomoku(size = 15) {
  const board = Array.from({ length: size }, () => new Array(size).fill(EMPTY))
  const moves = []   // {x, y, side} 按落子顺序
  let winner = EMPTY // EMPTY=未分胜负；-1=平局

  /** 从最后一手沿四方向数连子，>=5 即胜。只查最后一手，O(1) 量级。 */
  function winsFrom(x, y, side) {
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]]
    for (const [dx, dy] of dirs) {
      let n = 1
      for (const s of [1, -1]) {
        let cx = x + dx * s, cy = y + dy * s
        while (cx >= 0 && cx < size && cy >= 0 && cy < size && board[cy][cx] === side) {
          n++; cx += dx * s; cy += dy * s
        }
      }
      if (n >= 5) return true
    }
    return false
  }

  /**
   * 落子裁判。
   * @returns {{ok:true, win:boolean, draw:boolean} | {ok:false, reason:string}}
   */
  function place(x, y, side) {
    if (winner !== EMPTY) return { ok: false, reason: '本局已结束' }
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= size || y < 0 || y >= size) {
      return { ok: false, reason: `坐标越界（0~${size - 1}）` }
    }
    if (board[y][x] !== EMPTY) return { ok: false, reason: `(${x},${y}) 已有棋子` }
    board[y][x] = side
    moves.push({ x, y, side })
    const win = winsFrom(x, y, side)
    if (win) winner = side
    else if (moves.length === size * size) winner = -1
    return { ok: true, win, draw: winner === -1 }
  }

  /** 紧凑文本棋盘：喂给模型的每回合局面。·空 B黑 W白，行列标号。 */
  function renderText(lastN = 0) {
    const head = '   ' + Array.from({ length: size }, (_, i) => String(i).padStart(2)).join(' ')
    const rows = board.map((row, y) =>
      String(y).padStart(2) + ' ' + row.map((c) => (c === BLACK ? ' B' : c === WHITE ? ' W' : ' ·')).join(''))
    const tail = lastN > 0 && moves.length > 0
      ? `\n最近 ${Math.min(lastN, moves.length)} 手: ` + moves.slice(-lastN).map((m) => `${m.side === BLACK ? 'B' : 'W'}(${m.x},${m.y})`).join(' ')
      : ''
    return head + '\n' + rows.join('\n') + tail
  }

  return {
    size,
    get moves() { return moves.slice() },
    get winner() { return winner },
    get moveCount() { return moves.length },
    at(x, y) { return board[y]?.[x] ?? EMPTY },
    matrix() { return board.map((r) => r.slice()) },
    place,
    winsFrom,
    renderText,
  }
}

// ── 本地启发式对手（离线模式）：攻守双线评分，难度=防守权重+噪音+防水概率 ──
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
