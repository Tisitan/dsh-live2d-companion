/**
 * panel.js —— 模型面板：悬浮齿轮入口、模型扫描/切换/导入、预览弹窗。
 *
 * 面板只依赖 ctx 提供的 switchModel / modelPath / box / showBubble；
 * 不直接操作状态机或渲染细节。入口按钮默认静置 1.2 秒后自动隐藏，
 * 鼠标悬停模型区域时重新出现（面板打开时保持显示）。
 */

import { BASE, PREVIEW, BRIDGE } from './config.js'
import { resolveBinding, extractInventory } from './binding.js'

/** 面板宽度上限（px）；窄窗口（如桌宠）下由 CSS min() 收缩，钳制用实测宽度。 */
const PANEL_WIDTH = 280

/**
 * 初始化模型面板。
 * @param {Object} ctx 共享上下文（switchModel / modelPath / box / showBubble）
 * @returns {?Object} 面板公共句柄；preview=1 的预览 iframe 中返回 null
 */
export function initPanel(ctx) {
  if (PREVIEW) return null

  const style = document.createElement('style')
  style.textContent = `
#l2d-model-toggle {
  position: absolute; top: 6px; right: 6px; z-index: 20;
  width: 30px; height: 30px; padding: 0; border-radius: 50%;
  border: 1px solid rgba(0,0,0,.12); background: rgba(255,255,255,.88);
  color: #556; font: 15px/1 system-ui, sans-serif; cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,.18);
  opacity: .72; transition: opacity .25s ease, background .15s ease;
}
#l2d-model-toggle:hover { opacity: 1; background: #fff; }
#l2d-model-toggle.l2d-hidden { opacity: 0; pointer-events: none; }
#l2d-model-help {
  position: absolute; top: 42px; right: 6px; z-index: 20;
  width: 30px; height: 30px; padding: 0; border-radius: 50%;
  border: 1px solid rgba(0,0,0,.12); background: rgba(255,255,255,.88);
  color: #556; font: 14px/1 system-ui, sans-serif; cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,.18);
  opacity: .72; transition: opacity .25s ease, background .15s ease;
}
#l2d-model-help:hover { opacity: 1; background: #fff; }
#l2d-model-help.l2d-hidden { opacity: 0; pointer-events: none; }
#l2d-help-card {
  position: fixed; z-index: 100000; width: min(250px, calc(100vw - 16px));
  background: rgba(255,255,255,.97); color: #334;
  border: 1px solid rgba(0,0,0,.12); border-radius: 12px;
  box-shadow: 0 10px 34px rgba(0,0,0,.24);
  font: 12px/1.8 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  padding: 10px 12px; box-sizing: border-box;
  opacity: 0; visibility: hidden; transform: translateY(-4px);
  transition: opacity .15s ease, transform .15s ease, visibility .15s;
}
#l2d-help-card.open { opacity: 1; visibility: visible; transform: none; }
#l2d-help-card .l2d-help-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; margin-bottom: 2px; }
#l2d-help-card .l2d-help-close { border: 0; background: none; cursor: pointer; color: #889; font-size: 14px; padding: 0 2px; }
#l2d-help-card ul { margin: 0; padding-left: 16px; }
#l2d-model-panel {
  position: fixed; z-index: 100000; width: min(280px, calc(100vw - 16px)); max-height: min(420px, calc(100vh - 16px));
  display: flex; flex-direction: column; box-sizing: border-box;
  background: rgba(255,255,255,.97); color: #334;
  border: 1px solid rgba(0,0,0,.12); border-radius: 12px;
  box-shadow: 0 10px 34px rgba(0,0,0,.24);
  font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  opacity: 0; visibility: hidden; transform: translateY(-4px) scale(.98);
  transform-origin: 100% 0; transition: opacity .15s ease, transform .15s ease, visibility .15s;
  overflow: hidden;
}
#l2d-model-panel.open { opacity: 1; visibility: visible; transform: none; }
#l2d-model-panel .l2d-panel-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px 6px; font-weight: 600;
}
#l2d-model-panel .l2d-panel-close {
  border: 0; background: transparent; color: #889; cursor: pointer;
  font: 16px/1 system-ui, sans-serif; padding: 2px 6px; border-radius: 6px;
}
#l2d-model-panel .l2d-panel-close:hover { background: #f0f1f3; color: #334; }
#l2d-model-panel .l2d-panel-current { padding: 0 12px 8px; color: #778; font-size: 12px; overflow-wrap: anywhere; }
#l2d-model-panel .l2d-panel-list {
  flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column;
  gap: 6px; padding: 0 8px 8px;
}
.l2d-model-row { display: flex; gap: 6px; align-items: stretch; }
.l2d-model-item {
  flex: 1; min-width: 0; text-align: left; border: 1px solid rgba(0,0,0,.08);
  background: #f7f8fa; border-radius: 8px; padding: 7px 9px; cursor: pointer;
  color: #334; font: inherit;
}
.l2d-model-item:hover { background: #eef3ff; border-color: #9db8ff; }
.l2d-model-row.selected .l2d-model-item { background: #e7f0ff; border-color: #6c96ff; box-shadow: inset 0 0 0 1px #6c96ff; }
.l2d-model-view {
  flex: 0 0 46px; border: 1px solid rgba(0,0,0,.08); border-radius: 8px;
  background: #fff; color: #556; cursor: pointer; font: 12px/1.2 inherit; padding: 4px;
}
.l2d-model-view:hover { background: #f0f4ff; border-color: #9db8ff; }
.l2d-model-name { font-weight: 600; }
.l2d-model-path { font-size: 11px; color: #889; overflow-wrap: anywhere; }
.l2d-model-empty { padding: 14px 8px; text-align: center; color: #99a; }
#l2d-model-panel .l2d-panel-status { padding: 4px 12px 8px; color: #778; min-height: 18px; font-size: 12px; }
#l2d-model-panel .l2d-panel-status.error { color: #c0392b; }
#l2d-model-panel .l2d-panel-actions { display: flex; gap: 8px; padding: 0 12px 12px; }
#l2d-model-panel .l2d-panel-actions button {
  flex: 1; padding: 6px 8px; border: 1px solid rgba(0,0,0,.12); border-radius: 8px;
  background: #fff; color: #445; cursor: pointer; font: inherit;
}
#l2d-model-panel .l2d-panel-actions button:hover:not(:disabled) { background: #f0f4ff; border-color: #9db8ff; }
#l2d-model-panel .l2d-panel-actions button:disabled { opacity: .45; cursor: default; }
#l2d-model-panel .l2d-fps-row {
  display: flex; align-items: center; gap: 8px; padding: 0 12px 12px;
  color: #778; font-size: 12px;
}
#l2d-model-panel .l2d-fps-row select {
  flex: 1; min-width: 0; font: inherit; color: #334;
  border: 1px solid rgba(0,0,0,.12); border-radius: 6px; padding: 3px 6px; background: #fff;
}
#l2d-model-panel .l2d-quit-row { padding: 0 12px 12px; }
#l2d-model-panel .l2d-soft-row { padding: 0 12px 10px; }
#l2d-model-panel .l2d-soft-label { display: flex; align-items: center; gap: 6px; color: #778; font-size: 12px; cursor: pointer; }
#l2d-model-panel .l2d-quit-row button {
  width: 100%; padding: 6px 8px; border: 1px solid rgba(192,57,43,.35); border-radius: 8px;
  background: #fff; color: #c0392b; cursor: pointer; font: inherit; font-size: 12px;
}
#l2d-model-panel .l2d-quit-row button:hover { background: #fdf0ee; }
#l2d-model-panel .l2d-quit-row button.arm { background: #c0392b; color: #fff; }
#l2d-viewer {
  position: fixed; inset: 0; z-index: 100001; display: none; padding: 16px;
  align-items: center; justify-content: center; background: rgba(24,29,40,.55);
}
#l2d-viewer.open { display: flex; }
#l2d-viewer .l2d-viewer-card {
  width: min(520px, 94vw); height: min(620px, 88vh); display: flex; flex-direction: column;
  background: rgba(255,255,255,.97); border-radius: 16px; overflow: hidden;
  box-shadow: 0 18px 60px rgba(0,0,0,.35);
}
#l2d-viewer .l2d-viewer-top {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 10px 12px; border-bottom: 1px solid rgba(0,0,0,.08); font-weight: 600;
}
#l2d-viewer .l2d-viewer-title { overflow-wrap: anywhere; font-size: 13px; color: #334; }
#l2d-viewer .l2d-viewer-close {
  border: 0; background: transparent; color: #889; cursor: pointer;
  font: 16px/1 system-ui, sans-serif; padding: 2px 8px; border-radius: 6px;
}
#l2d-viewer .l2d-viewer-close:hover { background: #f0f1f3; color: #334; }
#l2d-viewer iframe {
  flex: 1; border: 0; background: linear-gradient(180deg, #fafbff 0%, #eef1f8 100%);
}
#l2d-viewer .l2d-viewer-states {
  display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px;
  border-bottom: 1px solid rgba(0,0,0,.08);
}
#l2d-viewer .l2d-state-btn {
  padding: 4px 10px; border: 1px solid rgba(0,0,0,.12); border-radius: 999px;
  background: #fff; color: #445; cursor: pointer; font: 12px/1.4 inherit;
}
#l2d-viewer .l2d-state-btn:hover { background: #f0f4ff; border-color: #9db8ff; }
#l2d-viewer .l2d-state-btn.active { background: #e7f0ff; border-color: #6c96ff; color: #2b4a8f; }
#l2d-viewer .l2d-binder-toggle {
  border: 1px solid rgba(0,0,0,.12); background: #fff; color: #556; cursor: pointer;
  font: 12px/1.4 inherit; padding: 3px 10px; border-radius: 999px;
}
#l2d-viewer .l2d-binder-toggle:hover { background: #f0f4ff; border-color: #9db8ff; }
#l2d-viewer .l2d-binder-toggle.active { background: #e7f0ff; border-color: #6c96ff; color: #2b4a8f; }
#l2d-viewer .l2d-binder {
  max-height: 240px; overflow-y: auto; padding: 8px 12px;
  border-bottom: 1px solid rgba(0,0,0,.08); background: #fbfcfe;
  font-size: 12px; color: #445;
}
#l2d-viewer .l2d-binder-h { font-weight: 600; margin: 6px 0 4px; color: #556; }
#l2d-viewer .l2d-binder-tip { color: #889; margin-bottom: 2px; }
#l2d-viewer .l2d-binder-eslots, #l2d-viewer .l2d-binder-mslots, #l2d-viewer .l2d-binder-gallery {
  display: flex; flex-wrap: wrap; gap: 5px;
}
#l2d-viewer .l2d-chip {
  padding: 3px 9px; border: 1px solid rgba(0,0,0,.12); border-radius: 999px;
  background: #fff; cursor: pointer; font: 12px/1.4 inherit; color: #445;
}
#l2d-viewer .l2d-chip:hover { background: #f0f4ff; border-color: #9db8ff; }
#l2d-viewer .l2d-chip.on { background: #e7f0ff; border-color: #6c96ff; color: #2b4a8f; }
#l2d-viewer .l2d-chip .bound { color: #98a2b3; font-size: 10px; margin-left: 4px; }
#l2d-viewer .l2d-mat {
  padding: 4px 8px; border: 1px solid rgba(0,0,0,.12); border-radius: 8px;
  background: #fff; cursor: pointer; font: 12px/1.4 inherit; color: #334;
  text-align: left; max-width: 100%; overflow-wrap: anywhere;
}
#l2d-viewer .l2d-mat:hover { background: #f0f4ff; border-color: #9db8ff; }
#l2d-viewer .l2d-mat.on { background: #e7f0ff; border-color: #6c96ff; box-shadow: inset 0 0 0 1px #6c96ff; }
#l2d-viewer .l2d-mat .badges { display: block; color: #5a9e7a; font-size: 10px; }
#l2d-viewer .l2d-binder-cur { color: #6c96ff; font-weight: 400; }
#l2d-viewer .l2d-binder-current { margin: 4px 0; color: #445; }
#l2d-viewer .l2d-binder-current b { color: #2b4a8f; }
#l2d-viewer .l2d-binder-share { color: #b0792a; margin: 2px 0; }
#l2d-viewer .l2d-binder-actions { display: flex; gap: 8px; margin-top: 8px; }
#l2d-viewer .l2d-binder-actions button {
  flex: 1; padding: 5px 8px; border: 1px solid rgba(0,0,0,.12); border-radius: 8px;
  background: #fff; color: #445; cursor: pointer; font: inherit;
}
#l2d-viewer .l2d-binder-actions button:hover { background: #f0f4ff; border-color: #9db8ff; }
#l2d-viewer .l2d-binder-status { min-height: 16px; margin-top: 4px; color: #778; }
#l2d-viewer .l2d-binder-status.error { color: #c0392b; }
`
  document.head.appendChild(style)

  // ── 悬浮入口：挂件/桌宠右上角，静置自动隐藏 ──
  const toggle = document.createElement('button')
  toggle.id = 'l2d-model-toggle'
  toggle.type = 'button'
  toggle.title = '切换 Live2D 模型'
  toggle.setAttribute('aria-label', '切换 Live2D 模型')
  toggle.textContent = '⚙'
  toggle.addEventListener('pointerdown', (e) => e.stopPropagation())
  toggle.addEventListener('pointerup', (e) => e.stopPropagation())
  toggle.addEventListener('click', (e) => { e.stopPropagation(); togglePanel() })
  toggle.addEventListener('dblclick', (e) => e.stopPropagation())
  toggle.addEventListener('wheel', (e) => e.stopPropagation())
  ctx.box.appendChild(toggle)

  // ── 说明入口：齿轮下方的 ? 按钮，与齿轮同一显隐节奏 ──
  const helpToggle = document.createElement('button')
  helpToggle.id = 'l2d-model-help'
  helpToggle.type = 'button'
  helpToggle.title = '基本操作说明'
  helpToggle.setAttribute('aria-label', '基本操作说明')
  helpToggle.textContent = '?'
  helpToggle.addEventListener('pointerdown', (e) => e.stopPropagation())
  helpToggle.addEventListener('pointerup', (e) => e.stopPropagation())
  helpToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleHelp() })
  helpToggle.addEventListener('dblclick', (e) => e.stopPropagation())
  helpToggle.addEventListener('wheel', (e) => e.stopPropagation())
  ctx.box.appendChild(helpToggle)

  const helpCard = document.createElement('section')
  helpCard.id = 'l2d-help-card'
  helpCard.innerHTML = `
<div class="l2d-help-head"><span>基本操作</span><button class="l2d-help-close" type="button" title="关闭">×</button></div>
<ul>
  <li>点我：随机动作 + 吐槽</li>
  <li>双击：兴奋卖萌</li>
  <li>头顶悬停：摸头害羞</li>
  <li>拖拽：带我搬家（拖拽中缩放自动锁定）</li>
  <li>缩放：挂件滚轮 / 桌宠 Ctrl+滚轮</li>
  <li>⚙ 齿轮：模型 / 预览 / 绑定 / 帧率 / 退出</li>
  <li>左上小灯：AI 状态；多任务并行会分列任务灯</li>
  <li>台词：quips.json 自定义，保存约 30 秒生效</li>
</ul>`
  document.body.appendChild(helpCard)
  helpCard.querySelector('.l2d-help-close').addEventListener('click', () => toggleHelp(false))

  let helpOpen = false
  function positionHelp() {
    const rect = helpToggle.getBoundingClientRect()
    const w = helpCard.offsetWidth || 250
    const left = Math.min(Math.max(rect.right - w, 8), Math.max(8, window.innerWidth - w - 8))
    let top = rect.bottom + 8
    if (top + helpCard.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - helpCard.offsetHeight - 8)
    helpCard.style.left = left + 'px'
    helpCard.style.top = top + 'px'
  }
  function toggleHelp(show) {
    helpOpen = show ?? !helpOpen
    helpCard.classList.toggle('open', helpOpen)
    if (helpOpen) { showToggle(); positionHelp() }
    else scheduleHide()
    ctx.evalIgnore?.()
  }

  const panel = document.createElement('section')
  panel.id = 'l2d-model-panel'
  panel.innerHTML = `
<div class="l2d-panel-head">
  <span>Live2D 模型</span>
  <button class="l2d-panel-close" type="button" title="关闭">×</button>
</div>
<div class="l2d-panel-current">当前：<span class="l2d-current-path"></span></div>
<div class="l2d-panel-list"></div>
<div class="l2d-panel-status"></div>
<div class="l2d-panel-actions">
  <button type="button" class="l2d-reset">恢复默认</button>
  <button type="button" class="l2d-refresh">刷新列表</button>
  <button type="button" class="l2d-import">导入模型</button>
</div>
<div class="l2d-fps-row">
  <span>帧率</span>
  <select class="l2d-fps-select" title="渲染帧率预设（常态/睡眠/离线三档联动）">
    <option value="full">满血（60/30/12 fps）</option>
    <option value="balanced">均衡（30/12/6 fps，默认）</option>
    <option value="saver">省电（15/8/4 fps）</option>
  </select>
</div>
<div class="l2d-soft-row" hidden>
  <label class="l2d-soft-label" title="默认 GPU 渲染；拖动闪烁的机器开启后改走 CPU，切换后桌宠自动重启生效">
    <input type="checkbox" class="l2d-soft"> CPU 渲染模式（拖动闪烁时开启，切换后自动重启生效）
  </label>
</div>
<div class="l2d-quit-row" hidden>
  <button type="button" class="l2d-quit">退出桌宠</button>
</div>`
  document.body.appendChild(panel)

  const viewer = document.createElement('div')
  viewer.id = 'l2d-viewer'
  viewer.innerHTML = `
<div class="l2d-viewer-card">
  <div class="l2d-viewer-top">
    <span class="l2d-viewer-title"></span>
    <button class="l2d-binder-toggle" type="button" title="可视化绑定编辑">绑定</button>
    <button class="l2d-viewer-close" type="button" title="关闭">×</button>
  </div>
  <div class="l2d-binder" hidden>
    <div class="l2d-binder-tip">用法：先点上方状态按钮（工作/闲置…）选要配谁，再点下面的素材直接换上——点完立刻在预览里看到效果，满意了点「保存绑定」</div>
    <div class="l2d-binder-current">正在给【<b class="l2d-binder-state"></b>】配表现：　脸 <span class="l2d-binder-face"></span>　动作 <span class="l2d-binder-move"></span></div>
    <div class="l2d-binder-share" hidden></div>
    <div class="l2d-binder-h">脸（点一个换上）</div>
    <div class="l2d-binder-faces"></div>
    <div class="l2d-binder-h">动作（点一个换上）</div>
    <div class="l2d-binder-moves"></div>
    <div class="l2d-binder-h">点击池（点小人时随机播这些，可多选）</div>
    <div class="l2d-binder-pool"></div>
    <div class="l2d-binder-actions">
      <button type="button" class="l2d-binder-save">保存绑定</button>
      <button type="button" class="l2d-binder-reset">恢复自动嗅探</button>
    </div>
    <div class="l2d-binder-status"></div>
  </div>
  <div class="l2d-viewer-states"></div>
  <iframe title="Live2D 模型预览"></iframe>
</div>`
  document.body.appendChild(viewer)

  const importInput = document.createElement('input')
  importInput.type = 'file'
  importInput.multiple = true
  importInput.webkitdirectory = true
  importInput.style.display = 'none'
  document.body.appendChild(importInput)

  const closeBtn = panel.querySelector('.l2d-panel-close')
  const currentPathEl = panel.querySelector('.l2d-current-path')
  const listEl = panel.querySelector('.l2d-panel-list')
  const statusEl = panel.querySelector('.l2d-panel-status')
  const resetBtn = panel.querySelector('.l2d-reset')
  const refreshBtn = panel.querySelector('.l2d-refresh')
  const importBtn = panel.querySelector('.l2d-import')
  const fpsSelect = panel.querySelector('.l2d-fps-select')

  // 帧率预设：初始化跟随持久化值，切换立即生效并给气泡反馈
  if (fpsSelect && ctx.setFpsMode) {
    fpsSelect.value = ctx.fpsMode ?? 'balanced'
    fpsSelect.addEventListener('change', () => {
      ctx.setFpsMode(fpsSelect.value)
      const label = fpsSelect.selectedOptions[0]?.textContent ?? fpsSelect.value
      ctx.showBubble?.(`帧率已切换：${label}`, 1800)
    })
  }

  // 退出桌宠：仅桌宠形态显示；双击确认防误触，道别后再退场
  const quitRow = panel.querySelector('.l2d-quit-row')
  const quitBtn = panel.querySelector('.l2d-quit')
  // 软渲染开关：仅桌宠形态显示；勾选状态来自持久化配置，切换写盘后自动重启
  const softRow = panel.querySelector('.l2d-soft-row')
  const softCheck = panel.querySelector('.l2d-soft')
  if (softRow && softCheck && BRIDGE?.getSoft) {
    softRow.hidden = false
    BRIDGE.getSoft().then((v) => { softCheck.checked = !!v }).catch(() => { })
    softCheck.addEventListener('change', () => {
      ctx.showBubble?.(softCheck.checked ? '切换 CPU 渲染，咱马上回来…' : '切回 GPU 渲染，咱马上回来…', 1500)
      setTimeout(() => BRIDGE.setSoft(softCheck.checked), 800)
    })
  }
  if (quitRow && quitBtn && BRIDGE) {
    quitRow.hidden = false
    let armedAt = 0
    quitBtn.addEventListener('click', () => {
      const now = Date.now()
      if (armedAt !== 0 && now - armedAt < 3000) {
        ctx.showBubble?.('晚安主人，咱先退下啦…', 1500)
        setTimeout(() => BRIDGE.quit(), 900)
        return
      }
      armedAt = now
      quitBtn.classList.add('arm')
      quitBtn.textContent = '再点一次确认退出'
      setTimeout(() => {
        if (armedAt === now) {
          armedAt = 0
          quitBtn.classList.remove('arm')
          quitBtn.textContent = '退出桌宠'
        }
      }, 3000)
    })
  }
  const viewerTitle = viewer.querySelector('.l2d-viewer-title')
  const viewerFrame = viewer.querySelector('iframe')
  const viewerClose = viewer.querySelector('.l2d-viewer-close')
  const statesBar = viewer.querySelector('.l2d-viewer-states')

  // 预览状态按钮栏：点什么状态看什么表现（iframe 为隔离预览实例，不接 SSE）
  for (const [state, label] of [
    ['idle', '闲置'], ['thinking', '思考'], ['working', '工作'], ['waiting', '等待'],
    ['error', '出错'], ['done', '完成'], ['sleeping', '睡眠'], ['offline', '离线'],
  ]) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'l2d-state-btn'
    btn.dataset.state = state
    btn.textContent = label
    btn.addEventListener('click', () => {
      statesBar.querySelectorAll('.l2d-state-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      sendViewerState(state)
      // 绑定编辑器打开时，状态按钮同时充当「编辑目标」选择器
      if (!binderEl.hidden && binderDraft) { binderState = state; renderBinder() }
    })
    statesBar.appendChild(btn)
  }

  /**
   * iframe 就绪重试包装：同源取 contentWindow.__l2d。
   * 预览页冷启动（模块图 + PIXI + 模型 + 着色器编译）在低配机上可达 15 秒级，
   * 故重试窗口放宽到约 24 秒，避免开机窗口期内的点击被丢弃。
   * @param {(api:Object)=>void} cb 拿到预览 api 后执行
   */
  function withViewerApi(cb) {
    let tries = 0
    const attempt = () => {
      if (!viewer.classList.contains('open')) return // 弹窗已关，停止空转
      const api = viewerFrame.contentWindow?.__l2d
      if (api) { cb(api); return }
      if (++tries < 80) setTimeout(attempt, 300)
    }
    attempt()
  }

  /** 向预览 iframe 下达状态切换。 */
  function sendViewerState(state) {
    withViewerApi(api => api.enter(state))
  }

  // ── 绑定编辑器：状态直通（点状态选目标 → 点素材试穿换绑），保存写 profile.json ──

  const binderEl = viewer.querySelector('.l2d-binder')
  const binderToggle = viewer.querySelector('.l2d-binder-toggle')
  const binderStateEl = viewer.querySelector('.l2d-binder-state')
  const binderFaceEl = viewer.querySelector('.l2d-binder-face')
  const binderMoveEl = viewer.querySelector('.l2d-binder-move')
  const binderShareEl = viewer.querySelector('.l2d-binder-share')
  const binderFacesEl = viewer.querySelector('.l2d-binder-faces')
  const binderMovesEl = viewer.querySelector('.l2d-binder-moves')
  const binderPoolEl = viewer.querySelector('.l2d-binder-pool')
  const binderSaveBtn = viewer.querySelector('.l2d-binder-save')
  const binderResetBtn = viewer.querySelector('.l2d-binder-reset')
  const binderStatus = viewer.querySelector('.l2d-binder-status')

  /** 状态 → 绑定槽位映射 + 中文名（与预览状态栏一一对应；null = 该状态无动作位）。
   *  注意「思考」与「等待」共用 doubt 脸槽——UI 上会对共享给出提示。 */
  const STATE_DEF_UI = [
    ['idle', '闲置', 'default', null],
    ['thinking', '思考', 'doubt', 'think'],
    ['working', '工作', 'excited', 'excited'],
    ['waiting', '等待', 'doubt', 'shake'],
    ['error', '出错', 'troubled', 'dizzy'],
    ['done', '完成', 'happy', 'nod'],
    ['sleeping', '睡眠', 'sleep', 'sleep'],
    ['offline', '离线', 'dark', null],
  ]
  const STATE_LABEL = Object.fromEntries(STATE_DEF_UI.map(([s, l]) => [s, l]))
  const stateExprSlot = (s) => STATE_DEF_UI.find(([k]) => k === s)?.[2] ?? null
  const stateMotionSlot = (s) => STATE_DEF_UI.find(([k]) => k === s)?.[3] ?? null

  let viewerPath = ''   // 预览弹窗当前目标模型
  let binderPath = ''   // 编辑器已填充的模型（用于变更检测）
  let binderInventory = { expressions: [], motions: [] }
  /** 草稿：{ expressions: {槽位: 名}, motions: {槽位: [组,序号]}, clickPool: [[组,序号]] } */
  let binderDraft = null
  let binderState = 'idle'   // 当前编辑目标状态（与状态栏按钮联动）

  function binderSetStatus(text, isError = false) {
    binderStatus.textContent = text
    binderStatus.classList.toggle('error', isError)
  }

  /** 素材按钮文案：组:序号 + 文件名末段。 */
  function motionOptionLabel(m) {
    return `${m.group}:${m.index} ${m.file.split('/').pop()}`
  }

  /** 表情名 → 服役状态中文名列表（角标用，用户词汇而非槽位名）。 */
  function faceBadges(name) {
    return STATE_DEF_UI
      .filter(([, , eslot]) => eslot && binderDraft.expressions[eslot] === name)
      .map(([, label]) => label)
  }

  /** 动作 [组,序号] → 服役状态中文名列表（含点击池）。 */
  function moveBadges(g, i) {
    const hits = STATE_DEF_UI
      .filter(([, , , mslot]) => mslot && binderDraft.motions[mslot]?.[0] === g && binderDraft.motions[mslot]?.[1] === i)
      .map(([, label]) => label)
    if (binderDraft.clickPool.some(([pg, pi]) => pg === g && pi === i)) hits.push('点击池')
    return hits
  }

  function makeMat(text, on, badges, onClick, disabled = false) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'l2d-mat' + (on ? ' on' : '')
    btn.textContent = text
    btn.disabled = disabled
    if (badges.length > 0) {
      const s = document.createElement('span')
      s.className = 'badges'
      s.textContent = '→ ' + badges.join('、')
      btn.appendChild(s)
    }
    btn.addEventListener('click', onClick)
    return btn
  }

  /** 渲染编辑器：当前状态行 + 共享提示 + 脸/动作画廊 + 点击池。 */
  function renderBinder() {
    if (!binderDraft) return
    const eslot = stateExprSlot(binderState)
    const mslot = stateMotionSlot(binderState)
    binderStateEl.textContent = STATE_LABEL[binderState]
    binderFaceEl.textContent = binderDraft.expressions[eslot] ?? '（未绑定）'
    binderMoveEl.textContent = mslot ? (binderDraft.motions[mslot] ? motionOptionLabel({ group: binderDraft.motions[mslot][0], index: binderDraft.motions[mslot][1], file: '' }).trim() : '（未绑定）') : '（该状态无动作位）'
    // 共享提示：别的状态也在用同一个脸/动作槽时告知，避免"我改了A怎么B也变了"
    const sharers = STATE_DEF_UI.filter(([k, , s2]) => k !== binderState && s2 !== null && s2 === eslot).map(([, l]) => l)
    if (sharers.length > 0) {
      binderShareEl.hidden = false
      binderShareEl.textContent = `提示：「${sharers.join('」「')}」和当前状态共用同一张脸，换脸会一起变`
    } else {
      binderShareEl.hidden = true
    }

    binderFacesEl.replaceChildren()
    for (const name of binderInventory.expressions) {
      binderFacesEl.appendChild(makeMat(name, binderDraft.expressions[eslot] === name, faceBadges(name), () => toggleFace(name)))
    }
    binderMovesEl.replaceChildren()
    for (const m of binderInventory.motions) {
      const on = mslot !== null && binderDraft.motions[mslot]?.[0] === m.group && binderDraft.motions[mslot]?.[1] === m.index
      binderMovesEl.appendChild(makeMat(motionOptionLabel(m), on, moveBadges(m.group, m.index), () => toggleMove(m), mslot === null))
    }
    binderPoolEl.replaceChildren()
    for (const m of binderInventory.motions) {
      const on = binderDraft.clickPool.some(([pg, pi]) => pg === m.group && pi === m.index)
      binderPoolEl.appendChild(makeMat(motionOptionLabel(m), on, [], () => togglePool(m)))
    }
  }

  /** 换脸：写进当前状态的脸槽（再点同一个=解绑），并立即在预览里播放。 */
  function toggleFace(name) {
    const eslot = stateExprSlot(binderState)
    if (!eslot) return
    if (binderDraft.expressions[eslot] === name) delete binderDraft.expressions[eslot]
    else binderDraft.expressions[eslot] = name
    withViewerApi(api => api.rawExpr(name))
    renderBinder()
  }

  /** 换动作：写进当前状态的动作槽；无动作位的状态给出提示。 */
  function toggleMove(m) {
    const mslot = stateMotionSlot(binderState)
    if (!mslot) {
      binderSetStatus(`「${STATE_LABEL[binderState]}」没有动作位（闲置/离线靠模型自动呼吸）`, true)
      return
    }
    const cur = binderDraft.motions[mslot]
    if (cur && cur[0] === m.group && cur[1] === m.index) delete binderDraft.motions[mslot]
    else binderDraft.motions[mslot] = [m.group, m.index]
    withViewerApi(api => api.rawMotion(m.group, m.index))
    renderBinder()
  }

  /** 点击池多选开关，点选即试听。 */
  function togglePool(m) {
    const idx = binderDraft.clickPool.findIndex(([pg, pi]) => pg === m.group && pi === m.index)
    if (idx >= 0) binderDraft.clickPool.splice(idx, 1)
    else binderDraft.clickPool.push([m.group, m.index])
    withViewerApi(api => api.rawMotion(m.group, m.index))
    renderBinder()
  }

  /** 填充编辑器：拉取目标模型的清单与既有档案，渲染槽位表（显示值为 profile 覆盖后的生效绑定）。 */
  async function populateBinder(path) {
    binderPath = path
    const dir = path.split('/').slice(0, -1).join('/')
    binderSetStatus('正在读取素材清单…')
    let modelJson = null
    let profile = null
    try { modelJson = await (await fetch(`${BASE}/model/${path}`, { cache: 'no-store' })).json() } catch { }
    try { profile = await (await fetch(`${BASE}/model/${dir}/profile.json`, { cache: 'no-store' })).json() } catch { }
    binderInventory = extractInventory(modelJson)
    const resolved = resolveBinding(modelJson, profile)
    binderDraft = {
      expressions: { ...resolved.expr },
      motions: { ...resolved.motion },
      clickPool: resolved.clickPool.map((p) => [...p]),
    }
    renderBinder()
    binderSetStatus(profile ? '已加载既有 profile.json（可覆盖保存）' : '当前为自动嗅探结果（保存后生成 profile.json）')
  }

  /** 草稿 → profile.json 形状（丢弃空组；全空时返回 null，清空请走恢复嗅探）。 */
  function buildProfile() {
    const profile = {}
    if (Object.keys(binderDraft.expressions).length > 0) profile.expressions = binderDraft.expressions
    const motions = { ...binderDraft.motions }
    if (binderDraft.clickPool.length > 0) motions.clickPool = binderDraft.clickPool
    if (Object.keys(motions).length > 0) profile.motions = motions
    return profile.expressions || profile.motions ? profile : null
  }

  /** 保存：写档案 → 若编辑的正是当前模型则强制热重载绑定。 */
  async function saveBinder() {
    const profile = buildProfile()
    if (!profile) {
      binderSetStatus('没有可保存的绑定；想清空请用「恢复自动嗅探」', true)
      return
    }
    const dir = binderPath.split('/').slice(0, -1).join('/')
    binderSetStatus('正在保存…')
    try {
      const response = await fetch(BASE + '/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir, profile }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
      if (binderPath === ctx.modelPath) {
        await ctx.switchModel(ctx.modelPath, true)
        binderSetStatus('已保存并热生效')
      } else {
        binderSetStatus('已保存（切换到该模型时生效）')
      }
    } catch (error) {
      binderSetStatus('保存失败：' + error.message, true)
    }
  }

  /** 恢复自动嗅探：删除档案 → 热重载 → 重填表单显示嗅探结果。 */
  async function resetBinder() {
    const dir = binderPath.split('/').slice(0, -1).join('/')
    binderSetStatus('正在删除档案…')
    try {
      const response = await fetch(BASE + '/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir, reset: true }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
      if (binderPath === ctx.modelPath) await ctx.switchModel(ctx.modelPath, true)
      await populateBinder(binderPath)
    } catch (error) {
      binderSetStatus('恢复失败：' + error.message, true)
    }
  }

  binderToggle.addEventListener('click', () => {
    const willOpen = binderEl.hidden
    binderEl.hidden = !willOpen
    binderToggle.classList.toggle('active', willOpen)
    if (willOpen) {
      // 打开时跟随状态栏当前激活的按钮，保持「点谁配谁」的连续性
      const active = statesBar.querySelector('.l2d-state-btn.active')
      if (active?.dataset.state && STATE_LABEL[active.dataset.state]) binderState = active.dataset.state
      if (binderPath !== viewerPath) void populateBinder(viewerPath)
      else if (binderDraft) renderBinder()
    }
  })
  binderSaveBtn.addEventListener('click', () => void saveBinder())
  binderResetBtn.addEventListener('click', () => void resetBinder())

  let panelOpen = false
  let panelBusy = false
  let models = []
  let serverDefaultModel = ''
  let hideTimer = 0

  // ── 入口静置自动隐藏：悬停/指针移动时出现，面板或说明卡打开时保持 ──
  function showToggle() {
    clearTimeout(hideTimer)
    toggle.classList.remove('l2d-hidden')
    helpToggle.classList.remove('l2d-hidden')
  }
  function scheduleHide() {
    clearTimeout(hideTimer)
    if (!panelOpen && !helpOpen) {
      hideTimer = setTimeout(() => {
        toggle.classList.add('l2d-hidden')
        helpToggle.classList.add('l2d-hidden')
      }, 1200)
    }
  }
  showToggle()
  scheduleHide()
  ctx.box.addEventListener('pointerenter', showToggle)
  ctx.box.addEventListener('pointermove', showToggle)
  ctx.box.addEventListener('pointerleave', scheduleHide)

  function setStatus(text, isError = false) {
    statusEl.textContent = text
    statusEl.classList.toggle('error', isError)
  }

  function positionPanel() {
    if (!panelOpen) return
    const rect = toggle.getBoundingClientRect()
    const gap = 8
    // 窄窗口下面板会被 CSS min() 收缩，钳制必须用实测宽度而非宽度上限
    const w = panel.offsetWidth || PANEL_WIDTH
    let left = rect.right - w
    left = Math.min(Math.max(left, 8), Math.max(8, window.innerWidth - w - 8))
    let top = rect.bottom + gap
    if (top + panel.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - panel.offsetHeight - gap)
    }
    panel.style.left = left + 'px'
    panel.style.top = top + 'px'
  }

  function renderList() {
    currentPathEl.textContent = ctx.modelPath
    listEl.replaceChildren()
    if (models.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'l2d-model-empty'
      empty.textContent = '未找到 .model3.json 模型'
      listEl.appendChild(empty)
      return
    }
    for (const item of models) {
      const row = document.createElement('div')
      row.className = 'l2d-model-row' + (item.path === ctx.modelPath ? ' selected' : '')
      const itemBtn = document.createElement('button')
      itemBtn.type = 'button'
      itemBtn.className = 'l2d-model-item'
      const name = document.createElement('div')
      name.className = 'l2d-model-name'
      name.textContent = item.dir !== '' ? item.dir : item.file.replace(/\.model3\.json$/i, '')
      const path = document.createElement('div')
      path.className = 'l2d-model-path'
      path.textContent = item.path
      itemBtn.append(name, path)
      itemBtn.addEventListener('click', () => selectModel(item.path))
      const viewBtn = document.createElement('button')
      viewBtn.type = 'button'
      viewBtn.className = 'l2d-model-view'
      viewBtn.title = '预览 ' + item.path
      viewBtn.textContent = '查看'
      viewBtn.addEventListener('click', () => openViewer(item.path))
      row.append(itemBtn, viewBtn)
      listEl.appendChild(row)
    }
  }

  async function refreshModels() {
    setStatus('正在扫描模型…')
    try {
      const response = await fetch(BASE + '/models', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
      models = Array.isArray(data.models) ? data.models : []
      serverDefaultModel = typeof data.defaultModel === 'string' ? data.defaultModel : ''
      resetBtn.title = '恢复默认：' + (serverDefaultModel || 'cordis.patch.yml')
      renderList()
      setStatus(models.length > 0 ? `共 ${models.length} 个模型` : '未找到 .model3.json 模型')
    } catch (error) {
      setStatus('加载失败：' + error.message, true)
    }
  }

  async function selectModel(nextPath) {
    if (panelBusy) return
    if (nextPath === ctx.modelPath) {
      renderList()
      setStatus('已经是当前模型')
      return
    }
    panelBusy = true
    setStatus('正在切换…')
    try {
      const response = await fetch(BASE + '/model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: nextPath }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
      const switched = await ctx.switchModel(data.model)
      if (!switched && ctx.modelPath !== data.model) throw new Error('模型加载失败')
      renderList()
      setStatus('已切换：' + data.model)
    } catch (error) {
      setStatus('切换失败：' + error.message, true)
    } finally {
      panelBusy = false
    }
  }

  async function resetDefaultModel() {
    if (panelBusy) return
    panelBusy = true
    setStatus('正在恢复默认模型…')
    try {
      const response = await fetch(BASE + '/model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
      const switched = await ctx.switchModel(data.model)
      if (!switched && ctx.modelPath !== data.model) throw new Error('默认模型加载失败')
      renderList()
      setStatus('已恢复默认：' + data.model)
    } catch (error) {
      setStatus('恢复失败：' + error.message, true)
    } finally {
      panelBusy = false
    }
  }

  function openPanel() {
    panelOpen = true
    showToggle()
    panel.classList.add('open')
    positionPanel()
    ctx.evalIgnore?.()  // 面板展开后立即刷新穿透判定（面板区域纳入可交互）
    if (models.length === 0) void refreshModels()
    else renderList()
  }

  function closePanel() {
    panelOpen = false
    panel.classList.remove('open')
    scheduleHide()
    ctx.evalIgnore?.()
  }

  function togglePanel() {
    if (panelOpen) closePanel()
    else openPanel()
  }

  function openViewer(path) {
    if (!path) return
    viewerPath = path
    viewerTitle.textContent = path
    viewerFrame.src = `${BASE}/pet.html?model=${encodeURIComponent(path)}&preview=1`
    viewer.classList.add('open')
    ctx.evalIgnore?.()
  }

  function closeViewer() {
    viewer.classList.remove('open')
    viewerFrame.src = 'about:blank'
    statesBar.querySelectorAll('.l2d-state-btn').forEach(b => b.classList.remove('active'))
    binderEl.hidden = true
    binderToggle.classList.remove('active')
    ctx.evalIgnore?.()
  }

  function runImportFlow() {
    if (panelBusy) return
    importInput.value = ''
    importInput.click()
  }

  async function importSelectedFiles(fileList) {
    const files = [...fileList]
    if (files.length === 0) return
    let modelName = ''
    for (const file of files) {
      const rel = (file.webkitRelativePath || '').replaceAll('\\', '/')
      const first = rel.split('/')[0]
      if (first && first !== '.' && first !== '..' && !first.startsWith('.')) {
        modelName = first
        break
      }
    }
    if (!modelName) {
      const fallback = files.length === 1 ? files[0].name.replace(/\.model3\.json$/i, '') : 'my-model'
      const prompted = window.prompt('请输入模型文件夹名称', fallback)
      modelName = typeof prompted === 'string' ? prompted.trim() : ''
    }
    if (!modelName || modelName.includes('/') || modelName.includes('\\') || modelName.includes(':') || modelName.startsWith('.')) {
      setStatus('模型名称无效：请使用不含 / \\\\ : 的文件夹名', true)
      return
    }
    const ordered = [...files].sort((a, b) => {
      const ai = a.name.toLowerCase().endsWith('.model3.json') ? 1 : 0
      const bi = b.name.toLowerCase().endsWith('.model3.json') ? 1 : 0
      return ai - bi
    })
    panelBusy = true
    let model3Path = ''
    let uploaded = 0
    try {
      for (const file of ordered) {
        const rel = (file.webkitRelativePath || file.name).replaceAll('\\', '/')
        const parts = rel.split('/')
        const filePath = parts.length > 1 ? parts.slice(1).join('/') : file.name
        if (!filePath) continue
        setStatus(`导入中 ${uploaded + 1}/${ordered.length}：${file.name}`)
        const response = await fetch(`${BASE}/import?model=${encodeURIComponent(modelName)}&path=${encodeURIComponent(filePath)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: await file.arrayBuffer(),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
        uploaded += 1
        if (file.name.toLowerCase().endsWith('.model3.json')) model3Path = `${modelName}/${filePath}`
      }
    } catch (error) {
      panelBusy = false
      setStatus('导入失败：' + error.message, true)
      await refreshModels()
      return
    }
    panelBusy = false
    await refreshModels()
    if (model3Path) {
      await selectModel(model3Path)
    } else {
      setStatus(`导入完成：${modelName}（未找到 .model3.json）`)
    }
  }

  closeBtn.addEventListener('click', closePanel)
  resetBtn.addEventListener('click', resetDefaultModel)
  refreshBtn.addEventListener('click', () => refreshModels())
  importBtn.addEventListener('click', runImportFlow)
  importInput.addEventListener('change', () => {
    void importSelectedFiles(importInput.files)
    importInput.value = ''
  })
  viewerClose.addEventListener('click', closeViewer)
  viewer.addEventListener('click', (e) => { if (e.target === viewer) closeViewer() })
  resetBtn.title = '恢复 cordis.patch.yml 中配置的默认模型'
  window.addEventListener('resize', positionPanel)
  document.addEventListener('pointerdown', (e) => {
    if (panelOpen && !panel.contains(e.target) && !toggle.contains(e.target) && !viewer.contains(e.target)) closePanel()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (viewer.classList.contains('open')) closeViewer()
    else closePanel()
  })
  ctx.box.addEventListener('pointerup', () => { if (panelOpen) positionPanel() })

  return {
    refreshModels,
    openPanel,
    closePanel,
    openViewer,
    importModels: importSelectedFiles,
    get modelList() { return [...models] },
  }
}
