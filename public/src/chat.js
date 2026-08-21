import { BASE, PET, BRIDGE, STANDALONE } from './config.js'

export function initChat(ctx) {
  if (!PET || !STANDALONE) return null

  const style = document.createElement('style')
  style.textContent = `
    #l2d-chat-toggle{position:fixed;left:6px;top:6px;z-index:2147483645;display:grid;place-items:center;width:34px;height:34px;box-sizing:border-box;padding:0;border:1.5px solid rgba(178,211,255,.72);border-radius:50%;appearance:none;background:rgba(15,34,67,.82);color:#eaf4ff;font:18px/1 "Segoe UI Emoji","Segoe UI Symbol",sans-serif;text-align:center;cursor:pointer;box-shadow:0 3px 14px rgba(0,10,35,.28);backdrop-filter:blur(8px)}
    #l2d-chat-toggle:hover{background:rgba(35,70,120,.92)}
    #l2d-chat-panel{position:fixed;z-index:2147483646;left:8px;top:8px;width:min(360px,calc(100vw - 16px));max-height:calc(100vh - 16px);box-sizing:border-box;padding:10px;border:1px solid rgba(177,211,255,.75);border-radius:14px;background:rgba(10,25,52,.94);box-shadow:0 8px 28px rgba(0,8,30,.42);color:#edf6ff;font:12px/1.4 "Segoe UI","Microsoft YaHei",sans-serif;backdrop-filter:blur(12px)}
    #l2d-chat-panel[hidden]{display:none}
    #l2d-chat-head{display:flex;align-items:center;justify-content:space-between;margin:0 2px 7px;color:#cfe6ff}
    #l2d-chat-close{border:0;background:transparent;color:#cfe6ff;font-size:18px;line-height:18px;cursor:pointer}
    #l2d-chat-history{display:flex;flex-direction:column;gap:7px;min-height:62px;max-height:min(250px,calc(100vh - 120px));margin:0 0 9px;padding:8px;overflow-y:auto;overscroll-behavior:contain;border:1px solid rgba(169,206,255,.25);border-radius:10px;background:rgba(3,14,34,.45);scrollbar-width:thin;scrollbar-color:rgba(142,198,255,.55) transparent}
    #l2d-chat-empty{margin:auto;color:rgba(207,230,255,.62);text-align:center}
    .l2d-chat-line{display:flex;flex-direction:column;max-width:88%;gap:2px}
    .l2d-chat-line[data-role="user"]{align-self:flex-end;align-items:flex-end}
    .l2d-chat-line[data-role="nori"]{align-self:flex-start;align-items:flex-start}
    .l2d-chat-who{padding:0 3px;color:rgba(207,230,255,.68);font-size:10px}
    .l2d-chat-text{box-sizing:border-box;padding:6px 8px;border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
    .l2d-chat-line[data-role="user"] .l2d-chat-text{background:rgba(102,169,235,.88);color:#071c35;border-bottom-right-radius:3px}
    .l2d-chat-line[data-role="nori"] .l2d-chat-text{background:rgba(239,247,255,.95);color:#142743;border-bottom-left-radius:3px}
    #l2d-chat-form{display:flex;gap:7px}
    #l2d-chat-input{min-width:0;flex:1;height:32px;box-sizing:border-box;border:1px solid rgba(169,206,255,.55);border-radius:9px;outline:none;padding:0 9px;background:rgba(239,247,255,.96);color:#142743;font:13px "Segoe UI","Microsoft YaHei",sans-serif}
    #l2d-chat-input:focus{border-color:#8ec6ff;box-shadow:0 0 0 2px rgba(84,157,234,.22)}
    #l2d-chat-send{width:48px;border:0;border-radius:9px;background:#78b6f2;color:#0c2644;font-weight:600;cursor:pointer}
    #l2d-chat-send:disabled,#l2d-chat-input:disabled{opacity:.62;cursor:wait}
    #l2d-diary-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}
    #l2d-diary-tools button{height:26px;padding:0 8px;border:1px solid rgba(169,206,255,.42);border-radius:7px;background:rgba(30,64,108,.82);color:#eaf4ff;font:11px "Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer}
    #l2d-diary-tools button:disabled{opacity:.55;cursor:wait}
    #l2d-diary-auto-label{display:flex;align-items:center;gap:4px;margin-left:auto;color:#cfe6ff;white-space:nowrap}
    #l2d-diary-status{margin-top:5px;color:rgba(207,230,255,.68);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
    <div id="l2d-chat-history" role="log" aria-live="polite"><div id="l2d-chat-empty">本次启动的聊天会显示在这里</div></div>
    <form id="l2d-chat-form"><input id="l2d-chat-input" maxlength="1000" autocomplete="off" placeholder="输入消息......"><button id="l2d-chat-send" type="submit">发送</button></form>
    <div id="l2d-diary-tools"><button id="l2d-diary-save" type="button">总结并保存</button><button id="l2d-diary-dir" type="button">选择位置</button><label id="l2d-diary-auto-label"><input id="l2d-diary-auto" type="checkbox">闲置1分钟自动保存</label></div>
    <div id="l2d-diary-status">尚未选择日记位置</div>
  `
  document.body.append(toggle, panel)

  const form = panel.querySelector('#l2d-chat-form')
  const input = panel.querySelector('#l2d-chat-input')
  const send = panel.querySelector('#l2d-chat-send')
  const status = panel.querySelector('#l2d-chat-status')
  const close = panel.querySelector('#l2d-chat-close')
  const history = panel.querySelector('#l2d-chat-history')
  const emptyHistory = panel.querySelector('#l2d-chat-empty')
  const diarySave = panel.querySelector('#l2d-diary-save')
  const diaryDir = panel.querySelector('#l2d-diary-dir')
  const diaryAuto = panel.querySelector('#l2d-diary-auto')
  const diaryStatus = panel.querySelector('#l2d-diary-status')
  const historyRecords = []
  let diaryConfig = { dir: '', auto: false }
  let diaryTimer = 0
  let diarySaving = false
  let lastSavedCount = 0

  // 仅保存在当前页面内存中：关闭面板不丢，桌宠重启/页面重载即清空。
  function appendHistory(role, text) {
    const value = String(text ?? '').trim()
    if (!value) return
    historyRecords.push({ role: role === 'user' ? 'user' : 'nori', text: value })
    emptyHistory?.remove()
    const line = document.createElement('div')
    line.className = 'l2d-chat-line'
    line.dataset.role = role === 'user' ? 'user' : 'nori'
    const who = document.createElement('span')
    who.className = 'l2d-chat-who'
    who.textContent = role === 'user' ? '你' : 'Nori'
    const body = document.createElement('div')
    body.className = 'l2d-chat-text'
    body.textContent = value
    line.append(who, body)
    history.appendChild(line)
    history.scrollTop = history.scrollHeight
  }

  function diaryFolderLabel(dir) {
    const normalized = String(dir || '').replace(/[\\/]+$/, '')
    return normalized.split(/[\\/]/).pop() || normalized
  }

  function showDiaryConfig(message = '') {
    diaryAuto.checked = diaryConfig.auto === true
    diaryStatus.textContent = message || (diaryConfig.dir
      ? `保存到：${diaryFolderLabel(diaryConfig.dir)}`
      : '尚未选择日记位置')
    diaryStatus.title = diaryConfig.dir || ''
  }

  async function chooseDiaryDirectory() {
    const selected = await BRIDGE?.chooseDiaryDir?.()
    if (!selected?.dir) return false
    diaryConfig = selected
    showDiaryConfig()
    return true
  }

  async function saveDiary({ automatic = false } = {}) {
    if (diarySaving || historyRecords.length === 0 || historyRecords.length === lastSavedCount) return
    if (!diaryConfig.dir) {
      if (automatic || !await chooseDiaryDirectory()) return
    }
    diarySaving = true
    diarySave.disabled = true
    diaryDir.disabled = true
    const capturedCount = historyRecords.length
    const captured = historyRecords.slice(-200)
    showDiaryConfig(automatic ? '正在自动整理日记……' : 'Nori 正在整理这次聊天……')
    try {
      const ac = new AbortController()
      const timeout = setTimeout(() => ac.abort(), 50000)
      let response
      try {
        response = await fetch(BASE + '/diary/summarize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: captured }),
          signal: ac.signal,
        })
      } finally { clearTimeout(timeout) }
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.summary) throw new Error(data.error || '日记总结失败')
      const saved = await BRIDGE?.saveDiary?.({ summary: data.summary })
      if (!saved?.ok) throw new Error('日记保存失败')
      lastSavedCount = Math.max(lastSavedCount, capturedCount)
      showDiaryConfig(`已保存：${saved.file}`)
      if (!automatic) ctx.showBubble('日记保存好啦。Nori会记得这些的。', 6500, 2)
    } catch (error) {
      showDiaryConfig(error?.name === 'AbortError' ? '日记总结等待超时，请稍后再试' : String(error?.message || '日记保存失败'))
    } finally {
      diarySaving = false
      diarySave.disabled = false
      diaryDir.disabled = false
    }
  }

  function scheduleDiarySave() {
    clearTimeout(diaryTimer)
    if (!diaryConfig.auto || historyRecords.length === lastSavedCount) return
    diaryTimer = setTimeout(() => void saveDiary({ automatic: true }), 60000)
  }

  void Promise.resolve(BRIDGE?.getDiaryConfig?.()).then(config => {
    if (config) diaryConfig = config
    showDiaryConfig()
  }).catch(() => showDiaryConfig())

  diarySave.addEventListener('click', () => void saveDiary())
  diaryDir.addEventListener('click', () => void chooseDiaryDirectory())
  diaryAuto.addEventListener('change', async () => {
    if (diaryAuto.checked && !diaryConfig.dir && !await chooseDiaryDirectory()) {
      diaryAuto.checked = false
      return
    }
    const updated = await BRIDGE?.setDiaryAuto?.(diaryAuto.checked)
    if (updated) diaryConfig = updated
    showDiaryConfig()
    if (diaryConfig.auto) scheduleDiarySave()
    else clearTimeout(diaryTimer)
  })

  // overlay 桌宠的窗口固定铺满屏幕，模型才是会移动的主体。聊天入口与
  // panel.js 的 🔒❓⚙️🎮 共用右侧竖列，固定占第 5 格；输入框贴近模型并自动翻边。
  let followX = null
  let followY = null
  function followChat() {
    const b = ctx.modelBounds?.()
    if (b && b.width > 0) {
      const targetX = Math.min(Math.max(b.x + b.width + 8, 6), Math.max(6, window.innerWidth - 42))
      const columnTop = Math.min(Math.max(b.y + 4, 6), Math.max(6, window.innerHeight - 216))
      const targetY = columnTop + 160
      if (followX === null) { followX = targetX; followY = targetY }
      followX += (targetX - followX) * 0.3
      followY += (targetY - followY) * 0.3
      toggle.style.left = Math.round(followX) + 'px'
      toggle.style.top = Math.round(followY) + 'px'

      if (!panel.hidden) {
        const panelW = panel.offsetWidth || Math.min(360, window.innerWidth - 16)
        const panelH = panel.offsetHeight || 82
        const left = Math.min(Math.max(b.x + b.width / 2 - panelW / 2, 8), Math.max(8, window.innerWidth - panelW - 8))
        const above = b.y - panelH - 12
        const top = above >= 8 ? above : Math.min(b.y + b.height + 12, window.innerHeight - panelH - 8)
        panel.style.left = Math.round(left) + 'px'
        panel.style.top = Math.round(Math.max(8, top)) + 'px'
      }
    }
    requestAnimationFrame(followChat)
  }
  requestAnimationFrame(followChat)

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
    clearTimeout(diaryTimer)
    appendHistory('user', message)
    input.value = ''
    input.disabled = true
    send.disabled = true
    closeChat()
    ctx.enter('thinking')
    ctx.showBubble('唔......Nori想一下。', 90000, 1)
    try {
      // 95 秒前端超时：宿主 90s 超时返回 504，fetch 自身不设限会在 TCP 假死时永远转圈
      const ac = new AbortController()
      const timeout = setTimeout(() => ac.abort(), 95000)
      let response
      try {
        response = await fetch(BASE + '/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message }),
          signal: ac.signal,
        })
      } finally { clearTimeout(timeout) }
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw Object.assign(new Error(data.error || 'chat failed'), { status: response.status })
      ctx.enter('done')
      const holdMs = Math.max(6500, Math.min(15000, String(data.reply).length * 85))
      appendHistory('nori', data.reply)
      scheduleDiarySave()
      ctx.showBubble(data.reply, holdMs, 2)
    } catch (error) {
      ctx.enter('error')
      const text = error.status === 503
        ? 'OpenCode还没有连接......先打开OpenCode，再试一次哦。'
        : error.status === 504 || error.name === 'AbortError'
          ? '等了好久也没收到回答......再问Nori一次吧。'
          : '唔......这次没能接上OpenCode。'
      appendHistory('nori', text)
      scheduleDiarySave()
      ctx.showBubble(text, 8500, 2)
    } finally {
      input.disabled = false
      send.disabled = false
    }
  })

  ctx.openChat = openChat
  return { openChat, closeChat }
}
