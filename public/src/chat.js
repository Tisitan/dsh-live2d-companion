import { BASE, PET, BRIDGE, STANDALONE } from './config.js'

export function initChat(ctx) {
  if (!PET || !STANDALONE) return null

  const style = document.createElement('style')
  style.textContent = `
    #l2d-chat-toggle{position:fixed;right:43px;top:7px;z-index:2147483645;width:30px;height:30px;border:1px solid rgba(178,211,255,.72);border-radius:50%;background:rgba(15,34,67,.82);color:#eaf4ff;font:18px/28px "Segoe UI",sans-serif;cursor:pointer;box-shadow:0 3px 14px rgba(0,10,35,.28);backdrop-filter:blur(8px)}
    #l2d-chat-toggle:hover{background:rgba(35,70,120,.92)}
    #l2d-chat-panel{position:fixed;z-index:2147483646;left:8px;right:8px;bottom:10px;padding:10px;border:1px solid rgba(177,211,255,.75);border-radius:14px;background:rgba(10,25,52,.94);box-shadow:0 8px 28px rgba(0,8,30,.42);color:#edf6ff;font:12px/1.4 "Segoe UI","Microsoft YaHei",sans-serif;backdrop-filter:blur(12px)}
    #l2d-chat-panel[hidden]{display:none}
    #l2d-chat-head{display:flex;align-items:center;justify-content:space-between;margin:0 2px 7px;color:#cfe6ff}
    #l2d-chat-close{border:0;background:transparent;color:#cfe6ff;font-size:18px;line-height:18px;cursor:pointer}
    #l2d-chat-form{display:flex;gap:7px}
    #l2d-chat-input{min-width:0;flex:1;height:32px;box-sizing:border-box;border:1px solid rgba(169,206,255,.55);border-radius:9px;outline:none;padding:0 9px;background:rgba(239,247,255,.96);color:#142743;font:13px "Segoe UI","Microsoft YaHei",sans-serif}
    #l2d-chat-input:focus{border-color:#8ec6ff;box-shadow:0 0 0 2px rgba(84,157,234,.22)}
    #l2d-chat-send{width:48px;border:0;border-radius:9px;background:#78b6f2;color:#0c2644;font-weight:600;cursor:pointer}
    #l2d-chat-send:disabled,#l2d-chat-input:disabled{opacity:.62;cursor:wait}
  `
  document.head.appendChild(style)

  const toggle = document.createElement('button')
  toggle.id = 'l2d-chat-toggle'
  toggle.type = 'button'
  toggle.title = '和 Nori 聊天'
  toggle.setAttribute('aria-label', '和 Nori 聊天')
  toggle.textContent = '💬'

  const panel = document.createElement('section')
  panel.id = 'l2d-chat-panel'
  panel.hidden = true
  panel.innerHTML = `
    <div id="l2d-chat-head"><span id="l2d-chat-status">和 Nori 说点什么</span><button id="l2d-chat-close" type="button" aria-label="关闭">×</button></div>
    <form id="l2d-chat-form"><input id="l2d-chat-input" maxlength="1000" autocomplete="off" placeholder="输入消息......"><button id="l2d-chat-send" type="submit">发送</button></form>
  `
  document.body.append(toggle, panel)

  const form = panel.querySelector('#l2d-chat-form')
  const input = panel.querySelector('#l2d-chat-input')
  const send = panel.querySelector('#l2d-chat-send')
  const status = panel.querySelector('#l2d-chat-status')
  const close = panel.querySelector('#l2d-chat-close')

  function protect(element) {
    for (const event of ['pointerdown', 'pointerup', 'click', 'dblclick', 'wheel']) {
      element.addEventListener(event, e => e.stopPropagation())
    }
    element.addEventListener('pointerenter', () => BRIDGE?.setIgnore(false))
  }
  protect(toggle)
  protect(panel)

  async function refreshStatus() {
    try {
      const result = await fetch(BASE + '/chat/status', { cache: 'no-store' })
      const data = await result.json()
      status.textContent = data.connected ? 'Nori 已连上 OpenCode' : '请先打开 OpenCode'
    } catch { status.textContent = '暂时看不到 OpenCode' }
  }

  function openChat() {
    panel.hidden = false
    BRIDGE?.setIgnore(false)
    void refreshStatus()
    requestAnimationFrame(() => input.focus())
  }

  function closeChat() {
    panel.hidden = true
    ctx.evalIgnore?.()
  }

  toggle.addEventListener('click', () => panel.hidden ? openChat() : closeChat())
  close.addEventListener('click', closeChat)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const message = input.value.trim()
    if (!message) return
    input.disabled = true
    send.disabled = true
    closeChat()
    ctx.enter('thinking')
    ctx.showBubble('唔......Nori想一下。', 90000, 1)
    try {
      const response = await fetch(BASE + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw Object.assign(new Error(data.error || 'chat failed'), { status: response.status })
      input.value = ''
      ctx.enter('done')
      const holdMs = Math.max(6500, Math.min(15000, String(data.reply).length * 85))
      ctx.showBubble(data.reply, holdMs, 2)
    } catch (error) {
      ctx.enter('error')
      const text = error.status === 503
        ? 'OpenCode还没有连接......先打开OpenCode，再试一次哦。'
        : error.status === 504
          ? '等了好久也没收到回答......再问Nori一次吧。'
          : '唔......这次没能接上OpenCode。'
      ctx.showBubble(text, 8500, 2)
    } finally {
      input.disabled = false
      send.disabled = false
    }
  })

  ctx.openChat = openChat
  return { openChat, closeChat }
}
