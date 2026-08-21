// 五子棋引擎与本地 AI 测试：裁判校验 / 四方向胜负 / 长连 / 平局 / 不可变性 / AI 攻守纪律。
// 运行：node games/gomoku/engine.test.mjs
import { createGomoku, EMPTY, BLACK, WHITE } from './engine.mjs'
import { createLocalAI } from './ai.mjs'

let passed = 0, failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ FAIL: ${label}`) }
}

// ── 落子裁判 ──
{
  const e = createGomoku()
  assert(e.place(7, 7, BLACK).ok, 'place: 合法落子')
  assert(!e.place(7, 7, WHITE).ok, 'place: 占位拒收')
  assert(!e.place(15, 0, BLACK).ok && !e.place(-1, 0, BLACK).ok, 'place: 越界拒收')
  assert(!e.place(3.5, 4, BLACK).ok, 'place: 非整数拒收（浮点）')
  assert(!e.place('7', 7, BLACK).ok, 'place: 非整数拒收（字符串）')
  assert(!e.place(null, undefined, BLACK).ok, 'place: null/undefined 拒收')
  assert(e.moveCount === 1, 'place: 拒收不入账（moveCount 不被污染）')
}

// ── 胜负判定：四方向 ──
{
  const h = createGomoku()
  for (let i = 0; i < 4; i++) { h.place(3 + i, 7, BLACK); h.place(3 + i, 8, WHITE) }
  const r = h.place(7, 7, BLACK)
  assert(r.ok && r.win && h.winner === BLACK, 'win: 横五')

  const v = createGomoku()
  for (let i = 0; i < 4; i++) { v.place(5, 2 + i, BLACK); v.place(6, 2 + i, WHITE) }
  assert(v.place(5, 6, BLACK).win, 'win: 竖五')

  const d1 = createGomoku()
  for (let i = 0; i < 4; i++) { d1.place(2 + i, 2 + i, BLACK); d1.place(8, 2 + i, WHITE) }
  assert(d1.place(6, 6, BLACK).win, 'win: 主对角线五')

  const d2 = createGomoku()
  for (let i = 0; i < 4; i++) { d2.place(6 - i, 2 + i, BLACK); d2.place(9, 2 + i, WHITE) }
  assert(d2.place(2, 6, BLACK).win, 'win: 副对角线五')

  const four = createGomoku()
  for (let i = 0; i < 3; i++) { four.place(3 + i, 7, BLACK); four.place(3 + i, 8, WHITE) }
  assert(!four.place(6, 7, BLACK).win && four.winner === EMPTY, 'win: 四连不判胜')

  const over = createGomoku()
  over.place(2, 10, BLACK); over.place(0, 0, WHITE)
  over.place(3, 10, BLACK); over.place(2, 0, WHITE)
  over.place(5, 10, BLACK); over.place(4, 0, WHITE)
  over.place(6, 10, BLACK); over.place(6, 0, WHITE)
  over.place(7, 10, BLACK); over.place(8, 0, WHITE)
  const sixth = over.place(4, 10, BLACK)   // 一手嵌入两段之间，合成六连（白子隔行散开无连击）
  assert(sixth.ok && sixth.win && over.winner === BLACK, 'win: 一手合成六连（长连 >=5）判胜')
}

// ── 终局锁 ──
{
  const e = createGomoku()
  for (let i = 0; i < 4; i++) { e.place(3 + i, 7, BLACK); e.place(3 + i, 8, WHITE) }
  e.place(7, 7, BLACK)   // 黑胜
  const r = e.place(0, 0, WHITE)
  assert(!r.ok && r.reason.includes('结束'), '终局锁: 分胜负后拒绝再走')
}

// ── 平局（3x3 小板无可成五） ──
{
  const e = createGomoku(3)
  const order = [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]]
  let last
  for (const [x, y] of order) last = e.place(x, y, BLACK)
  assert(last.ok && last.draw && e.winner === -1, 'draw: 满盘无胜=平局')
  assert(!e.place(0, 0, WHITE).ok, 'draw: 平局后也上锁')
}

// ── 不可变性与防御 ──
{
  const e = createGomoku()
  e.place(7, 7, BLACK)
  const m1 = e.matrix()
  m1[7][7] = WHITE
  assert(e.at(7, 7) === BLACK, 'matrix: 返回副本，外部改写不污染引擎')
  const mv = e.moves
  mv.push({ x: 0, y: 0, side: WHITE })
  assert(e.moveCount === 1, 'moves: 返回副本')
  assert(e.at(-1, 99) === EMPTY, 'at: 越界读返回 EMPTY 不抛')
}

// ── 文本棋盘 ──
{
  const e = createGomoku()
  e.place(7, 7, BLACK)
  e.place(8, 7, WHITE)
  const t = e.renderText(2)
  assert(t.includes('B') && t.includes('W') && t.includes('·'), 'renderText: 含 B/W/空位标记')
  assert(t.includes('最近 2 手') && t.includes('B(7,7)') && t.includes('W(8,7)'), 'renderText: 尾部最近手记账')
}

// ── 本地 AI 纪律（hard=零噪音零放水，确定性断言） ──
{
  const ai = createLocalAI('hard')
  assert(ai.difficulty === 'hard', 'ai: 难度记账')

  const win = createGomoku()
  for (let i = 0; i < 4; i++) { win.place(3 + i, 7, WHITE) }   // 白已有四连
  win.place(0, 0, BLACK)
  const wmv = ai.pickMove(win)
  assert((wmv.x === 2 && wmv.y === 7) || (wmv.x === 7 && wmv.y === 7), 'ai(hard): 送到嘴边的五连必吃')

  const blk = createGomoku()
  for (let i = 0; i < 4; i++) { blk.place(3 + i, 7, BLACK) }   // 黑活四威胁
  blk.place(0, 0, WHITE)
  const bmv = ai.pickMove(blk)
  assert((bmv.x === 2 && bmv.y === 7) || (bmv.x === 7 && bmv.y === 7), 'ai(hard): 对手活四必堵')

  const empty = createGomoku()
  const emv = ai.pickMove(empty)
  const c = Math.floor(empty.size / 2)
  assert(Math.abs(emv.x - c) <= 1 && Math.abs(emv.y - c) <= 1, 'ai: 空盘天元附近开')

  const full = createGomoku(1)
  full.place(0, 0, BLACK)
  assert(ai.pickMove(full) === null, 'ai: 满盘返回 null（防御分支）')

  const easy = createLocalAI('wat')   // 未知难度回落 normal
  assert(easy.difficulty === 'normal' || easy.difficulty === 'wat', 'ai: 未知难度不崩')
}

console.log(`\ngomoku engine/ai: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
