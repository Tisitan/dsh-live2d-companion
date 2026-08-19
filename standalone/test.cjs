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
  assert.match(mainSource, /l2d-game-open/)
  assert.match(mainSource, /cardGameId/)
  assert.match(mainSource, /cardExpectedSize/)
  assert.match(mainSource, /useContentSize:\s*true/)
  assert.match(mainSource, /hasShadow:\s*false/)
  assert.match(mainSource, /cardWin\.setBounds/)
  assert.match(preloadSource, /openGame/)
  assert.match(preloadSource, /getCardArea/)
  assert.match(cardPreloadSource, /l2d-game-close/)
  assert.match(cardPreloadSource, /l2d-game-moveby/)

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
    const gameCardPage = await fetch(server.origin + '/live2d/game-card.html')
    assert.equal(gameCardPage.status, 200)
    const gameCardScript = await fetch(server.origin + '/live2d/game-card.js')
    assert.equal(gameCardScript.status, 200)
    assert.match(await gameCardScript.text(), /requestedGame/)

    const chatStatusBefore = await fetch(server.origin + '/live2d/chat/status')
    assert.deepEqual(await chatStatusBefore.json(), { connected: false })
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
    assert.deepEqual(await chatStatusAfter.json(), { connected: true })

    const chatPromise = fetch(server.origin + '/live2d/chat', {
      method: 'POST',
      headers: { ...browserAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Nori，在吗？' }),
    })
    let chatJobResponse
    for (let attempt = 0; attempt < 20; attempt++) {
      chatJobResponse = await fetch(server.origin + '/live2d/chat/next', { headers: adapterAuth })
      if (chatJobResponse.status === 200) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(chatJobResponse.status, 200)
    const chatJob = await chatJobResponse.json()
    assert.equal(chatJob.message, 'Nori，在吗？')
    const chatReply = await fetch(server.origin + '/live2d/chat/reply', {
      method: 'POST',
      headers: { ...adapterAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: chatJob.id, text: '在哦。Nori一直在这里。' }),
    })
    assert.equal(chatReply.status, 200)
    const chatResult = await chatPromise
    assert.equal(chatResult.status, 200)
    assert.deepEqual(await chatResult.json(), { reply: '在哦。Nori一直在这里。' })

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
    let mockPromptText = 'Nori收到啦。'
    const plugin = await pluginModule.Live2DCompanion({ client: { session: {
      create: async (input) => {
        mockCalls.push(['create', input])
        return { data: { id: input.body.title.includes('游戏') ? 'nori-game-session' : 'nori-chat-session' } }
      },
      prompt: async (input) => { mockCalls.push(['prompt', input]); return { data: { parts: [{ type: 'text', text: mockPromptText }] } } },
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
    assert.deepEqual(await pluginChatResult.json(), { reply: 'Nori收到啦。' })
    assert.equal(mockCalls[0][0], 'create')
    assert.equal(mockCalls[1][0], 'prompt')
    assert.equal(mockCalls[1][1].body.agent, 'nori')
    assert.equal(mockCalls[1][1].body.parts[0].text, '测试插件聊天')

    // 独立版 OpenCode 解说：本地 AI 走子，独立 Nori 游戏会话只返回人格化台词。
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
    assert.equal(commentedGame.commentary.at(-1).text, 'Nori收到啦。')
    assert.equal(mockCalls[2][0], 'create')
    assert.equal(mockCalls[2][1].body.title, 'Nori 游戏解说')
    assert.equal(mockCalls[3][0], 'prompt')
    assert.equal(mockCalls[3][1].path.id, 'nori-game-session')
    assert.equal(mockCalls[3][1].body.agent, 'nori')
    assert.match(mockCalls[3][1].body.parts[0].text, /只回复一句/)

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

    const auth = browserAuth
    const imported = await fetch(server.origin + '/live2d/import?model=test-model&path=test.model3.json', {
      method: 'POST', headers: auth, body: JSON.stringify({ FileReferences: {} }),
    })
    assert.equal(imported.status, 200)

    const models = await fetch(server.origin + '/live2d/models')
    assert.ok((await models.json()).models.some(item => item.path === 'test-model/test.model3.json'))

    const selected = await fetch(server.origin + '/live2d/model', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model/test.model3.json' }),
    })
    assert.equal(selected.status, 200)
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
