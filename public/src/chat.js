import { BASE, PET, BRIDGE, STANDALONE } from './config.js'

export function initChat(ctx) {
  if (!PET || !STANDALONE) return null

  const style = document.createElement('style')
  style.textContent = `
    #l2d-chat-toggle{position:fixed;left:6px;top:6px;z-index:2147483645;display:grid;place-items:center;width:34px;height:34px;box-sizing:border-box;padding:0;border:1.5px solid rgba(178,211,255,.72);border-radius:50%;appearance:none;background:rgba(15,34,67,.82);color:#eaf4ff;font:18px/1 "Segoe UI Emoji","Segoe UI Symbol",sans-serif;text-align:center;cursor:pointer;box-shadow:0 3px 14px rgba(0,10,35,.28);backdrop-filter:blur(8px)}
    #l2d-chat-toggle:hover{background:rgba(35,70,120,.92)}
    #l2d-chat-panel{position:fixed;z-index:2147483646;left:8px;top:8px;width:min(360px,calc(100vw - 16px));max-height:calc(100vh - 16px);box-sizing:border-box;padding:10px;overflow-y:auto;border:1px solid rgba(177,211,255,.75);border-radius:14px;background:rgba(10,25,52,.94);box-shadow:0 8px 28px rgba(0,8,30,.42);color:#edf6ff;font:12px/1.4 "Segoe UI","Microsoft YaHei",sans-serif;backdrop-filter:blur(12px)}
    #l2d-chat-panel[hidden]{display:none}
    #l2d-chat-head{display:flex;align-items:center;justify-content:space-between;margin:0 2px 7px;color:#cfe6ff;cursor:move;touch-action:none;user-select:none}
    #l2d-chat-close{border:0;background:transparent;color:#cfe6ff;font-size:18px;line-height:18px;cursor:pointer}
    #l2d-chat-history{display:flex;flex-direction:column;gap:7px;min-height:62px;max-height:min(250px,calc(100vh - 120px));margin:0 0 9px;padding:8px;overflow-y:auto;overscroll-behavior:contain;border:1px solid rgba(169,206,255,.25);border-radius:10px;background:rgba(3,14,34,.45);scrollbar-width:thin;scrollbar-color:rgba(142,198,255,.55) transparent}
    #l2d-chat-empty{margin:auto;color:rgba(207,230,255,.62);text-align:center}
    .l2d-chat-line{display:flex;flex-direction:column;max-width:88%;gap:2px}
    .l2d-chat-line[data-role="user"]{align-self:flex-end;align-items:flex-end}
    .l2d-chat-line[data-role="assistant"]{align-self:flex-start;align-items:flex-start}
    .l2d-chat-who{padding:0 3px;color:rgba(207,230,255,.68);font-size:10px}
    .l2d-chat-text{box-sizing:border-box;padding:6px 8px;border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
    .l2d-chat-line[data-role="user"] .l2d-chat-text{background:rgba(102,169,235,.88);color:#071c35;border-bottom-right-radius:3px}
    .l2d-chat-line[data-role="assistant"] .l2d-chat-text{background:rgba(239,247,255,.95);color:#142743;border-bottom-left-radius:3px}
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
    #l2d-memory-review{margin-top:8px;padding:8px;border:1px solid rgba(169,206,255,.35);border-radius:9px;background:rgba(3,14,34,.68)}
    #l2d-memory-review[hidden]{display:none}
    #l2d-memory-review-title{margin-bottom:6px;color:#dceeff;font-weight:600}
    #l2d-memory-candidates{display:flex;max-height:min(300px,42vh);flex-direction:column;gap:7px;overflow-y:auto}
    .l2d-memory-candidate{padding:7px;border-radius:8px;background:rgba(34,67,108,.68)}
    .l2d-diary-choice{display:flex;align-items:center;gap:7px;padding:7px;border-radius:8px;background:rgba(34,67,108,.68);overflow-wrap:anywhere}
    .l2d-diary-choice[data-processed="true"]{opacity:.58}
    .l2d-memory-new,.l2d-memory-old{white-space:pre-wrap;overflow-wrap:anywhere}
    .l2d-memory-new{color:#f2f8ff}.l2d-memory-old{margin-top:5px;color:#b8cce3}
    .l2d-memory-reason{margin-top:4px;color:#94b7dc;font-size:10px}
    .l2d-memory-candidate select{width:100%;height:27px;margin-top:6px;border:1px solid rgba(169,206,255,.45);border-radius:6px;background:#183657;color:#edf6ff}
    #l2d-memory-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:7px}
    #l2d-memory-actions button{height:27px;padding:0 10px;border:1px solid rgba(169,206,255,.45);border-radius:7px;background:#244e7e;color:#edf6ff;cursor:pointer}
  `
  document.head.appendChild(style)

  const toggle = document.createElement('button')
  toggle.id = 'l2d-chat-toggle'
  toggle.type = 'button'
  toggle.title = '和桌宠聊天'
  toggle.setAttribute('aria-label', '和桌宠聊天')
  toggle.textContent = '💬'

  const panel = document.createElement('section')
  panel.id = 'l2d-chat-panel'
  panel.hidden = true
  panel.innerHTML = `
    <div id="l2d-chat-head"><span id="l2d-chat-status">和桌宠说点什么</span><button id="l2d-chat-close" type="button" aria-label="关闭">×</button></div>
    <div id="l2d-chat-history" role="log" aria-live="polite"><div id="l2d-chat-empty">本次启动的聊天会显示在这里</div></div>
    <form id="l2d-chat-form"><input id="l2d-chat-input" maxlength="1000" autocomplete="off" placeholder="输入消息......"><button id="l2d-chat-send" type="submit">发送</button></form>
    <div id="l2d-diary-tools"><button id="l2d-diary-save" type="button">总结并保存</button><button id="l2d-memory-extract" type="button">提炼日记</button><button id="l2d-diary-location" type="button">保存位置</button><button id="l2d-profile-open" type="button">角色档案</button><label id="l2d-diary-auto-label"><input id="l2d-diary-auto" type="checkbox">闲置1分钟自动保存</label></div>
    <div id="l2d-diary-status">日记保存到当前角色档案</div>
    <section id="l2d-memory-review" hidden><div id="l2d-memory-review-title">确认要保存的长期记忆</div><div id="l2d-memory-candidates"></div><div id="l2d-memory-actions"><button id="l2d-memory-cancel" type="button">取消</button><button id="l2d-memory-commit" type="button">保存选择</button></div></section>
  `
  document.body.append(toggle, panel)

  const form = panel.querySelector('#l2d-chat-form')
  const input = panel.querySelector('#l2d-chat-input')
  const send = panel.querySelector('#l2d-chat-send')
  const status = panel.querySelector('#l2d-chat-status')
  const head = panel.querySelector('#l2d-chat-head')
  const close = panel.querySelector('#l2d-chat-close')
  const history = panel.querySelector('#l2d-chat-history')
  const emptyHistory = panel.querySelector('#l2d-chat-empty')
  const diarySave = panel.querySelector('#l2d-diary-save')
  const diaryLocation = panel.querySelector('#l2d-diary-location')
  const profileOpen = panel.querySelector('#l2d-profile-open')
  const diaryAuto = panel.querySelector('#l2d-diary-auto')
  const diaryStatus = panel.querySelector('#l2d-diary-status')
  const memoryExtract = panel.querySelector('#l2d-memory-extract')
  const memoryReview = panel.querySelector('#l2d-memory-review')
  const memoryCandidates = panel.querySelector('#l2d-memory-candidates')
  const memoryCancel = panel.querySelector('#l2d-memory-cancel')
  const memoryCommit = panel.querySelector('#l2d-memory-commit')
  const historyRecords = []
  let activeProfile = null
  let companionName = '桌宠'
  let diaryTimer = 0
  let diarySaving = false
  let lastSavedCount = 0
  let memorySourceHashes = []
  let memoryProfileId = ''
  let memoryBusy = false
  let memoryPhase = ''
  let statusTimer = 0
  let diaryMirrorDir = ''

  // 仅保存在当前页面内存中：关闭面板不丢，桌宠重启/页面重载即清空。
  function appendHistory(role, text) {
    const value = String(text ?? '').trim()
    if (!value) return
    historyRecords.push({ role: role === 'user' ? 'user' : 'assistant', text: value })
    emptyHistory?.remove()
    const line = document.createElement('div')
    line.className = 'l2d-chat-line'
    line.dataset.role = role === 'user' ? 'user' : 'assistant'
    const who = document.createElement('span')
    who.className = 'l2d-chat-who'
    who.textContent = role === 'user' ? '你' : companionName
    const body = document.createElement('div')
    body.className = 'l2d-chat-text'
    body.textContent = value
    line.append(who, body)
    history.appendChild(line)
    history.scrollTop = history.scrollHeight
  }

  function showDiaryConfig(message = '') {
    diaryAuto.checked = activeProfile?.autoDiary === true
    diaryStatus.textContent = message || (activeProfile
      ? diaryMirrorDir ? `角色档案内保存，并另存到：${diaryMirrorDir}` : `保存到「${activeProfile.name}」角色档案`
      : '正在读取角色档案……')
    diaryStatus.title = diaryMirrorDir || activeProfile?.name || ''
  }

  async function loadActiveProfile() {
    const response = await fetch(BASE + '/companion-profiles', { cache: 'no-store' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || '角色档案读取失败')
    activeProfile = data.active || null
    companionName = activeProfile?.name || '桌宠'
    toggle.title = `和${companionName}聊天`
    toggle.setAttribute('aria-label', toggle.title)
    showDiaryConfig()
    return activeProfile
  }

  async function loadDiaryLocation() {
    if (!BRIDGE?.getDiaryConfig) {
      diaryLocation.hidden = true
      return
    }
    const config = await BRIDGE.getDiaryConfig().catch(() => null)
    diaryMirrorDir = typeof config?.dir === 'string' ? config.dir : ''
    showDiaryConfig()
  }

  async function saveDiary({ automatic = false } = {}) {
    if (diarySaving || historyRecords.length === 0 || historyRecords.length === lastSavedCount) return
    if (!activeProfile) await loadActiveProfile().catch(() => null)
    if (!activeProfile) return
    diarySaving = true
    diarySave.disabled = true
    diaryLocation.disabled = true
    profileOpen.disabled = true
    const capturedCount = historyRecords.length
    const captured = historyRecords.slice(-200)
    showDiaryConfig(automatic ? '正在自动整理日记……' : '桌宠正在整理这次聊天……')
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
      const saveResponse = await fetch(BASE + '/diary/save', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ summary: data.summary }),
      })
      const saved = await saveResponse.json().catch(() => ({}))
      if (!saveResponse.ok || !saved?.ok) throw new Error(saved.error || '日记保存失败')
      let mirrored = null
      if (diaryMirrorDir && BRIDGE?.saveDiary) {
        try { mirrored = await BRIDGE.saveDiary({ summary: data.summary, profileName: activeProfile.name }) }
        catch (error) {
          lastSavedCount = Math.max(lastSavedCount, capturedCount)
          showDiaryConfig(`角色档案已保存，但指定位置写入失败：${String(error?.message || error)}`)
          return
        }
      }
      lastSavedCount = Math.max(lastSavedCount, capturedCount)
      showDiaryConfig(mirrored?.path ? `已保存并另存：${mirrored.path}` : `已保存：${saved.file}`)
      if (!automatic) ctx.showBubble('日记保存好了。', 6500, 2)
    } catch (error) {
      showDiaryConfig(error?.name === 'AbortError' ? '日记总结等待超时，请稍后再试' : String(error?.message || '日记保存失败'))
    } finally {
      diarySaving = false
      diarySave.disabled = false
      diaryLocation.disabled = false
      profileOpen.disabled = false
    }
  }

  function scheduleDiarySave() {
    clearTimeout(diaryTimer)
    if (!activeProfile?.autoDiary || historyRecords.length === lastSavedCount) return
    diaryTimer = setTimeout(() => void saveDiary({ automatic: true }), 60000)
  }

  void Promise.all([
    loadActiveProfile(),
    loadDiaryLocation(),
  ]).catch(() => showDiaryConfig('角色档案或日记位置读取失败'))

  diarySave.addEventListener('click', () => void saveDiary())
  profileOpen.addEventListener('click', () => ctx.openProfileEditor?.())
  diaryLocation.addEventListener('click', async () => {
    if (!BRIDGE?.chooseDiaryDir) return
    diaryLocation.disabled = true
    try {
      const chosen = await BRIDGE.chooseDiaryDir()
      if (typeof chosen?.dir === 'string' && chosen.dir) diaryMirrorDir = chosen.dir
      showDiaryConfig()
    } catch (error) {
      showDiaryConfig(String(error?.message || '保存位置选择失败'))
    } finally {
      diaryLocation.disabled = false
    }
  })

  function renderMemoryCandidates(candidates) {
    memoryPhase = 'candidates'
    panel.querySelector('#l2d-memory-review-title').textContent = '确认要保存的长期记忆'
    memoryCommit.textContent = '保存选择'
    memoryCandidates.replaceChildren()
    for (const candidate of candidates) {
      const item = document.createElement('article')
      item.className = 'l2d-memory-candidate'
      item.dataset.category = candidate.category
      item.dataset.content = candidate.content
      item.dataset.replaceId = candidate.matchId || ''
      const fresh = document.createElement('div')
      fresh.className = 'l2d-memory-new'
      fresh.textContent = `新记忆：${candidate.content}`
      item.appendChild(fresh)
      if (candidate.existing?.content) {
        const old = document.createElement('div')
        old.className = 'l2d-memory-old'
        old.textContent = `已有记忆：${candidate.existing.content}`
        item.appendChild(old)
      }
      if (candidate.reason) {
        const reason = document.createElement('div')
        reason.className = 'l2d-memory-reason'
        reason.textContent = `提炼理由：${candidate.reason}`
        item.appendChild(reason)
      }
      const choice = document.createElement('select')
      choice.setAttribute('aria-label', '这条记忆的保存方式')
      const choices = candidate.matchId
        ? [['replace', '替换已有记忆（推荐）'], ['add', '仍然新增一条'], ['skip', '跳过']]
        : [['add', '新增到长期记忆'], ['skip', '跳过']]
      for (const [value, label] of choices) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = label
        choice.appendChild(option)
      }
      item.appendChild(choice)
      memoryCandidates.appendChild(item)
    }
    memoryReview.hidden = false
  }

  function renderDiaryChoices(diaries) {
    memoryPhase = 'diaries'
    memoryCandidates.replaceChildren()
    panel.querySelector('#l2d-memory-review-title').textContent = '选择要提炼的日记'
    memoryCommit.textContent = '开始提炼'
    const pending = diaries.filter(item => !item.processed)
    const selectAll = document.createElement('label')
    selectAll.className = 'l2d-diary-choice'
    const allBox = document.createElement('input')
    allBox.type = 'checkbox'
    allBox.checked = pending.length > 0
    const allText = document.createElement('span')
    allText.textContent = '全选尚未提炼的日记'
    selectAll.append(allBox, allText)
    memoryCandidates.appendChild(selectAll)
    for (const diary of diaries) {
      const label = document.createElement('label')
      label.className = 'l2d-diary-choice'
      label.dataset.processed = String(diary.processed === true)
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.className = 'l2d-diary-choice-box'
      box.value = diary.file
      box.checked = !diary.processed
      box.disabled = diary.processed === true
      const name = document.createElement('span')
      name.textContent = `${diary.file}${diary.processed ? '（已提炼）' : ''}`
      label.append(box, name)
      memoryCandidates.appendChild(label)
    }
    allBox.addEventListener('change', () => {
      const boxes = [...memoryCandidates.querySelectorAll('.l2d-diary-choice-box:not(:disabled)')]
      boxes.forEach(box => { box.checked = allBox.checked })
    })
    memoryReview.hidden = false
  }

  async function openDiaryPicker() {
    if (memoryBusy) return
    memoryBusy = true
    memoryExtract.disabled = true
    memoryReview.hidden = true
    showDiaryConfig('正在读取当前角色的日记……')
    try {
      const response = await fetch(BASE + '/diary/list', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || '日记列表读取失败')
      if (!Array.isArray(data.diaries) || !data.diaries.length) {
        showDiaryConfig('当前角色档案还没有日记，请先总结并保存')
        return
      }
      memoryProfileId = data.profileId || ''
      renderDiaryChoices(data.diaries)
      const count = data.diaries.filter(item => !item.processed).length
      showDiaryConfig(count ? `还有 ${count} 篇日记尚未提炼，可自行勾选` : '这些日记都已经提炼过了')
    } catch (error) {
      showDiaryConfig(String(error?.message || '日记列表读取失败'))
    } finally {
      memoryBusy = false
      memoryExtract.disabled = false
    }
  }

  async function extractSelectedDiaries(files) {
    if (memoryBusy) return
    if (!files.length) { showDiaryConfig('请至少选择一篇尚未提炼的日记'); return }
    if (files.length > 40) { showDiaryConfig('一次最多提炼 40 篇日记'); return }
    memoryBusy = true
    memoryCommit.disabled = true
    memoryCancel.disabled = true
    showDiaryConfig(`正在提炼选中的 ${files.length} 篇日记……`)
    try {
      const response = await fetch(BASE + '/diary/extract-memory', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profileId: memoryProfileId, files }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw Object.assign(new Error(data.error || '记忆提炼失败'), { status: response.status })
      if (data.alreadyProcessed) {
        showDiaryConfig('当前角色的日记都已经提炼过了')
        return
      }
      if (!Array.isArray(data.candidates) || !data.candidates.length) {
        showDiaryConfig('没有发现值得长期保存的新记忆')
        return
      }
      memorySourceHashes = Array.isArray(data.sourceHashes) ? data.sourceHashes : []
      memoryProfileId = data.profileId || ''
      renderMemoryCandidates(data.candidates)
      showDiaryConfig(`已提炼 ${data.diaryFiles?.length || files.length} 篇日记：请逐条确认保存方式`)
    } catch (error) {
      if (error?.status === 503) status.textContent = '请先打开 OpenCode'
      showDiaryConfig(String(error?.message || '记忆提炼失败'))
    } finally {
      memoryBusy = false
      memoryCommit.disabled = false
      memoryCancel.disabled = false
    }
  }

  async function commitMemorySelection() {
    if (memoryBusy) return
    if (memoryPhase === 'diaries') {
      const files = [...memoryCandidates.querySelectorAll('.l2d-diary-choice-box:checked')].map(box => box.value)
      await extractSelectedDiaries(files)
      return
    }
    const items = [...memoryCandidates.querySelectorAll('.l2d-memory-candidate')].map(item => {
      const action = item.querySelector('select')?.value || 'skip'
      return action === 'skip' ? null : {
        action, category: item.dataset.category, content: item.dataset.content,
        replaceId: action === 'replace' ? item.dataset.replaceId : '',
      }
    }).filter(Boolean)
    if (!items.length) {
      showDiaryConfig('没有选择要保存的记忆')
      return
    }
    memoryBusy = true
    memoryCommit.disabled = true
    memoryCancel.disabled = true
    try {
      const response = await fetch(BASE + '/memory/commit', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profileId: memoryProfileId, sourceHashes: memorySourceHashes, items }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.ok) throw new Error(data.error || '记忆保存失败')
      memoryReview.hidden = true
      memoryCandidates.replaceChildren()
      memorySourceHashes = []
      memoryProfileId = ''
      memoryPhase = ''
      showDiaryConfig(`记忆已保存：新增 ${data.added} 条，替换 ${data.replaced} 条，跳过 ${data.skipped} 条`)
      ctx.showBubble('长期记忆已经整理好了。', 6500, 2)
    } catch (error) {
      showDiaryConfig(String(error?.message || '记忆保存失败'))
    } finally {
      memoryBusy = false
      memoryCommit.disabled = false
      memoryCancel.disabled = false
    }
  }

  memoryExtract.addEventListener('click', () => void openDiaryPicker())
  memoryCommit.addEventListener('click', () => void commitMemorySelection())
  memoryCancel.addEventListener('click', () => {
    if (memoryBusy) return
    memoryReview.hidden = true
    memoryCandidates.replaceChildren()
    memorySourceHashes = []
    memoryProfileId = ''
    memoryPhase = ''
    showDiaryConfig('已取消，本次没有修改长期记忆')
  })

  diaryAuto.addEventListener('change', async () => {
    if (!activeProfile) await loadActiveProfile().catch(() => null)
    if (!activeProfile) { diaryAuto.checked = false; return }
    const response = await fetch(BASE + '/companion-profiles', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...activeProfile, autoDiary: diaryAuto.checked }),
    })
    const updated = await response.json().catch(() => ({}))
    if (response.ok && updated.active) activeProfile = updated.active
    showDiaryConfig()
    if (activeProfile?.autoDiary) scheduleDiarySave()
    else clearTimeout(diaryTimer)
  })

  // 聊天入口跟随模型；打开后的聊天栏是独立浮窗，只在第一次打开时靠近模型放置。
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

  let panelPositioned = false
  let panelDrag = null
  function clampPanel(left, top) {
    const panelW = panel.offsetWidth || Math.min(360, window.innerWidth - 16)
    const panelH = panel.offsetHeight || 82
    return {
      left: Math.min(Math.max(left, 8), Math.max(8, window.innerWidth - panelW - 8)),
      top: Math.min(Math.max(top, 8), Math.max(8, window.innerHeight - panelH - 8)),
    }
  }

  function placePanelOnce() {
    if (panelPositioned) return
    const b = ctx.modelBounds?.()
    const panelW = panel.offsetWidth || Math.min(360, window.innerWidth - 16)
    const panelH = panel.offsetHeight || 82
    let left = 8
    let top = 8
    if (b && b.width > 0) {
      left = b.x + b.width / 2 - panelW / 2
      const above = b.y - panelH - 12
      top = above >= 8 ? above : b.y + b.height + 12
    }
    const placed = clampPanel(left, top)
    panel.style.left = Math.round(placed.left) + 'px'
    panel.style.top = Math.round(placed.top) + 'px'
    panelPositioned = true
  }

  head.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return
    const rect = panel.getBoundingClientRect()
    panelDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      left: rect.left, top: rect.top }
    head.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  })
  head.addEventListener('pointermove', event => {
    if (!panelDrag || panelDrag.pointerId !== event.pointerId) return
    const placed = clampPanel(
      panelDrag.left + event.clientX - panelDrag.startX,
      panelDrag.top + event.clientY - panelDrag.startY,
    )
    panel.style.left = Math.round(placed.left) + 'px'
    panel.style.top = Math.round(placed.top) + 'px'
  })
  const finishPanelDrag = event => {
    if (!panelDrag || panelDrag.pointerId !== event.pointerId) return
    panelDrag = null
    if (head.hasPointerCapture?.(event.pointerId)) head.releasePointerCapture(event.pointerId)
  }
  head.addEventListener('pointerup', finishPanelDrag)
  head.addEventListener('pointercancel', finishPanelDrag)

  async function refreshStatus() {
    try {
      const result = await fetch(BASE + '/chat/status', { cache: 'no-store' })
      const data = await result.json()
      companionName = data.profileName || companionName
      status.textContent = data.connected ? `${companionName}已连上 OpenCode` : '请先打开 OpenCode'
    } catch { status.textContent = '暂时看不到 OpenCode' }
  }

  function openChat() {
    panel.hidden = false
    BRIDGE?.setIgnore(false)
    requestAnimationFrame(placePanelOnce)
    void refreshStatus()
    clearInterval(statusTimer)
    statusTimer = setInterval(() => {
      if (panel.hidden) { clearInterval(statusTimer); statusTimer = 0; return }
      void refreshStatus()
    }, 3000)
    requestAnimationFrame(() => input.focus())
  }

  function closeChat() {
    panel.hidden = true
    clearInterval(statusTimer)
    statusTimer = 0
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
    ctx.showBubble('正在思考……', 90000, 1)
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
      appendHistory('assistant', data.reply)
      scheduleDiarySave()
      ctx.showBubble(data.reply, holdMs, 2)
    } catch (error) {
      ctx.enter('error')
      const text = error.status === 503
        ? 'OpenCode还没有连接......先打开OpenCode，再试一次哦。'
        : error.status === 504 || error.name === 'AbortError'
          ? '等了好久也没收到回答……请再试一次。'
          : '唔......这次没能接上OpenCode。'
      appendHistory('assistant', text)
      if (error.status === 503) status.textContent = '请先打开 OpenCode'
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
