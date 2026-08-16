/**
 * stage.js —— 渲染层：PIXI 应用、模型加载/热切换、布局收身、缩放动画、槽位播放。
 *
 * 初始化完成后 ctx 上可用：app / model / binding / setExpr / playMotion /
 * modelBounds / layout / switchModel / getModelPath；缩放状态
 * （scale/targetScale/petBaseW/petBaseH）也挂在 ctx 上与 interact 模块共享。
 */

import { BASE, PET, BRIDGE, MODEL_QUERY, BASE_W, BASE_H, store, loadScript } from './config.js'
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
  })
  app.view.style.width = '100%'
  app.view.style.height = '100%'
  app.view.style.display = 'block'
  ctx.box.appendChild(app.view)
  ctx.app = app

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

  let model = await PIXI.live2d.Live2DModel.from(`${BASE}/model/${modelPath}`, { autoInteract: false })
  app.stage.addChild(model)
  ctx.model = model
  let naturalW = model.internalModel.originalWidth
  let naturalH = model.internalModel.originalHeight

  ctx.scale = store.getScale()
  ctx.targetScale = ctx.scale
  ctx.petBaseW = PET_DEFAULT_W
  ctx.petBaseH = PET_DEFAULT_H
  ctx.modelBounds = () => ctx.model.getBounds()

  /** 布局：挂件按固定画布，桌宠按窗口；桌宠底部锚定（站地上），挂件垂直居中。 */
  ctx.layout = () => {
    const w = PET ? window.innerWidth : BASE_W
    const h = PET ? window.innerHeight : BASE_H
    app.renderer.resize(w, h)
    const s = Math.min(w / naturalW, h / naturalH) * FIT_RATIO * (BRIDGE ? 1 : ctx.scale)
    ctx.model.scale.set(s)
    ctx.model.x = (w - ctx.model.width) / 2
    ctx.model.y = PET ? (h - ctx.model.height) : (h - ctx.model.height) / 2
  }
  ctx.layout()

  // 桌宠收身：量网格真实宽高比，窗口收成刚好包住模型（保持用户缩放比例）
  function fitPetWindow() {
    if (!BRIDGE) return
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
   * @param {?string} slot 槽位名（见 binding.js）
   */
  ctx.playMotion = (slot) => {
    const m = slot ? ctx.binding.motion[slot] : undefined
    if (!m) return
    ctx.model.motion(m[0], m[1]).catch(() => { })
  }

  // 模型热切换令牌：只允许最后一次请求生效，避免并发切换互相覆盖
  let switchToken = 0

  /**
   * 热切换当前模型：加载新模型与其绑定，成功后替换舞台上的旧模型。
   * 旧模型保留到新模型就绪，加载失败时当前模型不受影响。
   * @param {string} nextPath 相对 model/ 的 .model3.json 路径
   * @returns {Promise<boolean>} 是否完成切换（同路径返回 false）
   */
  ctx.switchModel = async (nextPath) => {
    if (!nextPath || nextPath === modelPath) return false
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
