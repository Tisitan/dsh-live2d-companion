// 五子棋前端渲染器：纯绘制+点击映射，状态由宿主快照下发。
// 渲染器契约（games/<id>.js export default { create() }）：
//   canvasSize: number                 // 画布边长 px
//   sideLabel: string                  // 「轮到你（黑）」的执子名
//   hint: string                       // 侧栏操作提示
//   winText / loseText / drawText      // 终局状态行文案
//   draw(g2d, canvas, state, fx)       // 全量重绘；fx={aiMove, t0} 时负责 AI 走子动画
//   clickToMove(state, relX, relY)     // 点击→{move} 走子输入 | {pending:true} 仅选中态变化 | null 忽略
const MARGIN = 26
const DEFAULT_SIZE = 15
const CANVAS = 500

export default {
  create() {
    // 格距随路数推导（未来服务端改路数前端自动适配，不再硬绑 15 路）
    const cellFor = (size) => (CANVAS - 2 * MARGIN) / (size - 1)
    const pxFor = (size, i) => MARGIN + cellFor(size) * i
    const boardSize = (state) => state?.size ?? DEFAULT_SIZE

    function draw(g2d, canvas, state, fx) {
      const w = canvas.width
      const size = boardSize(state)
      const CELL = cellFor(size)
      const px = (i) => pxFor(size, i)
      g2d.clearRect(0, 0, w, w)
      g2d.strokeStyle = 'rgba(90, 65, 25, .75)'
      g2d.lineWidth = 1
      for (let i = 0; i < size; i++) {
        g2d.beginPath(); g2d.moveTo(px(i), px(0)); g2d.lineTo(px(i), px(size - 1)); g2d.stroke()
        g2d.beginPath(); g2d.moveTo(px(0), px(i)); g2d.lineTo(px(size - 1), px(i)); g2d.stroke()
      }
      // 星位仅 15 路标准盘绘制（其他尺寸画角星会错位）
      if (size === 15) {
        g2d.fillStyle = 'rgba(90, 65, 25, .9)'
        for (const [sx, sy] of [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]]) {
          g2d.beginPath(); g2d.arc(px(sx), px(sy), 3, 0, Math.PI * 2); g2d.fill()
        }
      }
      if (!state || !state.board) return
      // AI 落子动画：目标子从 0 放大到全尺寸（与解说语句同帧出现）
      const anim = fx?.aiMove ? Math.min(1, (performance.now() - fx.t0) / 200) : 1
      const ease = 1 - (1 - anim) * (1 - anim)   // ease-out
      const last = state.moves?.[state.moves.length - 1]
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const c = state.board[y][x]
          if (c === 0) continue
          const isAnimating = fx?.aiMove && fx.aiMove.x === x && fx.aiMove.y === y && ease < 1
          const r = (CELL / 2 - 2.5) * (isAnimating ? ease : 1)
          if (r <= 0) continue
          const cx = px(x), cy = px(y)
          const grad = g2d.createRadialGradient(cx - r / 3, cy - r / 3, r / 6, cx, cy, r)
          if (c === 1) { grad.addColorStop(0, '#666'); grad.addColorStop(1, '#111') }
          else { grad.addColorStop(0, '#fff'); grad.addColorStop(1, '#cfd4da') }
          g2d.fillStyle = grad
          g2d.beginPath(); g2d.arc(cx, cy, r, 0, Math.PI * 2); g2d.fill()
          if (!isAnimating) {
            g2d.strokeStyle = c === 1 ? 'rgba(0,0,0,.6)' : 'rgba(0,0,0,.25)'
            g2d.stroke()
          }
        }
      }
      if (last) {
        g2d.fillStyle = '#d33'
        g2d.beginPath(); g2d.arc(px(last.x), px(last.y), 3.5, 0, Math.PI * 2); g2d.fill()
      }
      return ease < 1   // true=动画未结束（壳继续 rAF）
    }

    function clickToMove(state, relX, relY) {
      const size = boardSize(state)
      const CELL = cellFor(size)
      const x = Math.round((relX - MARGIN) / CELL)
      const y = Math.round((relY - MARGIN) / CELL)
      if (x < 0 || x >= size || y < 0 || y >= size) return null
      if (!state.board?.[y] || state.board[y][x] !== 0) return null
      return { move: { x, y } }
    }

    return {
      canvasSize: 500,
      sideLabel: '黑',
      hint: '你执黑先手，点击交叉点落子；咱的解说会用气泡说给你听',
      winText: '你赢了！五子连珠 🎉',
      loseText: '这局是咱的胜利~下次加油哦',
      drawText: '平局收场',
      draw,
      clickToMove,
      // 乐观渲染：黑子先入画再等服务端；拒绝时全量回滚（防幻子污染本地状态）
      applyOptimistic(state, move) {
        state.board[move.y][move.x] = 1
        ;(state.moves ??= []).push({ x: move.x, y: move.y, side: 1 })
      },
      rollbackOptimistic(state, move) {
        if (state.board?.[move.y]?.[move.x] === 1) state.board[move.y][move.x] = 0
        const mi = (state.moves ?? []).findLastIndex((m) => m.x === move.x && m.y === move.y && m.side === 1)
        if (mi >= 0) state.moves.splice(mi, 1)
      },
    }
  },
}
