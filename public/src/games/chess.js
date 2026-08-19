// 国际象棋前端渲染器：点选走子（选中→合法落点提示→点目标），升变四选一小弹层。
// 快照契约（宿主 chess snapshot）：board=FEN字符矩阵（白大写黑小写）、turn、check、
// lastMove{from,to}、legal=[{from,to,promotion?}]（仅轮到你且未终局时下发）。
const MARGIN = 30
const CELL = 55
const CANVAS = 500
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }
const LIGHT = '#f0d9b5', DARK = '#b58863'
const PROMO_CHOICES = ['q', 'r', 'b', 'n']   // 后车马象
const PROMO_LABEL = { q: '后', r: '车', b: '象', n: '马' }

/** 升变选择层的几何（绘制与命中测试共用同一口径，不许各算各的）。 */
function promoBox(to) {
  const bx = Math.min(Math.max(MARGIN + CELL * to.x - CELL * 1.5, 4), CANVAS - CELL * 4 - 8)
  const by = to.y === 0 ? MARGIN + 2 : MARGIN + CELL * 7 - 2 - CELL
  return { bx, by }
}

export default {
  create() {
    // 渲染器内部选中态：点选走子是两段式交互，选择不属于服务端局面
    let sel = null            // {x,y} 选中的己方棋子
    let promoPick = null      // {from, to, choices:[...]} 升变待选

    const sqPx = (i) => MARGIN + CELL * i
    const sameSq = (a, b) => a && b && a.x === b.x && a.y === b.y

    function legalTargets(state, from) {
      return (state.legal ?? []).filter((m) => m.from.x === from.x && m.from.y === from.y)
    }

    function draw(g2d, canvas, state, fx) {
      g2d.clearRect(0, 0, canvas.width, canvas.height)
      // 格子
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        g2d.fillStyle = (x + y) % 2 === 0 ? LIGHT : DARK
        g2d.fillRect(sqPx(x), sqPx(y), CELL, CELL)
      }
      // 坐标标号
      g2d.fillStyle = 'rgba(90,65,25,.7)'
      g2d.font = '11px system-ui'
      g2d.textAlign = 'center'; g2d.textBaseline = 'middle'
      for (let i = 0; i < 8; i++) {
        g2d.fillText('abcdefgh'[i], sqPx(i) + CELL / 2, sqPx(8) + 12)
        g2d.fillText(String(8 - i), 14, sqPx(i) + CELL / 2)
      }
      if (!state?.board) return false
      // 最近一手高亮
      if (state.lastMove) {
        g2d.fillStyle = 'rgba(255, 213, 79, .45)'
        for (const sq of [state.lastMove.from, state.lastMove.to]) {
          g2d.fillRect(sqPx(sq.x), sqPx(sq.y), CELL, CELL)
        }
      }
      // 选中格 + 合法落点（终局后不画残留选中态）
      if (sel && state.status === 'playing') {
        g2d.fillStyle = 'rgba(106, 168, 79, .5)'
        g2d.fillRect(sqPx(sel.x), sqPx(sel.y), CELL, CELL)
        for (const m of legalTargets(state, sel)) {
          const capture = state.board[m.to.y][m.to.x] !== null || m.ep
          g2d.fillStyle = capture ? 'rgba(211, 47, 47, .55)' : 'rgba(46, 125, 50, .5)'
          g2d.beginPath()
          if (capture) {
            g2d.arc(sqPx(m.to.x) + CELL / 2, sqPx(m.to.y) + CELL / 2, CELL / 2 - 4, 0, Math.PI * 2)
            g2d.lineWidth = 4; g2d.strokeStyle = 'rgba(211,47,47,.7)'; g2d.stroke()
          } else {
            g2d.arc(sqPx(m.to.x) + CELL / 2, sqPx(m.to.y) + CELL / 2, 8, 0, Math.PI * 2)
            g2d.fill()
          }
        }
      }
      // 走子滑动动画：fx.playerMove=玩家走子即时动画（棋盘快照还没到——from/to 遮罩持续
      // 到响应到达，否则会回跳旧位）；fx.aiMove=AI 走子随解说同帧动画（快照已含走子）
      const moving = fx?.aiMove ?? fx?.playerMove ?? null
      const isPlayerAnim = !fx?.aiMove && !!fx?.playerMove
      const anim = moving?.from ? Math.min(1, (performance.now() - fx.t0) / 220) : 1
      const ease = 1 - (1 - anim) * (1 - anim)
      // 棋子
      g2d.font = '44px "Segoe UI Symbol", "Noto Sans Symbols 2", sans-serif'
      g2d.textAlign = 'center'; g2d.textBaseline = 'middle'
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const ch = state.board[y][x]
        if (!ch) continue
        if (moving) {
          if (isPlayerAnim) {
            if (moving.from.x === x && moving.from.y === y) continue   // 玩家棋子走遮罩绘制
            if (moving.to.x === x && moving.to.y === y) continue       // 被吃子遮罩
          } else if (ease < 1 && moving.to.x === x && moving.to.y === y) continue   // AI 棋子在插值位
        }
        drawPiece(g2d, ch, sqPx(x) + CELL / 2, sqPx(y) + CELL / 2)
      }
      if (moving?.from && moving.to) {
        let ch
        if (isPlayerAnim) {
          ch = state.board[moving.from.y][moving.from.x]
          if (fx.playerMove.promotion) ch = fx.playerMove.promotion.toUpperCase()   // 升变直接画新棋子
        } else if (ease < 1) {
          ch = state.board[moving.to.y][moving.to.x]
        }
        if (ch) {
          const ix = sqPx(moving.from.x) + (sqPx(moving.to.x) - sqPx(moving.from.x)) * ease
          const iy = sqPx(moving.from.y) + (sqPx(moving.to.y) - sqPx(moving.from.y)) * ease
          drawPiece(g2d, ch, ix + CELL / 2, iy + CELL / 2)
        }
      }
      // 被将军的王格红晕。
      // 玩家走子动画期间整段跳过：此时 check/turn 是旧快照，红晕会在 from 格把已被遮罩的王
      // 再画一遍（双王幽灵）——响应到达后新快照自会给出正确的将军状态
      if (state.check && state.status !== 'over' && !isPlayerAnim) {
        const kingChar = state.turn === 'w' ? 'K' : 'k'
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          if (state.board[y][x] === kingChar) {
            g2d.fillStyle = 'rgba(211, 47, 47, .35)'
            g2d.fillRect(sqPx(x), sqPx(y), CELL, CELL)
            drawPiece(g2d, kingChar, sqPx(x) + CELL / 2, sqPx(y) + CELL / 2)
          }
        }
      }
      // 升变选择层
      if (promoPick) {
        const { from, to } = promoPick
        const { bx, by } = promoBox(to)
        g2d.fillStyle = 'rgba(255,255,255,.97)'
        g2d.strokeStyle = 'rgba(74,127,181,.6)'
        g2d.beginPath(); g2d.roundRect(bx, by, CELL * 4 + 8, CELL, 8); g2d.fill(); g2d.stroke()
        PROMO_CHOICES.forEach((t, i) => {
          g2d.fillStyle = '#eef4fb'
          g2d.fillRect(bx + 4 + i * CELL + 2, by + 2, CELL - 4, CELL - 4)
          g2d.fillStyle = '#223'
          g2d.font = '30px "Segoe UI Symbol", sans-serif'
          g2d.fillText(GLYPH[t], bx + 4 + i * CELL + CELL / 2, by + CELL / 2 - 4)
          g2d.font = '10px system-ui'
          g2d.fillText(PROMO_LABEL[t], bx + 4 + i * CELL + CELL / 2, by + CELL - 8)
          g2d.font = '44px "Segoe UI Symbol", "Noto Sans Symbols 2", sans-serif'
        })
        void from
      }
      return ease < 1
    }

    function drawPiece(g2d, ch, cx, cy) {
      const isWhite = ch === ch.toUpperCase()
      g2d.fillStyle = isWhite ? '#fafafa' : '#222'
      g2d.strokeStyle = isWhite ? 'rgba(0,0,0,.65)' : 'rgba(255,255,255,.35)'
      g2d.lineWidth = 1.5
      g2d.strokeText(GLYPH[ch.toLowerCase()], cx, cy)
      g2d.fillText(GLYPH[ch.toLowerCase()], cx, cy)
    }

    function clickToMove(state, relX, relY) {
      if (!state?.board || state.status !== 'playing') return null
      // 升变选择层点击优先
      if (promoPick) {
        const { from, to } = promoPick
        const { bx, by } = promoBox(to)
        if (relY >= by && relY <= by + CELL && relX >= bx + 4 && relX <= bx + 4 + CELL * 4) {
          const idx = Math.floor((relX - bx - 4) / CELL)
          const promotion = PROMO_CHOICES[Math.min(Math.max(idx, 0), 3)]
          promoPick = null
          return { move: { from, to, promotion } }
        }
        promoPick = null   // 点层外取消升变选择
        return { pending: true }
      }
      const x = Math.floor((relX - MARGIN) / CELL)
      const y = Math.floor((relY - MARGIN) / CELL)
      if (x < 0 || x > 7 || y < 0 || y > 7) { sel = null; return { pending: true } }
      const ch = state.board[y][x]
      const mine = (c) => c && c === c.toUpperCase()   // 玩家=白=大写
      if (sel) {
        const targets = legalTargets(state, sel).filter((m) => m.to.x === x && m.to.y === y)
        if (targets.length > 0) {
          const promos = targets.filter((m) => m.promotion)
          const from = sel
          sel = null
          if (promos.length > 0) {
            promoPick = { from, to: { x, y } }
            return { pending: true }
          }
          return { move: { from, to: { x, y } } }
        }
        // 点到自己别的子=改选；点到其他=取消
        sel = mine(ch) ? { x, y } : null
        return { pending: true }
      }
      if (mine(ch)) {
        sel = { x, y }
        return { pending: true }
      }
      return null
    }

    return {
      canvasSize: 500,
      sideLabel: '白',
      hint: '你执白先手：点选你的棋子，绿点是可落位、红圈是可吃子；兵到底线会问你升变什么',
      winText: '将杀！你赢了 🎉',
      loseText: '这局是咱的胜利~下次加油哦',
      drawText: '和棋收场',
      draw,
      clickToMove,
      reset() { sel = null; promoPick = null },
    }
  },
}
