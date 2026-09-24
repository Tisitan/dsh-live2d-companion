'use strict'
// 穿透单源决策状态机（Linux/X11 input-shape 失同步根治）。
//
// 背景：setIgnoreMouseEvents 是盲写（Electron 无读回），X11 下 input-shape
// 偶发与主进程认知失同步，渲染层事件驱动的旧状态机在穿透态收不到任何 DOM
// 事件，双向卡死无法自愈。改造后渲染层只上报「交互矩形集」（模型包围盒+48px
// ∪ 可命中 UI 矩形 ∪ pinned/dragging 标志），本模块以 OS 光标位置比对矩形集
// 产出应处交互态并驱动 setIgnoreMouseEvents——判定不再依赖任何 DOM 事件到达。
//
// 语义与原渲染层状态机（interact.js 旧 evalIgnore）等价：
//   卫星窗死区恒穿透 > UI 矩形即时可点 > pinned 恒穿透 >
//   模型矩形停留 600ms（位移<24px）放行 / 出框滞回回收。
//
// 看门狗（三重 + X 层命中校验 + 稳态重申 + 冻结探针）：
//   a) 行为核验——交互态下光标移动后须在宽限内看到渲染层真实输入到达
//      （心跳上报的时间戳），缺失即重申施加；穿透态下渲染层仍持续收输入
//      同为失同步证据，反向重申施加。宽限按平台分治（Linux 700ms /
//      非 Linux 2500ms）：证据唯一通道是渲染层心跳（周期 2000ms），
//      宽限必须大于心跳周期，否则结构性误报——详见 INPUT_GRACE_MS_LINUX 注释；
//   b) 拖拽冻结由渲染层 dragging 标志驱动，渲染层自带 30s 悬挂强制收尾；
//   c) 连续 3 次失同步进入安全态（恒穿透 60s，防全屏捕获输入），到期自动
//      重试恢复，再失步则重进；
//   d) 光标读数冻结探针——Electron Linux/X11 实证 screen.getCursorScreenPoint()
//      会进程内冻结（读数来自 Chromium 事件流缓存，窗口穿透收不到事件即停更；
//      X 服务器侧实际位置正常）。窗口 Configure 事件（1px 微移）实证可解冻，
//      但移动会重置穿透态（第四轮实证），故触发必须持正向证据：
//      主读数静止超阈值且外部探针在动，二者缺一不 wiggle；
//   e) X 层命中校验——宿主探针喂入的光标命中读回（observedHit）与认知态比对，
//      「认知穿透但实测命中本窗」连续 2 拍即失同步铁证，与渲染层是否在位解耦；
//   f) 稳态重申——距上次 apply 超 5s 即同值重申（启动期盲写丢失/窗口移动重置/
//      API 失效等未观测失守的终极兜底）；窗口 move/resize 事件经 reassert() 即时重申。
//
// pet/main.js 与 standalone/main.cjs 共用本模块，保证两形态行为一致。

/** 停留放行阈值：模型上静止 ≥600ms 且位移 ≤24px 才放行交互（看视频路过不黑屏）。 */
const DWELL_MS = 600
const DWELL_SLACK = 24
/** 行为核验宽限（Linux/X11）：交互态下光标移动后等待渲染层输入证据的时间。
 *  收紧有利及早捕获真失同步——Linux 侧有 X 层命中读回作为独立第二通道，且
 *  forceReapply 的 toggle-through 真能愈合（实验室实测 hover 期失同步 1 次捕获即自愈）。 */
const INPUT_GRACE_MS_LINUX = 700
/** 行为核验宽限（非 Linux：win32/darwin）。
 *  **120 Windows 实测证据（2026-09-24）**：输入证据的唯一通道是渲染层心跳
 *  `public/src/interact.js` 的 `setInterval(heartbeat, 2000)`，700ms 宽限 < 2000ms 心跳周期
 *  = **结构性误报**（宽限内根本等不到下一拍心跳）。Windows 上 forceReapply 是直写
 *  （无反向脉冲可愈合，见下方平台分派），但 syncFails 照常累加 → 3 次进安全态恒穿透
 *  60s/120s 退避，桌宠点不动（实测复现两轮）。
 *  放宽无代价：Windows 无 X11 input-shape 失同步病，本核验在 win32 上只是兜底，
 *  多等的 1.8s 不会漏掉任何需要处置的失同步（真实失同步另有稳态重申 5s 兜底）。
 *  ⚠️ 心跳周期（interact.js 的 2000ms）若未来改动，必须同步复核本常量。 */
const INPUT_GRACE_MS_NON_LINUX = 2500
/** 按平台取行为核验宽限。调用时求值而非模块加载时求值：离线验证需在同一进程内
 *  mock process.platform 后新建决策器来覆盖两条分支（模块级常量会被加载期固化）。 */
const defaultInputGraceMs = () => (process.platform === 'linux' ? INPUT_GRACE_MS_LINUX : INPUT_GRACE_MS_NON_LINUX)
/** 反向核验静默期：施加穿透后等待 X11 input-shape 生效的时间。 */
const PASS_QUIET_MS = 500
/** 反向核验余波窗：施加穿透瞬间仍在途/队列中的输入不算失效证据（X11 shape 异步生效）。 */
const PASS_ECHO_MS = 400
/** 连续失同步次数上限，达到即进安全态。 */
const SYNC_FAIL_LIMIT = 3
/** 安全态持续时长：到期自动重试恢复正常决策。 */
const SAFE_MODE_MS = 60000
/** 光标读数冻结嫌疑阈值：主读数静止超该时长且外部探针在动（冻结正向证据）才触发 wiggle。 */
const CURSOR_FREEZE_MS = 60000
/** 稳态重申间隔：距上次 apply 超此时长即同值重申（覆盖启动期盲写丢失/窗口移动重置等
 *  一切未被观测到的 X 层失守；同值重申幂等无害）。 */
const REASSERT_MS = 5000
/** X 层命中读回的新鲜度上限：超期不采信（光标在副屏/同级置顶窗时读回不可用）。 */
const HIT_FRESH_MS = 1500
/** 命中矛盾判定防抖拍数：连续 N 拍「认知穿透但实测命中本窗」才按失同步处置。 */
const HIT_MISMATCH_LIMIT = 2
/** 重申防抖：距上次 apply 小于该值跳过（避让 toggle-through 余波与 move 事件风暴）。 */
const REASSERT_DEBOUNCE_MS = 300
/** wiggle 自残静默窗：wiggle 的 1px 自移必然重置 X 层穿透（移动重置矢量），窗口内的
 *  「实测命中本窗」与渲染层输入都是自愈中的预期瞬态，计入 desync 证据会形成
 *  wiggle→desync→safe mode→复发永动环（2026-09-13 生产 pet.log 实证；振荡环断点一）。
 *  3s 取值实证依据：慢环境（Xvfb+openbox）toggle-through 愈合需 ~1.5-2s，快环境
 *  （GNOME 生产）~0.4s；且 wiggle 有疗效上限（下条），生命周期最多 3 次，
 *  慢环境的检测延迟代价有界。 */
const WIGGLE_QUIET_MS = 3000
/** wiggle 疗效上限：连续 N 次 wiggle 主读数仍未解冻（60s 后探针又 fire=上次无效）即判
 *  本环境 wiggle 无效并停用——外部探针已全权接管决策，wiggle 只是 33ms 顺滑度优化，
 *  无效还每次自残一个捕获窗（振荡环断点二）。 */
const WIGGLE_FAIL_LIMIT = 3
/** 安全态退避窗口：退出安全态后该时长内再进，时长 ×2 退避（上限 8×）（断点三：
 *  safe mode 到期同毫秒 wiggle 即复发的退避/hysteresis）。 */
const SAFE_BACKOFF_WINDOW_MS = 300000

/**
 * 创建决策器。
 * @param {Object} io 宿主环境钩子
 * @param {(ignore: boolean) => void} io.apply 施加窗口穿透态
 * @param {(state: {interactive: boolean, dwell: ?{x: number, y: number}}) => void} io.notify 通知渲染层状态迁移
 * @param {(...args: unknown[]) => void} io.log 异常日志（console.error 通道）
 * @param {(...args: unknown[]) => void} io.debug 调试日志（L2D_DEBUG=1 才输出）
 * @param {() => void} [io.wiggle] 窗口 1px 微移（X11 Configure 重同步，解冻光标读数）
 * @param {Object} [tuning] 阈值覆盖（离线验证注入用；生产走默认值）
 */
function createPassthrough(io, tuning = {}) {
  const cursorFreezeMs = tuning.cursorFreezeMs ?? CURSOR_FREEZE_MS
  const inputGraceMs = tuning.inputGraceMs ?? defaultInputGraceMs()
  const passQuietMs = tuning.passQuietMs ?? PASS_QUIET_MS
  const syncFailLimit = tuning.syncFailLimit ?? SYNC_FAIL_LIMIT
  const safeModeMs = tuning.safeModeMs ?? SAFE_MODE_MS
  const reassertMs = tuning.reassertMs ?? REASSERT_MS
  const wiggleQuietMs = tuning.wiggleQuietMs ?? WIGGLE_QUIET_MS
  const wiggleFailLimit = tuning.wiggleFailLimit ?? WIGGLE_FAIL_LIMIT
  const safeModeCapMs = tuning.safeModeCapMs ?? safeModeMs * 8
  const safeBackoffWindowMs = tuning.safeBackoffWindowMs ?? SAFE_BACKOFF_WINDOW_MS

  let rects = { model: null, ui: [], pinned: false, dragging: false }
  let cardAreas = []          // 卫星窗死区（宿主实时推送的屏幕矩形）
  let interState = false      // 当前施加的交互态（true=窗口接收鼠标）
  let dwellAnchor = null      // 停留计时锚点 {x,y,at}
  let syncFails = 0           // 连续失同步证据数
  let safeMode = false        // 安全态：恒穿透，暂停自动交互
  let safeModeAt = 0
  let expectInputAt = 0       // 正向核验：期待渲染层输入到达的时刻
  let passAppliedAt = 0       // 反向核验：最近一次施加穿透的时刻
  let lastInputAt = 0         // 渲染层最近一次真实输入事件时刻（心跳上报）
  let lastSeenInput = 0       // 已核销过的输入证据时刻
  let lastMainMoveAt = 0    // 主读数最近移动时刻（冻结探针证据一：主读数静止时长）
  let lastExtMoveAt = 0     // 外部探针最近移动时刻（冻结探针证据二：外部源在动=主读数真冻结）
  let extCursor = null        // 外部光标探针 {x,y,at}（Linux xdotool；主读数冻结时接管）
  let lastFeedX = NaN         // 决策光标最近值：moved 以喂入坐标变化为准
  let lastFeedY = NaN
  let lastDecision = null     // 最近一次仲裁后的决策光标（宿主推送/首帧拉取复用）
  let retryEpoch = 0          // 重试代数：防止过期回锁/回放污染后续状态
  let lastTick = {}           // 最近一次 tick 的判定现场（诊断用）
  let lastApplyAt = 0         // 最近一次 apply 时刻（稳态重申基准/重申防抖）
  let lastHit = null          // X 层命中读回 {isPet, at}（宿主探针喂入；与渲染层证据解耦）
  let hitMismatch = 0         // 连续「认知穿透但实测命中本窗」拍数（按新读回计，非 tick 计）
  let lastHitCountedAt = 0    // 已计拍的读回时刻（同一读数不被 33ms tick 重复计拍）
  let hitQuietUntil = 0       // 命中校验静默窗：desync toggle-through 全程+读回延迟覆盖
  let wiggleFails = 0         // 连续 wiggle 无效计数（主读数真动即清零；达限停用）
  let wiggleDisabled = false  // wiggle 判无效停用（外部探针全权接管，不再自残捕获窗）
  let safeLevel = 0           // 安全态退避级别（连续进出 ×2，上限 safeModeCapMs）
  let lastSafeExitAt = 0      // 最近一次退出安全态时刻（退避窗口判定）
  let safeDuration = 0        // 本次安全态的实际时长（入态时按退避级别定）
  let reassertMuteUntil = 0   // 事件重申静默期（wiggle 自移编排：去程 toggle 会在返程
  //  重置前空放、返程后又被 300ms 防抖饿死——第六轮实验室实证；静默期后由 reassertNow 收尾）

  const inRect = (x, y, r) => !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
  const inAnyRect = (x, y, list) => list.some((r) => inRect(x, y, r))
  const rectOk = (r) => !!r && [r.x, r.y, r.w, r.h].every((n) => Number.isFinite(n))

  /** 静默窗只延不缩：wiggle 自移触发的 move→forceReapply 会用更短的窗覆盖 wiggle 的
   *  1500ms 豁免窗，窗尾提前解封把自愈期捕获误计为 desync（第六轮实验室实证竞态）。 */
  const quietHit = (until) => { hitQuietUntil = Math.max(hitQuietUntil, until) }

  function applyPassthrough(ignore) {
    if (!ignore) passAppliedAt = 0
    else passAppliedAt = Date.now()
    lastApplyAt = Date.now()
    io.apply(ignore)
  }

  function notifyState(dwellSnapshot) {
    io.notify({ interactive: interState, dwell: dwellSnapshot ?? null })
  }

  /** 失同步处置：toggle-through 重申目标态（先反向再回目标，强制 XShape 真实重发，
   *  防同值重申被 Electron 内部去重吞掉）；连续超限则进安全态（穿透优先，防全屏捕获输入）。 */
  function desync(reason) {
    syncFails += 1
    quietHit(Date.now() + 600)   // toggle-through 反向期窗口真捕获+读回延迟，命中校验静默防连锁
    io.log(`[l2d-pet] passthrough desync #${syncFails}: ${reason} -> reapply ignore=${!interState}`)
    if (syncFails >= syncFailLimit) {
      const nowSafe = Date.now()
      // 退避：退出后短时间内再进 = 病根未除，时长 ×2（上限 cap）；根治后超时再进归 0 级
      if (lastSafeExitAt !== 0 && nowSafe - lastSafeExitAt < safeBackoffWindowMs) safeLevel = Math.min(safeLevel + 1, 3)
      else safeLevel = 0
      const duration = Math.min(safeModeMs * 2 ** safeLevel, safeModeCapMs)
      safeMode = true
      safeModeAt = nowSafe
      safeDuration = duration
      interState = false
      dwellAnchor = null
      // 入态愈合在 Linux 必须用 toggle-through：同值 apply(true) 会被 Electron 去重吞掉
      // （X 层已失守时毫无效果——2026-09-13 生产实证：安全态入态同值写未愈，
      // 捕获持续到守护扑杀）。Windows/macOS 无去重/失同步病，forceReapply 内部改直写
      forceReapply(300)
      notifyState()
      io.log(`[l2d-pet] desync persists after ${syncFails} retries, safe mode: passthrough pinned ${duration / 1000}s (level ${safeLevel})`)
      return
    }
    forceReapply(300)
  }

  /** 强制重申。分平台两路，语义差异有据：
   *  - Linux/X11：toggle-through（先反向再回目标）——同值盲写会被 Electron 内部去重吞掉，
   *    且 X11 input-shape 异步生效，反向脉冲是强制 XShape 真实重发的唯一手段（第六轮实证：
   *    X 层被移动重置后同值 setIgnoreMouseEvents 毫无效果，裸 wiggle 往返 2s 不愈合）。
   *    对内部状态丢失与 X 层丢失双有效，严格优于同值重申。
   *  - Windows/macOS：直写一次到位。这两平台 setIgnoreMouseEvents 同步可靠，不存在 X11
   *    input-shape 失同步病，故无「必须反向脉冲」的动机；而反向脉冲会在真实窗口上放行鼠标
   *    ~reverseMs（一个凭空的输入捕获窗：点击会落到桌宠而非其下窗口），纯有害。
   *  @param {number} reverseMs 反向保持时长（仅 Linux 使用；desync 用 300 覆盖在途余波；事件重申用 120 短脉冲） */
  function forceReapply(reverseMs) {
    const target = !interState
    if (process.platform !== 'linux') {
      // 直写：无反向脉冲即无捕获窗，故无需 quietHit 静默；记账必须走 applyPassthrough
      // （passAppliedAt/lastApplyAt 需同步更新，否则稳态重申会立刻重复触发）
      applyPassthrough(target)
      return
    }
    const epoch = ++retryEpoch
    if (target) passAppliedAt = Date.now()   // 反向重试：静默期自回锁时刻重新起算
    else passAppliedAt = 0
    lastApplyAt = Date.now()
    quietHit(Date.now() + reverseMs + 500)   // 反向期捕获+读回延迟，命中校验静默
    io.apply(!target)
    setTimeout(() => {
      if (epoch !== retryEpoch) return       // 状态机已另有翻转/重试，过期重放作废
      lastApplyAt = Date.now()
      io.apply(target)
    }, reverseMs)
  }

  /** 模型矩形内停留判定：位移超阈值重新计时，静默满 DWELL_MS 放行。 */
  function dwellCheck(x, y, now) {
    if (dwellAnchor && Math.hypot(x - dwellAnchor.x, y - dwellAnchor.y) > DWELL_SLACK) dwellAnchor = null
    if (!dwellAnchor) dwellAnchor = { x, y, at: now }
    return now - dwellAnchor.at >= DWELL_MS
  }

  /** 冻结探针：必须有正向证据才 wiggle——主读数静止超阈值（证据一）且外部探针
   *  新鲜且在移动（证据二：人在动鼠标而主读数不动=真冻结）。两证缺一即正常静止，
   *  不 wiggle（窗口移动会重置穿透态，wiggle 本身有捕获风险，宁可不探）。
   *  振荡环断点（2026-09-13 生产实证 wiggle→desync→safe mode→复发永动环）：
   *  一、自残静默窗——wiggle 的 1px 自移必重置穿透，窗内命中读回不计 desync 证据；
   *  二、疗效上限——连续 N 次 wiggle 主读数仍未解冻即停用（外部探针全权接管决策，
   *  wiggle 只是 33ms 顺滑度优化，无效还每次自残一个捕获窗）。 */
  function freezeProbe(now) {
    if (interState || rects.dragging || lastMainMoveAt === 0) return
    if (now - lastMainMoveAt < cursorFreezeMs) return      // 主读数活着
    if (extCursor === null || now - extCursor.at >= 3000) return   // 无外部源，无法证伪
    if (now - lastExtMoveAt >= cursorFreezeMs) return      // 外部源也静止=人真的没动
    if (typeof io.wiggle !== 'function') return   // 旧宿主未实现 wiggle 钩子时静默
    lastMainMoveAt = now   // 重置基准：wiggle 后重新起算（仍冻结则下轮再探）
    if (wiggleDisabled) return
    wiggleFails += 1   // 60s 后再次 fire 即上次无效；主读数真动在 tick 里清零
    if (wiggleFails >= wiggleFailLimit) {
      wiggleDisabled = true
      io.log(`[l2d-pet] wiggle ineffective ${wiggleFails}x in a row, disabled for this session (external probe drives decisions)`)
      return
    }
    quietHit(now + wiggleQuietMs)   // 自残捕获窗豁免：移动重置+重申+读回延迟全覆盖
    reassertMuteUntil = now + 500   // 自移往返（300ms）+余量内事件重申静音，收尾由宿主 reassertNow
    io.log(`[l2d-pet] main cursor reading frozen >${cursorFreezeMs / 1000}s while external probe moving, wiggle to resync`)
    io.wiggle()
  }

  return {
    /** 渲染层上报的交互矩形集（屏坐标）：全量替换 + 脏数据剔除。 */
    setRects(next) {
      if (!next || typeof next !== 'object') return
      rects = {
        model: rectOk(next.model) ? next.model : null,
        ui: Array.isArray(next.ui) ? next.ui.filter(rectOk) : [],
        pinned: next.pinned === true,
        dragging: next.dragging === true,
      }
    },
    /** 卫星窗死区矩形（屏坐标）：宿主开/移动/关卡片窗时推送。 */
    setCardAreas(list) {
      cardAreas = Array.isArray(list) ? list.filter(rectOk) : []
    },
    /** 渲染层心跳：携带最近一次真实输入事件时间戳（行为核验的证据源）。 */
    heartbeat(at) {
      if (Number.isFinite(at)) lastInputAt = at
    },
    /** 外部光标探针（Linux xdotool）：主进程 getCursorScreenPoint 读数走
     *  Chromium 事件流缓存，窗口穿透收不到事件即滞后/冻结；xdotool 直读
     *  X 服务器不受影响。探针新鲜（<3s）时决策优先采用外部源。 */
    externalCursor(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      if (extCursor !== null && (extCursor.x !== x || extCursor.y !== y)) lastExtMoveAt = Date.now()
      extCursor = { x, y, at: Date.now() }
    },
    /** X 层命中读回（宿主探针喂入）：isPet=光标当前是否命中本窗。与渲染层证据解耦——
     *  渲染层缺位（页面加载失败/初始化崩溃）时这是唯一的失同步证据源。 */
    observedHit(isPet) {
      if (typeof isPet === 'boolean') lastHit = { isPet, at: Date.now() }
    },
    /** 宿主窗口 move/resize/restore 事件入口：窗口移动会重置 X 层穿透态（实证），立即
     *  toggle-through 强制重申（同值重申被 Electron 去重吞掉；120ms 短反向脉冲实证
     *  不足以完成 XShape 重发，须与 desync 同规格 300ms——第六轮实验室对照）。
     *  上述 300ms 反向规格仅 Linux 适用（Windows/macOS 走直写，见 forceReapply）。
     *  300ms 防抖避让事件风暴；reassertMuteUntil 内（wiggle 自移编排）不动作。 */
    reassert() {
      const now = Date.now()
      if (now < reassertMuteUntil) return
      if (now - lastApplyAt < REASSERT_DEBOUNCE_MS) return
      forceReapply(300)
    },
    /** wiggle 自移编排入口：自移期间的事件重申全部静音（去程 toggle 在返程重置前空放、
     *  返程后又被防抖饿死的病理），由调用方在动作结束后 reassertNow 一刀收尾。 */
    muteReassert(ms) {
      if (Number.isFinite(ms)) reassertMuteUntil = Date.now() + ms
    },
    /** 无防抖强制重申：仅限自移编排收尾（全部移动落地后调用，retryEpoch 防过期重放）。 */
    reassertNow() {
      forceReapply(300)
    },
    /**
     * 每 tick（33ms 轮询）驱动：决策 + 行为核验 + 冻结探针。
     * @param {number} x y OS 光标屏坐标
     * @param {boolean} cursorMoved 光标自上 tick 起是否移动
     */
    tick(x, y, cursorMoved) {
      const now = Date.now()
      if (safeMode) {
        if (now - safeModeAt < safeDuration) {
          // 安全态也要稳态重申：入态时的一次性盲写会被其后的窗口移动/最小化还原
          // 重置（实验室实证：安全态 60s 内捕获无人重申），恒穿透承诺必须周期续写
          if (now - lastApplyAt >= reassertMs) applyPassthrough(true)
          // 安全态内 X 层命中校验照常：入态 toggle 未愈的失守由强制重发兜底
          // （生产实证：同值入态写被去重吞掉后捕获持续到守护扑杀）；不计 syncFails
          if (lastHit !== null && now - lastHit.at < HIT_FRESH_MS && now >= hitQuietUntil) {
            if (lastHit.isPet) {
              if (lastHit.at !== lastHitCountedAt) {
                lastHitCountedAt = lastHit.at
                hitMismatch += 1
                if (hitMismatch >= HIT_MISMATCH_LIMIT) {
                  hitMismatch = 0
                  io.log('[l2d-pet] safe mode: X hit-test still lands on pet, force reapply')
                  forceReapply(300)
                }
              }
            } else hitMismatch = 0
          }
          lastDecision = { x, y }
          return lastDecision
        }
        safeMode = false
        syncFails = 0
        lastSafeExitAt = now
        lastMainMoveAt = now   // hysteresis：退出即给冻结探针重新计满阈值，防同毫秒 wiggle 即复发
        io.log('[l2d-pet] safe mode expired, resuming passthrough decisions')
      }
      if (rects.dragging) { lastDecision = { x, y }; return lastDecision }   // 拖拽期冻结判定（原渲染层 evalIgnore 同语义）
      // 光标源仲裁：外部探针新鲜（<3s）时优先采用（主读数在穿透窗收不到事件时
      // 滞后/冻结）；外部源缺位或过期则回退主读数。moved=决策光标相对上 tick 变化
      let cx = x
      let cy = y
      if (extCursor !== null && now - extCursor.at < 3000) { cx = extCursor.x; cy = extCursor.y }
      const moved = cursorMoved || cx !== lastFeedX || cy !== lastFeedY
      lastFeedX = cx
      lastFeedY = cy
      if (cursorMoved) {
        lastMainMoveAt = now
        // 疗效清零只认「静默窗外的真解冻」：wiggle 捕获窗内真实事件流入造成的短暂
        // 解冻是自残副产物（金丝雀实证：每次 wiggle 都因此重置计数，停用永不达成）
        if (now >= hitQuietUntil) wiggleFails = 0
      } else if (lastMainMoveAt === 0) lastMainMoveAt = now   // 首个 tick 起算主读数静止时长
      x = cx
      y = cy
      lastDecision = { x: cx, y: cy }
      let target = false
      let dwellActive = false
      if (inAnyRect(x, y, cardAreas)) {
        target = false             // 卫星窗死区优先于一切：点击属于卡片
      } else if (inAnyRect(x, y, rects.ui)) {
        target = true              // UI 控件不受停留等待限制
      } else if (rects.pinned) {
        target = false             // 手动锁定：模型区恒穿透
      } else if (inRect(x, y, rects.model)) {
        dwellActive = true
        target = interState ? true : dwellCheck(x, y, now)   // 滞回：已交互则区内保持
      }
      if (!dwellActive) dwellAnchor = null   // 出框/死区/UI 任一分支都取消停留计时
      lastTick = { x: Math.round(x), y: Math.round(y), inModel: inRect(x, y, rects.model), dwell: dwellAnchor ? Math.round(now - dwellAnchor.at) : null }
      if (target !== interState) {
        // 翻转前抓停留快照给调试探针（dwellDebug），随后清锚点
        const snapshot = dwellAnchor ? { x: dwellAnchor.x, y: dwellAnchor.y } : null
        interState = target
        dwellAnchor = null
        expectInputAt = 0
        applyPassthrough(!interState)
        notifyState(snapshot)
        io.debug(`[l2d-pet] passthrough -> ${interState ? 'interactive' : 'passthrough'} @${Math.round(x)},${Math.round(y)}`)
      }
      // ── 行为核验（Electron 无 isIgnoreMouseEvents 读回，用输入证据判失同步）──
      if (interState) {
        // 正向：交互态下有新输入到达=穿透确已解除（顺手核销+清零计数）；
        // 光标动了却迟迟无输入，宽限期后重申施加。
        // 宽限期必须 > 心跳周期（2000ms）：证据只能搭心跳车到达，宽限短于心跳即
        // 结构性误报（win32 实测进安全态）——取值见 INPUT_GRACE_MS_NON_LINUX
        if (lastInputAt > lastSeenInput) {
          lastSeenInput = lastInputAt
          syncFails = 0
          expectInputAt = 0
        } else if (cursorMoved && expectInputAt === 0) {
          expectInputAt = now
        }
        if (expectInputAt !== 0 && now - expectInputAt > inputGraceMs) {
          desync('interactive but no input reached renderer')
          expectInputAt = 0
        }
      } else {
        // 反向：穿透施加过静默期后，渲染层仍持续收到「施加 400ms 之后才产生」的
        // 新鲜输入，且光标此刻不在任何交互矩形上——input-shape 未上锁的证据。
        // 施加瞬间的在途余波（X11 shape 异步生效前的尾巴）不算，防误报；
        // hitQuietUntil 静默窗（wiggle 自残/toggle-through 反向期）内收到输入是
        // 预期瞬态，同样不计（第六轮实验室实证：wiggle 捕获窗的输入误计 desync）
        if (passAppliedAt !== 0 && now - passAppliedAt > passQuietMs
          && now >= hitQuietUntil
          && lastInputAt > passAppliedAt + PASS_ECHO_MS && now - lastInputAt < 400
          && !inAnyRect(x, y, rects.ui) && !inRect(x, y, rects.model)) {
          desync('passthrough but renderer still receives input')
        }
      }
      // ── X 层命中校验（与渲染层证据解耦的直接证据）：认知穿透但实测命中本窗
      // 连续 2 拍 = 穿透失守铁证（盲写丢失/移动重置/API 失效全覆盖），按失同步处置。
      // 拍数按新读回计（读回 500ms 一拍，33ms tick 不重复计同一读数）；
      // desync 后 600ms 静默窗覆盖 toggle-through 反向期的真实捕获读数，防连锁误判。
      // interState=true 一侧不判：光标可能在死区/副屏/同级置顶窗，误报代价大于收益
      if (lastHit !== null && now - lastHit.at < HIT_FRESH_MS && now >= hitQuietUntil) {
        if (!interState && lastHit.isPet) {
          if (lastHit.at !== lastHitCountedAt) {
            lastHitCountedAt = lastHit.at
            hitMismatch += 1
            if (hitMismatch >= HIT_MISMATCH_LIMIT) {
              hitMismatch = 0
              desync('passthrough believed but X hit-test lands on pet window')
            }
          }
        } else {
          hitMismatch = 0
        }
      }
      // ── 稳态重申：距上次 apply 超 5s 即同值重申当前态（覆盖未被任何观测捕获的
      //  X 层失守路径；同值重申幂等无害，被 Electron 去重吞掉时由上方命中校验兜底）──
      if (now - lastApplyAt >= reassertMs) applyPassthrough(!interState)
      freezeProbe(now)
      return lastDecision
    },
    /** 最近一次仲裁后的决策光标（穿透态主读数冻结时宿主推送链复用）；未 tick 过为 null。 */
    cursor() {
      return lastDecision
    },
    /** 诊断快照：调试日志用（L2D_DEBUG=1）。 */
    snapshot() {
      return {
        interState,
        safeMode,
        safeLevel,
        wiggleDisabled,
        model: rects.model,
        uiCount: rects.ui.length,
        pinned: rects.pinned,
        dragging: rects.dragging,
        cards: cardAreas.length,
        extCursor: extCursor ? { x: extCursor.x, y: extCursor.y, age: Date.now() - extCursor.at } : null,
        lastHit: lastHit ? { isPet: lastHit.isPet, age: Date.now() - lastHit.at } : null,
        hitMismatch,
        lastApplyAge: Date.now() - lastApplyAt,
        inputGraceMs,   // 生效值（平台分治/tuning 覆盖后）：排障与离线验证的可观测点
        lastTick: lastTick,
      }
    },
  }
}

module.exports = { createPassthrough, DWELL_MS, DWELL_SLACK, INPUT_GRACE_MS_LINUX, INPUT_GRACE_MS_NON_LINUX, defaultInputGraceMs }
