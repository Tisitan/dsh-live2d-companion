// 游戏卫星窗加载器（桌宠模式）：复用 game.js 的对局卡，差异仅在声道与关窗——
// 气泡台词经 BroadcastChannel 转发给 overlay 页的 Live2D 小人说出；
// × 按钮关闭整个卫星窗而非仅隐藏 DOM 卡。
import { attachGame } from './src/game.js'

const bc = 'BroadcastChannel' in window ? new BroadcastChannel('l2d-companion') : null
const requestedGame = new URLSearchParams(location.search).get('game') || 'gomoku'

const ctx = {
  gameId: requestedGame,
  showBubble: (text, ms, priority) => bc?.postMessage({ type: 'bubble', text, ms, priority }),
  evalIgnore: () => { },   // 独立小窗无穿透状态机
}
attachGame(ctx)
ctx.openGame?.()

// 卫星窗里 × = 关窗（attachGame 自带的隐藏监听照样跑，无害）
document.getElementById('l2d-game')
  ?.querySelector('.l2d-game-close')
  ?.addEventListener('click', () => window.__cardBridge?.close())

const card = document.getElementById('l2d-game')

// ── 窗口拖动：IPC moveBy（screenX 差量喂主进程移窗）。窗口不透明，无透明窗
// 移动丢帧问题；pointer capture 保证拖出窗口边界也不脱手。──
const head = card?.querySelector('.l2d-game-head')
head?.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return   // chips/× 不参与拖动
  e.preventDefault()
  head.setPointerCapture(e.pointerId)
  let lx = e.screenX
  let ly = e.screenY
  const move = (ev) => {
    window.__cardBridge?.moveBy(ev.screenX - lx, ev.screenY - ly)
    lx = ev.screenX
    ly = ev.screenY
  }
  const up = () => {
    head.removeEventListener('pointermove', move)
    head.removeEventListener('pointerup', up)
    head.removeEventListener('pointercancel', up)
  }
  head.addEventListener('pointermove', move)
  head.addEventListener('pointerup', up)
  head.addEventListener('pointercancel', up)
})
