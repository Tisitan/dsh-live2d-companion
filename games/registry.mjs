// 游戏注册表：游戏中心的宿主侧中枢。新游戏 = 一个目录 + 一次 register，路由/快照自动接入。
//
// 对局模型（本地为主 + LLM 解说）：
//   本地引擎确定性裁决，本地 AI 按难度执子（难度分档在本地生效——LLM 听不懂难度）；
//   在线模式 = LLM 以所选人格做「解说员」（不执子，只点评），离线模式 = 本地台词池。
//   AI 落子在引擎内即时完成，但响应扣住直到解说就位——前端收到响应时动画与语句同帧出现。
//
// 游戏描述符契约（games/<id>/index.mjs export default）：
// {
//   id: string,                        // 路由/前端渲染器同名键
//   name: string,                      // chips 显示名
//   createEngine(): Engine,            // 纯逻辑引擎实例
//   createAI(difficulty): { pickMove(engine) => move|null|Promise<move|null> },
//                                        // 可异步（深搜让出事件循环；调用方一律 await）
//   playerMove(engine, input): {ok:true, win, draw, move, desc}|{ok:false, reason},  // 玩家走子裁判+应用；
//                                        //   desc=人类可读走子描述（必须在引擎内即取——AI 走子后 lastMove 即被覆盖）
//   aiMove(engine, move): {ok, win, draw, desc},                                     // AI 走子应用+描述
//   snapshot(engine): object,          // 并入 /game/state 响应的游戏专属局面数据
//   isOver(engine): { over:boolean, winner:1|2|-1|0, reason?:string },           // 1=玩家 2=AI -1=平
//   outcomeLines(engine): { playerWin, aiWin, draw },   // 终局系统播报文案
//   boardText(engine): string,         // 紧凑文本局面（解说提示词上下文）
//   commentatorBrief(userTitle): string,        // 首回合解说员角色简报
//   startLine?(difficulty, mode): string,       // 开局播报（缺省通用文案）
//   quips: { normal:[], block:[], win:[], lose?:[] }, // 离线/解说超时兜底台词池（第一人称；lose=玩家制胜终局服输池）
//   pickQuipKey?(move, aiResult): 'normal'|'block'|'win'  // 台词情境选择，缺省 normal
//   llmMoveSpec?(engine, playerDesc): { prompt, parse(text)=>move|null },  // 阿尔法狗难度协议（可选）：
//                                        // LLM 亲自执子；走法写在 <move>…</move> 闭合标签里，
//                                        // playerDesc=对方刚走的一手描述（注入 prompt 免它瞎猜战况），
//                                        // parse 严格校验（无闭合标签/非法走法→null 触发重试/兜底）
// }

/** @type {Map<string, object>} */
const games = new Map()

/**
 * 登记游戏。重复 id 直接覆盖（开发期热改语义）；描述符缺关键字段立刻炸，别留到路由期。
 * @param {object} descriptor
 */
export function registerGame(descriptor) {
  const required = ['id', 'name', 'createEngine', 'createAI', 'playerMove', 'aiMove',
    'snapshot', 'isOver', 'outcomeLines', 'boardText', 'commentatorBrief', 'quips']
  for (const key of required) {
    if (descriptor?.[key] == null) throw new Error(`game descriptor missing: ${key}`)
  }
  games.set(descriptor.id, descriptor)
}

/** 取游戏描述符；未知 id 返回 undefined。 */
export function getGame(id) { return games.get(id) }

/** 目录清单：/game/list 的数据源。 */
export function listGames() {
  return [...games.values()].map((g) => ({ id: g.id, name: g.name, available: true }))
}

/** 台词情境选择缺省实现：AI 赢了用 win，这手以堵为主用 block，否则 normal。 */
export function defaultQuipKey(move, aiResult) {
  if (aiResult?.win) return 'win'
  if (move?.blocked) return 'block'
  return 'normal'
}
