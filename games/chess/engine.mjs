// 国际象棋引擎：完整规则（合法走子/将军/将杀/逼和/易位/吃过路兵/升变/五十回合/三次重复/子力不足）。
// 纯逻辑无 IO 无依赖，宿主与 standalone 共用。
// 约定：board[y][x]，y=0 是第 8 横排（黑方老家），y=7 是第 1 横排（白方老家）。
// x=0..7 ↔ 列 a..h。棋子 { c:'w'|'b', t:'p'|'n'|'b'|'r'|'q'|'k' }。
// 玩家=白(w)先手，AI=黑(b)。

export const PIECE_NAMES = { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' }
/** FEN 字符（快照用）：白大写黑小写。 */
export const PIECE_CHARS = { w: { p: 'P', n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K' }, b: { p: 'p', n: 'n', b: 'b', r: 'r', q: 'q', k: 'k' } }

const KNIGHT_D = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]
const KING_D = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
const BISHOP_D = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
const ROOK_D = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/** 格子代数名：(0,0)='a8'，(4,7)='e1'。 */
export function squareName(x, y) { return 'abcdefgh'[x] + String(8 - y) }

export function createChess() {
  // 初始布局
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r']
  const board = Array.from({ length: 8 }, () => new Array(8).fill(null))
  for (let x = 0; x < 8; x++) {
    board[0][x] = { c: 'b', t: back[x] }
    board[1][x] = { c: 'b', t: 'p' }
    board[6][x] = { c: 'w', t: 'p' }
    board[7][x] = { c: 'w', t: back[x] }
  }
  let turn = 'w'
  // 易位权：wk/wq/bk/bq（王侧/后侧）
  let castling = { wk: true, wq: true, bk: true, bq: true }
  let ep = null            // 过路兵目标格 {x,y} | null
  let halfmove = 0         // 五十回合计数（吃子/兵动清零）
  let fullmove = 1
  let lastMove = null      // {from,to,piece,captured,promotion,castle,ep,check,mate}
  let repetition = new Map()   // 局面键 → 出现次数（三次重复判和）
  let gameOver = null      // {winner:'w'|'b'|null, draw:boolean, reason:string} | null

  const inBoard = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8

  /** 局面键：棋子分布+手方+易位权+过路兵（三次重复判定用）。 */
  function posKey() {
    let s = turn
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const p = board[y][x]
      s += p ? PIECE_CHARS[p.c][p.t] : '.'
    }
    s += (castling.wk ? 'K' : '') + (castling.wq ? 'Q' : '') + (castling.bk ? 'k' : '') + (castling.bq ? 'q' : '')
    // FIDE 细节：ep 格仅在过路兵吃子真实可行时才区分局面（横向邻格有敌兵才算）
    let epReal = false
    if (ep) {
      const pawnRow = turn === 'w' ? ep.y + 1 : ep.y - 1
      epReal = [ep.x - 1, ep.x + 1].some((px) =>
        inBoard(px, pawnRow) && board[pawnRow][px]?.c === turn && board[pawnRow][px]?.t === 'p')
    }
    s += epReal ? squareName(ep.x, ep.y) : '-'
    return s
  }
  repetition.set(posKey(), 1)

  /** (x,y) 是否被 byColor 方攻击。 */
  function attacked(x, y, byColor) {
    // 兵：byColor 的兵攻击源在目标格「后方」（白兵向上攻→站在 y+1 攻 y）
    const pawnRow = byColor === 'w' ? y + 1 : y - 1
    if (inBoard(x - 1, pawnRow) && board[pawnRow][x - 1]?.c === byColor && board[pawnRow][x - 1]?.t === 'p') return true
    if (inBoard(x + 1, pawnRow) && board[pawnRow][x + 1]?.c === byColor && board[pawnRow][x + 1]?.t === 'p') return true
    for (const [dx, dy] of KNIGHT_D) {
      const p = inBoard(x + dx, y + dy) ? board[y + dy][x + dx] : null
      if (p && p.c === byColor && p.t === 'n') return true
    }
    for (const [dx, dy] of KING_D) {
      const p = inBoard(x + dx, y + dy) ? board[y + dy][x + dx] : null
      if (p && p.c === byColor && p.t === 'k') return true
    }
    for (const [dirs, types] of [[BISHOP_D, ['b', 'q']], [ROOK_D, ['r', 'q']]]) {
      for (const [dx, dy] of dirs) {
        let cx = x + dx, cy = y + dy
        while (inBoard(cx, cy)) {
          const p = board[cy][cx]
          if (p) {
            if (p.c === byColor && types.includes(p.t)) return true
            break
          }
          cx += dx; cy += dy
        }
      }
    }
    return false
  }

  function kingSquare(color) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      if (board[y][x]?.c === color && board[y][x]?.t === 'k') return { x, y }
    }
    return null
  }

  const inCheck = (color) => {
    const k = kingSquare(color)
    return k ? attacked(k.x, k.y, color === 'w' ? 'b' : 'w') : false
  }

  /** 伪合法走子（不过滤送将），from 缺省=全部。 */
  function pseudoMoves(color, fromSq = null) {
    const out = []
    const push = (fx, fy, tx, ty, extra = {}) => {
      const piece = board[fy][fx]
      // 兵到末排：生成 4 种升变
      if (piece.t === 'p' && (ty === 0 || ty === 7)) {
        for (const promo of ['q', 'r', 'b', 'n']) out.push({ from: { x: fx, y: fy }, to: { x: tx, y: ty }, promotion: promo, ...extra })
      } else {
        out.push({ from: { x: fx, y: fy }, to: { x: tx, y: ty }, ...extra })
      }
    }
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const p = board[y][x]
      if (!p || p.c !== color) continue
      if (fromSq && (fromSq.x !== x || fromSq.y !== y)) continue
      if (p.t === 'p') {
        const fwd = color === 'w' ? -1 : 1
        const startRow = color === 'w' ? 6 : 1
        if (inBoard(x, y + fwd) && !board[y + fwd][x]) {
          push(x, y, x, y + fwd)
          if (y === startRow && !board[y + 2 * fwd][x]) push(x, y, x, y + 2 * fwd, { double: true })
        }
        for (const dx of [-1, 1]) {
          const tx = x + dx, ty = y + fwd
          if (!inBoard(tx, ty)) continue
          const target = board[ty][tx]
          if (target && target.c !== color) push(x, y, tx, ty, { capture: true })
          // 过路兵：目标格是 ep 标记且横向邻格有敌兵
          if (ep && ep.x === tx && ep.y === ty) push(x, y, tx, ty, { ep: true, capture: true })
        }
      } else if (p.t === 'n' || p.t === 'k') {
        const dirs = p.t === 'n' ? KNIGHT_D : KING_D
        for (const [dx, dy] of dirs) {
          const tx = x + dx, ty = y + dy
          if (!inBoard(tx, ty)) continue
          const target = board[ty][tx]
          if (!target || target.c !== color) push(x, y, tx, ty, { capture: !!target })
        }
      } else {
        const dirs = p.t === 'b' ? BISHOP_D : p.t === 'r' ? ROOK_D : [...BISHOP_D, ...ROOK_D]
        for (const [dx, dy] of dirs) {
          let tx = x + dx, ty = y + dy
          while (inBoard(tx, ty)) {
            const target = board[ty][tx]
            if (!target) push(x, y, tx, ty)
            else { if (target.c !== color) push(x, y, tx, ty, { capture: true }); break }
            tx += dx; ty += dy
          }
        }
      }
    }
    // 易位：王未动+车未动+中间空+王现处/途经/到达格不受攻。
    // fromSq 过滤时也要生成：玩家点王再点易位落点，from 恰是王的位置
    const row = color === 'w' ? 7 : 0
    if (!fromSq || (fromSq.x === 4 && fromSq.y === row)) {
      const enemy = color === 'w' ? 'b' : 'w'
      const rights = color === 'w' ? ['wk', 'wq'] : ['bk', 'bq']
      if (castling[rights[0]] && !board[row][5] && !board[row][6]
        && !attacked(4, row, enemy) && !attacked(5, row, enemy) && !attacked(6, row, enemy)) {
        out.push({ from: { x: 4, y: row }, to: { x: 6, y: row }, castle: 'k' })
      }
      if (castling[rights[1]] && !board[row][3] && !board[row][2] && !board[row][1]
        && !attacked(4, row, enemy) && !attacked(3, row, enemy) && !attacked(2, row, enemy)) {
        out.push({ from: { x: 4, y: row }, to: { x: 2, y: row }, castle: 'q' })
      }
    }
    return out
  }

  /** 应用走子，返回 undo 信息。 */
  function apply(m) {
    const piece = board[m.from.y][m.from.x]
    const undo = {
      captured: board[m.to.y][m.to.x],
      epCaptured: m.ep ? board[m.from.y][m.to.x] : null,
      prevCastling: { ...castling }, prevEp: ep, prevHalf: halfmove, prevLast: lastMove,
    }
    board[m.to.y][m.to.x] = m.promotion ? { c: piece.c, t: m.promotion } : piece
    board[m.from.y][m.from.x] = null
    if (m.ep) board[m.from.y][m.to.x] = null   // 过路兵：吃掉身后的兵
    if (m.castle) {
      const row = m.from.y
      if (m.castle === 'k') { board[row][5] = board[row][7]; board[row][7] = null }
      else { board[row][3] = board[row][0]; board[row][0] = null }
    }
    // 易位权更新：王动/车动/车被吃
    if (piece.t === 'k') { if (piece.c === 'w') { castling.wk = false; castling.wq = false } else { castling.bk = false; castling.bq = false } }
    for (const [sq, key] of [[[0, 0], 'bq'], [[7, 0], 'bk'], [[0, 7], 'wq'], [[7, 7], 'wk']]) {
      if ((m.from.x === sq[0] && m.from.y === sq[1]) || (m.to.x === sq[0] && m.to.y === sq[1])) castling[key] = false
    }
    ep = m.double ? { x: m.from.x, y: m.from.y + (piece.c === 'w' ? -1 : 1) } : null
    halfmove = (piece.t === 'p' || undo.captured || undo.epCaptured) ? 0 : halfmove + 1
    if (turn === 'b') fullmove++
    lastMove = { ...m, piece: piece.t, color: piece.c, captured: undo.captured?.t ?? (m.ep ? 'p' : null) }
    turn = turn === 'w' ? 'b' : 'w'
    return undo
  }

  function unapply(m, undo) {
    turn = turn === 'w' ? 'b' : 'w'
    if (turn === 'b') fullmove--
    const piece = board[m.to.y][m.to.x]
    board[m.from.y][m.from.x] = m.promotion ? { c: piece.c, t: 'p' } : piece
    board[m.to.y][m.to.x] = undo.captured
    if (m.ep) board[m.from.y][m.to.x] = undo.epCaptured
    if (m.castle) {
      const row = m.from.y
      if (m.castle === 'k') { board[row][7] = board[row][5]; board[row][5] = null }
      else { board[row][0] = board[row][3]; board[row][3] = null }
    }
    castling = undo.prevCastling; ep = undo.prevEp; halfmove = undo.prevHalf; lastMove = undo.prevLast
  }

  /** 合法走子 = 伪合法过滤送将。from 缺省=当前手方全部。 */
  function legalMoves(fromSq = null) {
    const color = turn
    return pseudoMoves(color, fromSq).filter((m) => {
      const undo = apply(m)
      const ok = !inCheck(color)
      unapply(m, undo)
      return ok
    })
  }

  /** 子力不足判和：王对王 / 王+单轻子对王 / 王象对王象（同色格象）。 */
  function insufficientMaterial() {
    const pieces = []
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const p = board[y][x]
      if (p && p.t !== 'k') pieces.push({ ...p, x, y })
    }
    if (pieces.length === 0) return true
    if (pieces.length === 1 && (pieces[0].t === 'b' || pieces[0].t === 'n')) return true
    // 双方各一象且同色格=死局（同一方的双子不算——那是真实子力）。
    // 注意 K+N vs K+N 不算：FIDE 下该子力存在合法将杀局面（配合杀），自动判和是规则错判
    if (pieces.length === 2 && pieces[0].c !== pieces[1].c) {
      if (pieces.every((p) => p.t === 'b')) {
        return ((pieces[0].x + pieces[0].y) % 2) === ((pieces[1].x + pieces[1].y) % 2)
      }
    }
    return false
  }

  /** 终局结算（在每次 move 后调用）。
      有意简化：三次重复/五十回合采用自动判和（FIDE 为声明制，五次重复/75 回合才强制）——
      休闲对弈没有裁判席，自动制体验更好。 */
  function settle() {
    const moves = legalMoves()
    const checked = inCheck(turn)
    if (moves.length === 0) {
      gameOver = checked
        ? { winner: turn === 'w' ? 'b' : 'w', draw: false, reason: 'checkmate' }
        : { winner: null, draw: true, reason: 'stalemate' }
      return
    }
    if (halfmove >= 100) { gameOver = { winner: null, draw: true, reason: 'fifty' }; return }
    if (insufficientMaterial()) { gameOver = { winner: null, draw: true, reason: 'material' }; return }
    const key = posKey()
    const count = (repetition.get(key) ?? 0) + 1
    repetition.set(key, count)
    if (count >= 3) gameOver = { winner: null, draw: true, reason: 'repetition' }
  }

  /**
   * 走子入口。input = { from:{x,y}, to:{x,y}, promotion?:'q'|'r'|'b'|'n' }
   * @returns {{ok:true, flags:object} | {ok:false, reason:string}}
   */
  function move(input) {
    if (gameOver) return { ok: false, reason: '本局已结束' }
    const from = input?.from, to = input?.to
    // 整数闸先于 inBoard：浮点 y 能滑过范围检查后让 board[y] 变 undefined 崩掉（五子棋同款防御）
    if (!from || !to
      || !Number.isInteger(from.x) || !Number.isInteger(from.y)
      || !Number.isInteger(to.x) || !Number.isInteger(to.y)
      || !inBoard(from.x, from.y) || !inBoard(to.x, to.y)) return { ok: false, reason: '坐标无效' }
    const piece = board[from.y][from.x]
    if (!piece) return { ok: false, reason: '起点没有棋子' }
    if (piece.c !== turn) return { ok: false, reason: turn === 'w' ? '现在是白方走' : '现在是黑方走' }
    const legal = legalMoves(from)
    const promo = typeof input.promotion === 'string' ? input.promotion.toLowerCase() : undefined
    const m = legal.find((mm) => mm.to.x === to.x && mm.to.y === to.y
      && (mm.promotion === undefined || mm.promotion === (promo ?? 'q')))   // 升变缺省=后
    if (!m) {
      const needsPromo = legal.some((mm) => mm.to.x === to.x && mm.to.y === to.y && mm.promotion)
      if (needsPromo && promo && !['q', 'r', 'b', 'n'].includes(promo)) return { ok: false, reason: '升变兵种须为 q/r/b/n' }
      return { ok: false, reason: `${squareName(from.x, from.y)}→${squareName(to.x, to.y)} 不是合法着法` }
    }
    apply(m)
    settle()
    const checked = inCheck(turn)
    if (lastMove) { lastMove.check = checked; lastMove.mate = gameOver?.reason === 'checkmate' }
    const flags = {
      capture: !!m.capture, captured: undefined, promotion: m.promotion, castle: m.castle, ep: !!m.ep,
      // 显式判等：'stalemate'.includes('mate')===true 的脆写法不许进门
      check: checked && gameOver?.reason !== 'checkmate', mate: gameOver?.reason === 'checkmate',
    }
    return { ok: true, flags }
  }

  /** 文本棋盘：喂解说提示词。大写=白(解说员的对手)，小写=黑。 */
  function renderText() {
    const rows = board.map((row, y) =>
      String(8 - y) + ' ' + row.map((p) => p ? PIECE_CHARS[p.c][p.t] : '·').join(' '))
    return '  a b c d e f g h\n' + rows.join('\n')
      + `\n手方：${turn === 'w' ? '白' : '黑'}`
      + (inCheck(turn) ? '（被将军）' : '')
  }

  return {
    get turn() { return turn },
    get lastMove() { return lastMove },
    get moveCount() { return fullmove * 2 - (turn === 'w' ? 2 : 1) },   // 总半手数（近似）
    at(x, y) { return board[y]?.[x] ?? null },
    inCheck,
    legalMoves,
    move,
    // AI 搜索专用：裸 apply/unapply（不结算终局、不记重复表），搜索树内部使用
    doMove: apply,
    undoMove: unapply,
    /** 引擎状态：{over, winner:'w'|'b'|null, draw, reason, check} */
    status() { return { over: !!gameOver, winner: gameOver?.winner ?? null, draw: !!gameOver?.draw, reason: gameOver?.reason ?? null, check: inCheck(turn) } },
    renderText,
    /** 快照：并入 /game/state 响应（FEN 字符矩阵，白大写黑小写）。 */
    snapshot() {
      return {
        board: board.map((row) => row.map((p) => (p ? PIECE_CHARS[p.c][p.t] : null))),
        turn, castling: { ...castling },
        ep: ep ? { ...ep } : null,
        check: inCheck(turn),
        lastMove: lastMove ? { from: lastMove.from, to: lastMove.to } : null,
        over: !!gameOver, overReason: gameOver?.reason ?? null,
      }
    },
  }
}
