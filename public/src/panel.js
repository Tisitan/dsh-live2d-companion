/**
 * panel.js —— 模型面板：悬浮齿轮入口、模型扫描/切换/导入、预览弹窗。
 *
 * 面板只依赖 ctx 提供的 switchModel / modelPath / box / showBubble；
 * 不直接操作状态机或渲染细节。入口按钮默认静置 1.2 秒后自动隐藏，
 * 鼠标悬停模型区域时重新出现（面板打开时保持显示）。
 */

import { BASE, PREVIEW } from './config.js'

/** 面板锚定宽度（px），positionModelPanel 用它做视口钳制。 */
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
#l2d-model-panel {
  position: fixed; z-index: 100000; width: 280px; max-height: min(420px, calc(100vh - 16px));
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
</div>`
  document.body.appendChild(panel)

  const viewer = document.createElement('div')
  viewer.id = 'l2d-viewer'
  viewer.innerHTML = `
<div class="l2d-viewer-card">
  <div class="l2d-viewer-top">
    <span class="l2d-viewer-title"></span>
    <button class="l2d-viewer-close" type="button" title="关闭">×</button>
  </div>
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
  const viewerTitle = viewer.querySelector('.l2d-viewer-title')
  const viewerFrame = viewer.querySelector('iframe')
  const viewerClose = viewer.querySelector('.l2d-viewer-close')

  let panelOpen = false
  let panelBusy = false
  let models = []
  let serverDefaultModel = ''
  let hideTimer = 0

  // ── 入口静置自动隐藏：悬停/指针移动时出现，面板打开时保持 ──
  function showToggle() {
    clearTimeout(hideTimer)
    toggle.classList.remove('l2d-hidden')
  }
  function scheduleHide() {
    clearTimeout(hideTimer)
    if (!panelOpen) hideTimer = setTimeout(() => toggle.classList.add('l2d-hidden'), 1200)
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
    let left = rect.right - PANEL_WIDTH
    left = Math.min(Math.max(left, 8), Math.max(8, window.innerWidth - PANEL_WIDTH - 8))
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
    if (models.length === 0) void refreshModels()
    else renderList()
  }

  function closePanel() {
    panelOpen = false
    panel.classList.remove('open')
    scheduleHide()
  }

  function togglePanel() {
    if (panelOpen) closePanel()
    else openPanel()
  }

  function openViewer(path) {
    if (!path) return
    viewerTitle.textContent = path
    viewerFrame.src = `${BASE}/pet.html?model=${encodeURIComponent(path)}&preview=1`
    viewer.classList.add('open')
  }

  function closeViewer() {
    viewer.classList.remove('open')
    viewerFrame.src = 'about:blank'
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
