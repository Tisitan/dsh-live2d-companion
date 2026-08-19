// 国际象棋 AI 测试：合法性 + 战术嗅觉 + 难度分档 + 将杀视野（含 check extension）。
// 运行：node games/chess/ai.test.mjs
import { createChess } from './engine.mjs'
import { createChessAI } from './ai.mjs'

let passed = 0, failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ FAIL: ${label}`) }
}
const sq = (name) => ({ x: 'abcdefgh'.indexOf(name[0]), y: 8 - Number(name[1]) })
const mv = (from, to) => ({ from: sq(from), to: sq(to) })

async function main() {
  // ── 基本合法性：AI 出的手必须在合法清单里 ──
  for (const diff of ['easy', 'normal', 'hard']) {
    const e = createChess()
    e.move(mv('e2', 'e4'))
    const ai = createChessAI(diff)
    const m = await ai.pickMove(e)
    const legal = m && e.legalMoves().some((lm) => lm.from.x === m.from.x && lm.from.y === m.from.y
      && lm.to.x === m.to.x && lm.to.y === m.to.y && (lm.promotion ?? 'q') === (m.promotion ?? 'q'))
    assert(!!legal, `${diff}: AI 走子合法`)
  }

  // ── 走子可应用（hard，白后冒进局面）──
  {
    const e = createChess()
    e.move(mv('e2', 'e4')); e.move(mv('e7', 'e5'))
    e.move(mv('d1', 'h5'))
    const ai = createChessAI('hard')
    const m = await ai.pickMove(e)
    const undo = e.doMove(m)
    const ok = e.status() !== null
    e.undoMove(m, undo)
    assert(ok, 'hard: 走子可应用')
  }

  // ── 将杀嗅觉：hard 一手杀必须找到（黑 Qh4# 场景）──
  {
    const e = createChess()
    e.move(mv('f2', 'f3')); e.move(mv('e7', 'e5'))
    e.move(mv('g2', 'g4'))
    const ai = createChessAI('hard')
    const m = await ai.pickMove(e)
    assert(m.from.x === sq('d8').x && m.from.y === sq('d8').y && m.to.x === sq('h4').x && m.to.y === sq('h4').y,
      'hard: 找到一手杀（Qh4#）')
  }

  // ── 将杀视野：easy（depth 1）也该看见一手杀（check extension 修复验证；35% 放水率故多次抽样）──
  {
    const e = createChess()
    e.move(mv('f2', 'f3')); e.move(mv('e7', 'e5'))
    e.move(mv('g2', 'g4'))
    const ai = createChessAI('easy')
    let found = false
    for (let i = 0; i < 20 && !found; i++) {
      const m = await ai.pickMove(e)
      if (m.from.x === sq('d8').x && m.to.x === sq('h4').x && m.to.y === sq('h4').y) found = true
    }
    assert(found, 'easy: 一手杀在搜索视野内（20 次抽样内命中）')
  }

  // ── 超时哨兵回归：预算闸抛 SEARCH_TIMEOUT 后引擎必须完好（undo 链 finally 保护）──
  {
    const e = createChess()
    for (const [a, b] of [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'c4'], ['g8', 'f6']]) e.move(mv(a, b))
    const before = e.renderText()
    const ai = createChessAI('hard', 0)   // 预算 0ms：必然触发超时哨兵（深层抛出）
    const m = await ai.pickMove(e)
    assert(e.renderText() === before, '超时哨兵上抛后引擎无腐坏（无幽灵棋子）')
    const legal = m && e.legalMoves().some((lm) => lm.from.x === m.from.x && lm.from.y === m.from.y
      && lm.to.x === m.to.x && lm.to.y === m.to.y)
    assert(!!legal, '超时保底手仍合法')
  }

  console.log(`\nchess ai: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}
main()
