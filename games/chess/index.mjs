// 国际象棋游戏描述符：引擎 + 本地 AI + 解说提示词 + 台词池，装配进注册表。
// 玩家执白先手，AI 执黑。走子输入 {from:{x,y}, to:{x,y}, promotion?}。
import { createChess, squareName, PIECE_NAMES } from './engine.mjs'
import { createChessAI } from './ai.mjs'

/** 走子的人类描述（解说提示词素材）：「对方(白)的马从 g1 跳到 f3」「你(黑)的后吃掉了 d4 的兵，将军！」。 */
function describe(engine, subject) {
  const lm = engine.lastMove
  if (!lm) return `${subject}走了一步`
  const piece = PIECE_NAMES[lm.piece] ?? '棋子'
  const from = squareName(lm.from.x, lm.from.y)
  const to = squareName(lm.to.x, lm.to.y)
  let s
  if (lm.castle) s = `${subject}${lm.castle === 'k' ? '短' : '长'}易位（王车换位）`
  else if (lm.captured) s = `${subject}的${piece}从 ${from} 吃掉了 ${to} 的${PIECE_NAMES[lm.captured] ?? '棋子'}`
  else s = `${subject}的${piece}从 ${from} 走到 ${to}`
  if (lm.promotion) s += `，升变为${PIECE_NAMES[lm.promotion]}`
  if (lm.mate) s += '，将杀！'
  else if (lm.check) s += '，将军！'
  return s
}

export default {
  id: 'chess',
  name: '国际象棋',

  createEngine: () => createChess(),
  createAI: (difficulty) => createChessAI(difficulty),

  playerMove(engine, input) {
    const r = engine.move(input)
    if (!r.ok) return { ok: false, reason: r.reason }
    // desc 即取：AI 走子后 lastMove 就被覆盖了
    return { ok: true, win: r.flags.mate, draw: engine.status().draw, move: { from: input.from, to: input.to, promotion: engine.lastMove?.promotion }, desc: describe(engine, '对方(白)') }
  },

  aiMove(engine, move) {
    if (!move) return { ok: false, win: false, draw: false, desc: '' }   // 契约允许 pickMove 返回 null
    const r = engine.move({ from: move.from, to: move.to, promotion: move.promotion })
    if (!r.ok) return { ok: false, win: false, draw: false, desc: '' }
    return { ok: true, win: r.flags.mate, draw: engine.status().draw, desc: describe(engine, '你(黑)') }
  },

  snapshot(engine) {
    const s = engine.snapshot()
    // 前端点选走子的合法落点数据源：仅轮到玩家且未终局时下发（引擎内部轻量，轮询无负担）
    if (!s.over && engine.turn === 'w') {
      s.legal = engine.legalMoves().map((m) => ({ from: m.from, to: m.to, promotion: m.promotion, ep: !!m.ep }))
    }
    return s
  },

  isOver(engine) {
    const s = engine.status()
    // winner 对齐注册表约定：1=玩家(白) 2=AI(黑) -1=平局
    return { over: s.over, winner: s.winner === 'w' ? 1 : s.winner === 'b' ? 2 : s.over ? -1 : 0 }
  },

  outcomeLines(engine) {
    const reason = engine.status().reason
    return {
      playerWin: '将杀！你赢了，漂亮！',
      aiWin: '将杀，对局结束。',
      draw: { stalemate: '逼和——无子可动，平局收场。', fifty: '五十回合无吃子无兵动，和棋。', repetition: '三次重复局面，和棋。', material: '双方子力不足，和棋。' }[reason] ?? '和棋收场。',
    }
  },

  boardText: (engine) => engine.renderText(),

  /** 阿尔法狗难度协议：LLM 亲自执黑。走法必须写在 <move>e7e5</move> 闭合标签里——
      位置无关、提取无歧义；标签之外全是台词。parse 只对合法清单认账（无闭合标签→null 触发重试）。 */
  llmMoveSpec(engine, playerDesc = '') {
    const legal = engine.legalMoves()
    const uci = (m) => squareName(m.from.x, m.from.y) + squareName(m.to.x, m.to.y) + (m.promotion ?? '')
    return {
      prompt: '这盘国际象棋由你亲自执黑（对方执白）。当前局面（大写=白方 小写=黑方）：\n'
        + engine.renderText()
        + (playerDesc ? `\n注意：${playerDesc}——这一步已经落在棋盘上。` : '')
        + '\n你的合法走法（代数记谱，起始格+目标格）：' + legal.map(uci).join(' ')
        + '\n你的选择必须写在闭合标签里输出：<move>e7e5</move>（从上面合法走法里原样挑一个；升变带后缀如 <move>e7e8q</move>），必须有 </move> 收尾。'
        + '\n标签之外随便你说什么：边下边聊，口语，40 字内，惊讶/得意/不服/警惕都行。'
        + '\n你没有也不能使用任何工具（不许提问、不许调用任何东西），直接用纯文本回复。',
      parse(text) {
        const tag = String(text ?? '').match(/<move>\s*([\s\S]*?)\s*<\/move>/i)
        if (!tag) return null
        const m = tag[1].match(/\b([a-h][1-8])([a-h][1-8])([qrbn])?\b/i)
        if (!m) return null
        const fx = 'abcdefgh'.indexOf(m[1][0].toLowerCase()), fy = 8 - Number(m[1][1])
        const tx = 'abcdefgh'.indexOf(m[2][0].toLowerCase()), ty = 8 - Number(m[2][1])
        const promo = m[3]?.toLowerCase()
        // 只对合法清单认账：返回清单里的走法对象（ep/castle 等标记随行）。
        // 带后缀→精确匹配该升变兵种；不带→升变走法缺省认后（q），普通走法直接命中
        const candidates = legal.filter((lm) => lm.from.x === fx && lm.from.y === fy
          && lm.to.x === tx && lm.to.y === ty)
        const hit = promo
          ? candidates.find((lm) => lm.promotion === promo)
          : candidates.find((lm) => (lm.promotion ?? 'q') === 'q') ?? candidates[0]
        if (!hit) return null
        const victim = engine.at(hit.to.x, hit.to.y)
        return { ...hit, blocked: !!victim || !!hit.ep }
      },
    }
  },

  commentatorBrief: (title) => `你正在和${title}下国际象棋。${title}执白先手，你执黑后手。`
    + `对局中称呼对方为「${title}」。`
    + '你的走子由本地引擎代劳，但每一手都是「你」的棋——你不是解说员，是边下边聊的对局者本人。'
    + '说的话要像下棋时脱口而出的碎碎念：对对方的走法可以惊讶、得意、不服、警惕、阴阳怪气，'
    + '也可以说自己的打算或心情（"哎哟这手有点东西""嘿嘿这位置咱惦记好久了"这种味道）。'
    + '口语化，有情绪起伏，不超过 40 字。别用解说腔，别复述坐标，别用列表，别每句都以称呼开头。'
    + '你没有也不能使用任何工具（不许提问、不许调用任何东西），直接用纯文本回复。',

  /** 开局播报（覆盖注册表缺省）：点明执白先手与代数坐标。 */
  startLine: (difficulty, mode) => `对局开始（${mode === 'offline' ? '本地对弈' : '在线解说'}·${{ easy: '简单', normal: '普通', hard: '困难', alphago: '阿尔法狗' }[difficulty]}）：你执白先手，点选棋子再走目标格。`,

  quips: {
    normal: ['嗯…就这里！', '这步如何？', '轮到主人啦~', '咱想想…有了！', '将军的思路咱有了~'],
    block: ['嘿嘿，吃掉咯~', '这个咱收下啦！', '主人的棋子闻起来真香~', '交换！咱不亏~'],
    win: ['将杀！咱厉害吧~', '赢啦赢啦！主人承让承让~'],
    lose: ['呜哇…被将杀了，主人好棋！这局咱心服口服~', '大意失荆州…主人的杀法太漂亮了，认输认输！', '输啦…主人这盘布局深远，咱甘拜下风！'],
  },

  pickQuipKey(move, aiResult) {
    if (aiResult?.win) return 'win'
    if (move?.blocked) return 'block'   // chess 的 blocked 语义=吃子
    return 'normal'
  },
}
