// passthrough.cjs 决策状态机离线验证（第六轮回迁版——/tmp 被重启清空后重写并入库）。
// 覆盖：一~三轮语义回归 + 第四轮（命中校验/稳态重申/冻结正向证据/reassert）+
// 第五轮（安全态重申）+ 第六轮（振荡环三断点/toggle-through 重申/安全态入态愈合/态内校验）。
// 用法：node pet/passthrough-verify.mjs
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createPassthrough } = require('./passthrough.cjs')

let passed = 0, failed = 0
const assert = (cond, label) => { if (cond) { passed++; console.log('  ✓ ' + label) } else { failed++; console.log('  ✗ FAIL: ' + label) } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function make(tuning) {
  const applied = []
  const logs = []
  const p = createPassthrough({
    apply: (ignore) => applied.push(ignore),
    notify: (s) => { p.lastNotify = s },
    log: (...a) => logs.push(a.join(' ')),
    debug: () => { },
    wiggle: () => { p.wiggles = (p.wiggles ?? 0) + 1 },
  }, tuning)
  p.applied = applied
  p.logs = logs
  return p
}
const R = (x, y, w, h) => ({ x, y, w, h })
const wait = async (p, ms, x = 500, y = 500) => { await sleep(ms); p.tick(x, y, false) }

;(async () => {
  // ① 空矩形集：恒穿透（首 tick 冷启动重申=穿透）
  {
    const p = make()
    p.setRects({ model: null, ui: [], pinned: false, dragging: false })
    p.tick(500, 500, true); await wait(p, 300)
    assert(p.applied.every(a => a === true) && !p.lastNotify?.interactive, '① 空矩形集恒穿透且无翻转通知')
  }

  // ② 模型区停留 600ms 放行，出框滞回回收
  {
    const p = make()
    p.setRects({ model: R(400, 400, 200, 200), ui: [], pinned: false, dragging: false })
    p.tick(500, 500, true)
    await wait(p, 300)
    assert(p.lastNotify?.interactive !== true, '②a 停留 300ms 未放行')
    await wait(p, 500)
    assert(p.lastNotify?.interactive === true && p.applied.includes(false), '②b 停留满 600ms 放行')
    p.tick(900, 900, true)
    assert(p.lastNotify?.interactive === false && p.applied.includes(true), '②c 出框立即回收穿透')
  }

  // ③ 位移超 24px 重新计时
  {
    const p = make()
    p.setRects({ model: R(400, 400, 200, 200), ui: [], pinned: false, dragging: false })
    p.tick(500, 500, true); await wait(p, 400)
    p.tick(600, 500, true); await wait(p, 300, 600, 500)
    assert(p.lastNotify?.interactive !== true, '③ 位移超阈值后 300ms 未放行（计时已重启）')
    await wait(p, 500, 600, 500)
    assert(p.lastNotify?.interactive === true, '③b 重新计时期满放行')
  }

  // ④ 优先级：UI 即时 / pinned 恒穿透 / 死区优先
  {
    const p = make()
    p.setRects({ model: R(400, 400, 200, 200), ui: [R(700, 700, 50, 50)], pinned: false, dragging: false })
    p.tick(720, 720, true)
    assert(p.lastNotify?.interactive === true, '④a UI 矩形即时放行')
    const q = make()
    q.setRects({ model: R(400, 400, 200, 200), ui: [], pinned: true, dragging: false })
    q.tick(500, 500, true); await wait(q, 900)
    assert(q.lastNotify?.interactive !== true, '④b pinned 模型区恒穿透')
    const s = make()
    s.setRects({ model: R(400, 400, 200, 200), ui: [], pinned: false, dragging: false })
    s.setCardAreas([R(400, 400, 200, 200)])
    s.tick(500, 500, true); await wait(s, 900)
    assert(s.lastNotify?.interactive !== true, '④c 卫星窗死区优先于模型区')
  }

  // ⑤ dragging 冻结判定
  {
    const p = make()
    p.setRects({ model: R(400, 400, 200, 200), ui: [], pinned: false, dragging: true })
    p.tick(500, 500, true); await wait(p, 900)
    assert(p.lastNotify?.interactive !== true && p.applied.every(a => a === true), '⑤ dragging 冻结判定')
  }

  // ⑥ 穿透失步被反向核验捕获并重申穿透
  {
    const p = make()
    p.setRects({ model: null, ui: [], pinned: false, dragging: false })
    p.tick(50, 50, true); await wait(p, 600)
    p.heartbeat(Date.now())
    await wait(p, 100, 50, 50)
    p.heartbeat(Date.now())
    p.tick(50, 50, false)
    assert(p.logs.some(l => l.includes('renderer still receives input')), '⑥ 穿透失步被反向核验捕获并重申穿透')
  }

  // ⑦ 正向核验 + 安全态（入态 toggle-through：先反向后回目标）
  {
    const p = make()
    p.setRects({ model: R(400, 400, 200, 200), ui: [], pinned: false, dragging: false })
    p.tick(500, 500, true); await wait(p, 700)
    assert(p.lastNotify?.interactive === true, '⑦a 放行')
    for (let i = 0; i < 3; i++) { p.tick(501 + i, 500, true); await wait(p, 900, 501 + i, 500) }
    assert(p.logs.some(l => l.includes('desync')), '⑦b 宽限期后重申施加（desync 重试）')
    assert(p.logs.some(l => l.includes('safe mode')), '⑦c 连续失步进入安全态')
    const during = p.applied.length
    await wait(p, 500)   // 入态 toggle 300ms 回摆完成
    assert(p.applied[p.applied.length - 1] === true, '⑦d 安全态入态 toggle-through 回到恒穿透（同值写会被去重吞掉）')
    await wait(p, 400)
    assert(p.applied.length === during + 1, '⑦e 安全态内不自动翻转（仅入态 toggle 的一次回摆）')
  }

  // ⑧ 脏数据剔除
  {
    const p = make()
    p.setRects({ model: { x: NaN, y: 0, w: 10, h: 10 }, ui: [R(0, 0, 5, 5), { x: 1, y: 2 }], pinned: 'x', dragging: 1 })
    p.tick(2, 2, true)
    assert(p.lastNotify?.interactive === true, '⑧ 脏 model 被剔除、合法 ui 保留')
  }

  // ⑨ tick 仲裁光标返回与 cursor()（第三轮）
  {
    const p = make()
    p.setRects({ model: R(400, 400, 200, 200), ui: [], pinned: false, dragging: false })
    const r1 = p.tick(123, 456, true)
    assert(r1 && r1.x === 123 && r1.y === 456, '⑨a 无探针时 tick 回传主读数')
    p.externalCursor(700, 800)
    const r2 = p.tick(123, 456, false)
    assert(r2 && r2.x === 700 && r2.y === 800, '⑨b 探针新鲜时 tick 回传外部仲裁源')
    assert(p.cursor()?.x === 700, '⑨c cursor() 访问器=最近仲裁光标')
    await sleep(3100)
    const r3 = p.tick(123, 456, false)
    assert(r3.x === 123 && r3.y === 456, '⑨d 探针过期回退主读数')
  }

  // ⑩ 外部源接管下 dwell 放行（主读数冻结不挡路）
  {
    const p = make()
    p.setRects({ model: R(400, 400, 200, 200), ui: [], pinned: false, dragging: false })
    p.externalCursor(500, 500)
    p.tick(0, 0, false)
    await wait(p, 300, 0, 0)
    assert(p.lastNotify?.interactive !== true, '⑩a 外部源接管 300ms 未放行')
    p.externalCursor(500, 500); await sleep(500); p.tick(0, 0, false)
    p.externalCursor(500, 500)
    p.tick(0, 0, false)
    assert(p.lastNotify?.interactive === true, '⑩b 外部源接管 dwell 满放行（主读数冻结不挡路）')
  }

  // ⑪ X 层命中校验：连续矛盾拍才处置（第四轮）
  {
    const p = make()
    p.setRects({ model: null, ui: [], pinned: false, dragging: false })
    p.tick(50, 50, true); await wait(p, 100)
    const logs0 = p.logs.length
    p.observedHit(true); p.tick(50, 50, false)
    assert(!p.logs.slice(logs0).some(l => l.includes('hit-test')), '⑪a 单拍矛盾不动作（防抖）')
    await sleep(20)
    p.observedHit(true); p.tick(50, 50, false)
    assert(p.logs.slice(logs0).some(l => l.includes('hit-test')), '⑪b 连续矛盾触发失同步处置')
    await wait(p, 500)
    assert(p.applied[p.applied.length - 1] === true, '⑪c 处置后回到穿透施加')
  }

  // ⑫ 读回质量：非本窗不误报 / 过期不采信
  {
    const p = make()
    p.setRects({ model: null, ui: [], pinned: false, dragging: false })
    p.tick(50, 50, true)
    const logs0 = p.logs.length
    p.observedHit(false); p.tick(50, 50, false); await sleep(20)
    p.observedHit(false); p.tick(50, 50, false)
    assert(!p.logs.slice(logs0).some(l => l.includes('hit-test')), '⑫a 读回非本窗不误报')
    await sleep(1600)
    p.observedHit(true)   // 喂入后不 tick，等其过期
    await sleep(1600)
    p.tick(50, 50, false)
    assert(!p.logs.slice(logs0).some(l => l.includes('hit-test')), '⑫b 过期读回不采信')
  }

  // ⑬ 冷启动重申 + 稳态重申（第四轮）
  {
    const p = make()
    p.setRects({ model: null, ui: [], pinned: false, dragging: false })
    const n0 = p.applied.length
    p.tick(50, 50, true)
    assert(p.applied.length > n0 && p.applied[p.applied.length - 1] === true, '⑬a 冷启动首 tick 即重申穿透（盲写失守兜底）')
    await wait(p, 5200)
    assert(p.applied.length >= n0 + 2, '⑬b 5s 稳态重申穿透')
  }

  // ⑭ wiggle 冻结探针正向证据（第二/四轮）
  {
    const p = make({ cursorFreezeMs: 200 })
    p.setRects({ model: null, ui: [], pinned: false, dragging: false })
    p.tick(50, 50, true)
    await sleep(300)
    p.externalCursor(100, 100); p.tick(50, 50, false)   // 外部源也未动
    assert((p.wiggles ?? 0) === 0, '⑭a 主读数静止+外部源静止=真静止，不 wiggle（旧行为回归防护）')
    p.externalCursor(150, 150); await sleep(250)
    p.externalCursor(180, 180); p.tick(50, 50, false)
    assert((p.wiggles ?? 0) === 1, '⑭b 主读数静止+外部源在动=真冻结，wiggle')
  }

  // ⑮ reassert：防抖 + toggle-through（第六轮：同值重申被 Electron 去重吞掉）
  {
    const p = make()
    p.setRects({ model: null, ui: [], pinned: false, dragging: false })
    p.tick(50, 50, true)
    const before = p.applied.length
    p.reassert()
    assert(p.applied.length === before, '⑮a 距上次 apply <300ms 防抖跳过')
    await sleep(400)
    p.reassert()
    assert(p.applied.length === before + 1 && p.applied[before] === false, '⑮b1 防抖期后 toggle-through 反向脉冲')
    await sleep(450)
    assert(p.applied[p.applied.length - 1] === true, '⑮b2 300ms 后回到目标穿透态（与 desync 同规格脉冲）')
  }

  // ⑯ 交互态一侧命中读回不动作
  {
    const p = make()
    p.setRects({ model: R(400, 400, 200, 200), ui: [], pinned: false, dragging: false })
    p.tick(500, 500, true); await wait(p, 700)
    assert(p.lastNotify?.interactive === true, '⑯a 交互态就位')
    p.heartbeat(Date.now())
    const logsBefore = p.logs.length
    p.observedHit(false); p.tick(500, 500, false); await sleep(20)
    p.observedHit(false); p.tick(500, 500, false)
    assert(!p.logs.slice(logsBefore).some(l => l.includes('hit-test')), '⑯b 交互态实测非本窗不误报')
  }

  // ⑰ desync 后静默窗：toggle-through 反向期的真实捕获读数不连锁
  {
    const p = make()
    p.setRects({ model: R(400, 400, 200, 200), ui: [], pinned: false, dragging: false })
    p.tick(50, 50, true)
    p.observedHit(true); p.tick(50, 50, false); await sleep(20)
    p.observedHit(true); p.tick(50, 50, false)
    assert(p.logs.filter(l => l.includes('hit-test')).length === 1, '⑰a 首次失同步触发一次处置')
    await sleep(150); p.observedHit(true); p.tick(50, 50, false)
    await sleep(150); p.observedHit(true); p.tick(50, 50, false)
    assert(p.logs.filter(l => l.includes('hit-test')).length === 1, '⑰b 静默窗内不连锁（反向期捕获是预期）')
    await sleep(700)
    p.observedHit(true); p.tick(50, 50, false); await sleep(20)
    p.observedHit(true); p.tick(50, 50, false)
    assert(p.logs.filter(l => l.includes('hit-test')).length === 2, '⑰c 静默窗过后持续失守再次处置')
  }

  // ⑱ 安全态稳态重申 + 态内 X 层校验兜底（第五/六轮）
  {
    const p = make({ inputGraceMs: 150, reassertMs: 300, safeModeMs: 1500 })
    p.setRects({ model: R(400, 400, 200, 200), ui: [], pinned: false, dragging: false })
    p.tick(500, 500, true); await wait(p, 700)
    for (let i = 0; i < 3; i++) { p.tick(501 + i, 500, true); await wait(p, 400, 501 + i, 500) }
    assert(p.logs.some(l => l.includes('safe mode')), '⑱a 进入安全态')
    await wait(p, 400)   // 入态 toggle 300ms 回摆已完成
    const during = p.applied.length
    await wait(p, 400)   // 超 reassertMs，安全态内应周期续写 apply(true)
    assert(p.applied.length > during && p.applied[p.applied.length - 1] === true, '⑱b 安全态内稳态重申穿透（盲写续写）')
    // 态内命中校验：持续失守 → 强制重发（不计 syncFails）
    const logs0 = p.logs.length
    p.observedHit(true); p.tick(500, 500, false); await sleep(20)
    p.observedHit(true); p.tick(500, 500, false)
    assert(p.logs.slice(logs0).some(l => l.includes('safe mode: X hit-test still lands')), '⑱c 安全态内持续失守触发强制重发')
    await wait(p, 900)   // 累计超 safeModeMs
    p.tick(500, 500, false)
    assert(p.logs.some(l => l.includes('safe mode expired')), '⑱d 安全态到期恢复决策')
  }

  // ⑲ 振荡不成立（第六轮三断点）
  {
    const p = make({ cursorFreezeMs: 200, wiggleQuietMs: 500 })
    p.setRects({ model: null, ui: [], pinned: false, dragging: false })
    p.tick(50, 50, true)
    p.externalCursor(100, 100); await sleep(250)
    p.externalCursor(130, 130); p.tick(100, 100, false)
    assert(p.wiggles === 1, '⑲a0 冻结探针点火 wiggle')
    const logsAtWiggle = p.logs.length
    p.observedHit(true); p.tick(130, 130, false); await sleep(20)
    p.observedHit(true); p.tick(130, 130, false)
    assert(!p.logs.slice(logsAtWiggle).some(l => l.includes('hit-test')), '⑲a wiggle 自残静默窗内不累计 desync')
    await sleep(550)
    p.observedHit(true); p.tick(130, 130, false); await sleep(20)
    p.observedHit(true); p.tick(130, 130, false)
    assert(p.logs.slice(logsAtWiggle).some(l => l.includes('hit-test')), '⑲a2 静默窗过后命中校验照常工作')
  }
  {
    const p = make({ cursorFreezeMs: 150, wiggleFailLimit: 3 })
    p.setRects({ model: null, ui: [], pinned: false, dragging: false })
    p.tick(50, 50, true)
    for (let i = 0; i < 4; i++) {
      p.externalCursor(200 + i * 10, 200); await sleep(200)
      p.externalCursor(210 + i * 10, 200); p.tick(200, 200, false)
    }
    assert(p.wiggles === 2 && p.logs.some(l => l.includes('wiggle ineffective')), '⑲b 连续无效达限后 wiggle 停用（前 2 次有效，第 3 次起禁）')
  }
  {
    // 疗效清零只认静默窗外真解冻（金丝雀实证漏洞：捕获窗内短暂解冻反复清零）
    const p = make({ cursorFreezeMs: 150, wiggleFailLimit: 3, wiggleQuietMs: 600 })
    p.setRects({ model: null, ui: [], pinned: false, dragging: false })
    p.tick(50, 50, true)
    p.externalCursor(300, 300); await sleep(200)
    p.externalCursor(310, 300); p.tick(300, 300, false)   // fire#1 → wiggle
    assert(p.wiggles === 1, '⑲b2a fire#1 wiggle')
    p.tick(301, 300, true)   // 静默窗内的主读数移动（捕获窗事件流入）——不得清零
    await sleep(200)
    p.externalCursor(320, 300); p.tick(300, 300, false)   // fire#2（若被清零则仍是第 1 次）
    p.externalCursor(330, 300); await sleep(200)
    p.externalCursor(340, 300); p.tick(300, 300, false)   // fire#3 → 达限停用
    assert(p.logs.some(l => l.includes('wiggle ineffective')), '⑲b2 静默窗内解冻不清零，疗效计数正常达限停用')
  }
  {
    const p = make({ syncFailLimit: 1, safeModeMs: 200, safeModeCapMs: 1600, safeBackoffWindowMs: 1000, cursorFreezeMs: 200, inputGraceMs: 150 })
    p.setRects({ model: null, ui: [], pinned: false, dragging: false })
    p.tick(50, 50, true)
    p.observedHit(true); p.tick(50, 50, false); await sleep(20)
    p.observedHit(true); p.tick(50, 50, false)
    assert(p.snapshot().safeMode === true && p.logs.some(l => l.includes('level 0')), '⑲c0 首次进安全态 level 0')
    await sleep(260); p.tick(50, 50, false)
    assert(p.snapshot().safeMode === false, '⑲c1 安全态到期退出')
    const wigglesAtExit = p.wiggles ?? 0
    p.externalCursor(300, 300); p.tick(50, 50, false)
    assert((p.wiggles ?? 0) === wigglesAtExit, '⑲d 安全态退出 hysteresis：不立即 wiggle')
    await sleep(650)
    p.observedHit(true); p.tick(50, 50, false); await sleep(20)
    p.observedHit(true); p.tick(50, 50, false)
    assert(p.logs.some(l => l.includes('level 1')), '⑲c2 退避窗口内再进安全态升 level 1（时长 ×2）')
    await sleep(260); p.tick(50, 50, false)
    assert(p.snapshot().safeMode === true, '⑲c3 退避后时长确实翻倍（260ms 时仍在安全态）')
  }

  // ⑳ forceReapply 平台分派（Windows 兼容批次）：win32 直写一次到位，linux 保持 toggle-through
  {
    const realPlatform = process.platform
    // process.platform 是 configurable 的只读属性：改写后立即回读自证生效，
    // mock 失效时本组必然红（绝不允许「没真改却假绿」）
    const setPlatform = (value) => {
      Object.defineProperty(process, 'platform', { value, configurable: true })
      if (process.platform !== value) throw new Error(`process.platform mock failed (wanted ${value}, got ${process.platform})`)
    }
    try {
      // ── win32：直写，无反向脉冲（反向会凭空真实放行鼠标 ~300ms）──
      setPlatform('win32')
      const w = make()
      w.setRects({ model: null, ui: [], pinned: false, dragging: false })
      w.tick(50, 50, true)                       // 冷启动重申穿透，interState=false → target=true
      const n0 = w.applied.length
      w.reassertNow()
      assert(w.applied.length === n0 + 1 && w.applied[n0] === true, '⑳a win32 强制重申直写一次到位（无 toggle 反向脉冲）')
      await sleep(450)                           // 反向脉冲若存在会在 300ms 落地
      assert(w.applied.length === n0 + 1, '⑳b win32 无 300ms 回摆（直写不挂定时器）')

      // ── win32 交互态一侧：目标 false 同样直写，不得出现 apply(true) 脉冲 ──
      const w2 = make()
      w2.setRects({ model: R(400, 400, 200, 200), ui: [], pinned: false, dragging: false })
      w2.tick(500, 500, true)
      await wait(w2, 700)                        // 停留满 600ms 放行 → interState=true
      assert(w2.lastNotify?.interactive === true, '⑳c win32 交互态就位')
      const m0 = w2.applied.length
      w2.reassertNow()
      assert(w2.applied.length === m0 + 1 && w2.applied[m0] === false, '⑳d win32 交互态重申直写 apply(false)，无穿透脉冲')
      await sleep(450)
      assert(w2.applied.length === m0 + 1, '⑳e win32 交互态同样无回摆')

      // ── linux：toggle-through 语义原样保持（先反向脉冲，300ms 后回目标）──
      setPlatform('linux')
      const l = make()
      l.setRects({ model: null, ui: [], pinned: false, dragging: false })
      l.tick(50, 50, true)
      const k0 = l.applied.length
      l.reassertNow()
      assert(l.applied.length === k0 + 1 && l.applied[k0] === false, '㉑a linux 强制重申先发反向脉冲（toggle-through 不变）')
      await sleep(450)
      assert(l.applied.length === k0 + 2 && l.applied[k0 + 1] === true, '㉑b linux 300ms 后回目标穿透态（toggle-through 不变）')
    } finally {
      setPlatform(realPlatform)                  // 恢复真实平台，后续/外部行为不受污染
    }
    assert(process.platform === realPlatform, '㉑c 平台 mock 已复原')
  }

  console.log(`\n结果：${passed} 通过, ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
})()
