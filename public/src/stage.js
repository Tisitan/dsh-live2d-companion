/**
 * stage.js —— 渲染层：PIXI 应用、模型加载/热切换、布局收身、缩放动画、槽位播放。
 *
 * 初始化完成后 ctx 上可用：app / model / binding / setExpr / playMotion /
 * modelBounds / layout / switchModel / getModelPath；缩放状态
 * （scale/targetScale/petBaseW/petBaseH）也挂在 ctx 上与 interact 模块共享。
 */

import { BASE, PET, BRIDGE, MODEL_QUERY, PREVIEW, BASE_W, BASE_H, store, loadScript } from './config.js'
import { loadBinding } from './binding.js'

/** 桌宠窗口默认尺寸（收身前）；收身后被实测网格宽高比取代。 */
const PET_DEFAULT_W = 340
const PET_DEFAULT_H = 460

/** 模型填充窗口的比例上限，保留的边距给动作挥臂留出余量。 */
const FIT_RATIO = 0.92

/** 内置默认模型（相对 public/model/）。 */
const DEFAULT_MODEL = 'nori/ARGNori.model3.json'

/**
 * 初始化渲染层。
 * @param {Object} ctx 共享上下文
 */
export async function initStage(ctx) {
  await loadScript(BASE + '/vendor/pixi.min.js')
  await loadScript(BASE + '/vendor/live2dcubismcore.min.js')
  await loadScript(BASE + '/vendor/pixi-live2d-cubism4.min.js')

  const app = new PIXI.Application({
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    powerPreference: 'low-power',
  })
  app.view.style.width = '100%'
  app.view.style.height = '100%'
  app.view.style.display = 'block'
  ctx.box.appendChild(app.view)
  ctx.app = app

  // ── 帧率分级：模型呼吸动画必须持续渲染，但无需无差别烧电 ──
  // 三档预设（常态/睡眠/离线），面板可视化切换并持久化；窗口隐藏时完全停渲染。
  const FPS_MODES = {
    full: { active: 60, sleep: 30, offline: 12 },
    balanced: { active: 30, sleep: 12, offline: 6 },
    saver: { active: 15, sleep: 8, offline: 4 },
  }
  {
    const saved = store.getFpsMode()
    ctx.fpsMode = FPS_MODES[saved] ? saved : 'balanced'
  }
  // 放开 PIXI 默认 minFPS=10 的地板：否则 maxFPS 设 8/6/4 会被静默钳回 10
  // （minFPS 同时是 deltaTime 尖峰钳制，4 档 = 单帧最多补 250ms，动画不会跳飞）
  app.ticker.minFPS = 4
  /** 按状态套用所选预设的分档帧率。 */
  const applyTier = (next) => {
    const t = FPS_MODES[ctx.fpsMode]
    app.ticker.maxFPS = next === 'sleeping' ? t.sleep : next === 'offline' ? t.offline : t.active
  }
  /** 切换帧率预设（面板调用）：持久化 + 立即按当前状态生效。 */
  ctx.setFpsMode = (mode) => {
    if (!FPS_MODES[mode]) return
    ctx.fpsMode = mode
    store.setFpsMode(mode)
    applyTier(ctx.getState?.() ?? 'idle')
  }
  applyTier('idle')
  ctx.on('enter', (next) => applyTier(next))
  // 窗口最小化/隐藏时完全停渲染；恢复可见立即续跑
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) app.ticker.stop()
    else app.ticker.start()
  })

  // 模型路径：?model= 查询 > 宿主 /live2d/config > 内置默认
  let modelPath = MODEL_QUERY
  if (!modelPath) {
    try {
      const remote = await (await fetch(BASE + '/config', { cache: 'no-store' })).json()
      modelPath = remote.model
    } catch { }
  }
  if (!modelPath) modelPath = DEFAULT_MODEL
  ctx.getModelPath = () => modelPath
  Object.defineProperty(ctx, 'modelPath', { get: () => modelPath, enumerable: true })

  ctx.binding = await loadBinding(modelPath)

  /** 模型加载带兜底链：配置模型坏了回退内置默认；默认也挂则显示可见错误而非一团空气。 */
  async function loadModel(path) {
    return PIXI.live2d.Live2DModel.from(`${BASE}/model/${path}`, { autoInteract: false })
  }
  let model
  try {
    model = await loadModel(modelPath)
  } catch (firstError) {
    console.warn(`[l2d] model load failed, falling back to default: ${modelPath}`, firstError)
    try {
      modelPath = DEFAULT_MODEL
      ctx.binding = await loadBinding(modelPath)
      model = await loadModel(modelPath)
    } catch (secondError) {
      // 连默认模型都加载失败（首次使用未放模型 / 缺 cubismcore）：在容器里留文字提示
      const notice = document.createElement('div')
      Object.assign(notice.style, {
        position: 'absolute', inset: '20% 8% auto', padding: '10px 12px', borderRadius: '10px',
        background: 'rgba(0,0,0,.72)', color: '#ffd7d7', font: '12px/1.7 sans-serif',
        whiteSpace: 'pre-wrap', pointerEvents: 'none', zIndex: 3,
      })
      notice.textContent = 'Live2D 模型加载失败\n请检查 model/ 目录与 vendor/live2dcubismcore.min.js'
      ctx.box.appendChild(notice)
      throw secondError
    }
  }
  app.stage.addChild(model)
  ctx.model = model
  let naturalW = model.internalModel.originalWidth
  let naturalH = model.internalModel.originalHeight

  ctx.scale = store.getScale()
  ctx.targetScale = ctx.scale
  ctx.petBaseW = PET_DEFAULT_W
  ctx.petBaseH = PET_DEFAULT_H
  // 包围盒缓存：getBounds 要遍历全部网格顶点，而交互路径（穿透/摸头）随指针事件
  // 可达 60-120Hz——每帧只量一次，交互全部读缓存；布局等需要精确值的仍走实测。
  let cachedBounds = null
  app.ticker.add(() => { if (ctx.model) cachedBounds = ctx.model.getBounds() })
  ctx.modelBounds = () => cachedBounds ?? ctx.model.getBounds()

  /** 布局：挂件按固定画布，桌宠按窗口；桌宠底部锚定（站地上），挂件垂直居中。
   *  两遍制：先按标称尺寸缩放，再量真实渲染包围盒二次修正——标称与实测
   *  不符的模型（帽檐/飘带溢出标称框）在任何窗口下都不会被裁切。 */
  ctx.layout = () => {
    const w = PET ? window.innerWidth : BASE_W
    const h = PET ? window.innerHeight : BASE_H
    app.renderer.resize(w, h)
    const zoom = (BRIDGE || PREVIEW) ? 1 : ctx.scale
    let s = Math.min(w / naturalW, h / naturalH) * FIT_RATIO * zoom
    ctx.model.scale.set(s)
    const b = ctx.model.getBounds()
    if (b.width > 0 && b.height > 0) {
      const k = Math.min(1, (w * FIT_RATIO * zoom) / b.width, (h * FIT_RATIO * zoom) / b.height)
      if (k < 1) {
        s *= k
        ctx.model.scale.set(s)
      }
      const b2 = ctx.model.getBounds()
      ctx.model.x += (w - b2.width) / 2 - b2.x
      ctx.model.y += (PET ? (h - b2.height) : (h - b2.height) / 2) - b2.y
      return
    }
    ctx.model.x = (w - ctx.model.width) / 2
    ctx.model.y = PET ? (h - ctx.model.height) : (h - ctx.model.height) / 2
  }
  ctx.layout()

  // 尺寸自愈：iframe/容器尺寸变化（预览弹窗开合、绑定栏展开等）不一定触发
  // window resize，用 ResizeObserver 兜底重新布局，防止预览按旧尺寸裁切
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => ctx.layout()).observe(ctx.box)
  }

  // 桌宠收身：量网格真实宽高比，窗口收成刚好包住模型（保持用户缩放比例）
  // 预览 iframe 中禁用（iframe 里可能继承 preload 桥，绝不能让它 resize 真窗口）
  function fitPetWindow() {
    if (!BRIDGE || PREVIEW) return
    const b = ctx.model.getBounds()
    if (b.width > 0 && b.height > 0) {
      ctx.petBaseW = Math.min(1200, Math.max(160, Math.round(ctx.petBaseH * (b.width / b.height))))
      BRIDGE.resizeTo(Math.round(ctx.petBaseW * ctx.scale), Math.round(ctx.petBaseH * ctx.scale))
    }
  }
  if (BRIDGE) setTimeout(fitPetWindow, 200)

  window.addEventListener('resize', () => {
    ctx.layout()
    ctx.evalIgnore?.()
    if (!PET && ctx.box.style.left !== '') {
      ctx.box.style.left = Math.min(Math.max(parseFloat(ctx.box.style.left), -BASE_W / 2), window.innerWidth - BASE_W / 3) + 'px'
      ctx.box.style.top = Math.min(Math.max(parseFloat(ctx.box.style.top), 0), window.innerHeight - BASE_H / 3) + 'px'
    }
  })

  // 缩放动画：滚轮只改 targetScale，ticker 按帧平滑逼近
  app.ticker.add(() => {
    const dt = app.ticker.deltaMS / 1000
    if (Math.abs(ctx.targetScale - ctx.scale) > 0.001) {
      ctx.scale += (ctx.targetScale - ctx.scale) * Math.min(1, dt * 7)
      if (BRIDGE) {
        BRIDGE.resizeTo(Math.round(ctx.petBaseW * ctx.scale), Math.round(ctx.petBaseH * ctx.scale))
        ctx.evalIgnore?.()
      } else {
        ctx.layout()
      }
    }
  })

  /**
   * 播放表情槽位；槽位未绑定时静默跳过。
   * @param {?string} slot 槽位名（见 binding.js）
   */
  ctx.setExpr = (slot) => {
    const name = slot ? ctx.binding.expr[slot] : undefined
    if (!name) return
    try { ctx.model.expression(name) } catch { }
  }

  /**
   * 播放动作槽位；槽位未绑定时静默跳过。
   * 强制抢占语义：先清残存动作队列再以最高优先级立即播放，
   * 避免快速连切状态时旧动作排队滞留、几秒后错位播放。
   * @param {?string} slot 槽位名（见 binding.js）
   */
  ctx.playMotion = (slot) => {
    const m = slot ? ctx.binding.motion[slot] : undefined
    if (!m) return
    try { ctx.model.internalModel.motionManager.stopAllMotions() } catch { }
    ctx.model.motion(m[0], m[1], 3).catch(() => { }) // 3 = MotionPriority.FORCE
  }

  // 模型热切换令牌：只允许最后一次请求生效，避免并发切换互相覆盖
  let switchToken = 0

  /**
   * 热切换当前模型：加载新模型与其绑定，成功后替换舞台上的旧模型。
   * 旧模型保留到新模型就绪，加载失败时当前模型不受影响。
   * @param {string} nextPath 相对 model/ 的 .model3.json 路径
   * @param {boolean} force 同路径也强制重载（绑定档案保存后刷新用）
   * @returns {Promise<boolean>} 是否完成切换（同路径且未强制时返回 false）
   */
  ctx.switchModel = async (nextPath, force = false) => {
    if (!nextPath || (nextPath === modelPath && !force)) return false
    const token = ++switchToken
    const [nextModel, nextBinding] = await Promise.all([
      PIXI.live2d.Live2DModel.from(`${BASE}/model/${nextPath}`, { autoInteract: false }),
      loadBinding(nextPath),
    ])
    if (token !== switchToken) {
      try { nextModel.destroy(true) } catch { }
      return false
    }

    const previous = ctx.model
    if (previous) {
      app.stage.removeChild(previous)
      try { previous.destroy(true) } catch { }
    }
    model = nextModel
    ctx.model = nextModel
    app.stage.addChild(nextModel)
    ctx.binding = nextBinding
    modelPath = nextPath
    naturalW = nextModel.internalModel.originalWidth
    naturalH = nextModel.internalModel.originalHeight
    ctx.layout()
    if (BRIDGE) setTimeout(fitPetWindow, 200)
    ctx.setExpr(ctx.stateExpr?.() ?? 'default')
    ctx.emit?.('model', nextPath)
    return true
  }
}
