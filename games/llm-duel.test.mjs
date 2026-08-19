// 阿尔法狗（LLM 亲自执子）协议测试：llmMoveSpec 的闭合标签解析校验。
// 标签合法认账 / 裸写拒收 / 未闭合拒收 / 越界占位拒收 / 内嵌容错 / 国象 UCI 清单匹配+升变。
// 运行：node games/llm-duel.test.mjs
import gomoku from './gomoku/index.mjs'
import chess from './chess/index.mjs'

let passed = 0, failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ FAIL: ${label}`) }
}

// ── 五子棋 ──
{
  const e = gomoku.createEngine()
  e.place(7, 7, 1)   // 黑占天元
  const spec = gomoku.llmMoveSpec(e)
  assert(typeof spec.prompt === 'string' && spec.prompt.includes('<move>') && spec.prompt.includes('</move>'),
    'gomoku: prompt 含闭合标签格式说明')
  const ok = spec.parse('<move>8,7</move>\n嘿嘿这位置咱惦记好久了')
  assert(ok && ok.x === 8 && ok.y === 7, 'gomoku: 标签坐标认账')
  assert(spec.parse('8,7\n裸写坐标') === null, 'gomoku: 无标签裸写拒收（格式纪律）')
  assert(spec.parse('<move>8,7') === null, 'gomoku: 未闭合标签拒收')
  assert(spec.parse('<move>7,7</move>') === null, 'gomoku: 占位拒收（天元已有子）')
  assert(spec.parse('<move>15,3</move>') === null, 'gomoku: 越界拒收')
  assert(spec.parse('<move>咱想想…</move>') === null, 'gomoku: 标签内无坐标拒收')
  const inline = spec.parse('咱走这里！<move>9,6</move> 嘿嘿')
  assert(inline && inline.x === 9 && inline.y === 6, 'gomoku: 内嵌标签位置无关')
  const cn = spec.parse('<move>8，7</move>')
  assert(cn && cn.x === 8 && cn.y === 7, 'gomoku: 中文逗号容错')
}

// ── 国际象棋 ──
{
  const e = chess.createEngine()
  e.move({ from: { x: 4, y: 6 }, to: { x: 4, y: 4 } })   // 1.e4，轮到黑（LLM 方）
  const spec = chess.llmMoveSpec(e)
  assert(spec.prompt.includes('<move>') && spec.prompt.includes('</move>'), 'chess: prompt 含闭合标签格式说明')
  const ok = spec.parse('<move>e7e5</move>\n主人这步有点东西')
  assert(ok && ok.from.x === 4 && ok.from.y === 1 && ok.to.x === 4 && ok.to.y === 3, 'chess: 标签 UCI 认账')
  assert(spec.parse('e7e5') === null, 'chess: 无标签裸写拒收（格式纪律）')
  assert(spec.parse('<move>e2e4</move>') === null, 'chess: 非己方棋子走法拒收（白兵不是黑的）')
  assert(spec.parse('<move>e7e9</move>') === null, 'chess: 非法目标格拒收')
  assert(spec.parse('<move>e7e5q</move>') === null, 'chess: 无升变的走法带升变后缀拒收')
  const caps = spec.parse('<MOVE>E7E5</MOVE>')
  assert(caps && caps.to.y === 3, 'chess: 大写标签+大写 UCI 容错')
  const inline = spec.parse('咱想想……有了！<move>c7c5</move> 这手如何？')
  assert(inline && inline.to.y === 3, 'chess: 内嵌标签位置无关')
}

console.log(`\nllm-duel: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
