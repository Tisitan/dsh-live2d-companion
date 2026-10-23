// Test-only FEN setup. The engine deliberately exposes no position-import API.
// Change only constructor setup in an isolated module; rule functions and the
// public runtime module stay unchanged. The package's files allowlist excludes
// this helper. Fail loudly if the constructor anchor changes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./engine.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const signature = 'export function createChess() {'
const anchor = '  return {\n    get turn() { return turn },'
assert.equal(source.split(signature).length, 2)
assert.equal(source.split(anchor).length, 2)
const setup = `
  if (fixture) {
    for (let y = 0; y < 8; y++) board[y] = fixture.board[y].map(p => p ? { ...p } : null)
    turn = fixture.turn
    castling = { ...fixture.castling }
    ep = fixture.ep ? { ...fixture.ep } : null
    halfmove = fixture.halfmove
    fullmove = fixture.fullmove
    lastMove = null
    gameOver = null
    repetition.clear()
    repetition.set(posKey(), 1)
  }
`
const fixtureSource = source.replace(signature, 'export function createChess(fixture) {')
  .replace(anchor, setup + anchor)
const { createChess: createFixture } = await import('data:text/javascript;base64,' + Buffer.from(fixtureSource).toString('base64'))

export function fromFen(fen) {
  const [placement, turn, rights, target, half, full, ...extra] = fen.split(' ')
  assert.equal(extra.length, 0)
  assert.match(turn, /^[wb]$/)
  assert.match(rights, /^(?:-|K?Q?k?q?)$/)
  assert.match(target, /^(?:-|[a-h][36])$/)
  assert.match(half, /^\d+$/)
  assert.match(full, /^[1-9]\d*$/)
  const board = placement.split('/').map(rank => {
    const row = []
    for (const char of rank) {
      if (/^[1-8]$/.test(char)) row.push(...Array(Number(char)).fill(null))
      else {
        assert.match(char, /^[pnbrqkPNBRQK]$/)
        row.push({ c: char === char.toUpperCase() ? 'w' : 'b', t: char.toLowerCase() })
      }
    }
    assert.equal(row.length, 8)
    return row
  })
  assert.equal(board.length, 8)
  for (const color of ['w', 'b']) assert.equal(board.flat().filter(p => p?.c === color && p.t === 'k').length, 1)
  return createFixture({ board, turn,
    castling: { wk: rights.includes('K'), wq: rights.includes('Q'), bk: rights.includes('k'), bq: rights.includes('q') },
    ep: target === '-' ? null : { x: 'abcdefgh'.indexOf(target[0]), y: 8 - Number(target[1]) },
    halfmove: Number(half), fullmove: Number(full) })
}

export const sq = name => ({ x: 'abcdefgh'.indexOf(name[0]), y: 8 - Number(name[1]) })
export function play(engine, ...moves) {
  for (const move of moves) {
    const result = engine.move({ from: sq(move.slice(0, 2)), to: sq(move.slice(2, 4)), promotion: move[4] })
    assert.equal(result.ok, true, `${move}: ${result.reason ?? 'setup move rejected'}`)
  }
}
export const stateOf = engine => JSON.stringify({ snapshot: engine.snapshot(), status: engine.status(), lastMove: engine.lastMove, moveCount: engine.moveCount })
