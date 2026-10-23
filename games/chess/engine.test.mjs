// 国际象棋引擎测试：黄金值 perft + 关键规则路径。运行：node games/chess/engine.test.mjs
import { createChess } from './engine.mjs'
import { fromFen, play, stateOf } from './fixture.test-utils.mjs'

let passed = 0, failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ FAIL: ${label}`) }
}

/** perft：depth 层全合法走子计数（引擎正确性黄金基准）。 */
function perft(engine, depth) {
  if (depth === 0) return 1
  let nodes = 0
  for (const m of engine.legalMoves()) {
    const undo = engine.doMove(m)
    nodes += perft(engine, depth - 1)
    engine.undoMove(m, undo)
  }
  return nodes
}

const sq = (name) => ({ x: 'abcdefgh'.indexOf(name[0]), y: 8 - Number(name[1]) })
const mv = (from, to, promotion) => ({ from: sq(from), to: sq(to), promotion })

// ── 初始局面 ──
{
  const e = createChess()
  assert(e.legalMoves().length === 20, '初始合法走子=20')
  assert(perft(e, 2) === 400, 'perft(2)=400')
  assert(perft(e, 3) === 8902, 'perft(3)=8902')
  assert(e.status().over === false, '初始未终局')
}

// ── 愚人杀（fool's mate）：1.f3 e5 2.g4 Qh4# ──
{
  const e = createChess()
  e.move(mv('f2', 'f3')); e.move(mv('e7', 'e5')); e.move(mv('g2', 'g4'))
  const r = e.move(mv('d8', 'h4'))
  assert(r.ok && r.flags.mate, '愚人杀：后将杀判定')
  assert(e.status().over && e.status().winner === 'b' && e.status().reason === 'checkmate', '愚人杀：黑胜终局')
  const r2 = e.move(mv('a2', 'a3'))
  assert(!r2.ok, '终局后拒绝走子')
}

// ── 非法走子 ──
{
  const e = createChess()
  assert(!e.move(mv('e2', 'e5')).ok, '兵不能走三格')
  assert(!e.move(mv('e7', 'e5')).ok, '不能走对手的子')
  assert(!e.move(mv('e1', 'e2')).ok, '王不能走进被兵占的格子（e2 有己方兵）')
  e.move(mv('e2', 'e4')); e.move(mv('e7', 'e5'))
  // 送将：白王若暴露在被将状态不能置之不理——先构造牵制：这里简单测「不能送王入虎口」
  const e2 = createChess()
  e2.move(mv('e2', 'e4')); e2.move(mv('d7', 'd5'))
  const pin = e2.move(mv('e4', 'd5'))  // 吃兵
  assert(pin.ok && pin.flags.capture, '正常吃子可行')
}

// ── 王车易位 ──
{
  const e = createChess()
  e.move(mv('e2', 'e4')); e.move(mv('e7', 'e5'))
  e.move(mv('g1', 'f3')); e.move(mv('b8', 'c6'))
  e.move(mv('f1', 'c4')); e.move(mv('f8', 'c5'))
  const kingMoves = e.legalMoves(sq('e1'))
  const castle = kingMoves.find((m) => m.castle === 'k')
  assert(!!castle, '白短易位被生成')
  const r = e.move(mv('e1', 'g1'))
  assert(r.ok && r.flags.castle === 'k', '短易位执行')
  assert(e.at(sq('g1').x, sq('g1').y)?.t === 'k' && e.at(sq('f1').x, sq('f1').y)?.t === 'r', '易位后王车位置正确')
}

// ── 吃过路兵 ──
{
  const e = createChess()
  e.move(mv('e2', 'e4')); e.move(mv('a7', 'a6'))
  e.move(mv('e4', 'e5')); e.move(mv('d7', 'd5'))   // 黑兵冲两格，落在白兵旁
  const epMove = e.legalMoves(sq('e5')).find((m) => m.ep)
  assert(!!epMove, '过路兵被生成')
  const r = e.move(mv('e5', 'd6'))
  assert(r.ok && r.flags.ep, '过路兵执行')
  assert(e.at(sq('d6').x, sq('d6').y)?.t === 'p' && e.at(sq('d5').x, sq('d5').y) === null, '过路兵吃掉了身后的兵')
}

// ── 畸形输入（非整数坐标不得崩引擎；board[y] 对浮点 y 是 undefined 炸点）──
{
  const e = createChess()
  const snap = e.snapshot()
  assert(!e.move({ from: { x: 4, y: 1.5 }, to: { x: 4, y: 3 } }).ok, '畸形: 浮点 from.y 拒收')
  assert(!e.move({ from: { x: 4, y: '6' }, to: { x: 4, y: 4 } }).ok, '畸形: 字符串坐标拒收')
  assert(!e.move({ from: { x: 4, y: true }, to: { x: 4, y: 4 } }).ok, '畸形: 布尔坐标拒收')
  assert(!e.move({ from: null, to: { x: 4, y: 4 } }).ok && !e.move({}).ok, '畸形: 缺 from/to 拒收')
  const after = e.snapshot()
  assert(JSON.stringify(snap.board) === JSON.stringify(after.board) && after.turn === snap.turn,
    '畸形: 拒收后局面零污染')
}

// Rule references: https://handbook.fide.com/chapter/e012023
// 3.7.3 en passant, 3.7.3.3–5 promotion, 3.8.2 castling,
// 5.2.1/5.2.2 stalemate/dead positions, 9.2/9.3 repetition/50 moves.
// This app intentionally settles 3 repetitions / 50 moves automatically.

// ── Real promotion positions: all four pieces, both colors, captures/default/rejection ──
for (const promotion of ['q', 'r', 'b', 'n']) {
  for (const [fen, from, to, color] of [
    ['7k/P7/8/8/8/8/8/7K w - - 0 1', 'a7', 'a8', 'w'],
    ['7k/8/8/8/8/8/1p6/7K b - - 0 1', 'b2', 'b1', 'b'],
    ['1r5k/P7/8/8/8/8/8/7K w - - 0 1', 'a7', 'b8', 'w'],
  ]) {
    const e = fromFen(fen)
    const result = e.move(mv(from, to, promotion))
    const piece = e.at(sq(to).x, sq(to).y)
    assert(result.ok && result.flags.promotion === promotion && piece?.t === promotion && piece.c === color,
      `promotion: ${from}→${to}=${promotion} executes`)
  }
}
{
  const e = fromFen('7k/P7/8/8/8/8/8/7K w - - 0 1')
  const before = stateOf(e)
  assert(!e.move(mv('a7', 'a8', 'x')).ok && stateOf(e) === before, 'promotion: invalid piece rejected without mutation')
  assert(e.move(mv('a7', 'a8')).ok && e.at(0, 0)?.t === 'q', 'promotion: omitted piece defaults to queen')
}

// ── Stalemate is a draw, not mate; mate takes precedence over the 50-move clock ──
{
  const e = fromFen('k7/8/2K5/1Q6/8/8/8/8 w - - 0 1')
  const result = e.move(mv('b5', 'b6'))
  assert(result.ok && result.flags.mate === false && e.status().reason === 'stalemate' && !e.status().check,
    'stalemate: Qb6 leaves no legal move without check')
  assert(!e.move(mv('a8', 'a7')).ok, 'stalemate: terminal position rejects further moves')
  const mate = fromFen('k7/8/2K5/1Q6/8/8/8/8 w - - 99 1')
  const mating = mate.move(mv('b5', 'b7'))
  assert(mating.ok && mating.flags.mate && mate.status().winner === 'w' && mate.status().reason === 'checkmate',
    'mate: Qb7# takes precedence over reaching halfmove 100')
}

// ── Fifty moves: threshold, pawn/capture resets, and search undo preserves clock ──
{
  const e = fromFen('7k/8/8/8/8/8/P7/R3K3 w - - 99 1')
  const before = stateOf(e)
  for (const move of e.legalMoves()) { const undo = e.doMove(move); e.undoMove(move, undo) }
  assert(stateOf(e) === before, 'search undo: all public position fields unchanged at 50-move boundary')
  play(e, 'a1b1')
  assert(e.status().reason === 'fifty' && e.status().draw, 'fifty: quiet 100th halfmove draws')
  const pawn = fromFen('7k/8/8/8/8/8/P7/R3K3 w - - 99 1')
  play(pawn, 'a2a3', 'h8g8')
  assert(!pawn.status().over, 'fifty: pawn move resets clock')
  const capture = fromFen('7k/8/8/8/8/8/n7/R3K3 w - - 99 1')
  play(capture, 'a1a2', 'h8g8')
  assert(!capture.status().over, 'fifty: capture resets clock')
}

// ── Repetition: legal-move identity, including pinned en passant ──
const whiteKnightCycle = ['b1c3', 'b8c6', 'c3b1', 'c6b8']
const blackKnightCycle = ['b8c6', 'b1c3', 'c6b8', 'c3b1']
{
  const e = createChess()
  play(e, 'g1f3', 'g8f6', 'f3g1', 'f6g8')
  assert(!e.status().over, 'repetition: second occurrence remains playable')
  play(e, 'g1f3', 'g8f6', 'f3g1', 'f6g8')
  assert(e.status().reason === 'repetition', 'repetition: third occurrence draws')
}
for (const [fen, cycle, label] of [
  ['1n2k3/8/8/r4pPK/8/8/8/1N6 w - f6 0 1', whiteKnightCycle, 'white horizontal pin'],
  ['1n6/8/8/8/R4Ppk/8/8/1N2K3 b - f3 0 1', blackKnightCycle, 'black horizontal pin'],
  ['1n2k3/8/8/5p1K/8/8/8/1N6 w - f6 0 1', whiteKnightCycle, 'no adjacent pawn'],
]) {
  const e = fromFen(fen)
  const before = stateOf(e)
  assert(!e.legalMoves().some(m => m.ep), `repetition ${label}: no legal en passant`)
  for (let i = 0; i < 10; i++) for (const move of e.legalMoves()) {
    const undo = e.doMove(move); e.undoMove(move, undo)
  }
  assert(stateOf(e) === before, `repetition ${label}: legal/search probes preserve position`)
  play(e, ...cycle)
  assert(!e.status().over, `repetition ${label}: second occurrence remains playable`)
  play(e, ...cycle)
  assert(e.status().reason === 'repetition', `repetition ${label}: unavailable ep does not split third occurrence`)
}
for (const [fen, cycle] of [
  ['1n2k3/8/8/5pPK/8/8/8/1N6 w - f6 0 1', whiteKnightCycle],
  ['1n6/8/8/8/5Ppk/8/8/1N2K3 b - f3 0 1', blackKnightCycle],
]) {
  const e = fromFen(fen)
  assert(e.legalMoves().some(m => m.ep), 'repetition: legal ep exists in the initial position')
  play(e, ...cycle, ...cycle)
  assert(!e.status().over, 'repetition: legal ep distinguishes initial position from its two returns')
  play(e, cycle[0])
  assert(e.status().reason === 'repetition', 'repetition: third occurrence without ep still draws')
}
{
  const e = fromFen('1nr4k/8/8/2PpP3/8/8/8/1NK5 w - d6 0 1')
  const before = stateOf(e)
  const candidates = e.legalMoves().filter(m => m.ep)
  assert(candidates.length === 1 && candidates[0].from.x === 4,
    'ep: a pinned left neighbor does not hide the legal right-neighbor capture')
  const undo = e.doMove(candidates[0]); e.undoMove(candidates[0], undo)
  assert(stateOf(e) === before, 'ep: capture search undo restores both pawns and all public state')
  play(e, ...whiteKnightCycle, ...whiteKnightCycle)
  assert(!e.status().over, 'repetition: one legal ep candidate is enough to distinguish the position')
}
{
  const e = fromFen('1n2k3/5p2/8/r5PK/8/8/8/1N6 b - - 7 10')
  play(e, 'f7f5') // posKey runs in real move settlement, not only fixture initialization.
  const s = e.snapshot()
  assert(s.turn === 'w' && s.ep.x === 5 && s.ep.y === 2 && e.at(5, 3)?.c === 'b'
    && e.at(6, 3)?.c === 'w' && e.moveCount === 20 && e.lastMove.piece === 'p',
    'ep repetition probe restores board, turn, ep, lastMove and fullmove count')
  play(e, ...whiteKnightCycle, ...whiteKnightCycle)
  assert(e.status().reason === 'repetition', 'ep repetition: actual double-pawn move seeds correct repetition key')
}
{
  const e = fromFen('4k2r/8/8/8/8/8/8/4K2R w Kk - 0 1')
  const cycle = ['e1f1', 'e8f8', 'f1e1', 'f8e8']
  play(e, ...cycle, ...cycle)
  assert(!e.status().over, 'repetition: lost castling rights distinguish initial position')
}

// ── Dead material: actual settling moves, plus mating material must stay playable ──
for (const [fen, move, expected, label] of [
  ['7k/8/8/8/8/8/3n4/3K4 w - - 0 1', 'd1d2', true, 'K vs K'],
  ['7k/8/8/8/8/8/3p4/2B1K3 w - - 0 1', 'c1d2', true, 'K+B vs K'],
  ['7k/8/8/8/8/3p4/8/2N1K3 w - - 0 1', 'c1d3', true, 'K+N vs K'],
  ['5b1k/8/8/8/8/8/8/2B1K3 w - - 0 1', 'e1d1', true, 'same-color bishops'],
  ['7k/8/8/8/8/4B3/8/2B1K3 w - - 0 1', 'e1d1', true, 'same-side promoted bishops on one color'],
  ['5b1k/8/8/8/8/4B3/8/2B1K3 w - - 0 1', 'e1d1', true, 'multiple bishops on one color across both sides'],
  ['7k/8/8/8/8/3B4/8/2B1K3 w - - 0 1', 'e1d1', false, 'same-side bishop pair on different colors'],
  ['2b4k/8/8/8/8/8/8/2B1K3 w - - 0 1', 'e1d1', false, 'opposite-color bishops'],
  ['1n5k/8/8/8/8/8/8/2N1K3 w - - 0 1', 'e1d1', false, 'K+N vs K+N'],
  ['7k/8/8/8/8/8/8/1NN1K3 w - - 0 1', 'e1d1', false, 'K+NN vs K'],
]) {
  const e = fromFen(fen)
  play(e, move)
  assert((e.status().reason === 'material') === expected && (expected || !e.status().over), `material: ${label}`)
}

// ── Both castling sides/colors, attacks, obstruction and permanent lost rights ──
for (const [turn, from, to, rookTo, flag] of [
  ['w', 'e1', 'g1', 'f1', 'k'], ['w', 'e1', 'c1', 'd1', 'q'],
  ['b', 'e8', 'g8', 'f8', 'k'], ['b', 'e8', 'c8', 'd8', 'q'],
]) {
  const e = fromFen(`r3k2r/8/8/8/8/8/8/R3K2R ${turn} KQkq - 0 1`)
  const before = stateOf(e)
  const move = e.legalMoves().find(m => m.castle === flag)
  const undo = e.doMove(move); e.undoMove(move, undo)
  assert(stateOf(e) === before, `castling ${from}→${to}: search undo restores all state`)
  const result = e.move(mv(from, to))
  assert(result.ok && result.flags.castle === flag && e.at(sq(to).x, sq(to).y)?.t === 'k'
    && e.at(sq(rookTo).x, sq(rookTo).y)?.t === 'r', `castling ${from}→${to}: king and rook move`)
}
for (const [fen, label] of [
  ['k3r3/8/8/8/8/8/8/4K2R w K - 0 1', 'in check'],
  ['k4r2/8/8/8/8/8/8/4K2R w K - 0 1', 'through attacked square'],
  ['k5r1/8/8/8/8/8/8/4K2R w K - 0 1', 'into check'],
  ['k7/8/8/8/8/8/8/4KB1R w K - 0 1', 'blocked path'],
]) {
  const e = fromFen(fen)
  const before = stateOf(e)
  assert(!e.move(mv('e1', 'g1')).ok && stateOf(e) === before, `castling rejects ${label} without mutation`)
}
{
  const e = fromFen('1r5k/8/8/8/8/8/8/R3K3 w Q - 0 1')
  assert(e.move(mv('e1', 'c1')).ok, 'long castling: attack on b1 does not prohibit king path e1-d1-c1')
  const rook = fromFen('4k3/8/8/8/8/8/8/4K2R w K - 0 1')
  play(rook, 'h1h2', 'e8e7', 'h2h1', 'e7e8')
  assert(!rook.move(mv('e1', 'g1')).ok, 'castling right stays lost after rook returns')
  const king = fromFen('4k3/8/8/8/8/8/8/4K2R w K - 0 1')
  play(king, 'e1f1', 'e8e7', 'f1e1', 'e7e8')
  assert(!king.move(mv('e1', 'g1')).ok, 'castling right stays lost after king returns')
}

console.log(`\nchess engine: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
