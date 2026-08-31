// 五子棋游戏描述符：引擎 + 本地 AI + 解说提示词 + 台词池，装配进注册表。
import { createGomoku, EMPTY, BLACK, WHITE } from './engine.mjs'
import { createLocalAI } from './ai.mjs'

/** 局势一句话素材：最后一手形成的最高威胁（解说提示词的"战术看点"）。 */
function threatLine(engine, x, y, side) {
  // 复用引擎 winsFrom 的方向扫描，数连子与开放端（与 ai.mjs 的线分同构，文字化输出）
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]]
  let best = null
  for (const [dx, dy] of DIRS) {
    let count = 1, open = 0
    for (const s of [1, -1]) {
      let cx = x + dx * s, cy = y + dy * s
      while (engine.at(cx, cy) === side) { count++; cx += dx * s; cy += dy * s }
      if (engine.at(cx, cy) === EMPTY && cx >= 0 && cx < engine.size && cy >= 0 && cy < engine.size) open++
    }
    const rank = count >= 5 ? 5 : count === 4 && open > 0 ? 4 : count === 3 && open === 2 ? 3 : count === 3 ? 2 : 0
    if (rank > (best?.rank ?? 0)) best = { rank, count, open }
  }
  if (!best) return ''
  if (best.rank === 5) return '，五子连珠'
  if (best.rank === 4) return best.open === 2 ? '，形成活四（下一手必杀）' : '，形成冲四'
  if (best.rank === 3) return '，形成活三'
  if (best.rank === 2) return '，形成眠三'
  return ''
}

export default {
  id: 'gomoku',
  name: '五子棋',

  createEngine: () => createGomoku(15),
  createAI: (difficulty) => createLocalAI(difficulty),

  playerMove(engine, input) {
    const r = engine.place(input?.x, input?.y, BLACK)
    return r.ok
      ? { ok: true, win: r.win, draw: r.draw, move: { x: input.x, y: input.y }, desc: `对方(黑)落在 (${input.x},${input.y})${threatLine(engine, input.x, input.y, BLACK)}` }
      : { ok: false, reason: r.reason }
  },

  aiMove(engine, move) {
    if (!move) return { ok: false, win: false, draw: false, desc: '' }   // 契约允许 pickMove 返回 null
    const r = engine.place(move.x, move.y, WHITE)
    return { ok: r.ok, win: !!r.win, draw: !!r.draw, desc: `你(白)落在 (${move.x},${move.y})${threatLine(engine, move.x, move.y, WHITE)}` }
  },

  snapshot(engine) {
    return { size: engine.size, board: engine.matrix(), moves: engine.moves, winner: engine.winner }
  },

  isOver(engine) {
    return { over: engine.winner !== EMPTY, winner: engine.winner }
  },

  outcomeLines: () => ({
    playerWin: '你赢了！五子连珠，漂亮！',
    aiWin: '白棋五子连珠，对局结束。',
    draw: '棋盘已满，平局收场。',
  }),

  boardText: (engine) => engine.renderText(4),

  /** 阿尔法狗难度协议：LLM 亲自执子。走法必须写在 <move>x,y</move> 闭合标签里——
      位置无关、提取无歧义；标签之外全是台词。parse 严格校验（无闭合标签→null 触发重试）。 */
  llmMoveSpec(engine, playerDesc = '') {
    return {
      prompt: '这盘五子棋由你亲自执子（你执白=W，对方执黑=B）。当前局面（·空位 B黑 W白，行首数字是行号、顶部是列号）：\n'
        + engine.renderText(4)
        + `\n棋盘 ${engine.size}x${engine.size}，坐标从 0 起（x 是横列、y 是纵行）。`
        + (playerDesc ? `\n注意：${playerDesc}——棋盘上这个 B 子已经落下，它周围的空位才是你能下的。` : '')
        + '\n你的落子必须写在闭合标签里输出：<move>x,y</move>（例如 <move>7,7</move>），必须有 </move> 收尾。'
        + '\n重要：只能选棋盘上显示为 · 的空位，已有 B/W 的位置咱落不进去，选了会被裁判打回。'
        + '\n标签之外随便你说什么：边下边聊，口语短句简短自然就好，惊讶/得意/不服/警惕都行。'
        + '\n你没有也不能使用任何工具（不许提问、不许调用任何东西），直接用纯文本回复。',
      parse(text) {
        const tag = String(text ?? '').match(/<move>\s*([\s\S]*?)\s*<\/move>/i)
        if (!tag) return null
        const m = tag[1].match(/(\d{1,2})\s*[,，、]\s*(\d{1,2})/)
        if (!m) return null
        const x = Number(m[1]), y = Number(m[2])
        if (x < 0 || y < 0 || x >= engine.size || y >= engine.size) return null
        if (engine.at(x, y) !== EMPTY) return null
        return { x, y, blocked: false }
      },
    }
  },

  commentatorBrief: (title) => `你正在和${title}下五子棋（15x15 棋盘）。${title}执黑先手，你执白后手。`
    + `对局中称呼对方为「${title}」。`
    + '规则：横/竖/斜任意方向先连成 5 子者胜。'
    + '你的落子由本地引擎代劳，但每一手都是「你」的棋——你不是解说员，是边下边聊的对局者本人。'
    + '说的话要像下棋时脱口而出的碎碎念：对对方的走法可以惊讶、得意、不服、警惕、阴阳怪气，'
    + '也可以说自己的打算或心情（"哎哟这手有点东西""嘿嘿这位置咱惦记好久了"这种味道）。'
    + '口语化，有情绪起伏，简短自然就好（别憋长篇）。别用解说腔，别复述坐标，别用列表。'
    + '你没有也不能使用任何工具（不许提问、不许调用任何东西），直接用纯文本回复。',

  quips: {
    normal: ['嗯…就这里！', '这步如何？', '轮到主人啦~', '咱想想…有了！', '这里这里！'],
    block: ['嘿嘿，堵上咯~', '此路不通！', '主人这手咱可看见了', '想连四？没门~'],
    win: ['赢啦赢啦！主人承让承让~', '五子连珠！咱厉害吧~'],
    lose: ['呜哇…五子连珠，主人好厉害！这局咱认输~', '大意了…主人这手咱没防住，佩服佩服！', '输啦输啦…主人棋力了得，再来一局咱一定赢回来！'],
  },
}
