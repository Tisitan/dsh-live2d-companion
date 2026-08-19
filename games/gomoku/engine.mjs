// 五子棋引擎：纯逻辑确定性裁判，无 IO 无依赖。宿主与 standalone 共用。
// 约定：0=空 1=黑(玩家先手) 2=白(AI)。坐标 0 起，x=列 y=行。

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
