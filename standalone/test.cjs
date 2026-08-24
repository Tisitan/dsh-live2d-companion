const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createStandaloneServer } = require('./server.cjs')

function runHook(script, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `hook exited ${code}`)))
    child.stdin.end(JSON.stringify(input))
  })
}

async function main() {
  const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
  const preloadSource = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8')
  const cardPreloadSource = fs.readFileSync(path.join(__dirname, 'preload-card.cjs'), 'utf8')
  const chatSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'src', 'chat.js'), 'utf8')
  const interactSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'src', 'interact.js'), 'utf8')
  const stageSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'src', 'stage.js'), 'utf8')
  const stateSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'src', 'state.js'), 'utf8')
  const openCodeAdapterSource = fs.readFileSync(path.join(__dirname, 'adapters', 'opencode-live2d.js'), 'utf8')
  const installerSource = fs.readFileSync(path.join(__dirname, 'adapters', 'install-adapters.cjs'), 'utf8')
  assert.match(mainSource, /l2d-game-open/)
  assert.match(mainSource, /cardGameId/)
  assert.match(mainSource, /cardExpectedSize/)
  assert.match(mainSource, /useContentSize:\s*true/)
  assert.match(mainSource, /hasShadow:\s*false/)
  assert.match(mainSource, /cardWin\.setBounds/)
  assert.match(mainSource, /l2d-restart/)
  assert.match(preloadSource, /openGame/)
  assert.match(preloadSource, /getCardArea/)
  assert.match(preloadSource, /getDiaryConfig/)
  assert.match(preloadSource, /chooseDiaryDir/)
  assert.match(preloadSource, /saveDiary/)
  assert.match(cardPreloadSource, /l2d-game-close/)
  assert.match(cardPreloadSource, /l2d-game-moveby/)
  assert.match(chatSource, /l2d-chat-history/)
  assert.match(chatSource, /appendHistory\('user'/)
  assert.match(chatSource, /appendHistory\('assistant'/)
  assert.match(chatSource, /diary\/summarize/)
  assert.match(chatSource, /diary\/extract-memory/)
  assert.match(chatSource, /memory\/commit/)
  assert.match(chatSource, /替换已有记忆/)
  assert.match(chatSource, /setInterval\(\(\) =>/)
  assert.match(chatSource, /status\.textContent = '请先打开 OpenCode'/)
  assert.match(chatSource, /l2d-diary-location/)
  assert.match(chatSource, /BRIDGE\.chooseDiaryDir/)
  assert.match(chatSource, /BRIDGE\.saveDiary/)
  assert.match(chatSource, /角色档案已保存，但指定位置写入失败/)
  assert.match(chatSource, /head\.setPointerCapture/)
  assert.match(chatSource, /placePanelOnce/)
  assert.match(chatSource, /pointercancel/)
  assert.match(chatSource, /60000/)
  assert.match(mainSource, /l2d-diary-save/)
  assert.match(mainSource, /diary-\$\{now\.getFullYear\(\)\}/)
  assert.match(openCodeAdapterSource, /L2D_COMPANION_AGENT/)
  assert.match(openCodeAdapterSource, /live2d-companion/)
  assert.match(installerSource, /live2d-companion\.md/)
  assert.ok(fs.existsSync(path.join(__dirname, 'adapters', 'live2d-companion.md')))
  assert.match(interactSource, /wokeFromSleep/)
  assert.match(interactSource, /clickReact\(true\)/)
  assert.match(interactSource, /你回来啦/)
  assert.match(stageSource, /setEyeBlinkEnabled/)
  assert.match(stageSource, /blink\.setParameterIds/)
  assert.match(stageSource, /!enabled && !ctx\.binding\?\.motion\?\.sleep/)
  assert.match(stageSource, /guardIdlePool/)
  assert.match(stateSource, /setEyeBlinkEnabled\?\.\(next !== 'sleeping'\)/)
  assert.match(stateSource, /if \(woke\) ctx\.stopMotions\?\.\(\)/)
  assert.match(preloadSource, /restart/)

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-standalone-test-'))
  const publicDir = path.resolve(__dirname, '..', 'public')
  const server = await createStandaloneServer({ publicDir, dataDir })
  const adapterFile = path.join(dataDir, 'adapter.json')
  try {
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    const adapter = JSON.parse(fs.readFileSync(adapterFile, 'utf8'))
    assert.equal(adapter.endpoint, server.origin + '/live2d/adapter')
    assert.match(adapter.token, /^[a-f0-9]{64}$/)

    const page = await fetch(server.target)
    assert.equal(page.status, 200)
    const cookie = page.headers.get('set-cookie')
    assert.ok(cookie?.includes('l2d_standalone_token='))
    const browserAuth = { cookie: cookie.split(';')[0] }
    const importedModel = await fetch(server.origin + '/live2d/import?model=test-model&path=test.model3.json', {
      method: 'POST', headers: browserAuth, body: JSON.stringify({ FileReferences: {} }),
    })
    assert.equal(importedModel.status, 200)
    const selectedModel = await fetch(server.origin + '/live2d/model', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model/test.model3.json' }),
    })
    assert.equal(selectedModel.status, 200)

    const profilesDenied = await fetch(server.origin + '/live2d/companion-profiles')
    assert.equal(profilesDenied.status, 403)
    const profilesResponse = await fetch(server.origin + '/live2d/companion-profiles', { headers: browserAuth })
    const profileData = await profilesResponse.json()
    assert.equal(profilesResponse.status, 200)
    assert.equal(profileData.active.model, 'test-model/test.model3.json')
    const profileId = profileData.active.id
    const savedProfile = await fetch(server.origin + '/live2d/companion-profiles', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ ...profileData.active, name: '测试桌宠', persona: '你是用于测试的桌宠。', autoDiary: true }),
    })
    assert.equal(savedProfile.status, 200)
    const personaReplacement = await fetch(server.origin + '/live2d/companion-profiles', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: profileId, name: '测试桌宠', model: profileData.active.model,
        memoryProvider: 'local', persona: '你是用于测试的更新后桌宠。' }),
    }).then(r => r.json())
    assert.equal(personaReplacement.active.persona, '你是用于测试的更新后桌宠。')
    assert.equal(personaReplacement.active.autoDiary, true)
    const memoryImport = await fetch(`${server.origin}/live2d/companion-profile/import?id=${profileId}&kind=memory&name=test-memory.md`, {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'text/plain' }, body: '用户和桌宠曾经一起下棋。',
    })
    assert.equal(memoryImport.status, 200)
    const importedMemory = await memoryImport.json()
    assert.equal(importedMemory.category, 'event')
    assert.match(importedMemory.file, /^memory-.*\.md$/)
    const duplicateMemory = await fetch(`${server.origin}/live2d/companion-profile/import?id=${profileId}&kind=memory&name=test-memory.md`, {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'text/plain' }, body: '  用户和桌宠曾经一起下棋  ',
    })
    assert.equal((await duplicateMemory.json()).duplicate, true)
    const memoryIndex = JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles', profileId, 'memories', 'index.json'), 'utf8'))
    assert.equal(memoryIndex.length, 1)
    const secondProfileResponse = await fetch(server.origin + '/live2d/companion-profiles', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '另一个角色', model: 'test-model/test.model3.json', persona: '独立测试档案。' }),
    })
    const secondProfile = (await secondProfileResponse.json()).active
    assert.notEqual(secondProfile.id, profileId)
    await fetch(`${server.origin}/live2d/companion-profile/import?id=${secondProfile.id}&kind=memory&name=private.md`, {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'text/plain' }, body: '另一个角色喜欢潜水。',
    })
    const reactivateProfile = await fetch(server.origin + '/live2d/companion-profiles', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'activate', id: profileId }),
    })
    assert.equal((await reactivateProfile.json()).active.id, profileId)
    const allProfiles = await fetch(server.origin + '/live2d/companion-profiles', { headers: browserAuth }).then(r => r.json())
    assert.equal(allProfiles.profiles.filter(item => item.model === 'test-model/test.model3.json').length, 2)
    const seedDiary = await fetch(server.origin + '/live2d/diary/save', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ summary: '今天一起去了海边捡贝壳。' }),
    })
    assert.equal(seedDiary.status, 200)
    const gameCardPage = await fetch(server.origin + '/live2d/game-card.html')
    assert.equal(gameCardPage.status, 200)
    const gameCardScript = await fetch(server.origin + '/live2d/game-card.js')
    assert.equal(gameCardScript.status, 200)
    assert.match(await gameCardScript.text(), /requestedGame/)

    const chatStatusBefore = await fetch(server.origin + '/live2d/chat/status')
    assert.deepEqual(await chatStatusBefore.json(), { connected: false, profileId, profileName: '测试桌宠' })
    const chatPollDenied = await fetch(server.origin + '/live2d/chat/next')
    assert.equal(chatPollDenied.status, 403)
    const heartbeatDenied = await fetch(server.origin + '/live2d/chat/heartbeat')
    assert.equal(heartbeatDenied.status, 403)
    const adapterAuth = { authorization: `Bearer ${adapter.token}` }
    const heartbeatAllowed = await fetch(server.origin + '/live2d/chat/heartbeat', { headers: adapterAuth })
    assert.equal(heartbeatAllowed.status, 204)
    const emptyPoll = await fetch(server.origin + '/live2d/chat/next', { headers: adapterAuth })
    assert.equal(emptyPoll.status, 204)
    const chatStatusAfter = await fetch(server.origin + '/live2d/chat/status')
    assert.deepEqual(await chatStatusAfter.json(), { connected: true, profileId, profileName: '测试桌宠' })

    const chatPromise = fetch(server.origin + '/live2d/chat', {
      method: 'POST',
      headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ message: '还记得我们一起下棋吗？' }),
    })
    let chatJobResponse
    for (let attempt = 0; attempt < 20; attempt++) {
      chatJobResponse = await fetch(server.origin + '/live2d/chat/next', { headers: adapterAuth })
      if (chatJobResponse.status === 200) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(chatJobResponse.status, 200)
    const chatJob = await chatJobResponse.json()
    assert.equal(chatJob.message, '还记得我们一起下棋吗？')
    assert.match(chatJob.memory, /一起下棋/)
    assert.doesNotMatch(chatJob.memory, /喜欢潜水/)
    assert.equal(chatJob.profileId, profileId)
    assert.equal(chatJob.profileName, '测试桌宠')
    assert.match(chatJob.persona, /用于测试的更新后桌宠/)
    const chatReply = await fetch(server.origin + '/live2d/chat/reply', {
      method: 'POST',
      headers: { ...adapterAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: chatJob.id, text: '在这里。' }),
    })
    assert.equal(chatReply.status, 200)
    const chatResult = await chatPromise
    assert.equal(chatResult.status, 200)
    assert.deepEqual(await chatResult.json(), { reply: '在这里。' })

    const unrelatedChatPromise = fetch(server.origin + '/live2d/chat', {
      method: 'POST',
      headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ message: '今天的天气怎么样？' }),
    })
    let unrelatedJobResponse
    for (let attempt = 0; attempt < 20; attempt++) {
      unrelatedJobResponse = await fetch(server.origin + '/live2d/chat/next', { headers: adapterAuth })
      if (unrelatedJobResponse.status === 200) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(unrelatedJobResponse.status, 200)
    const unrelatedJob = await unrelatedJobResponse.json()
    assert.equal(unrelatedJob.memory, '')
    await fetch(server.origin + '/live2d/chat/reply', {
      method: 'POST',
      headers: { ...adapterAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: unrelatedJob.id, text: '天气不错。' }),
    })
    assert.deepEqual(await (await unrelatedChatPromise).json(), { reply: '天气不错。' })

    const diaryRecallPromise = fetch(server.origin + '/live2d/chat', {
      method: 'POST',
      headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ message: '海边捡贝壳好玩吗？' }),
    })
    let diaryRecallResponse
    for (let attempt = 0; attempt < 20; attempt++) {
      diaryRecallResponse = await fetch(server.origin + '/live2d/chat/next', { headers: adapterAuth })
      if (diaryRecallResponse.status === 200) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(diaryRecallResponse.status, 200)
    const diaryRecallJob = await diaryRecallResponse.json()
    assert.match(diaryRecallJob.memory, /海边捡贝壳/)
    await fetch(server.origin + '/live2d/chat/reply', {
      method: 'POST', headers: { ...adapterAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: diaryRecallJob.id, text: '很好玩。' }),
    })
    assert.deepEqual(await (await diaryRecallPromise).json(), { reply: '很好玩。' })

    const config = await fetch(server.origin + '/live2d/config')
    assert.equal(config.status, 200)

    const gameList = await fetch(server.origin + '/live2d/game/list')
    assert.deepEqual(await gameList.json(), {
      games: [{ id: 'gomoku', name: '五子棋', available: true }, { id: 'chess', name: '国际象棋', available: true }],
    })
    const newGame = await fetch(server.origin + '/live2d/game/new', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'gomoku', mode: 'offline', difficulty: 'normal', userTitle: '主人' }),
    })
    assert.equal(newGame.status, 200)
    const openedGame = await newGame.json()
    assert.equal(openedGame.status, 'playing')
    assert.equal(openedGame.mode, 'offline')
    assert.equal(openedGame.game, 'gomoku')
    const firstMove = await fetch(server.origin + '/live2d/game/move', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ x: 7, y: 7 }),
    })
    assert.equal(firstMove.status, 200)
    const movedGame = await firstMove.json()
    assert.equal(movedGame.moves.length, 2)
    assert.deepEqual(movedGame.moves[0], { x: 7, y: 7, side: 1 })
    assert.equal(movedGame.moves[1].side, 2)
    assert.ok(movedGame.aiMove && typeof movedGame.aiMove.x === 'number')

    // 国际象棋离线冒烟：开局 → e2e4 → AI 应手 → 合法走子下发
    const newChess = await fetch(server.origin + '/live2d/game/new', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'chess', mode: 'offline', difficulty: 'normal', userTitle: '主人' }),
    })
    assert.equal(newChess.status, 200)
    const openedChess = await newChess.json()
    assert.equal(openedChess.status, 'playing')
    assert.equal(openedChess.game, 'chess')
    assert.equal(openedChess.turn, 'w')
    assert.equal(openedChess.legal.length, 20)   // 初始 20 手
    const chessMove = await fetch(server.origin + '/live2d/game/move', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ from: { x: 4, y: 6 }, to: { x: 4, y: 4 } }),   // e2e4
    })
    assert.equal(chessMove.status, 200)
    const movedChess = await chessMove.json()
    assert.equal(movedChess.turn, 'w')           // AI 黑方已应手，又轮到白
    assert.ok(movedChess.aiMove?.from && movedChess.aiMove?.to)
    const illegalChess = await fetch(server.origin + '/live2d/game/move', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ from: { x: 4, y: 6 }, to: { x: 4, y: 2 } }),   // e2e5 非法（e2 已无兵）
    })
    assert.equal(illegalChess.status, 400)

    const denied = await fetch(server.origin + '/live2d/state', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'working' }),
    })
    assert.equal(denied.status, 403)

    const adapterDenied = await fetch(adapter.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'codex', sessionId: 's1', state: 'working' }),
    })
    assert.equal(adapterDenied.status, 403)

    const adapterAllowed = await fetch(adapter.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${adapter.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'codex', sessionId: 's1', state: 'working', text: '正在修改文件…' }),
    })
    assert.equal(adapterAllowed.status, 200)
    const adapterFrame = await adapterAllowed.json()
    assert.equal(adapterFrame.state, 'working')
    assert.equal(adapterFrame.message.text, '正在修改文件…')
    assert.deepEqual(adapterFrame.sessions, [{ n: 1, source: 'codex', state: 'working' }])

    await fetch(adapter.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${adapter.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'codex', sessionId: 's1', remove: true }),
    })

    const hiddenThinking = await fetch(adapter.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${adapter.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'opencode', sessionId: 'hidden-game-turn', state: 'thinking', hidden: true }),
    })
    assert.equal(hiddenThinking.status, 200)
    const hiddenFrame = await hiddenThinking.json()
    assert.equal(hiddenFrame.state, 'thinking')
    assert.deepEqual(hiddenFrame.sessions, [])
    await fetch(adapter.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${adapter.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'opencode', sessionId: 'hidden-game-turn', remove: true }),
    })
    const hookOutput = await runHook(path.join(__dirname, 'adapters', 'codex-hook.cjs'), {
      hook_event_name: 'Stop', session_id: 'hook-session', last_assistant_message: '**已经完成**\n```js\nsecret code\n```',
    }, { L2D_ADAPTER_FILE: adapterFile })
    assert.deepEqual(JSON.parse(hookOutput), {})
    const afterHook = await fetch(server.origin + '/live2d/state')
    assert.equal((await afterHook.json()).state, 'done')

    await fetch(adapter.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${adapter.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'codex', sessionId: 'hook-session', remove: true }),
    })
    const oldAdapterFile = process.env.L2D_ADAPTER_FILE
    process.env.L2D_ADAPTER_FILE = adapterFile
    const pluginModule = await import(pathToFileURL(path.join(__dirname, 'adapters', 'opencode-live2d.js')).href)
    const mockCalls = []
    let mockPromptText = '桌宠收到啦。'
    let mockMemoryReply = 'select'
    const plugin = await pluginModule.Live2DCompanion({ client: { session: {
      create: async (input) => {
        mockCalls.push(['create', input])
        const id = input.body.title.includes('游戏') ? 'companion-game-session'
          : input.body.title.includes('记忆筛选') ? 'companion-memory-session'
            : input.body.title.includes('记忆提炼') ? 'companion-extract-session'
            : 'companion-chat-session'
        return { data: { id } }
      },
      prompt: async (input) => {
        mockCalls.push(['prompt', input])
        let text = mockPromptText
        if (input.path.id === 'companion-memory-session') {
          if (mockMemoryReply === 'invalid') text = 'not-json'
          else {
            const prompt = input.body.parts[0].text
            const material = prompt.split('<memory-candidates>\n')[1]?.split('\n</memory-candidates>')[0] || ''
            const matching = material.split(/\n\n(?=\[M\d+\]\n)/).find(block => block.includes('一起下棋') || block.includes('下围棋')) || ''
            const id = matching.match(/^\[(M\d+)\]/)?.[1]
            text = JSON.stringify({ ids: id ? [id] : [] })
          }
        } else if (input.path.id === 'companion-extract-session') {
          text = JSON.stringify({ memories: [
            { category: 'preference', content: '用户喜欢陶艺。', matchId: null, reason: '稳定偏好' },
            { category: 'event', content: '用户后来更喜欢和桌宠下围棋。', matchId: memoryIndex[0].id, reason: '更新已有事件' },
          ] })
        }
        return { data: { parts: [{ type: 'text', text }] } }
      },
      delete: async (input) => { mockCalls.push(['delete', input]); return { data: true } },
    } } })
    await plugin.event({ event: { type: 'session.created', properties: { sessionID: 'oc1' } } })
    const afterOpenCodeStart = await fetch(server.origin + '/live2d/state')
    assert.equal((await afterOpenCodeStart.json()).state, 'thinking')
    await plugin.event({ event: { type: 'message.part.updated', properties: { sessionID: 'oc1', part: { type: 'text', text: 'OpenCode 完成测试' } } } })
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'oc1' } } })
    const afterOpenCodeDone = await fetch(server.origin + '/live2d/state')
    assert.equal((await afterOpenCodeDone.json()).state, 'done')

    const pluginChatPromise = fetch(server.origin + '/live2d/chat', {
      method: 'POST',
      headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ message: '测试插件聊天' }),
    })
    const pluginChatResult = await Promise.race([
      pluginChatPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('OpenCode plugin chat timed out')), 3500)),
    ])
    assert.equal(pluginChatResult.status, 200)
    assert.deepEqual(await pluginChatResult.json(), { reply: '桌宠收到啦。' })
    assert.equal(mockCalls[0][0], 'create')
    assert.equal(mockCalls[1][0], 'prompt')
    assert.equal(mockCalls[1][1].body.agent, 'live2d-companion')
    assert.match(mockCalls[1][1].body.parts[0].text, /companion-persona/)
    assert.match(mockCalls[1][1].body.parts[0].text, /用于测试的更新后桌宠/)
    assert.match(mockCalls[1][1].body.parts[0].text, /测试插件聊天$/)

    // 独立版 OpenCode 解说：本地 AI 走子，独立桌宠游戏会话只返回人格化台词。
    const onlineGame = await fetch(server.origin + '/live2d/game/new', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'gomoku', mode: 'online', difficulty: 'normal', userTitle: '主人' }),
    })
    assert.equal(onlineGame.status, 200)
    assert.equal((await onlineGame.json()).mode, 'online')
    const onlineMove = await Promise.race([
      fetch(server.origin + '/live2d/game/move', {
        method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ x: 7, y: 7 }),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('OpenCode game commentary timed out')), 5000)),
    ])
    assert.equal(onlineMove.status, 200)
    const commentedGame = await onlineMove.json()
    assert.equal(commentedGame.commentary.at(-1).text, '桌宠收到啦。')
    assert.equal(mockCalls[2][0], 'create')
    assert.equal(mockCalls[2][1].body.title, '桌宠游戏解说')
    assert.equal(mockCalls[3][0], 'prompt')
    assert.equal(mockCalls[3][1].path.id, 'companion-game-session')
    assert.equal(mockCalls[3][1].body.agent, 'live2d-companion')
    assert.match(mockCalls[3][1].body.parts[0].text, /只回复一句/)
    let afterGameTurnState = 'thinking'
    for (let attempt = 0; attempt < 20 && afterGameTurnState === 'thinking'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      afterGameTurnState = (await (await fetch(server.origin + '/live2d/state')).json()).state
    }
    assert.equal(afterGameTurnState, 'done')

    // 游戏台词由程序强制限制为一句、40 字；OpenCode 内部步骤总结必须被丢弃并回退本地台词。
    const emptyPoint = () => {
      const used = new Set(commentedGame.moves.map(move => `${move.x},${move.y}`))
      for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) if (!used.has(`${x},${y}`)) return { x, y }
      throw new Error('no empty point')
    }
    mockPromptText = '这是一句故意写得特别特别特别特别特别特别特别特别特别特别特别特别长的游戏台词。后面这句不该显示。'
    const longMove = await fetch(server.origin + '/live2d/game/move', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' }, body: JSON.stringify(emptyPoint()),
    })
    assert.equal(longMove.status, 200)
    const longCommentedGame = await longMove.json()
    assert.ok(longCommentedGame.commentary.at(-1).text.length <= 40)
    assert.doesNotMatch(longCommentedGame.commentary.at(-1).text, /后面这句/)
    commentedGame.moves = longCommentedGame.moves
    mockPromptText = 'CRITICAL - MAXIMUM STEPS REACHED. Summarize current work and remaining tasks. 最大步骤数已达到。'
    const filteredMove = await fetch(server.origin + '/live2d/game/move', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' }, body: JSON.stringify(emptyPoint()),
    })
    assert.equal(filteredMove.status, 200)
    const filteredGame = await filteredMove.json()
    assert.doesNotMatch(filteredGame.commentary.at(-1).text, /最大步骤|剩余任务|当前工作/)

    mockPromptText = '桌宠收到啦。'
    const diarySummary = await Promise.race([
      fetch(server.origin + '/live2d/diary/summarize', {
        method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', text: '今天一起下棋了' }, { role: 'assistant', text: '我玩得很开心。' }] }),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('OpenCode diary summary timed out')), 5000)),
    ])
    assert.equal(diarySummary.status, 200)
    assert.equal((await diarySummary.json()).summary, '桌宠收到啦。')
    assert.equal(mockCalls[6][0], 'create')
    assert.equal(mockCalls[6][1].body.title, '桌宠日记整理')
    assert.equal(mockCalls[7][0], 'prompt')
    assert.equal(mockCalls[7][1].body.agent, 'live2d-companion')
    assert.match(mockCalls[7][1].body.parts[0].text, /今天一起下棋了/)

    const diarySave = await fetch(server.origin + '/live2d/diary/save', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ summary: '今天测试了通用角色档案。' }),
    })
    assert.equal(diarySave.status, 200)
    const diaryResult = await diarySave.json()
    assert.equal(diaryResult.profileId, profileId)
    const diaryDir = path.join(dataDir, 'profiles', profileId, 'diaries')
    assert.ok(fs.readdirSync(diaryDir).some(name => name.endsWith('.md')))

    const diaryList = await fetch(server.origin + '/live2d/diary/list', { headers: browserAuth }).then(r => r.json())
    assert.equal(diaryList.diaries.length, 1)
    assert.equal(diaryList.diaries[0].processed, false)

    const extraction = await Promise.race([
      fetch(server.origin + '/live2d/diary/extract-memory', {
        method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ profileId, files: [diaryResult.file] }),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('OpenCode memory extraction timed out')), 5000)),
    ])
    assert.equal(extraction.status, 200)
    const extracted = await extraction.json()
    assert.equal(extracted.alreadyProcessed, false)
    assert.deepEqual(extracted.diaryFiles, [diaryResult.file])
    assert.equal(extracted.candidates.length, 2)
    assert.equal(extracted.candidates[0].matchId, null)
    assert.equal(extracted.candidates[1].matchId, memoryIndex[0].id)
    assert.match(extracted.candidates[1].existing.content, /一起下棋/)
    const extractionPrompt = mockCalls.find(call => call[0] === 'prompt' && call[1].path.id === 'companion-extract-session')
    assert.match(extractionPrompt[1].body.parts[0].text, /不要替用户决定是否覆盖/)

    const memoryCommit = await fetch(server.origin + '/live2d/memory/commit', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: extracted.profileId, sourceHashes: extracted.sourceHashes, items: [
        { action: 'add', category: extracted.candidates[0].category, content: extracted.candidates[0].content },
        { action: 'replace', category: extracted.candidates[1].category, content: extracted.candidates[1].content,
          replaceId: extracted.candidates[1].matchId },
      ] }),
    })
    assert.equal(memoryCommit.status, 200)
    const committed = await memoryCommit.json()
    assert.equal(committed.added, 1)
    assert.equal(committed.replaced, 1)
    const updatedIndex = JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles', profileId, 'memories', 'index.json'), 'utf8'))
    assert.equal(updatedIndex.length, 2)
    const replacedEntry = updatedIndex.find(item => item.id === memoryIndex[0].id)
    assert.match(fs.readFileSync(path.join(dataDir, 'profiles', profileId, 'memories', replacedEntry.file), 'utf8'), /更喜欢和桌宠下围棋/)

    const repeatedExtraction = await fetch(server.origin + '/live2d/diary/extract-memory', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ profileId, files: [diaryResult.file] }),
    })
    assert.equal(repeatedExtraction.status, 200)
    assert.equal((await repeatedExtraction.json()).alreadyProcessed, true)
    const processedDiaryList = await fetch(server.origin + '/live2d/diary/list', { headers: browserAuth }).then(r => r.json())
    assert.equal(processedDiaryList.diaries[0].processed, true)

    const activeBeforeSemantic = await fetch(server.origin + '/live2d/companion-profiles', { headers: browserAuth }).then(r => r.json())
    const enableSemantic = await fetch(server.origin + '/live2d/companion-profiles', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ ...activeBeforeSemantic.active, memoryProvider: 'opencode' }),
    })
    assert.equal((await enableSemantic.json()).active.memoryProvider, 'opencode')
    const semanticCallStart = mockCalls.length
    const semanticChat = await Promise.race([
      fetch(server.origin + '/live2d/chat', {
        method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ message: '棋盘上的对局还记得吗？' }),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('OpenCode semantic memory timed out')), 5000)),
    ])
    assert.equal(semanticChat.status, 200)
    assert.deepEqual(await semanticChat.json(), { reply: '桌宠收到啦。' })
    const semanticCalls = mockCalls.slice(semanticCallStart)
    const rerankPrompt = semanticCalls.find(call => call[0] === 'prompt' && call[1].path.id === 'companion-memory-session')
    assert.ok(rerankPrompt)
    assert.match(rerankPrompt[1].body.parts[0].text, /棋盘上的对局/)
    assert.ok(semanticCalls.some(call => call[0] === 'delete' && call[1].path.id === 'companion-memory-session'))
    const semanticAnswer = semanticCalls.find(call => call[0] === 'prompt' && call[1].path.id === 'companion-chat-session')
    assert.ok(semanticAnswer)
    assert.match(semanticAnswer[1].body.parts[0].text, /下围棋/)

    mockMemoryReply = 'invalid'
    const semanticProfile = await fetch(server.origin + '/live2d/companion-profiles', { headers: browserAuth }).then(r => r.json())
    await fetch(server.origin + '/live2d/companion-profiles', {
      method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify(semanticProfile.active),
    })
    const fallbackCallStart = mockCalls.length
    const fallbackChat = await Promise.race([
      fetch(server.origin + '/live2d/chat', {
        method: 'POST', headers: { ...browserAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ message: '还记得我们下围棋吗？' }),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('OpenCode memory fallback timed out')), 5000)),
    ])
    assert.equal(fallbackChat.status, 200)
    const fallbackCalls = mockCalls.slice(fallbackCallStart)
    const fallbackAnswer = fallbackCalls.find(call => call[0] === 'prompt' && call[1].path.id === 'companion-chat-session')
    assert.match(fallbackAnswer[1].body.parts[0].text, /下围棋/)
    if (oldAdapterFile === undefined) delete process.env.L2D_ADAPTER_FILE
    else process.env.L2D_ADAPTER_FILE = oldAdapterFile

    const allowed = await fetch(server.origin + '/live2d/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie.split(';')[0] },
      body: JSON.stringify({ state: 'working' }),
    })
    assert.equal(allowed.status, 200)
    assert.equal((await allowed.json()).state, 'working')

    const current = await fetch(server.origin + '/live2d/state')
    assert.deepEqual(await current.json(), { state: 'working' })

    const models = await fetch(server.origin + '/live2d/models')
    assert.ok((await models.json()).models.some(item => item.path === 'test-model/test.model3.json'))
    process.stdout.write('standalone server smoke test: ok\n')
  } finally {
    await server.close()
    assert.equal(fs.existsSync(adapterFile), false)
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
